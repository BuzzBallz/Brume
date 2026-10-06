// The preflight before every take of the demo video: read-only, nothing is built, signed or sent. One line per check,
// 'PASS|WARN|FAIL|INFO  <check>: <reason>', then 'N PASS, N WARN, N FAIL'; exit code 1 on any FAIL.
//   node src/preprod/preflight.ts [--agent http://127.0.0.1:8787] [--escrow <ref>] [--skip-mainnet]
// --escrow forces the take escrow (default: the first live, Disputed script-pot escrow of fixtures/preprod/bank.json whose
// buyer and seller are this machine's keys). --skip-mainnet drops the three mainnet reads (census, Sokosumi, dormancy).
// No key, token or project id is ever printed, not even partially: keys show as shortened addresses, the rest as present
// or absent, and every line is scrubbed of the secret env values before it is printed. A provider error or timeout is a
// hole: it is never a PASS.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import type { Datum, State, Value } from '../../shared/types.ts'
import { STATE } from '../../shared/types.ts'
import { KOIOS, PARAMS, SCRIPT_HASH, TUSDM, V1_ADDRESS } from '../../shared/constants.ts'
import { reach } from '../engine/reach.ts'
import { checkDormancy } from '../solver/dormancy.ts'
import { blockfrostGet, koiosHeaders, koiosLimited, liveUtxos, utxoInfo } from './chain.ts'
import { readDatum } from './datum.ts'
import { loadEnv, ROOT } from './env.ts'
import { escrowAt, lovelace, pureAda, refOf } from './fixture.ts'
import { isStale, reservedUtxos } from './settle.ts'
import { party, type Party } from './wallet.ts'

export type Status = 'PASS' | 'WARN' | 'FAIL' | 'INFO'
export type Line = { status: Status; check: string; reason: string }

// What the video says, as measured on 6 Oct: the census of the V1 script on mainnet and Sokosumi's vendors page.
export const VIDEO = { disputed: 61, refundRequested: 4, vendors: 9, coworkers: 12, agents: 41 } as const
// Brume's registration on preprod (Masumi registry V2): policy (56 hex) then asset name. AGENT_IDENTIFIER, when set, wins.
export const REGISTRATION = '67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b' + '10623ce443d4137e7acc0839c20c4ba0c022940ab6de665dea00cc8c16000001'
const TADA = 1_000_000n
const SOKOSUMI_VENDORS = 'https://www.sokosumi.com/vendors'

// ---------- pure parts (preflight.test.ts) ----------

export const shortRef = (ref: string): string => `${ref.slice(0, 10)}…#${ref.split('#')[1]}`
export const shortAddr = (a: string): string => `${a.slice(0, 14)}…${a.slice(-6)}`
export const tada = (l: bigint): string => `${Number(l) / 1e6} tADA`

// Validity windows are now ± 150 s: a clock off by minutes builds txs the ledger refuses outright. The skew is measured
// against a server's HTTP Date header (1 s resolution), never against the tip block, whose age follows the block gaps.
export const clockStatus = (skewMs: number): Status => (Math.abs(skewMs) < 30_000 ? 'PASS' : Math.abs(skewMs) < 90_000 ? 'WARN' : 'FAIL')
// The tip block's age by the server's own clock: preprod makes a block every ~20 s, so 3 min without one is a stalled
// chain or provider, and 10 min a dead one.
export const tipStatus = (ageMs: number): Status => (ageMs < 180_000 ? 'PASS' : ageMs < 600_000 ? 'WARN' : 'FAIL')
// The local clock minus a Date header read between the local times t0 and t1: the header is floored to the second, so
// its middle (+500 ms) is set against the middle of the round trip. null when the header is missing or not a date.
export function dateSkew(t0: number, t1: number, header: string | null): number | null {
  const server = header ? Date.parse(header) : NaN
  return Number.isFinite(server) ? Math.round((t0 + t1) / 2 - (server + 500)) : null
}
const worst = (...s: Status[]): Status => (s.includes('FAIL') ? 'FAIL' : s.includes('WARN') ? 'WARN' : 'PASS')

