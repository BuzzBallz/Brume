// S-5: the solver over every Disputed V1 escrow on mainnet, pinned to a tip. Keyless and read-only (Koios). For each:
// the band per horizon on path B (the product's path) and path A, and the engine's cross-check that the band is
// executable: the seller can concede now, and after the concession only the buyer can move the value (C11).
// Per unit of each escrow's value; never a dollar figure, and no sum across escrows is computed.
//   node src/solver/all.ts
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Datum, Value } from '../../shared/types.ts'
import { KOIOS, PARAMS, SCRIPT_HASH } from '../../shared/constants.ts'
import { reach } from '../engine/reach.ts'
import { readDatum } from '../preprod/datum.ts'
import { solve, solverInputFor } from './solve.ts'

type Row = { tx_hash: string; tx_index: number; value: string; inline_datum: { bytes: string } | null; asset_list: { policy_id: string; asset_name: string; quantity: string }[] | null }
type Tip = { block_height: number; hash: string; abs_slot: number; block_time: number }

async function koios<T>(path: string, body?: unknown): Promise<T> {
  for (let attempt = 0, wait = 1_000; ; attempt++, wait *= 2) {
    const res = await fetch(`${KOIOS.mainnet}${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) } : { signal: AbortSignal.timeout(30_000) }).catch(() => null)
    if (res?.ok) return (await res.json()) as T
    if (attempt >= 4) throw new Error(`Koios mainnet ${path}: ${res ? `HTTP ${res.status}` : 'no answer'} (a hole, not an answer)`)
    await new Promise((r) => setTimeout(r, wait))
  }
}

const before = (await koios<Tip[]>('/tip'))[0]
const rows: Row[] = []
for (let offset = 0; ; offset += 500) {
  const page = await koios<Row[]>(`/credential_utxos?offset=${offset}&limit=500`, { _payment_credentials: [SCRIPT_HASH], _extended: true })
  rows.push(...page)
  if (page.length < 500) break
}
const after = (await koios<Tip[]>('/tip'))[0]
const at = before.block_time * 1000 // the solver and the engine are evaluated at the first tip's time

let undecodable = 0
const disputed: { ref: string; d: Datum; v: Value }[] = []
for (const r of rows) {
  if (!r.inline_datum) { undecodable++; continue }
  let d: Datum
  try { d = readDatum(r.inline_datum.bytes) } catch { undecodable++; continue }
  if (d.state !== 'Disputed') continue
  const v: Value = { lovelace: r.value }
  for (const a of r.asset_list ?? []) v[a.policy_id + a.asset_name] = a.quantity
  disputed.push({ ref: `${r.tx_hash}#${r.tx_index}`, d, v })
}

const results = disputed.map(({ ref, d, v }) => {
  const now = reach(d, v, at, PARAMS, ref)
  const conceded = reach({ ...d, state: 'RefundRequested', resultHash: '', sellerCooldownTime: at + 3_600_000, buyerCooldownTime: 0 }, v, at, PARAMS, ref)
  const can = (g: typeof now, r: string, role: string): boolean => !!g.verdicts.find((x) => x.redeemer === r && x.role === role)?.allowed
  const B = solve(solverInputFor(ref, d, v, at), 'B'), A = solve(solverInputFor(ref, d, v, at), 'A')
  return {
    ref,
    units: Object.keys(v).length,
    bandB: B.bands.map((b) => ({ h: b.horizonDays, max: Number(b.sellerShareMax.toFixed(4)), feasible: b.feasible })),
    bandA: A.bands.map((b) => ({ h: b.horizonDays, max: Number(b.sellerShareMax.toFixed(4)), feasible: b.feasible })),
    pathATopUp: A.pathA.topUp,
    engine: {
      sellerCanConcedeNow: can(now, 'AuthorizeRefund', 'seller'),
      afterConcession: {
        buyerCanExit: can(conceded, 'WithdrawRefund', 'buyer'),
        adminCanArbitrate: can(conceded, 'WithdrawDisputed', 'admin'),
        sellerCanAnything: conceded.verdicts.some((x) => x.role === 'seller' && x.allowed),
      },
    },
  }
})

const max30B = results.map((r) => r.bandB.find((b) => b.h === 30)?.max ?? NaN)
const summary = {
  label: 'Solver over every Disputed V1 escrow on mainnet, read-only. Per unit of each escrow; no dollar figure, no sum across escrows.',
  tip: { before: { height: before.block_height, hash: before.hash, slot: before.abs_slot, time: new Date(before.block_time * 1000).toISOString() }, after: { height: after.block_height, hash: after.hash } },
  evaluatedAt: new Date(at).toISOString(),
  openUtxos: rows.length, undecodable, disputed: results.length,
  checks: {
    pathBFeasibleAllHorizons: results.filter((r) => r.bandB.every((b) => b.feasible)).length,
    pathAFeasibleAtH30: results.filter((r) => r.bandA.find((b) => b.h === 30)?.feasible).length,
    pathANeedsTopUp: results.filter((r) => Object.keys(r.pathATopUp).length > 0).length,
    sellerCanConcedeNow: results.filter((r) => r.engine.sellerCanConcedeNow).length,
    afterConcessionBuyerCanExit: results.filter((r) => r.engine.afterConcession.buyerCanExit).length,
    afterConcessionAdminCanArbitrate: results.filter((r) => r.engine.afterConcession.adminCanArbitrate).length,
    afterConcessionSellerCanAnything: results.filter((r) => r.engine.afterConcession.sellerCanAnything).length,
  },
  pathBSellerShareMaxAtH30: { min: Math.min(...max30B), max: Math.max(...max30B) },
  escrows: results,
}
mkdirSync(join(import.meta.dirname, '..', '..', 'fixtures'), { recursive: true })
const file = join(import.meta.dirname, '..', '..', 'fixtures', `solver-61-${before.block_height}.json`)
writeFileSync(file, JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify({ ...summary, escrows: `${results.length} rows in ${file}` }, null, 2))
