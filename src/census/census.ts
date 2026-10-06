import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { USDM, V1_ADDRESS } from '../../shared/constants.ts'
import { STATE } from '../../shared/types.ts'
import type { Census, Datum, Network, Provider, RawUtxo, Read, State, Tip, Value } from '../../shared/types.ts'
import * as blockfrost from '../read/blockfrost.ts'
import * as koios from '../read/koios.ts'
import { decodeDatum } from './decode.ts'

export type Snapshot = { network: Network; provider: Provider; tip: Tip; holes: number; utxos: RawUtxo[] }
export type Decoded = { utxo: RawUtxo; datum: Datum | null; error: string | null }

const FIXTURES = new URL('../../fixtures/mainnet/', import.meta.url)
const fixtureFile = (provider: Provider) => new URL(`utxos-${provider}.json`, FIXTURES)

export function sum(values: Value[]): Value {
  const out: Record<string, bigint> = {}
  for (const v of values) for (const [unit, qty] of Object.entries(v)) out[unit] = (out[unit] ?? 0n) + BigInt(qty)
  return Object.fromEntries(Object.entries(out).map(([unit, qty]) => [unit, qty.toString()]))
}

// An undecodable row is kept and counted, with its reason, never dropped.
export function decodeAll(utxos: RawUtxo[]): Decoded[] {
  return utxos.map((utxo) => {
    if (utxo.inlineDatumCbor === null) return { utxo, datum: null, error: 'no inline datum' }
    try {
      return { utxo, datum: decodeDatum(utxo.inlineDatumCbor), error: null }
    } catch (e) {
      return { utxo, datum: null, error: (e as Error).message }
    }
  })
}

export function buildCensus(net: Network, tip: Tip, read: Read<RawUtxo[]>): Census {
  const decoded = decodeAll(read.data)
  const byState = Object.fromEntries(STATE.map((s) => [s, 0])) as Record<State, number>
  for (const d of decoded) if (d.datum) byState[d.datum.state]++
  const ok = decoded.filter((d) => d.datum).length
  const disputed = decoded.filter((d) => d.datum?.state === 'Disputed').map((d) => d.utxo.value)
  return {
    network: net,
    tip,
    provider: read.provider,
    open: decoded.length,
    decoded: ok,
    undecodable: decoded.length - ok,
    holes: read.holes,
    byState,
    disputedTotals: { lovelace: '0', [USDM]: '0', ...sum(disputed) },
    rows: decoded
      .map((d) => ({ ref: d.utxo.ref, state: d.datum?.state ?? null, value: d.utxo.value }))
      .sort((a, b) => a.ref.localeCompare(b.ref)),
    secondProvider: null,
  }
}

export function compare(a: Read<RawUtxo[]>, b: Read<RawUtxo[]>): string[] {
  const diff: string[] = []
  const left = new Map(a.data.map((u) => [u.ref, u]))
  const right = new Map(b.data.map((u) => [u.ref, u]))
  for (const [ref, u] of left) {
    const v = right.get(ref)
    if (!v) diff.push(`${ref} only on ${a.provider}`)
    else {
      if (JSON.stringify(sum([u.value])) !== JSON.stringify(sum([v.value]))) diff.push(`${ref} value differs`)
      if (u.inlineDatumCbor?.toLowerCase() !== v.inlineDatumCbor?.toLowerCase()) diff.push(`${ref} datum differs`)
    }
  }
  for (const ref of right.keys()) if (!left.has(ref)) diff.push(`${ref} only on ${b.provider}`)
  const ta = sum(a.data.map((u) => u.value))
  const tb = sum(b.data.map((u) => u.value))
  for (const unit of new Set([...Object.keys(ta), ...Object.keys(tb)])) {
    if (ta[unit] !== tb[unit]) diff.push(`total ${unit}: ${a.provider} ${ta[unit] ?? 0} vs ${b.provider} ${tb[unit] ?? 0}`)
  }
  return diff
}