// What an agent's /availability must answer (MIP-003): anything else (a tunnel's error page, a stray server) is no agent.
export function isAvailable(text: string): boolean {
  try {
    const b = JSON.parse(text) as { status?: unknown; type?: unknown }
    return b?.status === 'available' && b?.type === 'masumi-agent'
  } catch {
    return false
  }
}
// /api/bank's rows, or null when the body is not that shape.
export function bankRows(text: string): { ref: string; state: string }[] | null {
  try {
    const rows = (JSON.parse(text) as { bank?: unknown } | null)?.bank
    return Array.isArray(rows) && rows.every((r) => typeof (r as { ref?: unknown } | null)?.ref === 'string') ? (rows as { ref: string; state: string }[]) : null
  } catch {
    return null
  }
}

// The take's pot: exactly 20 tADA and 10 tUSDM, nothing else.
export function isScriptPot(v: Value): boolean {
  const units = Object.keys(v).filter((u) => v[u] !== '0')
  return units.length === 2 && v.lovelace === String(20n * TADA) && v[TUSDM] === String(10n * TADA)
}

// CIP-25 strings over 64 bytes are split into arrays of strings: joined back here.
const joined = (x: unknown): string | null => (typeof x === 'string' ? x : Array.isArray(x) && x.every((s) => typeof s === 'string') ? x.join('') : null)

// api_base_url of one registry NFT from its mint's metadata (label 721 → policy → asset name). Only that asset's entry
// counts: another asset's URL under the same label is never taken for ours.
export function apiBaseUrl(metadata: Record<string, unknown> | null | undefined, policy: string, assetName: string): string | null {
  const byPolicy = (metadata?.['721'] as Record<string, unknown> | undefined)?.[policy] as Record<string, unknown> | undefined
  const entry = byPolicy?.[assetName] as Record<string, unknown> | undefined
  return entry ? joined(entry.api_base_url) : null
}

// '<n> Vendors <n> AI Coworkers <n> marketplace agents', read from the page text with the tags taken out.
export function vendorCounts(html: string): { vendors: number; coworkers: number; agents: number } | null {
  const text = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ')
  const m = text.match(/(\d+) Vendors? (\d+) AI Coworkers? (\d+) marketplace agents?/i)
  return m ? { vendors: Number(m[1]), coworkers: Number(m[2]), agents: Number(m[3]) } : null
}

// The V1 script's UTxOs by state, with the 16-field decoder. A row without a datum, or one that does not decode, is counted
// apart, never dropped.
export function countStates(rows: { inline_datum: { bytes: string } | null }[]): { byState: Record<State, number>; undecodable: number } {
  const byState = Object.fromEntries(STATE.map((s) => [s, 0])) as Record<State, number>
  let undecodable = 0
  for (const r of rows) {
    try {
      if (!r.inline_datum) throw new Error('no inline datum')
      byState[readDatum(r.inline_datum.bytes).state]++
    } catch {
      undecodable++
    }
  }
  return { byState, undecodable }
}

// Every secret env value (keys, tokens, project ids) is cut out of a line before it is printed: a provider error that
// quoted one could otherwise reach the terminal, and the terminal is on the video.
const SECRET = /KEY|TOKEN|SECRET|PASSWORD|PROJECT_ID/
export function scrub(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text
  for (const [name, value] of Object.entries(env)) {
    const v = value?.trim()
    if (v && v.length >= 8 && SECRET.test(name)) out = out.split(v).join('<redacted>')
  }
  return out
}

export const format = (l: Line): string => `${l.status}  ${l.check}: ${l.reason}`
export function tally(lines: Line[]): { pass: number; warn: number; fail: number; text: string } {
  const n = (s: Status): number => lines.filter((l) => l.status === s).length
  const [pass, warn, fail] = [n('PASS'), n('WARN'), n('FAIL')]
  return { pass, warn, fail, text: `${pass} PASS, ${warn} WARN, ${fail} FAIL` }
}

