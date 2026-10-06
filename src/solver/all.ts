// S-5: the solver over every Disputed V1 escrow on mainnet, pinned to a tip. Keyless and read-only (Koios). For each:
// the band per horizon on path B (the product's path) and path A, and the engine's cross-check that the band is
// executable: the seller can concede now, and after the concession only the buyer can move the value (C11).
// Per unit of each escrow's value; never a dollar figure, and no sum across escrows is computed.
// D9 + S-4: the arbiter's dormancy is checked live at the census tip, its full receipt goes into the fixture, and so does
// the path-B break-even curve, which is the same for every escrow (ADA binds on each, one arbiter, one T).
// Writes a new fixtures/solver-61-<tip>.json and never overwrites an existing one.
//   node src/solver/all.ts
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Datum, Value } from '../../shared/types.ts'
import { KOIOS, PARAMS, SCRIPT_HASH } from '../../shared/constants.ts'
import { reach } from '../engine/reach.ts'
import { readDatum } from '../preprod/datum.ts'
import { checkDormancyReceipt, spendsByRedeemer } from './dormancy.ts'
import { solve, solverInputFor } from './solve.ts'

const env = join(import.meta.dirname, '..', '..', '.env')
if (existsSync(env)) process.loadEnvFile(env) // BLOCKFROST_MAINNET_PROJECT_ID, for the second dormancy method; never printed

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
// The dormancy walk is bounded by the same first tip, so T is the silence through the census block.
const receipt = await checkDormancyReceipt({ tip: { height: before.block_height, hash: before.hash, timeMs: at } })
const dormancy = receipt.dormancy

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
  const B = solve(solverInputFor(ref, d, v, at, null, dormancy), 'B'), A = solve(solverInputFor(ref, d, v, at, null, dormancy), 'A')
  return {
    ref,
    curveB: B.wait.curve,
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
// The path-B curve does not depend on the escrow (every one holds lovelace, π = 1, so ADA binds): checked, not assumed.
if (!disputed[0]) throw new Error('no Disputed V1 escrow at this tip: nothing to price')
const wait = solve(solverInputFor('path B, any escrow holding lovelace', disputed[0].d, { lovelace: '1' }, at, null, dormancy), 'B').wait
const curveSame = results.filter((r) => JSON.stringify(r.curveB) === JSON.stringify(wait.curve)).length
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
  // D9: the receipt T rests on, with what each provider read since the pin.
  dormancy: {
    ...dormancy,
    checkedAt: new Date(receipt.checkedAtMs).toISOString(),
    walks: receipt.walks.map((x) => ({ provider: x.provider, tip: x.tip, txs: x.txs, spendsByRedeemer: spendsByRedeemer(x.spends), holes: x.holes, controls: x.controls, errors: x.errors, spends: x.spends })),
    skipped: receipt.skipped,
  },
  // S-4: break-evens only (deadline bands are 'for a buyer who would wait at most H days'); no value of waiting is computed.
  waitB: { silentDays: wait.silentDays, rateBoundPerYear: wait.rateBoundPerYear, meanGapDaysAtLeast: wait.meanGapDaysAtLeast, sameForAll: curveSame, curve: wait.curve },
  escrows: results.map(({ curveB, ...r }) => r),
}
mkdirSync(join(import.meta.dirname, '..', '..', 'fixtures'), { recursive: true })
const file = join(import.meta.dirname, '..', '..', 'fixtures', `solver-61-${before.block_height}.json`)
if (existsSync(file)) throw new Error(`${file} exists: a pinned fixture is never overwritten; re-run at a later tip`)
writeFileSync(file, JSON.stringify(summary, null, 2) + '\n')
for (const a of dormancy.acted) console.log(`ALERT: the arbiter acted at ${a.txHash} (${a.height}${a.validContract ? '' : ', phase-2-failed attempt'}): C3 and every dormancy sentence are withdrawn`)
console.log(JSON.stringify({ ...summary, dormancy: { ...summary.dormancy, walks: summary.dormancy.walks.map(({ spends, ...x }) => ({ ...x, spends: spends.length })) }, escrows: `${results.length} rows in ${file}` }, null, 2))
