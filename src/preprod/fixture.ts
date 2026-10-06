import { randomBytes } from 'node:crypto'
import type { UTxO } from '@meshsdk/core'
import type { Address, Datum, State } from '../../shared/types.ts'
import { V1_ADDRESS } from '../../shared/constants.ts'
import { preprodChain, utxoStatus } from './chain.ts'
import { mesh } from './mesh.ts'

// Our own preprod fixtures: escrows we lock, with a V1 datum we write. Never a mainnet or third-party escrow.

export const MIN = 60_000
export { TUSDM } from '../../shared/constants.ts'

export const lovelace = (u: UTxO): bigint => BigInt(u.output.amount.find((a) => a.unit === 'lovelace')?.quantity ?? '0')
export const tokenQty = (u: UTxO, unit: string): bigint => BigInt(u.output.amount.find((a) => a.unit === unit)?.quantity ?? '0')
// Funding may carry tokens (they go back in the change); collateral must be pure ADA.
export const byLovelace = (us: UTxO[]): UTxO[] => [...us].sort((a, b) => (lovelace(b) > lovelace(a) ? 1 : -1))
export const pureAda = (us: UTxO[]): UTxO[] => byLovelace(us.filter((u) => u.output.amount.every((a) => a.unit === 'lovelace')))
export const refOf = (u: UTxO): string => `${u.input.txHash}#${u.input.outputIndex}`

export function plutusAddress(bech32: string): Address {
  const a = mesh.deserializeAddress(bech32)
  if (!a.pubKeyHash) throw new Error('a party must be a key address: a script-controlled party can never satisfy a signature check')
  return { payment: { type: 'key', hash: a.pubKeyHash }, stake: a.stakeCredentialHash ? { type: 'key', hash: a.stakeCredentialHash } : null }
}

export type LockOptions = {
  state: Extract<State, 'ResultSubmitted' | 'Disputed'>
  unlock: 'future' | 'past' // path B needs nothing from unlock_time; path A's Withdraw needs it past
  collateralReturnLovelace: number
  arbitration?: 'open' | 'closed' // external_dispute_unlock_time past (the admin set may act) or 12 h ahead (default)
}

// A fresh 16-field datum with its own nonces and hashes. The result hash is set and submit_result_time is past, so the
// seller-first exit (WithdrawRefund needs lower >= submit_result_time) is reachable at once; cooldowns start at 0.
export function fixtureDatum(buyer: string, seller: string, nowMs: number, o: LockOptions): Datum {
  return {
    buyer: plutusAddress(buyer),
    seller: plutusAddress(seller),
    referenceKey: Buffer.from('brume-bank').toString('hex'),
    referenceSignature: randomBytes(16).toString('hex'),
    sellerNonce: randomBytes(10).toString('hex'),
    buyerNonce: randomBytes(10).toString('hex'),
    collateralReturnLovelace: o.collateralReturnLovelace,
    inputHash: randomBytes(32).toString('hex'),
    resultHash: randomBytes(32).toString('hex'),
    payByTime: nowMs - 30 * MIN,
    submitResultTime: nowMs - 20 * MIN,
    unlockTime: o.unlock === 'future' ? nowMs + 6 * 60 * MIN : nowMs - 10 * MIN,
    externalDisputeUnlockTime: o.arbitration === 'open' ? nowMs - 5 * MIN : nowMs + 12 * 60 * MIN,
    sellerCooldownTime: 0,
    buyerCooldownTime: 0,
    state: o.state,
  }
}

// Blockfrost's /txs/{hash}/utxos also lists spent outputs, so unspentness is confirmed on Koios before anything is built.
export async function escrowAt(ref: string, scriptAddress: string = V1_ADDRESS.preprod): Promise<UTxO> {
  const [hash, idx] = ref.split('#')
  const u = (await preprodChain().fetchUTxOs(hash, Number(idx))).find((x) => x.input.outputIndex === Number(idx))
  if (!u) throw new Error(`escrow ${ref} not found (not indexed yet?)`)
  const status = await utxoStatus([ref])
  if (status.get(ref) !== 'unspent') throw new Error(`escrow ${ref} is ${status.get(ref) ?? 'unknown to Koios'}: nothing is built on it`)
  if (u.output.address !== scriptAddress || !u.output.plutusData) throw new Error(`${ref} is not an escrow at ${scriptAddress.slice(0, 20)}… with an inline datum`)
  return u
}
