import type { BlockfrostProvider, UTxO } from '@meshsdk/core'
import type { Network, Provider } from '../../shared/types.ts'
import { KOIOS } from '../../shared/constants.ts'
import { requireEnv, loadEnv } from './env.ts'
import { mesh } from './mesh.ts'

// Every write in this repo goes through src/preprod. A mainnet value anywhere is a thrown error, never a fallback.
export class PreprodOnlyError extends Error {}

export function assertPreprod(net: Network): asserts net is 'preprod' {
  if (net !== 'preprod') throw new PreprodOnlyError(`refusing to write on ${net}: src/preprod writes on preprod only`)
}

export function assertPreprodAddress(address: string): void {
  if (!address.startsWith('addr_test1')) throw new PreprodOnlyError(`refusing a non-testnet address: ${address.slice(0, 12)}…`)
}

// Q-H (PLAN §10): preprod's Shelley era starts at slot 86400 = 2022-06-21T00:00:00Z, one slot per second.
// Measured on 6 Oct at Koios preprod block 5259347: abs_slot − (block_time − 1655769600) = 86400, 0 s error.
export const SLOT_ZERO = 86_400
export const SLOT_ZERO_MS = 1_655_769_600_000
export const SLOT_MS = 1_000

export function slotAt(ms: number, round: 'down' | 'up'): number {
  const exact = (ms - SLOT_ZERO_MS) / SLOT_MS
  return SLOT_ZERO + (round === 'down' ? Math.floor(exact) : Math.ceil(exact))
}

export const msAt = (slot: number): number => SLOT_ZERO_MS + (slot - SLOT_ZERO) * SLOT_MS

// Blockfrost reads and evaluates; the project id must be a preprod one, so a mainnet key cannot slip in.
export function preprodChain(): BlockfrostProvider {
  const id = requireEnv('BLOCKFROST_PREPROD_PROJECT_ID')
  if (!id.startsWith('preprod')) throw new PreprodOnlyError('BLOCKFROST_PREPROD_PROJECT_ID is not a preprod project id')
  return new mesh.BlockfrostProvider(id)
}

const BLOCKFROST_PREPROD = 'https://cardano-preprod.blockfrost.io/api/v0'