// ---------- network ----------

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// One HTTP call with a timeout. A thrown fetch (network, timeout) is thrown on: the caller reports the hole. t0/t1 and the
// Date header are kept for the clock check.
type Http = { status: number; text: string; date: string | null; t0: number; t1: number }
async function http(url: string, init: RequestInit = {}, ms = 15_000): Promise<Http> {
  const t0 = Date.now()
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(ms) })
  const t1 = Date.now()
  return { status: res.status, text: await res.text(), date: res.headers.get('date'), t0, t1 }
}
// Keyless mainnet Koios: 429, 5xx and network errors retried twice (1 s, 2 s), then thrown as a hole.
async function koiosMainnet<T>(path: string, body?: unknown): Promise<T> {
  let last = ''
  for (let attempt = 0, wait = 1_000; attempt < 3; attempt++, wait *= 2) {
    if (attempt) await new Promise((r) => setTimeout(r, wait))
    try {
      const init: RequestInit = body ? { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) } : { headers: { accept: 'application/json' } }
      const r = await http(`${KOIOS.mainnet}${path}`, init, 30_000)
      if (r.status === 200) return JSON.parse(r.text) as T
      last = `HTTP ${r.status}`
      if (r.status !== 429 && r.status < 500) break
    } catch (e: unknown) {
      last = message(e)
    }
  }
  throw new Error(`Koios mainnet ${path.split('?')[0]}: ${last} (a hole, not an answer)`)
}

// ---------- the checks ----------

type Ctx = { agent: string; forced: string | null; buyer: Party | null; seller: Party | null; take: string | null }
type Escrow = { ref: string; d: Datum; value: Value }

async function keys(c: Ctx): Promise<Line> {
  const check = 'keys'
  const problems: string[] = []
  const said: string[] = []
  for (const role of ['buyer', 'seller'] as const) {
    try {
      const p = await party(role)
      c[role] = p
      said.push(`${role} ${shortAddr(p.address)}`)
    } catch (e: unknown) {
      problems.push(message(e))
    }
  }
  const bf = !!process.env.BLOCKFROST_PREPROD_PROJECT_ID?.trim()
  if (!bf) problems.push('BLOCKFROST_PREPROD_PROJECT_ID is not set')
  const koios = !!process.env.KOIOS_PREPROD_API_TOKEN?.trim()
  said.push(`Blockfrost preprod project id ${bf ? 'present' : 'absent'}`, `Koios preprod token ${koios ? 'present' : 'absent'}`)
  if (problems.length) return { status: 'FAIL', check, reason: `${problems.join('; ')} (${said.join(', ')})` }
  if (!koios) return { status: 'WARN', check, reason: `${said.join(', ')}: keyless Koios capped us at ~6,300 calls on 6 Oct, set KOIOS_PREPROD_API_TOKEN` }
  return { status: 'PASS', check, reason: said.join(', ') }
}

// The clock reference rides on this call: the skew is read from Koios's Date header, the tip's age from its block_time.
type Tip = { line: Line; skewMs: number | null; serverMs: number | null; tipMs: number | null }
async function koiosTip(): Promise<Tip> {
  const check = 'koios'
  const hole = (reason: string): Tip => ({ line: { status: 'FAIL', check, reason }, skewMs: null, serverMs: null, tipMs: null })
  try {
    const r = await http(`${KOIOS.preprod}/tip`, { headers: koiosHeaders({ accept: 'application/json' }) })
    if (r.status === 429) {
      koiosLimited(429) // the reads below go to Blockfrost alone, said once on stderr
      return hole('HTTP 429: the Koios preprod cap is hit, every read falls back to Blockfrost alone')
    }
    if (r.status !== 200) return hole(`preprod /tip HTTP ${r.status}`)
    let tip: { block_no?: unknown; block_time?: unknown } | undefined
    try {
      tip = (JSON.parse(r.text) as { block_no?: unknown; block_time?: unknown }[])[0]
    } catch {
      tip = undefined // not JSON: the hole below
    }
    if (!tip || !Number.isInteger(tip.block_no)) return hole('preprod /tip answered 200 without a block number')
    const skewMs = dateSkew(r.t0, r.t1, r.date)
    return {
      line: { status: 'PASS', check, reason: `preprod tip at block ${tip.block_no}` },
      skewMs,
      serverMs: skewMs === null ? null : Math.round((r.t0 + r.t1) / 2) - skewMs,
      tipMs: Number.isInteger(tip.block_time) ? (tip.block_time as number) * 1000 : null,
    }
  } catch (e: unknown) {
    return hole(`preprod /tip: ${message(e)}`)
  }
}

