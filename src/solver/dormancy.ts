// D9: the arbiter's dormancy, verified live since a pinned block and never extrapolated to the wall clock. Read-only.
// The pin rests on K30's two-provider lifetime walk (17,000 newest V1 redeemers, zero WithdrawDisputed, 5 Oct) and the
// kickoff read at block 14031823 (fixtures/kickoff-2026-10-06.md §D, its positive control fired). The live check walks
// every V1 script spend after the pin: Koios keyless by payment credential, and Blockfrost by script hash as an
// independent second method when BLOCKFROST_MAINNET_PROJECT_ID is set (the key goes in a header, never in a URL or a log).
// Silence is claimed through the tip read BEFORE the walk, and only when every provider walked has 0 holes, both of its
// positive controls fired in the same run and the providers agree; otherwise T stays at the pin. A WithdrawDisputed since
// the pin ends the zero-event premise, a phase-2-failed attempt included (it still shows the admin set alive): 'acted'.
import type { Dormancy, Provider, Tip } from '../../shared/types.ts'
import { REDEEMER } from '../../shared/types.ts'
import { ARBITER_LAST_ACTION_MS, BLOCKFROST, KOIOS, SCRIPT_HASH } from '../../shared/constants.ts'
import * as blockfrost from '../read/blockfrost.ts'
import { request } from '../read/http.ts'
import * as koios from '../read/koios.ts'

export const PIN = { height: 14031823, hash: 'c0b028db36a5ff6e40a3f84cd76299ff5e703712f9480b79c661d5a5f7ff1cdc', timeMs: Date.parse('2026-10-06T04:48:28Z') } as const
// The last WithdrawDisputed on record (C3): every run must still decode and list it, or "zero 4s" means nothing (SPEC §3.6).
export const CONTROL_TX = '20fa8df4d36aba0a65718294ce2b7564ab693bbd4a755a3fd851041c11901ab8'
export const CONTROL_HEIGHT = 12704767
// The newest V1 spend before the pin (a Withdraw, block 14029685, 2026-10-05T16:17:46Z, read on Koios 6 Oct): Blockfrost's
// newest-first walk must reach exactly this row when it crosses the pin, which proves the window was read to its lower edge.
export const BOUNDARY_TX = '0741fbd02e3482e9b5d69f24d5a00b0787cdcf32dcd59b14769bb02520a9de13'
export const BOUNDARY_HEIGHT = 14029685
const WITHDRAW_DISPUTED = REDEEMER.indexOf('WithdrawDisputed')
const CACHE_MS = 10 * 60_000

// One V1 redeemer seen in a walk. A tx spending several escrows gives several.
export type Spend = { txHash: string; height: number; timeMs: number; redeemer: number; validContract: boolean }
// What one provider saw in (PIN.height, tip.height]. tip null: the tip read failed, so nothing can be claimed.
export type Walk = { provider: Provider; tip: Tip | null; txs: number; spends: Spend[]; holes: number; controls: { decode: boolean; listing: boolean }; errors: string[] }
export type Receipt = { checkedAtMs: number; dormancy: Dormancy; walks: Walk[]; skipped: string[] }
// tip: walk only through this block (all.ts passes the census tip). blockfrost: force the second method on or off.
export type Opts = { koiosBase?: string; blockfrostBase?: string; backoffMs?: number; tip?: Tip; blockfrost?: boolean }

// The offline value: silent through the pin, as walked by K30 and the kickoff read; no live provider, no live hole.
export const pinnedDormancy = (): Dormancy => ({
  lastActionMs: ARBITER_LAST_ACTION_MS, pin: { ...PIN }, through: { ...PIN }, method: 'pin', status: 'silent', providers: [], holes: 0, acted: [], diff: [],
})

export const spendsByRedeemer = (spends: Spend[]): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const s of spends) out[REDEEMER[s.redeemer] ?? String(s.redeemer)] = (out[REDEEMER[s.redeemer] ?? String(s.redeemer)] ?? 0) + 1
  return out
}