// Raw Blockfrost read for what Mesh does not expose (block height). 404 → null; a thrown fetch, 429 or 5xx is retried
// with backoff, then thrown: a hole, never a value.
export async function blockfrostGet<T>(path: string): Promise<T | null> {
  const id = requireEnv('BLOCKFROST_PREPROD_PROJECT_ID')
  if (!id.startsWith('preprod')) throw new PreprodOnlyError('BLOCKFROST_PREPROD_PROJECT_ID is not a preprod project id')
  for (let attempt = 0, wait = 1_000; ; attempt++, wait *= 2) {
    let res: Response
    try {
      res = await fetch(BLOCKFROST_PREPROD + path, { headers: { project_id: id }, signal: AbortSignal.timeout(30_000) })
    } catch (error: unknown) {
      if (attempt < 4) {
        await new Promise((r) => setTimeout(r, wait))
        continue
      }
      throw new Error(`Blockfrost preprod ${path.split('/').slice(0, 2).join('/')}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (res.status === 404) return null
    if (res.ok) return (await res.json()) as T
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise((r) => setTimeout(r, wait))
      continue
    }
    throw new Error(`Blockfrost preprod ${path.split('/').slice(0, 2).join('/')}: HTTP ${res.status}`)
  }
}

// Blockfrost's address listing lags a fresh spend (seen 6 Oct: an input spent one block earlier was still listed), so every
// UTxO we are about to spend is cross-checked on Koios. Spent, or unknown to Koios: dropped. A Koios failure throws.
export async function liveUtxos(address: string): Promise<UTxO[]> {
  const listed = await preprodChain().fetchAddressUTxOs(address)
  if (listed.length === 0) return []
  const refs = listed.map((u) => `${u.input.txHash}#${u.input.outputIndex}`)
  const res = await fetch(`${KOIOS.preprod}/utxo_info`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ _utxo_refs: refs }), signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`Koios utxo_info HTTP ${res.status}: cannot confirm which UTxOs are unspent`)
  const rows = (await res.json()) as { tx_hash: string; tx_index: number; is_spent: boolean }[]
  const unspent = new Set(rows.filter((r) => !r.is_spent).map((r) => `${r.tx_hash}#${r.tx_index}`))
  return listed.filter((u) => unspent.has(`${u.input.txHash}#${u.input.outputIndex}`))
}

// A submit has three outcomes besides success, and only one is a refusal:
// - LedgerRejection: the first attempt got HTTP 400 carrying a ledger rule. A data point, logged with its phase.
// - SubmitTransportError: the tx certainly never reached a ledger check (auth, a 400 from the provider itself). A hole.
// - AmbiguousSubmit: an attempt may have reached a node (timeout, network error, 5xx) and its answer is lost, or a later
//   retry was refused because the copy already in the mempool spends its inputs. Only the chain can decide.
export class LedgerRejection extends Error {}
export class SubmitTransportError extends Error {}
export class AmbiguousSubmit extends Error {}

// A ledger answer names a rule; a provider's own 400 (bad CBOR, bad request) does not.
const LEDGER_RULE = /ApplyTxError|Conway\w*Failure|Babbage\w*Failure|Shelley\w*Failure|Utxow?Failure|MempoolFailure|BadInputsUTxO/

// Phase 2 = the script ran and failed (the validator refused). Everything else the ledger rejects is phase 1.
// "ValidationTagMismatch (IsValid False) … PassedUnexpectedly" means the scripts passed: phase 1.
export const refusalPhase = (ledgerError: string): 1 | 2 =>
  /ValidationTagMismatch \(IsValid True\)|FailedUnexpectedly|PlutusFailure|CekError|EvaluationFailure|ScriptFailures/.test(ledgerError) ? 2 : 1

export type Submitter = { via: Provider; submitTx: (cborHex: string) => Promise<string> }

async function postCbor(url: string, cborHex: string, headers: Record<string, string>): Promise<string> {
  let mayHaveReached = false
  for (let attempt = 0, wait = 1_000; ; attempt++, wait *= 2) {
    let res: Response
    try {
      res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/cbor', ...headers }, body: Buffer.from(cborHex, 'hex'), signal: AbortSignal.timeout(30_000) })
    } catch (error: unknown) {
      mayHaveReached = true // the request may have been delivered before the connection failed
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, wait))
        continue
      }
      throw new AmbiguousSubmit(`no answer from the submit endpoint: ${error instanceof Error ? error.message : String(error)}`)
    }
    const text = await res.text()
    if (res.ok) return text.replace(/"/g, '').trim()
    if (res.status === 400) {
      if (mayHaveReached) throw new AmbiguousSubmit(`HTTP 400 after an earlier attempt may have reached the node: ${text.slice(0, 600)}`)
      if (!LEDGER_RULE.test(text)) throw new SubmitTransportError(`the provider rejected the request, not a ledger rule: ${text.slice(0, 300)}`)
      throw new LedgerRejection(text.slice(0, 1500))
    }
    if (res.status >= 500) mayHaveReached = true
    // Resubmitting the same bytes is safe for the chain (same hash), so transient failures are retried.
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await new Promise((r) => setTimeout(r, wait))
      continue
    }
    if (mayHaveReached) throw new AmbiguousSubmit(`submit HTTP ${res.status} after an attempt that may have reached the node`)
    throw new SubmitTransportError(`submit HTTP ${res.status}: ${text.slice(0, 200)}`)
  }
}

// After an ambiguous submit: is the tx in Blockfrost's mempool or in a block? Polls for up to `ms`.
export async function seenByChain(txHash: string, ms = 90_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await blockfrostGet(`/txs/${txHash}`)) return true
    if (await blockfrostGet(`/mempool/${txHash}`)) return true
    await new Promise((r) => setTimeout(r, 5_000))
  }
  return false
}

// SUBMIT_VIA=koios|blockfrost (PLAN §9 R-3). Koios is keyless: no auth header is sent at all.
export function preprodSubmitter(): Submitter {
  loadEnv()
  if (process.env.SUBMIT_VIA === 'blockfrost') {
    const id = requireEnv('BLOCKFROST_PREPROD_PROJECT_ID')
    if (!id.startsWith('preprod')) throw new PreprodOnlyError('BLOCKFROST_PREPROD_PROJECT_ID is not a preprod project id')
    return { via: 'blockfrost', submitTx: (cborHex) => postCbor(`${BLOCKFROST_PREPROD}/tx/submit`, cborHex, { project_id: id }) }
  }
  return { via: 'koios', submitTx: (cborHex) => postCbor(`${KOIOS.preprod}/submittx`, cborHex, {}) }
}