async function blockfrostTip(): Promise<{ line: Line; timeMs: number | null }> {
  const check = 'blockfrost'
  try {
    const b = await blockfrostGet<{ height: number; time: number }>('/blocks/latest')
    if (!b) return { line: { status: 'FAIL', check, reason: 'preprod /blocks/latest answered 404' }, timeMs: null }
    return { line: { status: 'PASS', check, reason: `preprod latest block ${b.height}` }, timeMs: b.time * 1000 }
  } catch (e: unknown) {
    return { line: { status: 'FAIL', check, reason: message(e) }, timeMs: null }
  }
}

// Two separate questions: is this machine's clock right (against Koios's Date header), and is preprod's tip moving (the
// newer of the two providers' tip blocks, aged by the server's clock, so a wrong local clock cannot hide a stall).
function clock(k: Tip, bfTipMs: number | null): Line {
  const check = 'clock'
  const tipMs = Math.max(k.tipMs ?? 0, bfTipMs ?? 0) || null
  if (k.skewMs === null || k.serverMs === null) {
    const age = tipMs === null ? null : Date.now() - tipMs
    return { status: 'WARN', check, reason: `no Date header from Koios to set the local clock against (see koios)${age === null ? '' : `; the tip block is ${Math.round(age / 1000)} s old by the local clock`}` }
  }
  const skew = clockStatus(k.skewMs)
  const said = [`local clock ${k.skewMs >= 0 ? '+' : ''}${(k.skewMs / 1000).toFixed(1)} s from Koios's Date header${skew === 'PASS' ? '' : ': validity windows are ± 150 s, set the system clock'}`]
  let tip: Status = 'FAIL'
  if (tipMs === null) said.push('no tip block time from either provider')
  else {
    const age = k.serverMs - tipMs
    tip = tipStatus(age)
    said.push(`the tip block is ${Math.round(age / 1000)} s old${tip === 'PASS' ? '' : ': preprod or the providers look stalled'}`)
  }
  return { status: worst(skew, tip), check, reason: said.join('; ') }
}

async function wallets(c: Ctx): Promise<Line> {
  const check = 'wallets'
  if (!c.buyer || !c.seller) return { status: 'FAIL', check, reason: 'the keys did not load (see keys)' }
  const [b, s] = await Promise.all([liveUtxos(c.buyer.address), liveUtxos(c.seller.address)])
  const big = (us: typeof b): typeof b => pureAda(us).filter((u) => lovelace(u) >= 5n * TADA)
  const total = b.reduce((n, u) => n + lovelace(u), 0n)
  const reserved = reservedUtxos()
  const buyerReady = big(b).length
  const sellerReady = big(s).filter((u) => !reserved.has(refOf(u))).length
  const reason = `buyer ${tada(total)} with ${buyerReady} pure-ADA UTxO(s) ≥ 5 tADA; seller ${sellerReady} pure-ADA UTxO(s) ≥ 5 tADA not reserved by a prepared proposal (${reserved.size} reserved)`
  const ok = total >= 50n * TADA && buyerReady >= 2 && sellerReady >= 2
  return { status: ok ? 'PASS' : 'FAIL', check, reason: ok ? reason : `${reason}; needed: buyer ≥ 50 tADA and 2, seller 2 (D13: leg 1 and leg 2 never share one)` }
}

