// The solver: which splits are individually rational for both parties, per exit path, per unit of the escrow value.
// Model (PLAN §10 D14): the disagreement point is arbitration, measured on all 120 lifetime arbitrations — the seller got
// nothing (r_s = 0) and the buyer got 100 % of the ADA and 73.6 % of the token; arbitration arrives by horizon H with
// probability 1 − e^(−λ̄H), λ̄ = ln 20 / T, the 95 % upper bound on the rate after T days with zero events.
// The share that reached neither party is what keeps a split rational for both even if arbitration arrived for sure;
// it enters only through those shares and is never an output field (PLAN §3 WON'T). No dollars, ever: units of V.
import type { Band, Datum, PathTerms, SolverInput, SolverOutput, UnitTerms, Value } from '../../shared/types.ts'
import { ARBITER_LAST_ACTION_MS, BUYER_ARB_SHARE, PARAMS, SELLER_ARB_SHARE } from '../../shared/constants.ts'

export const DAY_MS = 86_400_000
export const HORIZONS_DAYS = [7, 30, 90]

// Arbitration shares per unit; a token not in the measured table takes the measured token share (the 61 hold one token).
const TOKEN_BUYER_SHARE = Math.min(...Object.entries(BUYER_ARB_SHARE).filter(([u]) => u !== 'lovelace').map(([, s]) => s))
const shareOf = (table: Record<string, number>, unit: string, tokenDefault: number): number => table[unit] ?? (unit === 'lovelace' ? 1 : tokenDefault)

export const arrivalBy = (horizonDays: number, dormancyDays: number): number => 1 - Math.exp(-(Math.log(20) / dormancyDays) * horizonDays)

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

export function solve(input: SolverInput, path: 'A' | 'B' = 'B'): SolverOutput {
  if (!(input.dormancyDays > 0)) throw new Error('dormancyDays must be positive')
  const terms = pathTerms(input)
  return {
    ref: input.ref,
    path,
    pathA: terms.A,
    pathB: terms.B,
    bands: input.horizonsDays.map((h) => band(input, path, h)),
    frontRunP: { used: input.frontRunP ?? 1, measured: input.frontRunP !== null }, // worst case until S-1 measures it
  }
}

// The standard input for an escrow at a given time: deployed fee, measured shares, dormancy since the last arbitration.
export function solverInputFor(ref: string, datum: Datum, value: Value, nowMs: number, frontRunP: number | null = null): SolverInput {
  return {
    ref, value,
    collateralReturnLovelace: datum.collateralReturnLovelace,
    feePermille: PARAMS.feePermille,
    buyerArbShare: BUYER_ARB_SHARE,
    sellerArbShare: SELLER_ARB_SHARE,
    dormancyDays: (nowMs - ARBITER_LAST_ACTION_MS) / DAY_MS,
    horizonsDays: HORIZONS_DAYS,
    frontRunP,
  }
}