// Pure: the walks → the receipt. Any WithdrawDisputed → 'acted', T restarts at the newest one (valid or not: conservative)
// and runs to the live tip. Otherwise any hole, failed control or provider diff → 'unverified', through = the pin and
// method 'pin': a receipt says 'live' only when T rests on the live walk.
export function classify(walks: Walk[], lastActionMs: number = ARBITER_LAST_ACTION_MS): Dormancy {
  const tips = walks.map((w) => w.tip).filter((t): t is Tip => t !== null)
  const low = tips.length ? tips.reduce((a, b) => (b.height < a.height ? b : a)) : null
  const high = tips.length ? tips.reduce((a, b) => (b.height > a.height ? b : a)) : null
  // Providers are compared on the blocks they all read: (pin, lowest tip].
  const diff: string[] = []
  if (low && walks.length > 1) {
    const sets = walks.map((w) => new Set(w.spends.filter((s) => s.height > PIN.height && s.height <= low.height).map((s) => s.txHash)))
    walks.forEach((w, i) => {
      for (const h of sets[i]) if (sets.some((o, j) => j !== i && !o.has(h))) diff.push(`${h} (${w.provider} only)`)
    })
  }
  const acted = new Map<string, Dormancy['acted'][number]>()
  for (const s of walks.flatMap((w) => w.spends)) {
    if (s.redeemer !== WITHDRAW_DISPUTED || s.height <= PIN.height) continue
    const seen = acted.get(s.txHash)
    acted.set(s.txHash, { txHash: s.txHash, height: s.height, timeMs: s.timeMs, validContract: (seen?.validContract ?? true) && s.validContract })
  }
  const holes = walks.reduce((n, w) => n + w.holes, 0)
  const complete = walks.filter((w) => w.tip && w.holes === 0 && w.controls.decode && w.controls.listing)
  const base = { pin: { ...PIN }, method: 'live' as const, providers: complete.map((w) => w.provider), holes, diff }
  if (acted.size && high) {
    const list = [...acted.values()].sort((a, b) => b.height - a.height)
    return { ...base, lastActionMs: Math.max(lastActionMs, ...list.map((a) => a.timeMs)), through: { ...high }, status: 'acted', acted: list }
  }
  const clean = low !== null && complete.length === walks.length && diff.length === 0
  return { ...base, lastActionMs, through: clean ? { ...low } : { ...PIN }, method: clean ? 'live' : 'pin', status: clean ? 'silent' : 'unverified', acted: [] }
}

const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) })
const emptyWalk = (provider: Provider): Walk => ({ provider, tip: null, txs: 0, spends: [], holes: 0, controls: { decode: false, listing: false }, errors: [] })

type ListRow = { tx_hash: string; block_height: number; block_time: number }
type InfoRow = {
  tx_hash: string
  block_height: number
  tx_timestamp: number
  plutus_contracts: { script_hash: string; valid_contract: boolean; input?: { redeemer?: { purpose?: string; datum?: { value?: { constructor?: unknown } } } } }[] | null
  inputs: { payment_addr?: { cred?: string | null } | null }[] | null
}
const PAGE = 1000
const BATCH = 20

// Koios _after_block_height is INCLUSIVE (verified 6 Oct: from 12704767 the first row is the tx in block 12704767), so the
// walk after the pin asks from PIN.height + 1. Ordered by height then hash: within a block the order is otherwise unstable,
// and offsets must not shift while blocks arrive. null = no answer after retries.
export async function koiosListing(base: string, fromHeight: number, offset: number, limit: number, backoffMs?: number): Promise<ListRow[] | null> {
  const res = await request(`${base}/credential_txs?order=block_height.asc,tx_hash.asc&offset=${offset}&limit=${limit}`, post({ _payment_credentials: [SCRIPT_HASH], _after_block_height: fromHeight }), backoffMs)
  return res?.status === 200 && Array.isArray(res.body) ? (res.body as ListRow[]) : null
}