async function takeEscrows(c: Ctx): Promise<Line> {
  const check = 'take escrows'
  if (!c.buyer || !c.seller) return { status: 'FAIL', check, reason: 'the keys did not load (see keys)' }
  const bank = (JSON.parse(readFileSync(join(ROOT, 'fixtures', 'preprod', 'bank.json'), 'utf8')) as { ref: string }[]).map((e) => e.ref)
  const refs = c.forced ? [c.forced, ...bank.filter((r) => r !== c.forced)] : bank
  // Spentness for all of them in one call, then each live one read at the script with its datum.
  const info = await utxoInfo(refs)
  const live = refs.filter((r) => { const i = info.get(r); return !!i && !i.spent && i.address === V1_ADDRESS.preprod })
  const read: Escrow[] = await Promise.all(live.map(async (ref) => {
    const u = await escrowAt(ref)
    return { ref, d: readDatum(u.output.plutusData as string), value: Object.fromEntries(u.output.amount.map((a) => [a.unit, a.quantity])) }
  }))
  const local = new Set([c.buyer.pkh, c.seller.pkh])
  const disputed = read.filter((e) => (local.has(e.d.buyer.payment.hash) || local.has(e.d.seller.payment.hash)) && e.d.state === 'Disputed')
  const pots = disputed.filter((e) => isScriptPot(e.value))
  const others = disputed.filter((e) => !isScriptPot(e.value))
  // The take settles from this machine: prepare() needs the local seller key, the buyer's leg-2 signature the local buyer.
  const settles = (e: Escrow): boolean => e.d.buyer.payment.hash === c.buyer!.pkh && e.d.seller.payment.hash === c.seller!.pkh
  const take = c.forced ? disputed.find((e) => e.ref === c.forced) : pots.find(settles)
  // try anyway is the buyer's WithdrawRefund (controls.ts tryAnyway): the spare needs the local buyer key.
  const spare = disputed.filter((e) => e.ref !== take?.ref && e.d.buyer.payment.hash === c.buyer!.pkh)
  const list = (es: Escrow[]): string => (es.length ? es.map((e) => shortRef(e.ref)).join(', ') : 'none')
  const reason = `${refs.length - live.length} of ${refs.length} spent or gone; ours and Disputed: script pot ${list(pots)}; others ${list(others)}`
  if (c.forced && !take) {
    const f = read.find((e) => e.ref === c.forced)
    return { status: 'FAIL', check, reason: `--escrow ${shortRef(c.forced)} is ${f ? `${f.d.state}${local.has(f.d.buyer.payment.hash) || local.has(f.d.seller.payment.hash) ? '' : ', not ours'}` : 'spent or not at the script'}; ${reason}` }
  }
  if (!take) return { status: 'FAIL', check, reason: `no live Disputed script-pot escrow (20 tADA + 10 tUSDM) with this machine's buyer and seller; ${reason}` }
  c.take = take.ref
  if (!settles(take)) return { status: 'FAIL', check, reason: `take ${shortRef(take.ref)}: this machine's keys are not both its buyer and its seller, so it cannot be settled from here; ${reason}` }
  if (!spare.length) return { status: 'FAIL', check, reason: `take ${shortRef(take.ref)}, but no second Disputed escrow with the local buyer for try anyway (the settle spends the take); ${reason}` }
  const status: Status = isScriptPot(take.value) ? 'PASS' : 'WARN'
  return { status, check, reason: `take ${shortRef(take.ref)}${status === 'WARN' ? ' (forced, not a 20 tADA + 10 tUSDM pot)' : ''}, try anyway ${shortRef(spare[0].ref)}; ${reason}` }
}

async function engine(c: Ctx): Promise<Line> {
  const check = 'engine'
  if (!c.take) return { status: 'FAIL', check, reason: 'no take escrow (see take escrows)' }
  const u = await escrowAt(c.take)
  const d = readDatum(u.output.plutusData as string)
  const grid = reach(d, Object.fromEntries(u.output.amount.map((a) => [a.unit, a.quantity])), Date.now(), PARAMS, c.take)
  const cell = (r: string, role: string) => grid.verdicts.find((v) => v.redeemer === r && v.role === role)
  const concede = cell('AuthorizeRefund', 'seller')
  const tryIt = cell('WithdrawRefund', 'buyer')
  const ok = !!concede?.allowed && !!tryIt && !tryIt.allowed
  return {
    status: ok ? 'PASS' : 'FAIL', check,
    reason: `on ${shortRef(c.take)} (${d.state}): seller AuthorizeRefund ${concede?.allowed ? 'allowed' : `refused (${concede?.failed.join('; ')})`}, buyer WithdrawRefund ${tryIt?.allowed ? 'ALLOWED: try anyway would not be refused' : `refused (${tryIt?.failed.join('; ')})`}`,
  }
}

