// Shared contract between stream A and stream B. Any change: PLAN.md §11 entry + both agree.

export type Network = 'mainnet' | 'preprod'

// Index = Plutus constructor index. Confirmed on the mainnet census of 6 Oct: index 3 holds the 61 disputed escrows, index 2 the 4 concessions.
export const STATE = ['FundsLocked', 'ResultSubmitted', 'RefundRequested', 'Disputed'] as const
export type State = (typeof STATE)[number]

// Index = redeemer constructor (bare, no fields). K37.
export const REDEEMER = [
  'Withdraw',
  'SetRefundRequested',
  'UnSetRefundRequested',
  'WithdrawRefund',
  'WithdrawDisputed',
  'SubmitResult',
  'AuthorizeRefund',
] as const
export type Redeemer = (typeof REDEEMER)[number]

export type Role = 'buyer' | 'seller' | 'admin'

export type Credential = { type: 'key' | 'script'; hash: string }
// Plutus Address: credentials only, no network id. Pointer stake credentials are not represented: the decoder throws on them.
export type Address = { payment: Credential; stake: Credential | null }

// Validator parameters (SPEC-VALIDATOR §8). The deployed V1 set is PARAMS in constants.ts; our own deployment (S-2) has its own.
export type Params = {
  requiredAdmins: number
  adminKeyHashes: string[] // a key listed n times counts n times
  feeAddress: Address
  feePermille: number
  cooldownMs: number
}

// The 16 V1 datum fields, in declaration order (SPEC-TRANSACTIONS §0). Times in POSIX ms. Hex strings for bytes.
export type Datum = {
  buyer: Address
  seller: Address
  referenceKey: string
  referenceSignature: string
  sellerNonce: string
  buyerNonce: string
  collateralReturnLovelace: number
  inputHash: string
  resultHash: string
  payByTime: number
  submitResultTime: number
  unlockTime: number
  externalDisputeUnlockTime: number
  sellerCooldownTime: number
  buyerCooldownTime: number
  state: State
}

// unit ('lovelace' or policyId + assetNameHex) → quantity as a decimal string
export type Value = Record<string, string>

export type Provider = 'koios' | 'blockfrost' | 'fixture'
export type Tip = { height: number; hash: string; timeMs: number }

// Every read carries its hole count: an HTTP error is a hole, never a data point.
export type Read<T> = { data: T; holes: number; provider: Provider }

export type RawUtxo = { ref: string; address: string; value: Value; inlineDatumCbor: string | null }

export type Verdict = { redeemer: Redeemer; role: Role; allowed: boolean; failed: string[]; outputRules: string[] }
export type Grid = { ref: string; atMs: number; state: State; verdicts: Verdict[] }

export type CensusRow = { ref: string; state: State | null; value: Value }
export type Census = {
  network: Network
  tip: Tip
  provider: Provider
  open: number
  decoded: number
  undecodable: number
  holes: number
  byState: Record<State, number>
  disputedTotals: Value
  rows: CensusRow[]
  secondProvider: { provider: Provider; holes: number; diff: string[] } | null
}

export type SolverInput = {
  ref: string
  value: Value
  collateralReturnLovelace: number
  feePermille: number
  buyerArbShare: Record<string, number> // unit → observed buyer share in arbitration (C9)
  sellerArbShare: Record<string, number> // unit → observed seller share in arbitration (C9: 0 in 120 of 120)
  dormancyDays: number
  horizonsDays: number[]
  frontRunP: number | null // null until 5b measures it; solver shows the worst case
  dormancy?: Dormancy // the D9 receipt dormancyDays was computed from (solverInputFor always sets it)
}