// The V1 redeemers of these txs. A tx missing from the answer, a V1 entry without a spend purpose or a V1 redeemer's
// constructor (0 to 6), or fewer V1 spend entries than the tx has inputs at the script, is a hole: it could be the 4 we are
// looking for. A lock (no script input) legitimately shows none.
export async function koiosSpends(base: string, hashes: string[], backoffMs?: number): Promise<{ spends: Spend[]; holes: number; errors: string[] }> {
  const out = { spends: [] as Spend[], holes: 0, errors: [] as string[] }
  for (let i = 0; i < hashes.length; i += BATCH) {
    const chunk = hashes.slice(i, i + BATCH)
    const res = await request(`${base}/tx_info`, post({ _tx_hashes: chunk, _inputs: true, _metadata: false, _assets: false, _withdrawals: false, _certs: false, _scripts: true, _bytecode: false }), backoffMs)
    if (res?.status !== 200 || !Array.isArray(res.body)) {
      out.holes += chunk.length
      out.errors.push(`koios tx_info: no answer for ${chunk.length} txs`)
      continue
    }
    const rows = new Map((res.body as InfoRow[]).map((r) => [r.tx_hash, r]))
    for (const h of chunk) {
      const r = rows.get(h)
      if (!r) {
        out.holes++
        out.errors.push(`koios tx_info: ${h} missing`)
        continue
      }
      const atScript = (r.inputs ?? []).filter((i) => i.payment_addr?.cred === SCRIPT_HASH).length
      const v1 = (r.plutus_contracts ?? []).filter((c) => c.script_hash === SCRIPT_HASH)
      if (v1.length < atScript) {
        out.holes++
        out.errors.push(`koios tx_info: ${h} spends ${atScript} script inputs but shows ${v1.length} V1 redeemers`)
      }
      for (const c of v1) {
        const k = c.input?.redeemer?.datum?.value?.constructor
        if (c.input?.redeemer?.purpose !== 'spend' || !Number.isInteger(k) || (k as number) < 0 || (k as number) >= REDEEMER.length) {
          out.holes++
          out.errors.push(`koios tx_info: ${h} has a V1 redeemer that does not decode`)
          continue
        }
        out.spends.push({ txHash: h, height: r.block_height, timeMs: r.tx_timestamp * 1000, redeemer: k as number, validContract: c.valid_contract })
      }
    }
  }
  return out
}

async function walkKoios(o: Opts): Promise<Walk> {
  const base = o.koiosBase ?? KOIOS.mainnet
  const w = emptyWalk('koios')
  const t = o.tip ? { data: o.tip } : await koios.tip('mainnet', { base, backoffMs: o.backoffMs })
  if (!t.data) {
    w.holes++
    w.errors.push('koios tip: no answer')
    return w
  }
  const tip = (w.tip = t.data)
  const seen = new Set<string>()
  for (let offset = 0; ; offset += PAGE) {
    const page = await koiosListing(base, PIN.height + 1, offset, PAGE, o.backoffMs)
    if (!page) {
      w.holes++
      w.errors.push(`koios credential_txs offset ${offset}: no answer`)
      break
    }
    // Rows above the tip read first are outside the claim; rows at or below the pin are outside the window.
    for (const r of page) if (r.block_height > PIN.height && r.block_height <= tip.height) seen.add(r.tx_hash)
    if (page.length < PAGE) break
  }
  w.txs = seen.size
  const s = await koiosSpends(base, [...seen], o.backoffMs)
  w.spends = s.spends
  w.holes += s.holes
  w.errors.push(...s.errors)
  // The controls run the same calls as the walk, on the last arbitration.
  const c = await koiosSpends(base, [CONTROL_TX], o.backoffMs)
  w.holes += c.holes
  w.controls.decode = c.spends.some((x) => x.txHash === CONTROL_TX && x.height === CONTROL_HEIGHT && x.redeemer === WITHDRAW_DISPUTED)
  const l = await koiosListing(base, CONTROL_HEIGHT, 0, 5, o.backoffMs)
  if (!l) w.holes++
  w.controls.listing = !!l?.some((r) => r.tx_hash === CONTROL_TX && r.block_height === CONTROL_HEIGHT)
  return w
}

type BfRedeemer = { tx_hash: string; purpose: string; script_hash?: string; redeemer_data_hash: string }
const bfInit = (): RequestInit => ({ headers: { project_id: process.env.BLOCKFROST_MAINNET_PROJECT_ID ?? '', accept: 'application/json' } })
const BF_PAGE = 100