function inFlight(c: Ctx): Line {
  const check = 'in flight'
  if (!c.take) return { status: 'FAIL', check, reason: 'no take escrow (see take escrows)' }
  const slug = c.take.replace('#', '_')
  const pending = join(ROOT, 'out', 'seller', `${slug}.pending.json`)
  const lockFile = join(ROOT, 'out', 'seller', `${slug}.lock`)
  if (existsSync(pending)) return { status: 'FAIL', check, reason: `a concession of ${shortRef(c.take)} is in flight (out/seller/${slug}.pending.json): pnpm sign --resend ${c.take} first` }
  if (existsSync(lockFile)) {
    let owner: Parameters<typeof isStale>[0] = null
    try {
      owner = JSON.parse(readFileSync(lockFile, 'utf8')) as Parameters<typeof isStale>[0]
    } catch {
      owner = null // unreadable: no owner to wait for, as settle.ts reads it
    }
    if (isStale(owner)) return { status: 'WARN', check, reason: `a stale lock on ${shortRef(c.take)} (its process is gone or silent > 2 min): the next prepare takes it over` }
    return { status: 'FAIL', check, reason: `a settlement of ${shortRef(c.take)} is running now (process ${owner?.pid} on ${owner?.host}): wait for it to finish` }
  }
  return { status: 'PASS', check, reason: `no pending concession and no lock for ${shortRef(c.take)}` }
}

async function agent(c: Ctx): Promise<Line> {
  const check = 'agent'
  try {
    const a = await http(`${c.agent}/availability`, {}, 5_000)
    if (a.status !== 200) return { status: 'WARN', check, reason: `${c.agent}/availability HTTP ${a.status}: start it with pnpm agent` }
    if (!isAvailable(a.text)) return { status: 'WARN', check, reason: `${c.agent}/availability answers 200, but not as a MIP-003 agent (status available, type masumi-agent): another server holds the port` }
    const b = await http(`${c.agent}/api/bank`, {}, 30_000)
    if (b.status !== 200) return { status: 'WARN', check, reason: `up, but /api/bank HTTP ${b.status}` }
    const rows = bankRows(b.text)
    if (!rows) return { status: 'WARN', check, reason: 'up, but /api/bank answered an unexpected shape (no bank array)' }
    const row = c.take ? rows.find((r) => r.ref === c.take) : undefined
    if (!c.take) return { status: 'WARN', check, reason: `up, its bank lists ${rows.length} escrow(s), no take escrow to look for` }
    if (!row) return { status: 'WARN', check, reason: `up, but its bank (${rows.length} escrow(s)) does not list the take ${shortRef(c.take)}` }
    return { status: 'PASS', check, reason: `up at ${c.agent}, its bank lists the take ${shortRef(c.take)} (${row.state})` }
  } catch (e: unknown) {
    return { status: 'WARN', check, reason: `${c.agent} is down (${message(e)}): start it with pnpm agent` }
  }
}

