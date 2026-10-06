// A4: what each party can do to an escrow right now — 7 redeemers × {buyer, seller, admin}, from the guard table
// (SPEC-VALIDATOR §2) as the validator's source states it. Pure: no network, no clock, no key.
import type { Datum, Grid, Params, Redeemer, Role, State, Value, Verdict } from '../../shared/types.ts'
import { REDEEMER } from '../../shared/types.ts'

const ROLES: Role[] = ['buyer', 'seller', 'admin']

// The window a default tx gets (src/preprod/tx.ts: now ± 150 s, each bound nudged one slot outward), taken at its
// widest so a predicted "allowed" also holds for the tx actually built: lower ≥ now − 152 s, upper ≤ now + 152 s.
export const WINDOW_BEFORE_MS = 152_000
export const WINDOW_AFTER_MS = 152_000

// Who must sign each redeemer (SPEC-VALIDATOR §2). WithdrawDisputed is the admin set, k of its listed keys.
const SIGNER: Record<Redeemer, Role> = {
  Withdraw: 'seller',
  SetRefundRequested: 'buyer',
  UnSetRefundRequested: 'buyer',
  WithdrawRefund: 'buyer',
  WithdrawDisputed: 'admin',
  SubmitResult: 'seller',
  AuthorizeRefund: 'seller',
}

const ADMISSIBLE: Record<Redeemer, State[]> = {
  Withdraw: ['ResultSubmitted'],
  SetRefundRequested: ['FundsLocked', 'ResultSubmitted', 'Disputed'],
  UnSetRefundRequested: ['RefundRequested', 'Disputed'],
  WithdrawRefund: ['FundsLocked', 'RefundRequested'],
  WithdrawDisputed: ['Disputed'],
  SubmitResult: ['FundsLocked', 'ResultSubmitted', 'RefundRequested', 'Disputed'],
  AuthorizeRefund: ['Disputed'],
}

const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
const fmt = (unit: string, q: bigint): string => (unit === 'lovelace' ? `${q} lovelace` : `${q} of ${unit.slice(0, 8)}…`)

type Ctx = { d: Datum; value: Value; from: number; to: number; params: Params }

// must_start_after(T): a finite lower bound with T ≤ lower. must_end_before(T): upper < T, strictly.
const startedAfter = (c: Ctx, t: number): boolean => t <= c.from
const endsBefore = (c: Ctx, t: number): boolean => c.to < t

function guards(r: Redeemer, c: Ctx): string[] {
  const { d } = c
  const failed: string[] = []
  if (!ADMISSIBLE[r].includes(d.state)) failed.push(`needs ${ADMISSIBLE[r].join(' or ')} (is ${d.state})`)
  const hasResult = d.resultHash.length > 0
  switch (r) {
    case 'Withdraw':
      if (!hasResult) failed.push('needs a result hash')
      if (!startedAfter(c, d.unlockTime)) failed.push(`not before unlock_time ${iso(d.unlockTime)}`)
      break
    case 'SetRefundRequested':
      if (!endsBefore(c, d.unlockTime)) failed.push(`only before unlock_time ${iso(d.unlockTime)}`)
      if (!startedAfter(c, d.buyerCooldownTime)) failed.push(`buyer cooldown until ${iso(d.buyerCooldownTime)}`)
      break
    case 'UnSetRefundRequested':
      if (!startedAfter(c, d.buyerCooldownTime)) failed.push(`buyer cooldown until ${iso(d.buyerCooldownTime)}`)
      break
    case 'WithdrawRefund':
      if (hasResult) failed.push('needs an empty result hash')
      if (!startedAfter(c, d.submitResultTime)) failed.push(`not before submit_result_time ${iso(d.submitResultTime)}`)
      break
    case 'WithdrawDisputed':
      if (!hasResult) failed.push('needs a result hash')
      if (!startedAfter(c, d.externalDisputeUnlockTime)) failed.push(`not before external_dispute_unlock_time ${iso(d.externalDisputeUnlockTime)}`)
      if (c.params.requiredAdmins <= 0 || c.params.adminKeyHashes.length === 0) failed.push('no admin set')
      else if (c.params.requiredAdmins > c.params.adminKeyHashes.length) failed.push(`threshold ${c.params.requiredAdmins} exceeds the ${c.params.adminKeyHashes.length} listed keys`)
      break
    case 'SubmitResult': {
      if (!startedAfter(c, d.sellerCooldownTime)) failed.push(`seller cooldown until ${iso(d.sellerCooldownTime)}`)
      const beforeSubmit = endsBefore(c, d.submitResultTime)
      const beforeDispute = endsBefore(c, d.externalDisputeUnlockTime) && hasResult
      if (!beforeSubmit && !beforeDispute) failed.push(hasResult ? `submission window closed at ${iso(d.externalDisputeUnlockTime)}` : `submission window closed at ${iso(d.submitResultTime)}`)
      break
    }
    case 'AuthorizeRefund':
      if (!startedAfter(c, d.sellerCooldownTime)) failed.push(`seller cooldown until ${iso(d.sellerCooldownTime)}`)
      break
  }
  return failed
}

