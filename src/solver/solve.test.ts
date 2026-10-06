import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Datum, SolverInput } from '../../shared/types.ts'
import { ARBITER_LAST_ACTION_MS, BUYER_ARB_SHARE, SELLER_ARB_SHARE, TUSDM, USDM } from '../../shared/constants.ts'
import { PIN, pinnedDormancy } from './dormancy.ts'
import { arrivalBy, CURVE_SHARES, solve, solverInputFor, waitPoint, YEAR_DAYS } from './solve.ts'

// The hero mainnet escrow (a7084c50…#0): 4,029,850 lovelace, all of it the collateral floor, plus 2 USDM.
const HERO: SolverInput = {
  ref: 'a7084c50…#0', value: { lovelace: '4029850', [USDM]: '2000000' }, collateralReturnLovelace: 4_029_850, feePermille: 50,
  buyerArbShare: BUYER_ARB_SHARE, sellerArbShare: SELLER_ARB_SHARE, dormancyDays: 313, horizonsDays: [7, 30, 90], frontRunP: null,
}
const close = (a: number, b: number, eps = 1e-6): void => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`)

test('arrival by H against a 95 % upper bound after T = 313 silent days (hand-computed)', () => {
  close(arrivalBy(7, 313), 0.064802, 1e-6)
  close(arrivalBy(30, 313), 0.2495865, 1e-6) // 1 − 20^(−30/313) = 1 − 0.75 · e^0.000551183, by hand
  close(arrivalBy(90, 313), 0.577427, 1e-6)
  close(arrivalBy(313, 313), 0.95, 1e-12) // by construction
})

test('hand-computed case, path B, H = 30: band per asset and the scalar band', () => {
  const b = solve(HERO, 'B').bands.find((x) => x.horizonDays === 30)
  assert.ok(b)
  close(b.perUnit.lovelace.rBuyer, 0.2495865)
  close(b.perUnit.lovelace.sellerShareMax, 0.7504135)
  close(b.perUnit[USDM].rBuyer, 0.736 * 0.2495865)
  close(b.perUnit[USDM].sellerShareMax, 1 - 0.736 * 0.2495865)
  assert.equal(b.perUnit.lovelace.rSeller, 0) // 0 of 120
  assert.equal(b.sellerShareMin, 0)
  close(b.sellerShareMax, 0.7504135) // the intersection: the tighter asset decides
  assert.equal(b.feasible, true)
})

test('even if arbitration arrived for sure, the token keeps a band (26.4 % reached neither party)', () => {
  const sure = solve({ ...HERO, horizonsDays: [1e6] }, 'B').bands[0]
  close(sure.perUnit[USDM].sellerShareMax, 0.264, 1e-6)
  close(sure.perUnit.lovelace.sellerShareMax, 0, 1e-6)
})

test('path A on the hero escrow: the fee comes off every asset, the lovelace floor makes the band infeasible, the seller tops up', () => {
  const out = solve(HERO, 'A')
  assert.deepEqual(out.pathA.fee, { lovelace: '201492', [USDM]: '100000' })
  assert.deepEqual(out.pathA.defectorKeeps, { lovelace: '0', [USDM]: '1900000' })
  assert.deepEqual(out.pathA.topUp, { lovelace: '201492' })
  assert.deepEqual(out.pathA.exposedFloor, { lovelace: '4029850', [USDM]: '0' })
  assert.equal(out.pathA.exposedParty, 'buyer')
  const b = out.bands.find((x) => x.horizonDays === 30)
  assert.ok(b)
  assert.equal(b.feasible, false)
  close(b.perUnit[USDM].sellerShareMax, 1 - 0.05 - 0.736 * 0.2495865)
})

test('path B: no fee, the defecting buyer keeps all of V, the seller has no floor', () => {
  const out = solve(HERO, 'B')
  assert.deepEqual(out.pathB.fee, {})
  assert.deepEqual(out.pathB.defectorKeeps, HERO.value)
  assert.deepEqual(out.pathB.exposedFloor, { lovelace: '0', [USDM]: '0' })
  assert.equal(out.pathB.exposedParty, 'seller')
  assert.equal(out.path, 'B')
})

test('front-run probability: the worst case until it is measured', () => {
  assert.deepEqual(solve(HERO).frontRunP, { used: 1, measured: false })
  assert.deepEqual(solve({ ...HERO, frontRunP: 0.02 }).frontRunP, { used: 0.02, measured: true })
})

test('a token outside the measured table takes the measured token share (preprod tUSDM)', () => {
  const pre = solve({ ...HERO, value: { lovelace: '20000000', [TUSDM]: '10000000' }, collateralReturnLovelace: 2_000_000 }).bands.find((x) => x.horizonDays === 30)
  close(pre?.perUnit[TUSDM].rBuyer ?? -1, 0.736 * 0.2495865)
})

test('scale-free: the band does not move when the pot is multiplied', () => {
  const big = solve({ ...HERO, value: { lovelace: '402985000000', [USDM]: '200000000000' }, collateralReturnLovelace: 402_985_000_000 }, 'B').bands[1]
  const small = solve(HERO, 'B').bands[1]
  close(big.sellerShareMax, small.sellerShareMax, 1e-12)
})

// S-4: break-evens, the exact inverse of the deadline bands. T = 313, λ̄ = ln 20 / 313 per day.
const at = (s: number, path: 'A' | 'B' = 'B') => {
  const p = solve(HERO, path).wait.curve.find((x) => Math.abs(x.sellerShare - s) < 1e-12)
  assert.ok(p, `no curve point at ${s}`)
  return p
}

test('the curve: s = i/20 for i = 1..19 on the output path', () => {
  const c = solve(HERO, 'B').wait.curve
  assert.equal(c.length, 19)
  assert.deepEqual(c.map((p) => p.sellerShare), CURVE_SHARES)
  close(c[0].sellerShare, 0.05, 1e-15)
  close(c[18].sellerShare, 0.95, 1e-15)
})

test('hand checks, path B, ADA binds: deadline and break-even discount at s = 0.25, 0.40, 0.75', () => {
  const q = at(0.25)
  assert.equal(q.feasible, true)
  close(q.deadlineDays ?? NaN, 144.84, 0.005) // ln 4 · 313 / ln 20 = 144.8429
  close(q.breakEvenDiscountAnnual ?? NaN, 2.2068, 1e-4) // expm1(365.25 · λ̄/3) = 220.68 %/yr
  const f = at(0.4)
  close(f.deadlineDays ?? NaN, 95.736, 1e-3) // ln 2.5 · 313 / ln 20 = 95.73586
  const perDay = Math.log1p(f.breakEvenDiscountAnnual ?? NaN) / YEAR_DAYS // continuous δ* = λ̄ (1/0.6 − 1)
  close(perDay, (Math.log(20) / 313) * (2 / 3), 1e-12)
  close(perDay * 365, 2.32895, 1e-5) // the design hand figure, on a 365-day year
  close(perDay * YEAR_DAYS, 2.330546, 1e-5) // the same rate on the 365.25-day year the output uses
  close(at(0.75).deadlineDays ?? NaN, 30.06, 0.005) // ln (4/3) · 313 / ln 20 = 30.058
  close(solve(HERO).wait.meanGapDaysAtLeast, 313 / Math.log(20), 1e-9) // 104.48 d
  close(solve(HERO).wait.rateBoundPerYear, (Math.log(20) / 313) * 365.25, 1e-12)
  assert.equal(solve(HERO).wait.silentDays, 313)
})

test('inverse: the deadline band at H = H*(s) has seller share max = s, for every point of the curve', () => {
  for (const p of solve(HERO, 'B').wait.curve) {
    assert.ok(p.deadlineDays !== null)
    const b = solve({ ...HERO, horizonsDays: [p.deadlineDays] }, 'B').bands[0]
    close(b.perUnit.lovelace.sellerShareMax, p.sellerShare, 1e-9)
    close(b.sellerShareMax, p.sellerShare, 1e-9)
  }
  // positive control: one day longer and the band no longer reaches s
  const q = at(0.4)
  assert.ok(solve({ ...HERO, horizonsDays: [(q.deadlineDays ?? 0) + 1] }, 'B').bands[0].sellerShareMax < 0.4 - 1e-6)
})

test('path A on the hero escrow: every seller share is infeasible (the collateral floor is all the ADA), s = 0.4 included', () => {
  assert.deepEqual(at(0.4, 'A'), { sellerShare: 0.4, feasible: false, deadlineDays: null, breakEvenDiscountAnnual: null })
  assert.ok(solve(HERO, 'A').wait.curve.every((p) => !p.feasible))
  // positive control: with a floor of half the ADA, path A at s = 0.4 is feasible (b = 0.55 ≥ c/V = 0.5)
  assert.equal(waitPoint({ ...HERO, collateralReturnLovelace: 2_014_925 }, 'A', 0.4).feasible, true)
})

test('edge conventions: s = 0, b ≥ π, b = 0, b < 0', () => {
  // s = 0: the buyer keeps all of V ≥ π on every unit: no deadline needed (null), no rate needed (0)
  assert.deepEqual(waitPoint(HERO, 'B', 0), { sellerShare: 0, feasible: true, deadlineDays: null, breakEvenDiscountAnnual: 0 })
  // b ≥ π on one unit only: that unit sets no limit, the other decides (USDM b = 0.75 ≥ 0.736; ADA binds)
  close(waitPoint({ ...HERO, value: { lovelace: '4029850' } }, 'B', 0.25).deadlineDays ?? NaN, at(0.25).deadlineDays ?? NaN, 1e-12)
  // b = 0 (s = 1 on path B): only a zero deadline, and no discount rate makes it beat waiting
  assert.deepEqual(waitPoint(HERO, 'B', 1), { sellerShare: 1, feasible: true, deadlineDays: 0, breakEvenDiscountAnnual: null })
  // b < 0: the share is more than the pot
  assert.deepEqual(waitPoint(HERO, 'B', 1.2), { sellerShare: 1.2, feasible: false, deadlineDays: null, breakEvenDiscountAnnual: null })
})

// Every key name in an output, unit keys (lovelace, policy + name hex) left out.
const keyNames = (x: unknown, out = new Set<string>()): Set<string> => {
  if (Array.isArray(x)) for (const v of x) keyNames(v, out)
  else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) {
    if (k !== 'lovelace' && !/^[0-9a-f]{56,}$/.test(k)) out.add(k)
    keyNames(v, out)
  }
  return out
}
const FORBIDDEN = /discount|delta|worth|value|option|jeffreys|flat|posterior|prior|pooled|recommend|best|optimal/i
const forbidden = (x: unknown): string[] => [...keyNames(x)].filter((k) => k !== 'breakEvenDiscountAnnual' && FORBIDDEN.test(k))

test('no output field takes or reports a discount-rate input, a value of waiting or a recommended split', () => {
  const out = solve(HERO, 'B')
  assert.deepEqual(forbidden(out), [])
  assert.deepEqual(Object.keys(out.wait).sort(), ['curve', 'dormancy', 'meanGapDaysAtLeast', 'rateBoundPerYear', 'silentDays'])
  for (const p of out.wait.curve) assert.deepEqual(Object.keys(p).sort(), ['breakEvenDiscountAnnual', 'deadlineDays', 'feasible', 'sellerShare'])
  // nothing reads a rate from the input: a smuggled one changes nothing...
  assert.deepEqual(solve({ ...HERO, discountRatePerYear: 0.1 } as SolverInput, 'B'), out)
  // ...while a real input does (positive control for the comparison)
  assert.notDeepEqual(solve({ ...HERO, dormancyDays: 300 }, 'B'), out)
  // positive control for the scan
  assert.deepEqual(forbidden({ wait: { valueOfWaiting: 0.97, discountRatePerYear: 0.1, curve: [{ recommendedShare: 0.4 }] } }), ['valueOfWaiting', 'discountRatePerYear', 'recommendedShare'])
})

test('the scalar curve never shows the token break-even (it would reveal the 26.4 %)', () => {
  // The hero holds the token; with or without it the path-B curve is the same: ADA binds at every s.
  assert.deepEqual(solve(HERO, 'B').wait.curve, solve({ ...HERO, value: { lovelace: '4029850' } }, 'B').wait.curve)
  // positive control: the token alone would give a different curve (no deadline at s ≤ 0.264)
  assert.equal(waitPoint({ ...HERO, value: { [USDM]: '2000000' } }, 'B', 0.25).deadlineDays, null)
})

const DATUM = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'shared', 'mock', 'datum-disputed.mock.json'), 'utf8')).datum as Datum
const DAY = 86_400_000

test('solverInputFor: T comes from the dormancy receipt, not the wall clock', () => {
  const pinned = solverInputFor('h#0', DATUM, HERO.value, Date.now())
  close(pinned.dormancyDays, 312.2649074, 1e-7) // the pin, 2026-10-06T04:48:28Z
  assert.deepEqual(pinned.dormancy, pinnedDormancy())
  // a later clock claims nothing more
  assert.equal(solverInputFor('h#0', DATUM, HERO.value, Date.now() + 30 * DAY).dormancyDays, pinned.dormancyDays)
  const live = { ...pinnedDormancy(), method: 'live' as const, through: { height: 14032813, hash: 'x', timeMs: Date.parse('2026-10-06T10:16:48Z') } }
  close(solverInputFor('h#0', DATUM, HERO.value, 0, null, live).dormancyDays, 312.4929167, 1e-7)
  assert.equal(PIN.timeMs - ARBITER_LAST_ACTION_MS, pinned.dormancyDays * DAY)
})

test('acted: T restarts at the arbitration and solve() does not throw, even when it is in the tip block', () => {
  const tip = { height: 14040000, hash: 't', timeMs: Date.parse('2026-10-07T04:00:00Z') }
  const when = Date.parse('2026-10-07T03:00:00Z')
  const acted = { ...pinnedDormancy(), method: 'live' as const, status: 'acted' as const, lastActionMs: when, through: tip, acted: [{ txHash: 'a', height: 14039900, timeMs: when, validContract: false }] }
  const out = solve(solverInputFor('h#0', DATUM, HERO.value, 0, null, acted), 'B')
  close(out.wait.silentDays, 1 / 24, 1e-12)
  assert.equal(out.wait.dormancy.status, 'acted')
  const same = solve(solverInputFor('h#0', DATUM, HERO.value, 0, null, { ...acted, lastActionMs: tip.timeMs }), 'B')
  assert.equal(same.wait.silentDays, 0)
  assert.equal(same.bands[1].sellerShareMax, 0) // arrival bounded by 1: the ADA band closes, nothing throws
  assert.throws(() => solve({ ...HERO, dormancyDays: -1 })) // a receipt from the future is still a programming error
})
