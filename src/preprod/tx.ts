import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Asset, Protocol, UTxO } from '@meshsdk/core'
import type { Network, TxLogEntry } from '../../shared/types.ts'
import { V1_ADDRESS } from '../../shared/constants.ts'
import { assertPreprod, assertPreprodAddress, blockfrostGet, LedgerRejection, msAt, preprodChain, refusalPhase, slotAt, type Submitter } from './chain.ts'
import { ROOT } from './env.ts'
import { cst, mesh } from './mesh.ts'
import type { Party } from './wallet.ts'

// SPEC-VALIDATOR §7 + SPEC-TRANSACTIONS §1, enforced here for every transaction this repo builds.

export class TxRuleError extends Error {}

export type TxWindow = { fromSlot: number; toSlot: number; fromMs: number; toMs: number }

export const WINDOW_MARGIN_MS = 150_000
export const COOLDOWN_MARGIN_MS = 35 * 60_000

// Default window ≈ now − 150 s / now + 150 s, each bound nudged one slot outward. Pre-signed legs pass wider margins.
export function txWindow(nowMs: number, beforeMs = WINDOW_MARGIN_MS, afterMs = WINDOW_MARGIN_MS): TxWindow {
  const fromSlot = slotAt(nowMs - beforeMs, 'down') - 1
  const toSlot = slotAt(nowMs + afterMs, 'up') + 1
  return { fromSlot, toSlot, fromMs: msAt(fromSlot), toMs: msAt(toSlot) }
}

// The validator's current_time IS the tx upper bound, so a continuation cooldown is written from it, never from now,
// and with a wide margin rather than the computed minimum (a tight one is a refusal with no useful message).
export const cooldownFrom = (w: TxWindow): number => w.toMs + COOLDOWN_MARGIN_MS

export type TxOut = { address: string; amount: Asset[] }
export type PlainTx = {
  network: Network
  window: TxWindow
  signers: Party[] // declared as required signers, and the only keys that sign
  inputs: UTxO[] // explicit; the builder never selects from a whole wallet
  outputs: TxOut[]
  changeAddress: string
}

export type Built = { cborHex: string; txHash: string }

// What every built body must satisfy before anyone signs it. Reads the CBOR, not the spec that produced it.
export function checkTx(cborHex: string, expect: { signers: string[]; maxScriptOutputs?: number; inputs?: string[] }): void {
  const body = cst.deserializeTx(cborHex).body()
  if (expect.inputs) {
    // Exactly the inputs asked for: the two-UTxO rule depends on no input ever being added behind our back.
    const got = body.inputs().toCore().map((i) => `${i.txId}#${i.index}`).sort()
    const want = [...expect.inputs].sort()
    if (got.join() !== want.join()) throw new TxRuleError(`inputs differ from the ones given: ${got.length} in the body, ${want.length} given`)
  }
  if (body.ttl() === undefined) throw new TxRuleError('no upper validity bound (invalid_hereafter): the validator fails every branch without one')
  if (body.validityStartInterval() === undefined) throw new TxRuleError('no lower validity bound (invalid_before)')
  const required = new Set<string>(body.requiredSigners()?.toCore() ?? [])
  for (const s of expect.signers) if (!required.has(s)) throw new TxRuleError(`signer ${s.slice(0, 8)}… is not declared in required signers`)
  const net = body.networkId()
  if (net !== undefined && net !== 0) throw new TxRuleError('body network id is not testnet')
  let scriptOutputs = 0
  for (const o of body.outputs()) {
    const address = o.address().toBech32()
    assertPreprodAddress(address)
    if (address === V1_ADDRESS.preprod) {
      scriptOutputs++
      if (o.scriptRef() !== undefined) throw new TxRuleError('an escrow output carries a reference script')
    }
  }
  if (scriptOutputs > (expect.maxScriptOutputs ?? 0)) throw new TxRuleError(`${scriptOutputs} escrow outputs, at most ${expect.maxScriptOutputs ?? 0} allowed`)
}

let params: Promise<Protocol> | null = null
const protocol = (): Promise<Protocol> => (params ??= preprodChain().fetchProtocolParameters())

