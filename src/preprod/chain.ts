import type { BlockfrostProvider } from '@meshsdk/core'
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

// Raw Blockfrost read for what Mesh does not expose (block height). 404 → null; 429/5xx retried with backoff, then thrown.
export async function blockfrostGet<T>(path: string): Promise<T | null> {
  const id = requireEnv('BLOCKFROST_PREPROD_PROJECT_ID')
  if (!id.startsWith('preprod')) throw new PreprodOnlyError('BLOCKFROST_PREPROD_PROJECT_ID is not a preprod project id')
  for (let attempt = 0, wait = 1_000; ; attempt++, wait *= 2) {
    const res = await fetch(BLOCKFROST_PREPROD + path, { headers: { project_id: id }, signal: AbortSignal.timeout(30_000) })
    if (res.status === 404) return null
    if (res.ok) return (await res.json()) as T
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise((r) => setTimeout(r, wait))
      continue
    }
    throw new Error(`Blockfrost preprod ${path.split('/').slice(0, 2).join('/')}: HTTP ${res.status}`)
  }
}

// A submit has two kinds of failure, and only one is a refusal:
// - the node's ledger rejected the tx (HTTP 400 with the ledger error): a data point, logged with its phase;
// - the tx never reached a ledger check (auth, 429, 5xx, network): a hole, thrown, never logged as a refusal.
export class LedgerRejection extends Error {}
export class SubmitTransportError extends Error {}

// Phase 2 = the script ran and failed (the validator refused). Everything else the ledger rejects is phase 1.
export const refusalPhase = (ledgerError: string): 1 | 2 =>
  /PlutusFailure|ValidationTagMismatch|ScriptFailure|EvaluationFailure|CekError/i.test(ledgerError) ? 2 : 1

export type Submitter = { via: Provider; submitTx: (cborHex: string) => Promise<string> }

async function postCbor(url: string, cborHex: string, headers: Record<string, string>): Promise<string> {
  for (let attempt = 0, wait = 1_000; ; attempt++, wait *= 2) {
    let res: Response
    try {
      res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/cbor', ...headers }, body: Buffer.from(cborHex, 'hex'), signal: AbortSignal.timeout(30_000) })
    } catch (error: unknown) {
      if (attempt < 3) { await new Promise((r) => setTimeout(r, wait)); continue }
      throw new SubmitTransportError(`submit did not reach the node: ${error instanceof Error ? error.message : String(error)}`)
    }
    const text = await res.text()
    if (res.ok) return text.replace(/"/g, '').trim()
    if (res.status === 400) throw new LedgerRejection(text.slice(0, 1500))
    // Resubmitting the same bytes is safe (same hash), so transient failures are retried.
    if ((res.status === 429 || res.status >= 500) && attempt < 3) { await new Promise((r) => setTimeout(r, wait)); continue }
    throw new SubmitTransportError(`submit HTTP ${res.status}: ${text.slice(0, 200)}`)
  }
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
