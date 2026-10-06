// The solver: which splits are individually rational for both parties, per exit path, per unit of the escrow value.
// Model (PLAN §10 D14): the disagreement point is arbitration, measured on all 120 lifetime arbitrations — the seller got
// nothing (r_s = 0) and the buyer got 100 % of the ADA and 73.6 % of the token; arbitration arrives by horizon H with
// probability at most 1 − e^(−λ̄H), λ̄ = ln 20 / T, the 95 % upper bound on the rate after T days with zero events.
// The bands are deadline bands: for a buyer who would wait at most H days (nothing arriving after H counts for it).
// S-4: an open offer has no deadline, and what waiting is worth then rests on the buyer's patience, which no chain data
// measures. So the solver outputs break-evens only (the deadline H* at which a share matches arbitration, and the
// discount rate at or above which it beats waiting forever), never a value of waiting, a rate input or a recommended split.
// The share that reached neither party is what keeps a split rational for both even if arbitration arrived for sure;
// it enters only through those shares and is never an output field, nor is any per-unit token break-even that would
// reveal it (PLAN §3 WON'T). No dollars, ever: units of V.
import type { Band, Datum, Dormancy, PathTerms, SolverInput, SolverOutput, UnitTerms, Value, WaitPoint, WaitTerms } from '../../shared/types.ts'
import { BUYER_ARB_SHARE, PARAMS, SELLER_ARB_SHARE } from '../../shared/constants.ts'
import { pinnedDormancy } from './dormancy.ts'

export const DAY_MS = 86_400_000
export const HORIZONS_DAYS = [7, 30, 90]
export const YEAR_DAYS = 365.25
export const CURVE_SHARES = Array.from({ length: 19 }, (_, i) => (i + 1) / 20)

// Arbitration shares per unit; a token not in the measured table takes the measured token share (the 61 hold one token).
const TOKEN_BUYER_SHARE = Math.min(...Object.entries(BUYER_ARB_SHARE).filter(([u]) => u !== 'lovelace').map(([, s]) => s))
const shareOf = (table: Record<string, number>, unit: string, tokenDefault: number): number => table[unit] ?? (unit === 'lovelace' ? 1 : tokenDefault)

export const rateBound = (dormancyDays: number): number => Math.log(20) / dormancyDays // λ̄, per day
export const arrivalBy = (horizonDays: number, dormancyDays: number): number => 1 - Math.exp(-rateBound(dormancyDays) * horizonDays)

const feeOf = (q: bigint, permille: number): bigint => (q * BigInt(permille)) / 1000n

function pathTerms(input: SolverInput): { A: PathTerms; B: PathTerms } {
  const fee: Value = {}, sellerKeeps: Value = {}, topUp: Value = {}
  for (const [unit, q] of Object.entries(input.value)) {
    const total = BigInt(q)
    const f = feeOf(total, input.feePermille)
    fee[unit] = f.toString()
    const floor = unit === 'lovelace' ? BigInt(input.collateralReturnLovelace) : 0n
    const left = total - f - floor
    sellerKeeps[unit] = (left > 0n ? left : 0n).toString()
    if (left < 0n) topUp[unit] = (-left).toString()
  }
  const floorA: Value = Object.fromEntries(Object.keys(input.value).map((u) => [u, u === 'lovelace' ? String(input.collateralReturnLovelace) : '0']))
  return {
    // Path A, buyer first: the seller's Withdraw is leg 2, so the seller is the one who can defect, keeping V − fee − c.
    A: { fee, exposedParty: 'buyer', exposedFloor: floorA, defectorKeeps: sellerKeeps, topUp },
    // Path B, seller first: the buyer's WithdrawRefund is leg 2 and has no output rule: a defecting buyer keeps all of V.
    B: { fee: {}, exposedParty: 'seller', exposedFloor: Object.fromEntries(Object.keys(input.value).map((u) => [u, '0'])), defectorKeeps: { ...input.value }, topUp: {} },
  }
}

// The deadline band: the splits both accept when the buyer would wait at most H days for arbitration.
function band(input: SolverInput, path: 'A' | 'B', horizonDays: number): Band {
  const p = arrivalBy(horizonDays, input.dormancyDays)
  const perUnit: Record<string, UnitTerms> = {}
  for (const [unit, q] of Object.entries(input.value)) {
    const rBuyer = shareOf(input.buyerArbShare, unit, TOKEN_BUYER_SHARE) * p
    const rSeller = shareOf(input.sellerArbShare, unit, 0) * p
    let max = 1 - rBuyer // path B: the pot is all of V, the seller's share s, the buyer's 1 − s
    if (path === 'A') {
      const v = Number(q)
      const feeShare = v > 0 ? Number(feeOf(BigInt(q), input.feePermille)) / v : 0
      max = 1 - feeShare - rBuyer // the fee comes off the pot before the split
      if (unit === 'lovelace' && v > 0) max = Math.min(max, 1 - feeShare - input.collateralReturnLovelace / v) // buyer keeps ≥ c lovelace
    }
    perUnit[unit] = { rBuyer, rSeller, sellerShareMin: rSeller, sellerShareMax: max }
  }
  const units = Object.values(perUnit)
  const min = Math.max(...units.map((u) => u.sellerShareMin))
  const max = Math.min(...units.map((u) => u.sellerShareMax))
  return { horizonDays, feasible: units.every((u) => u.sellerShareMax >= u.sellerShareMin) && max >= min, sellerShareMin: min, sellerShareMax: max, perUnit }
}