// Blockfrost, a second method: the script's redeemers newest first, each tx's height from /txs, each constructor resolved
// from its redeemer data (never compared by hash: another CBOR encoding of the same constructor hashes differently).
async function walkBlockfrost(o: Opts): Promise<Walk> {
  const base = o.blockfrostBase ?? BLOCKFROST.mainnet
  const w = emptyWalk('blockfrost')
  const t = await blockfrost.tip('mainnet', { base, backoffMs: o.backoffMs })
  if (!t.data) {
    w.holes++
    w.errors.push('blockfrost tip: no answer')
    return w
  }
  const tip = (w.tip = o.tip && o.tip.height < t.data.height ? o.tip : t.data)
  const txs = new Map<string, Promise<{ height: number; timeMs: number; valid: boolean } | null>>()
  const txOf = (h: string) => {
    if (!txs.has(h)) txs.set(h, request(`${base}/txs/${h}`, bfInit(), o.backoffMs).then((r) => {
      const b = r?.status === 200 ? (r.body as { block_height: number; block_time: number; valid_contract: boolean }) : null
      return b && Number.isInteger(b.block_height) ? { height: b.block_height, timeMs: b.block_time * 1000, valid: b.valid_contract } : null
    }))
    return txs.get(h)!
  }
  const data = new Map<string, Promise<number | null>>()
  const constructorOf = (hash: string) => {
    if (!data.has(hash)) data.set(hash, request(`${base}/scripts/datum/${hash}`, bfInit(), o.backoffMs).then((r) => {
      const k = r?.status === 200 ? (r.body as { json_value?: { constructor?: unknown } }).json_value?.constructor : undefined
      return Number.isInteger(k) ? (k as number) : null
    }))
    return data.get(hash)!
  }
  let reached: { txHash: string; height: number } | null = null
  walk: for (let page = 1; ; page++) {
    const res = await request(`${base}/scripts/${SCRIPT_HASH}/redeemers?order=desc&count=${BF_PAGE}&page=${page}`, bfInit(), o.backoffMs)
    if (res?.status !== 200 || !Array.isArray(res.body)) {
      w.holes++
      w.errors.push(`blockfrost redeemers page ${page}: no answer`)
      break
    }
    const rows = res.body as BfRedeemer[]
    for (const r of rows) {
      const x = await txOf(r.tx_hash)
      if (!x) {
        w.holes++
        w.errors.push(`blockfrost txs: ${r.tx_hash} has no height`)
        continue
      }
      if (x.height <= PIN.height) {
        reached = { txHash: r.tx_hash, height: x.height }
        break walk
      }
      if (x.height > tip.height) continue
      const k = r.purpose === 'spend' ? await constructorOf(r.redeemer_data_hash) : null
      if (k === null || k < 0 || k >= REDEEMER.length) {
        w.holes++
        w.errors.push(`blockfrost: ${r.tx_hash} has a V1 redeemer that does not decode`)
        continue
      }
      w.spends.push({ txHash: r.tx_hash, height: x.height, timeMs: x.timeMs, redeemer: k, validContract: x.valid })
    }
    if (rows.length < BF_PAGE) break
  }
  w.txs = new Set(w.spends.map((s) => s.txHash)).size
  w.controls.listing = reached?.txHash === BOUNDARY_TX && reached.height === BOUNDARY_HEIGHT
  const c = await request(`${base}/txs/${CONTROL_TX}/redeemers`, bfInit(), o.backoffMs)
  const own = c?.status === 200 && Array.isArray(c.body) ? (c.body as BfRedeemer[]).filter((r) => r.script_hash === SCRIPT_HASH && r.purpose === 'spend') : null
  if (!own) w.holes++
  const ks = await Promise.all((own ?? []).map((r) => constructorOf(r.redeemer_data_hash)))
  w.controls.decode = ks.includes(WITHDRAW_DISPUTED) && (await txOf(CONTROL_TX))?.height === CONTROL_HEIGHT
  return w
}

// An unexpected answer shape is a hole on that provider, never a crash and never silence.
const guarded = (provider: Provider, run: Promise<Walk>): Promise<Walk> =>
  run.catch((error: unknown) => ({ ...emptyWalk(provider), holes: 1, errors: [`${provider}: ${error instanceof Error ? error.message : String(error)}`] }))

export async function runCheck(o: Opts = {}): Promise<Receipt> {
  const second = o.blockfrost ?? blockfrost.available('mainnet')
  const walks = await Promise.all([guarded('koios', walkKoios(o)), ...(second ? [guarded('blockfrost', walkBlockfrost(o))] : [])])
  return { checkedAtMs: Date.now(), dormancy: classify(walks), walks, skipped: second ? [] : ['blockfrost: BLOCKFROST_MAINNET_PROJECT_ID is not set, so the claim rests on one provider'] }
}

// Cached for 10 minutes when called with the defaults (the agent may call it per request).
let cached: { atMs: number; receipt: Promise<Receipt> } | null = null
export function checkDormancyReceipt(o: Opts = {}): Promise<Receipt> {
  const plain = Object.keys(o).length === 0
  if (plain && cached && Date.now() - cached.atMs < CACHE_MS) return cached.receipt
  const receipt = runCheck(o)
  if (plain) cached = { atMs: Date.now(), receipt }
  return receipt
}

export const checkDormancy = async (o: Opts = {}): Promise<Dormancy> => (await checkDormancyReceipt(o)).dormancy
