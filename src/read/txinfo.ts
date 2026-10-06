import type { State } from '../../shared/types.ts'

// What both providers agree to say about a transaction. `redeemer` is the constructor index, only known to Koios.
export type TxInfo = {
  hash: string
  blockHash: string
  blockHeight: number
  slot: number
  contracts: { scriptHash: string; purpose: string; redeemer: number | null; valid: boolean | null }[]
  validContract: boolean | null
  v1OutputStates: (State | null)[]
}
