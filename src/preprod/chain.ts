import type { BlockfrostProvider, UTxO } from '@meshsdk/core'
import type { Network, Provider } from '../../shared/types.ts'
import { KOIOS } from '../../shared/constants.ts'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { requireEnv, loadEnv, ROOT } from './env.ts'
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

export type ExUnits = { mem: number; steps: number }
export class EvaluationFailure extends Error {}

// Script evaluation against UTxOs that are not on chain yet (leg 1's output, for leg 2). Mesh's own conversion of
// chained txs drops the inline datum, so the validator could never read it: the extra set is written here, datum included.
export async function evaluateWithUtxos(cborHex: string, extra: UTxO[]): Promise<ExUnits[]> {
  const id = requireEnv('BLOCKFROST_PREPROD_PROJECT_ID')
  if (!id.startsWith('preprod')) throw new PreprodOnlyError('BLOCKFROST_PREPROD_PROJECT_ID is not a preprod project id')
  // Value shape Blockfrost's endpoint accepts (as Mesh sends it): { coins, <policyId>: { <assetNameHex>: quantity } }.
  // The Ogmios v5 { coins, assets: { "policy.name": q } } form is rejected ("failed to decode payload").
  const additionalUtxoSet = extra.map((u) => {
    const value: Record<string, unknown> = { coins: 0 }
    for (const a of u.output.amount) {
      if (a.unit === 'lovelace') value.coins = Number(a.quantity)
      else {
        const policy = a.unit.slice(0, 56)
        value[policy] = { ...((value[policy] as Record<string, number> | undefined) ?? {}), [a.unit.slice(56)]: Number(a.quantity) }
      }
    }
    const out: Record<string, unknown> = { address: u.output.address, value }
    if (u.output.plutusData) out.datum = u.output.plutusData
    return [{ txId: u.input.txHash, index: u.input.outputIndex }, out]
  })
  const res = await fetch(`${BLOCKFROST_PREPROD}/utils/txs/evaluate/utxos`, {
    method: 'POST', headers: { project_id: id, 'content-type': 'application/json' }, body: JSON.stringify({ cbor: cborHex, additionalUtxoSet }), signal: AbortSignal.timeout(60_000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Blockfrost evaluate HTTP ${res.status}: ${text.slice(0, 300)}`)
  const body = JSON.parse(text) as { result?: { EvaluationResult?: Record<string, { memory: number; steps: number }>; EvaluationFailure?: unknown } }
  const ok = body.result?.EvaluationResult
  if (!ok) throw new EvaluationFailure(`evaluation failed: ${JSON.stringify(body.result?.EvaluationFailure ?? body).slice(0, 1200)}`)
  return Object.values(ok).map((r) => ({ mem: r.memory, steps: r.steps }))
}

// Blockfrost's address listing lags a fresh spend (seen 6 Oct: an input spent one block earlier was still listed), so every
// UTxO we are about to spend is cross-checked on Koios. Spent, or unknown to Koios: dropped. A Koios failure throws.
// Koios utxo_info for a set of refs: spent or not, and at which address. A ref Koios does not know is absent from the map.
export async function utxoInfo(refs: string[]): Promise<Map<string, { spent: boolean; address: string }>> {
  const out = new Map<string, { spent: boolean; address: string }>()
  if (refs.length === 0) return out
  const res = await fetch(`${KOIOS.preprod}/utxo_info`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ _utxo_refs: refs }), signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`Koios utxo_info HTTP ${res.status}: cannot confirm which UTxOs are unspent`)
  for (const r of (await res.json()) as { tx_hash: string; tx_index: number; is_spent: boolean; address: string }[]) {
    out.set(`${r.tx_hash}#${r.tx_index}`, { spent: r.is_spent, address: r.address })
  }
  return out
}
export async function utxoStatus(refs: string[]): Promise<Map<string, 'spent' | 'unspent'>> {
  const info = await utxoInfo(refs)
  return new Map([...info].map(([ref, i]) => [ref, i.spent ? 'spent' : 'unspent']))
}

// It also lags the other way: a fresh output can be missing from it. So the candidates are the union of the Blockfrost
// and Koios listings, and only what Koios confirms unspent is kept.
type KoiosUtxo = { tx_hash: string; tx_index: number; address: string; value: string; asset_list: { policy_id: string; asset_name: string; quantity: string }[] | null }
// Both providers lag the node by about a block, so an input our own last tx spent can still read as unspent. Every tx we
// hand to a node records its inputs here (out/spent.json, kept 15 min, across processes), and liveUtxos skips them.
const SPENT_FILE = (): string => join(ROOT, 'out', 'spent.json')
const SPENT_TTL_MS = 15 * 60_000
function spentByUs(): Map<string, number> {
  const now = Date.now()
  const m = new Map<string, number>(existsSync(SPENT_FILE()) ? (JSON.parse(readFileSync(SPENT_FILE(), 'utf8')) as [string, number][]) : [])
  for (const [ref, at] of m) if (now - at > SPENT_TTL_MS) m.delete(ref)
  return m
}
// A definite ledger refusal spent nothing (unless it was refused because those inputs are already spent).
export function unmarkSpent(refs: string[]): void {
  const m = spentByUs()
  for (const r of refs) m.delete(r)
  mkdirSync(join(ROOT, 'out'), { recursive: true })
  writeFileSync(SPENT_FILE(), JSON.stringify([...m]))
}
export function markSpent(refs: string[]): void {
  const m = spentByUs()
  for (const r of refs) m.set(r, Date.now())
  mkdirSync(join(ROOT, 'out'), { recursive: true })
  writeFileSync(SPENT_FILE(), JSON.stringify([...m]))
}

export async function liveUtxos(address: string): Promise<UTxO[]> {
  const fromBlockfrost = await preprodChain().fetchAddressUTxOs(address)
  const kres = await fetch(`${KOIOS.preprod}/address_utxos`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ _addresses: [address], _extended: true }), signal: AbortSignal.timeout(30_000),
  })
  if (!kres.ok) throw new Error(`Koios address_utxos HTTP ${kres.status}: cannot list the UTxOs on a second provider`)
  const fromKoios: UTxO[] = ((await kres.json()) as KoiosUtxo[]).map((r) => ({
    input: { txHash: r.tx_hash, outputIndex: r.tx_index },
    output: { address: r.address, amount: [{ unit: 'lovelace', quantity: r.value }, ...(r.asset_list ?? []).map((a) => ({ unit: a.policy_id + a.asset_name, quantity: a.quantity }))] },
  }))
  const byRef = new Map<string, UTxO>()
  for (const u of [...fromKoios, ...fromBlockfrost]) byRef.set(`${u.input.txHash}#${u.input.outputIndex}`, u)
  const listed = [...byRef.values()]
  if (listed.length === 0) return []
  const status = await utxoStatus([...byRef.keys()])
  const ours = spentByUs()
  return listed.filter((u) => status.get(`${u.input.txHash}#${u.input.outputIndex}`) === 'unspent' && !ours.has(`${u.input.txHash}#${u.input.outputIndex}`))
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
      // The node quotes the whole script in base64 inside a phase-2 failure: cut it out, so the CEK reason survives truncation.
      throw new LedgerRejection(text.replace(/[A-Za-z0-9+/]{200,}={0,2}/g, '<script bytes>').slice(0, 1500))
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
export function preprodSubmitter(via?: 'koios' | 'blockfrost'): Submitter {
  loadEnv()
  if ((via ?? process.env.SUBMIT_VIA) === 'blockfrost') {
    const id = requireEnv('BLOCKFROST_PREPROD_PROJECT_ID')
    if (!id.startsWith('preprod')) throw new PreprodOnlyError('BLOCKFROST_PREPROD_PROJECT_ID is not a preprod project id')
    return { via: 'blockfrost', submitTx: (cborHex) => postCbor(`${BLOCKFROST_PREPROD}/tx/submit`, cborHex, { project_id: id }) }
  }
  return { via: 'koios', submitTx: (cborHex) => postCbor(`${KOIOS.preprod}/submittx`, cborHex, {}) }
}