// What a tx taking this branch must contain (SPEC-VALIDATOR §2 and §7), with this escrow's numbers.
function outputRules(r: Redeemer, c: Ctx): string[] {
  const { d, value, params } = c
  const keep = (state: string, extra: string): string => `one escrow output, value kept on every asset; datum kept except ${extra}; state → ${state}`
  switch (r) {
    case 'Withdraw': {
      const fee = Object.entries(value).map(([unit, q]) => fmt(unit, (BigInt(q) * BigInt(params.feePermille)) / 1000n))
      const rules = [
        `fee output to the fee address tagged with this escrow's output reference: at least ${fee.join(' + ')} (${params.feePermille / 10} % of every asset)`,
        `buyer output tagged with this escrow's output reference: at least ${d.collateralReturnLovelace} lovelace (no token floor)`,
      ]
      const ada = BigInt(value.lovelace ?? '0')
      const need = BigInt(d.collateralReturnLovelace) + (ada * BigInt(params.feePermille)) / 1000n
      if (need > ada) rules.push(`the escrow holds less lovelace than the fee plus the collateral floor: the seller adds ${need - ada} lovelace`)
      return rules
    }
    case 'SetRefundRequested':
      return [keep(d.resultHash ? 'Disputed' : 'RefundRequested', `seller cooldown 0 and buyer cooldown ≥ the tx upper bound + ${params.cooldownMs / 60_000} min`)]
    case 'UnSetRefundRequested':
      return [keep(d.resultHash ? 'ResultSubmitted' : 'FundsLocked', `seller cooldown 0 and buyer cooldown ≥ the tx upper bound + ${params.cooldownMs / 60_000} min`)]
    case 'SubmitResult':
      return [keep(d.state === 'FundsLocked' || d.state === 'ResultSubmitted' ? 'ResultSubmitted' : 'Disputed', `a non-empty result hash, seller cooldown ≥ the tx upper bound + ${params.cooldownMs / 60_000} min, buyer cooldown 0`)]
    case 'AuthorizeRefund':
      return [keep('RefundRequested', `an emptied result hash, seller cooldown ≥ the tx upper bound + ${params.cooldownMs / 60_000} min, buyer cooldown 0`)]
    case 'WithdrawRefund':
      return ['none: no fee output, no collateral output, the outputs are the buyer\'s to choose']
    case 'WithdrawDisputed':
      return [`none; signed by at least ${params.requiredAdmins} of the ${params.adminKeyHashes.length} listed admin keys (a key listed twice counts twice)`]
  }
}

function verdict(r: Redeemer, role: Role, c: Ctx): Verdict {
  const failed: string[] = []
  const signer = SIGNER[r]
  if (role !== signer) failed.push(signer === 'admin' ? 'only the admin set signs this' : `only the ${signer} signs this`)
  // address_to_verification_key returns nothing for a script credential: a script party can never satisfy a signature.
  if (role === signer && role !== 'admin' && c.d[role].payment.type === 'script') failed.push(`the ${role} is a script address: no signature can satisfy the check`)
  failed.push(...guards(r, c))
  return { redeemer: r, role, allowed: failed.length === 0, failed, outputRules: outputRules(r, c) }
}

export function reach(datum: Datum, value: Value, nowMs: number, params: Params, ref = ''): Grid {
  const c: Ctx = { d: datum, value, from: nowMs - WINDOW_BEFORE_MS, to: nowMs + WINDOW_AFTER_MS, params }
  return { ref, atMs: nowMs, state: datum.state, verdicts: REDEEMER.flatMap((r) => ROLES.map((role) => verdict(r, role, c))) }
}

export const allowedCells = (g: Grid): string[] => g.verdicts.filter((v) => v.allowed).map((v) => `${v.redeemer}/${v.role}`)