// The URL Sokosumi calls is the registration's api_base_url. It must answer as a MIP-003 agent, and, for the hire to land
// on the take, it must be this machine's agent: its /api/bank (which follows the local keys) must list the take escrow.
async function registered(c: Ctx): Promise<Line> {
  const check = 'registered endpoint'
  const id = process.env.AGENT_IDENTIFIER?.trim() || REGISTRATION
  if (!/^[0-9a-f]{58,}$/i.test(id)) return { status: 'FAIL', check, reason: 'AGENT_IDENTIFIER is not a policy id followed by an asset name (hex)' }
  const [policy, name] = [id.slice(0, 56).toLowerCase(), id.slice(56).toLowerCase()]
  let r: { status: number; text: string }
  try {
    r = await http(`${KOIOS.preprod}/asset_info`, { method: 'POST', headers: koiosHeaders({ 'content-type': 'application/json', accept: 'application/json' }), body: JSON.stringify({ _asset_list: [[policy, name]] }) })
  } catch (e: unknown) {
    return { status: 'FAIL', check, reason: `Koios preprod asset_info: ${message(e)}: the registration cannot be read` }
  }
  if (r.status !== 200) return { status: 'FAIL', check, reason: `Koios preprod asset_info HTTP ${r.status}: the registration cannot be read` }
  const row = (JSON.parse(r.text) as { minting_tx_metadata: Record<string, unknown> | null; total_supply: string }[])[0]
  if (!row) return { status: 'FAIL', check, reason: `no registry asset ${policy.slice(0, 8)}…${name.slice(-8)} on preprod` }
  if (row.total_supply === '0') return { status: 'FAIL', check, reason: `the registration ${policy.slice(0, 8)}…${name.slice(-8)} is burnt (deregistered)` }
  const url = apiBaseUrl(row.minting_tx_metadata, policy, name)?.replace(/\/+$/, '')
  if (!url) return { status: 'FAIL', check, reason: 'the registration has no api_base_url under its 721 entry' }
  const dead = 'the URL Sokosumi would call is dead: restart the tunnel and update the registration'
  let a: Http
  try {
    a = await http(`${url}/availability`, {}, 10_000)
  } catch (e: unknown) {
    return { status: 'FAIL', check, reason: `${url}/availability: ${message(e)}: ${dead}` }
  }
  if (a.status !== 200) return { status: 'FAIL', check, reason: `${url}/availability HTTP ${a.status}: ${dead}` }
  if (!isAvailable(a.text)) return { status: 'FAIL', check, reason: `${url}/availability answers 200, but not as a MIP-003 agent (status available, type masumi-agent): ${dead}` }
  if (!c.take) return { status: 'WARN', check, reason: `${url} answers as a MIP-003 agent; no take escrow to tell whether it is this machine's agent (see take escrows)` }
  let rows: { ref: string; state: string }[] | null
  try {
    const b = await http(`${url}/api/bank`, {}, 30_000)
    rows = b.status === 200 ? bankRows(b.text) : null
  } catch {
    rows = null // unknown: the line below says so
  }
  if (!rows) return { status: 'WARN', check, reason: `${url} answers as a MIP-003 agent, but its /api/bank cannot be read: it may not be this machine's agent` }
  if (!rows.some((r) => r.ref === c.take)) return { status: 'WARN', check, reason: `${url} answers as a MIP-003 agent, but its bank (${rows.length} escrow(s)) does not list the take ${shortRef(c.take)}: it is another machine's agent, and a Sokosumi hire would land there` }
  return { status: 'PASS', check, reason: `${url} answers as a MIP-003 agent and its bank lists the take ${shortRef(c.take)}: a Sokosumi hire lands on this machine` }
}

// Koios offsets are only stable with an explicit order, so the pages are ordered by (tx_hash, tx_index).
async function census(): Promise<Line> {
  const check = 'census'
  try {
    const tip = (await koiosMainnet<{ block_no: number }[]>('/tip'))[0]
    const rows: { inline_datum: { bytes: string } | null }[] = []
    for (let offset = 0; ; offset += 1000) {
      const page = await koiosMainnet<{ inline_datum: { bytes: string } | null }[]>(`/credential_utxos?order=tx_hash.asc,tx_index.asc&offset=${offset}&limit=1000`, { _payment_credentials: [SCRIPT_HASH], _extended: true })
      rows.push(...page)
      if (page.length < 1000) break
    }
    const { byState, undecodable } = countStates(rows)
    const now = `${byState.Disputed} Disputed and ${byState.RefundRequested} RefundRequested of ${rows.length} V1 UTxOs (${undecodable} undecodable) at mainnet block ${tip?.block_no}`
    if (byState.Disputed === VIDEO.disputed && byState.RefundRequested === VIDEO.refundRequested) return { status: 'PASS', check, reason: now }
    return { status: 'WARN', check, reason: `${now}, not ${VIDEO.disputed} and ${VIDEO.refundRequested}: the video's numbers must change` }
  } catch (e: unknown) {
    return { status: 'FAIL', check, reason: message(e) }
  }
}