async function readLive(net: Network, provider: typeof koios): Promise<Snapshot> {
  const read = await provider.utxosAt(net, V1_ADDRESS[net])
  // tip after the UTxO read: every row is at or before this block
  const tip = await provider.tip(net)
  if (!tip.data) throw new Error(`${read.provider}: tip unavailable, nothing to pin the census to`)
  return { network: net, provider: read.provider, tip: tip.data, holes: read.holes, utxos: read.data }
}

export async function loadSnapshots(net: Network, fixture: boolean, pin: boolean): Promise<Snapshot[]> {
  if (fixture) {
    const found = (['koios', 'blockfrost'] as const).filter((p) => existsSync(fixtureFile(p)))
    if (!found.length) throw new Error('no fixture in fixtures/mainnet/: run `pnpm census:mainnet --pin` once online')
    return found.map((p) => JSON.parse(readFileSync(fixtureFile(p), 'utf8')) as Snapshot)
  }
  const snaps = [await readLive(net, koios)]
  if (blockfrost.available(net)) snaps.push(await readLive(net, blockfrost))
  if (pin) {
    mkdirSync(FIXTURES, { recursive: true })
    for (const s of snaps) writeFileSync(fixtureFile(s.provider), JSON.stringify(s, null, 1))
  }
  return snaps
}

const asRead = (s: Snapshot, fixture: boolean): Read<RawUtxo[]> => ({ data: s.utxos, holes: s.holes, provider: fixture ? 'fixture' : s.provider })

export async function runCensus(net: Network = 'mainnet', fixture = process.env.READ_SOURCE === 'fixture', pin = false) {
  const snaps = await loadSnapshots(net, fixture, pin)
  const [first, second] = snaps
  const census = buildCensus(net, first.tip, asRead(first, fixture))
  if (second) census.secondProvider = { provider: fixture ? 'fixture' : second.provider, holes: second.holes, diff: compare(asRead(first, fixture), asRead(second, fixture)) }
  return { census, snaps }
}

const unitLabel = (u: string) => (u === USDM ? 'USDM' : u === 'lovelace' ? 'lovelace' : u.slice(0, 8))
const showValue = (v: Value) => Object.entries(v).map(([u, q]) => `${unitLabel(u)} ${q}`).join(' · ')

async function main() {
  if (existsSync('.env')) process.loadEnvFile('.env')
  const fixture = process.env.READ_SOURCE === 'fixture'
  const { census, snaps } = await runCensus('mainnet', fixture, process.argv.includes('--pin'))
  const [first, second] = snaps
  console.log(`${census.network} census · ${fixture ? `FIXTURE (${first.provider} snapshot)` : census.provider} · tip ${census.tip.height} ${census.tip.hash}`)
  console.log(`${census.open} open · ${census.decoded} decoded · ${census.undecodable} undecodable · ${census.holes} holes`)
  console.log(`by state: ${STATE.map((s) => `${s} ${census.byState[s]}`).join(' · ')}`)
  console.log(`Disputed total (UTxO set): ${showValue(census.disputedTotals)}`)
  console.log(`all open, summed from the UTxO set: ${showValue(sum(first.utxos.map((u) => u.value)))}`)
  for (const d of decodeAll(first.utxos)) if (d.error) console.log(`undecodable: ${d.utxo.ref} · ${d.error}`)
  const sp = census.secondProvider
  if (!second) console.log('second provider: skipped (no key). One provider only, not cross-checked.')
  else if (sp) {
    console.log(`second provider ${second.provider}: ${second.utxos.length} rows · ${sp.holes} holes · all open summed: ${showValue(sum(second.utxos.map((u) => u.value)))}`)
    console.log(sp.diff.length ? `diff (${sp.diff.length}):\n  ${sp.diff.join('\n  ')}` : 'diff: none (same refs, values, datums, totals)')
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
