import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SolverInput } from '../../shared/types.ts'
import { BUYER_ARB_SHARE, SELLER_ARB_SHARE, TUSDM, USDM } from '../../shared/constants.ts'
import { arrivalBy, solve } from './solve.ts'

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