// The band's exact inverse at seller share s, per unit, then reduced to the scalar point (one s for every asset).
// The buyer's share now is b = 1 − s (path B) or 1 − fee − s (path A, where the buyer also keeps ≥ c lovelace). Against
// the most active arbiter the silence allows, arbitration within H days is worth at most π(1 − e^(−λ̄H)), so b beats it
// iff H ≤ H* = ln(π / (π − b)) / λ̄; waiting forever at a discount δ is worth at most πλ̄ / (λ̄ + δ), so b beats it iff
// δ ≥ δ* = λ̄(π − b) / b. The tightest unit decides: the shortest deadline, the highest rate. b ≥ π: no deadline and no
// rate needed; b ≤ 0: only a zero deadline, and no rate works. The seller's arbitration share is 0 in 120 of 120, so the
// seller's side gives no break-even. Per-unit values stay here: the token's would reveal the 26.4 %.
export function waitPoint(input: SolverInput, path: 'A' | 'B', s: number): WaitPoint {
  const lambda = rateBound(input.dormancyDays)
  let feasible = true
  let deadline = Infinity
  let rate = 0 // δ*, continuous, per day; NaN once a unit has none
  for (const [unit, q] of Object.entries(input.value)) {
    const pi = shareOf(input.buyerArbShare, unit, TOKEN_BUYER_SHARE)
    const v = Number(q)
    let b = 1 - s
    if (path === 'A') {
      b -= v > 0 ? Number(feeOf(BigInt(q), input.feePermille)) / v : 0
      if (unit === 'lovelace' && v > 0 && b < input.collateralReturnLovelace / v) feasible = false
    }
    if (b < 0) feasible = false // the share is more than the pot
    deadline = Math.min(deadline, b <= 0 ? 0 : b >= pi ? Infinity : Math.log(pi / (pi - b)) / lambda)
    rate = Math.max(rate, b <= 0 ? NaN : b >= pi ? 0 : (lambda * (pi - b)) / b)
  }
  if (!feasible) return { sellerShare: s, feasible, deadlineDays: null, breakEvenDiscountAnnual: null }
  return { sellerShare: s, feasible, deadlineDays: Number.isFinite(deadline) ? deadline : null, breakEvenDiscountAnnual: Number.isNaN(rate) ? null : Math.expm1(YEAR_DAYS * rate) }
}

// T = 0 (an arbitration in the tip block) gives an unbounded rate, not an error: no crash mid-demo.
export function solve(input: SolverInput, path: 'A' | 'B' = 'B'): SolverOutput & { wait: WaitTerms } {
  if (!(input.dormancyDays >= 0)) throw new Error('dormancyDays must not be negative')
  const terms = pathTerms(input)
  const lambda = rateBound(input.dormancyDays)
  return {
    ref: input.ref,
    path,
    pathA: terms.A,
    pathB: terms.B,
    bands: input.horizonsDays.map((h) => band(input, path, h)),
    frontRunP: { used: input.frontRunP ?? 1, measured: input.frontRunP !== null }, // worst case until S-1 measures it
    wait: {
      silentDays: input.dormancyDays,
      rateBoundPerYear: lambda * YEAR_DAYS,
      meanGapDaysAtLeast: 1 / lambda,
      // A hand-built input (the tests' T = 313) carries no receipt: it gets the pin's, and silentDays is the T actually used.
      dormancy: input.dormancy ?? pinnedDormancy(),
      curve: CURVE_SHARES.map((s) => waitPoint(input, path, s)),
    },
  }
}

// The standard input for an escrow: deployed fee, measured shares, and T from the dormancy receipt (D9). nowMs no longer
// sets T: silence is claimed only through a block a provider read (the pin, or the tip of a clean live check), never
// extrapolated to the wall clock, which would claim days nobody checked. nowMs stays so the callers' signature holds.
export function solverInputFor(ref: string, datum: Datum, value: Value, nowMs: number, frontRunP: number | null = null, dormancy: Dormancy = pinnedDormancy()): SolverInput {
  void nowMs
  return {
    ref, value,
    collateralReturnLovelace: datum.collateralReturnLovelace,
    feePermille: PARAMS.feePermille,
    buyerArbShare: BUYER_ARB_SHARE,
    sellerArbShare: SELLER_ARB_SHARE,
    dormancyDays: (dormancy.through.timeMs - dormancy.lastActionMs) / DAY_MS,
    horizonsDays: HORIZONS_DAYS,
    frontRunP,
    dormancy,
  }
}