// D9: the arbiter's silence, claimed only through a block someone read, never extrapolated to the wall clock.
export type Dormancy = {
  lastActionMs: number // newest WithdrawDisputed known: ARBITER_LAST_ACTION_MS (C3) unless a newer one was found
  pin: { height: number; hash: string; timeMs: number } // silent through here: K30 lifetime walk + kickoff read
  through: { height: number; hash: string; timeMs: number } // silent through this block: the pin, or the live tip read BEFORE the walk
  method: 'pin' | 'live'
  status: 'silent' | 'unverified' | 'acted' // unverified: a live check with any hole, a failed control or a provider diff; T then stays at the pin
  providers: Provider[] // providers whose walk since the pin was complete (0 holes, both controls fired)
  holes: number
  acted: { txHash: string; height: number; timeMs: number; validContract: boolean }[] // WithdrawDisputed since the pin, phase-2-failed attempts included
  diff: string[] // script-spend tx hashes seen by one provider only
}
// S-4: break-evens only, never a value of waiting. On the output's path, the scalar (binding-asset) point for one seller share.
// deadlineDays: the longest a buyer may be willing to wait for this share to beat arbitration at the 95 % rate bound (null: any wait).
// breakEvenDiscountAnnual: the effective annual rate (decimal) at or above which the share beats waiting forever (null: no rate does).
export type WaitPoint = { sellerShare: number; feasible: boolean; deadlineDays: number | null; breakEvenDiscountAnnual: number | null }
export type WaitTerms = { silentDays: number; rateBoundPerYear: number; meanGapDaysAtLeast: number; dormancy: Dormancy; curve: WaitPoint[] }
// topUp: what the exiting party must add from its own inputs (path A when c is most of the ADA: the fee's lovelace).
export type PathTerms = { fee: Value; exposedParty: 'buyer' | 'seller'; exposedFloor: Value; defectorKeeps: Value; topUp: Value }
// Everything is per unit of that asset's locked quantity. Assets differ (C9: buyer took 100 % of the ADA, 73.6 % of the token).
export type UnitTerms = { rBuyer: number; rSeller: number; sellerShareMin: number; sellerShareMax: number }
export type Band = {
  horizonDays: number
  feasible: boolean // false when no share satisfies both reservations and the path's output rules
  sellerShareMin: number // scalar band: one share applied to every asset = intersection of the per-unit bands
  sellerShareMax: number
  perUnit: Record<string, UnitTerms>
}
// The share that reaches neither party in arbitration stays inside src/solver: never in this output (PLAN §3 WON'T).
export type SolverOutput = {
  ref: string
  path: SettlePath // the path the bands are for (SETTLE_PATH); on path A the pot is V − fee and the buyer keeps ≥ c lovelace
  pathA: PathTerms
  pathB: PathTerms
  bands: Band[]
  frontRunP: { used: number; measured: boolean }
  wait?: WaitTerms // optional so mocks compile; solve() always fills it
}

export type TxLogEntry = {
  step: string
  network: Network
  scriptHash: string // which validator ran: the shared V1 (SCRIPT_HASH) or our own deployment (S-2)
  redeemer?: Redeemer
  role?: Role
  txHash: string
  status: 'accepted' | 'refused'
  atMs: number
  expected?: 'accept' | 'refuse' // set on controls: the prediction made before submitting
  stage: 'evaluate' | 'submit' | 'confirm' // where the outcome was decided
  // phase 2 = the script failed (a validator refusal); phase 1 = a ledger rule (spent input, fee, bounds). Only phase 2 is "the validator refuses".
  refusal?: { phase: 1 | 2; ledgerError: string }
  via?: Provider
  block?: { height: number; hash: string; slot: number } // when accepted: the block that pins it
  error?: string
  readback?: { provider: Provider; validContract: boolean; balances?: { buyer: Value; seller: Value } }
}

// B = seller first: AuthorizeRefund (leg 1) → WithdrawRefund (leg 2). A = buyer first: UnSetRefundRequested → Withdraw.
export type SettlePath = 'A' | 'B'
export type Leg = {
  redeemer: Redeemer
  cborHex: string
  txHash: string // fixed by the body; no signature may change it
  validFromMs: number
  validToMs: number // leg 2 must still be valid when leg 1 confirms
  inputs: string[] // every input ref, escrow + funding + collateral; leg 1 never spends leg 2's funding inputs
}
export type Proposal = {
  escrowRef: string
  network: Network
  path: SettlePath
  sellerShare: number // fraction of every asset paid to the seller
  payout: { buyer: Value; seller: Value; fee: Value } // exact amounts written in the exit leg
  leg1?: Leg
  leg2?: Leg
  signedBy: Role[] // UI state only; submit() verifies the witnesses inside the CBOR, never this field
}
// Rule: leg 1 never carries the first mover's witness in a Proposal. The first mover (seller on B, buyer on A) signs leg 1
// only inside submit(), after checking the counterparty's witness on leg 2; otherwise whoever holds the file could submit
// the concession alone and never sign the exit.

// MIP-003 job output
export type JobResult = { escrowRef: string; grid: Grid; solver: SolverOutput; uiUrl: string }

// Function signatures each stream implements (PLAN §4)
export type UtxosAt = (net: Network, address: string) => Promise<Read<RawUtxo[]>>
export type UtxoByRef = (net: Network, ref: string) => Promise<Read<RawUtxo | null>>
export type TipOf = (net: Network) => Promise<Read<Tip>>
export type DecodeDatum = (cborHex: string) => Datum // throws on malformed
// reach evaluates the default tx window [nowMs − 150 s, nowMs + 150 s] widened to slot boundaries: the window tryAnyway builds.
export type Reach = (datum: Datum, value: Value, nowMs: number, params: Params) => Grid
export type Solve = (input: SolverInput) => SolverOutput
export type Prepare = (escrowRef: string, sellerShare: number) => Promise<Proposal>
export type Sign = (role: Role, proposal: Proposal) => Promise<Proposal>
export type Submit = (proposal: Proposal) => Promise<TxLogEntry[]>
export type TryAnyway = (escrowRef: string, redeemer: Redeemer, role: Role) => Promise<TxLogEntry>
