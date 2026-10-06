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
}
export type PathTerms = { fee: Value; exposedParty: 'buyer' | 'seller'; exposedFloor: Value; defectorKeeps: Value }
// Everything is per unit of that asset's locked quantity. Assets differ (C9: buyer took 100 % of the ADA, 73.6 % of the token).
export type UnitTerms = { rBuyer: number; rSeller: number; sellerShareMin: number; sellerShareMax: number }
export type Band = {
  horizonDays: number
  sellerShareMin: number // scalar band: one share applied to every asset = intersection of the per-unit bands
  sellerShareMax: number
  perUnit: Record<string, UnitTerms>
}
export type SolverOutput = {
  ref: string
  pathA: PathTerms
  pathB: PathTerms
  bands: Band[]
  arbitrationLeak: Record<string, number> // unit → share reaching neither party in arbitration (1 − buyer − seller)
  frontRunP: { used: number; measured: boolean }
}

export type TxLogEntry = {
  step: string
  network: Network
  txHash: string
  status: 'accepted' | 'refused'
  atMs: number
  expected?: 'accept' | 'refuse' // set on controls: the prediction made before submitting
  stage?: 'evaluate' | 'submit' | 'confirm' // where the outcome was decided; a validator refusal shown as such must be 'submit'
  blockHeight?: number // when accepted: the block that pins it
  error?: string
  readback?: { provider: Provider; validContract: boolean }
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

// MIP-003 job output
export type JobResult = { escrowRef: string; grid: Grid; solver: SolverOutput; uiUrl: string }

// Function signatures each stream implements (PLAN §4)
export type UtxosAt = (net: Network, address: string) => Promise<Read<RawUtxo[]>>
export type UtxoByRef = (net: Network, ref: string) => Promise<Read<RawUtxo | null>>
export type TipOf = (net: Network) => Promise<Read<Tip>>
export type DecodeDatum = (cborHex: string) => Datum // throws on malformed
export type Reach = (datum: Datum, value: Value, nowMs: number, params: Params) => Grid
export type Solve = (input: SolverInput) => SolverOutput
export type Prepare = (escrowRef: string, sellerShare: number) => Promise<Proposal>
export type Sign = (role: Role, proposal: Proposal) => Promise<Proposal>
export type Submit = (proposal: Proposal) => Promise<TxLogEntry[]>
export type TryAnyway = (escrowRef: string, redeemer: Redeemer, role: Role) => Promise<TxLogEntry>