async function sokosumi(): Promise<Line> {
  const check = 'sokosumi vendors'
  try {
    const r = await http(SOKOSUMI_VENDORS, { headers: { accept: 'text/html' } }, 20_000)
    if (r.status !== 200) return { status: 'FAIL', check, reason: `${SOKOSUMI_VENDORS} HTTP ${r.status}: the page cannot be read` }
    const n = vendorCounts(r.text)
    if (!n) return { status: 'FAIL', check, reason: `${SOKOSUMI_VENDORS} read, but no '<n> Vendors <n> AI Coworkers <n> marketplace agents' on it: the page cannot be read as before` }
    const now = `${n.vendors} vendors, ${n.coworkers} AI coworkers, ${n.agents} marketplace agents`
    if (n.vendors === VIDEO.vendors && n.coworkers === VIDEO.coworkers && n.agents === VIDEO.agents) return { status: 'PASS', check, reason: now }
    return { status: 'WARN', check, reason: `${now}, not ${VIDEO.vendors}, ${VIDEO.coworkers}, ${VIDEO.agents}: the video's numbers must change` }
  } catch (e: unknown) {
    return { status: 'FAIL', check, reason: `${SOKOSUMI_VENDORS}: ${message(e)}: the page cannot be read` }
  }
}

async function dormancy(): Promise<Line> {
  const check = 'dormancy'
  try {
    const d = await checkDormancy()
    if (d.status === 'acted') return { status: 'FAIL', check, reason: `the arbiter acted (WithdrawDisputed ${d.acted.map((a) => `${a.txHash.slice(0, 10)}… block ${a.height}`).join(', ')}): the pitch's dormancy lines are withdrawn` }
    if (d.status === 'silent') return { status: 'PASS', check, reason: `verified through block ${d.through.height} on ${d.providers.join(' + ')}` }
    return { status: 'WARN', check, reason: `unverified (${d.holes} hole(s)${d.diff.length ? `, ${d.diff.length} provider diff(s)` : ''}): silent through the pin, block ${d.through.height}, only` }
  } catch (e: unknown) {
    return { status: 'WARN', check, reason: `unverified: ${message(e)}` }
  }
}

// ---------- the run ----------

const failed = (check: string) => (e: unknown): Line => ({ status: 'FAIL', check, reason: message(e) })

export async function preflight(o: { agent: string; forced: string | null; skipMainnet: boolean }, print: (l: Line) => void): Promise<Line[]> {
  loadEnv()
  const c: Ctx = { agent: o.agent.replace(/\/+$/, ''), forced: o.forced, buyer: null, seller: null, take: null }
  // The three mainnet reads share nothing with the rest: started now, printed in their place at the end.
  const mainnet = o.skipMainnet ? null : [census(), sokosumi(), dormancy()]
  const lines: Line[] = []
  const say = (l: Line): void => {
    lines.push(l)
    print(l)
  }
  say(await keys(c).catch(failed('keys')))
  const k = await koiosTip()
  say(k.line)
  const bf = await blockfrostTip()
  say(bf.line)
  say(clock(k, bf.timeMs))
  say(await wallets(c).catch(failed('wallets')))
  say(await takeEscrows(c).catch(failed('take escrows')))
  say(await engine(c).catch(failed('engine')))
  say(inFlight(c))
  say(await agent(c))
  say(await registered(c))
  say({ status: 'INFO', check: 'sokosumi listing', reason: 'cannot be checked without an account: check by eye that Brume is listed' })
  if (mainnet) for (const l of await Promise.all(mainnet)) say(l)
  else say({ status: 'INFO', check: 'mainnet', reason: '--skip-mainnet: census, Sokosumi vendors and dormancy not read' })
  return lines
}

if (process.argv[1]?.endsWith('preflight.ts')) {
  const { values } = parseArgs({ options: { agent: { type: 'string', default: 'http://127.0.0.1:8787' }, escrow: { type: 'string' }, 'skip-mainnet': { type: 'boolean', default: false } } })
  if (values.escrow && !/^[0-9a-f]{64}#\d+$/.test(values.escrow)) throw new Error('--escrow <txHash>#<index>')
  const t0 = Date.now()
  const lines = await preflight({ agent: values.agent, forced: values.escrow ?? null, skipMainnet: values['skip-mainnet'] }, (l) => console.log(scrub(format(l))))
  const t = tally(lines)
  console.log(`\n${t.text} (${Math.round((Date.now() - t0) / 1000)} s)`)
  process.exitCode = t.fail ? 1 : 0
}