export async function buildPlain(spec: PlainTx): Promise<Built> {
  assertPreprod(spec.network)
  if (spec.inputs.length === 0) throw new TxRuleError('no inputs given')
  for (const u of spec.inputs) assertPreprodAddress(u.output.address)
  for (const o of spec.outputs) assertPreprodAddress(o.address)
  assertPreprodAddress(spec.changeAddress)
  // The fetcher only completes the given inputs; no input selection is ever called on this builder.
  const b = new mesh.MeshTxBuilder({ fetcher: preprodChain(), params: await protocol() }).setNetwork('preprod')
  for (const u of spec.inputs) b.txIn(u.input.txHash, u.input.outputIndex, u.output.amount, u.output.address)
  for (const o of spec.outputs) b.txOut(o.address, o.amount)
  for (const s of spec.signers) b.requiredSignerHash(s.pkh)
  b.invalidBefore(spec.window.fromSlot).invalidHereafter(spec.window.toSlot).changeAddress(spec.changeAddress)
  const cborHex = await b.complete()
  checkTx(cborHex, { signers: spec.signers.map((s) => s.pkh), inputs: spec.inputs.map((u) => `${u.input.txHash}#${u.input.outputIndex}`) })
  return { cborHex, txHash: mesh.resolveTxHash(cborHex) }
}

// Adds one party's witness. The body, hence the hash, must not move: leg 2 is signed against leg 1's hash.
export async function addWitness(built: Built, by: Party): Promise<Built> {
  const signed = await by.wallet.signTx(built.cborHex, true)
  const txHash = mesh.resolveTxHash(signed)
  if (txHash !== built.txHash) throw new TxRuleError(`signing changed the tx hash (${built.txHash.slice(0, 8)}… → ${txHash.slice(0, 8)}…)`)
  return { cborHex: signed, txHash }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// Submits, then waits for the tx to be visible in a block on Blockfrost. Retries reads with backoff.
// A ledger rejection is returned as a refused entry with its phase; a transport failure (SubmitTransportError) is thrown:
// it is a hole, and must never be logged or shown as a refusal. scriptHash: the validator the tx ran, '' when none.
export async function submitAndConfirm(signed: Built, submitter: Submitter, step: string, atMs: number, scriptHash = '', timeoutMs = 300_000): Promise<TxLogEntry> {
  const base = { step, network: 'preprod' as const, scriptHash, txHash: signed.txHash, atMs, via: submitter.via }
  let returned: string
  try {
    returned = await submitter.submitTx(signed.cborHex)
  } catch (error: unknown) {
    if (!(error instanceof LedgerRejection)) throw error
    return { ...base, status: 'refused', stage: 'submit', refusal: { phase: refusalPhase(error.message), ledgerError: error.message }, error: error.message.slice(0, 600) }
  }
  if (returned && returned !== signed.txHash) throw new TxRuleError(`submitter returned ${returned}, expected ${signed.txHash}`)
  const deadline = Date.now() + timeoutMs
  for (let wait = 5_000; Date.now() < deadline; wait = Math.min(wait * 2, 20_000)) {
    await sleep(wait)
    const tx = await blockfrostGet<{ block: string; block_height: number; slot: number; valid_contract: boolean }>(`/txs/${signed.txHash}`)
    if (tx) {
      const entry: TxLogEntry = { ...base, status: 'accepted', stage: 'confirm', block: { height: tx.block_height, hash: tx.block, slot: tx.slot } }
      // valid_contract false = phase 2 failed on chain and collateral was taken: never report that as accepted.
      return tx.valid_contract ? entry : { ...entry, status: 'refused', refusal: { phase: 2, ledgerError: 'valid_contract=false (collateral consumed)' } }
    }
  }
  return { ...base, status: 'accepted', stage: 'submit', error: `submitted, not seen in a block within ${timeoutMs / 1000} s` }
}

// Append-only run log per escrow or wallet: fixtures/preprod/txlog-<name>.json (survives reloads, README evidence).
export function appendTxLog(name: string, entry: TxLogEntry): string {
  const dir = join(ROOT, 'fixtures', 'preprod')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `txlog-${name.replace(/[^A-Za-z0-9._-]/g, '_')}.json`)
  const log: TxLogEntry[] = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []
  log.push(entry)
  writeFileSync(file, JSON.stringify(log, null, 2) + '\n')
  return file
}
