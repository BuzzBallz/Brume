import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createPublicKey, verify } from 'node:crypto'
import { join } from 'node:path'
import type { Asset, Protocol, UTxO } from '@meshsdk/core'
import type { Network, TxLogEntry } from '../../shared/types.ts'
import { V1_ADDRESS } from '../../shared/constants.ts'
import { AmbiguousSubmit, markSpent, unmarkSpent, assertPreprod, assertPreprodAddress, blockfrostGet, LedgerRejection, msAt, preprodChain, refusalPhase, seenByChain, slotAt, type Submitter } from './chain.ts'
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

export type TxOut = { address: string; amount: Asset[]; datumCbor?: string } // datumCbor: inline datum (an escrow lock)
export type PlainTx = {
  network: Network
  window: TxWindow
  signers: Party[] // declared as required signers, and the only keys that sign
  inputs: UTxO[] // explicit; the builder never selects from a whole wallet
  outputs: TxOut[]
  changeAddress: string
  maxScriptOutputs?: number // 1 for a lock into the escrow, 0 otherwise
  scriptAddress?: string // the escrow address in use (the shared V1 by default, our own deployment for S-2)
}

export type Built = { cborHex: string; txHash: string }

// What every built body must satisfy before anyone signs it. Reads the CBOR, not the spec that produced it.
export function checkTx(cborHex: string, expect: { signers: string[]; inputs: string[]; window: TxWindow; maxScriptOutputs?: number; scriptAddress?: string; coinsPerUtxoByte?: number }): void {
  const body = cst.deserializeTx(cborHex).body()
  // The body must carry the window the datum was computed from: a cooldown is only safe relative to this upper bound.
  if (body.ttl() !== undefined && Number(body.ttl()) !== expect.window.toSlot) throw new TxRuleError(`upper bound ${body.ttl()} is not the window's ${expect.window.toSlot}`)
  if (body.validityStartInterval() !== undefined && Number(body.validityStartInterval()) !== expect.window.fromSlot) throw new TxRuleError(`lower bound ${body.validityStartInterval()} is not the window's ${expect.window.fromSlot}`)
  // Exactly the inputs asked for: the two-UTxO rule depends on no input ever being added behind our back.
  const got = body.inputs().toCore().map((i) => `${i.txId}#${i.index}`).sort()
  const want = [...expect.inputs].sort()
  if (got.join() !== want.join()) throw new TxRuleError(`inputs differ from the ones given: ${got.length} in the body, ${want.length} given`)
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
    if (address === (expect.scriptAddress ?? V1_ADDRESS.preprod)) {
      scriptOutputs++
      if (o.scriptRef() !== undefined) throw new TxRuleError('an escrow output carries a reference script')
    }
  }
  if (scriptOutputs > (expect.maxScriptOutputs ?? 0)) throw new TxRuleError(`${scriptOutputs} escrow outputs, at most ${expect.maxScriptOutputs ?? 0} allowed`)
  // Min-UTxO is a phase-1 rule evaluation never runs: a pre-signed leg 2 that passes evaluation but leaves an output under
  // it would be refused AFTER the concession. Ledger rule: lovelace ≥ (160 + serialized output size) × coinsPerUTxOByte.
  if (expect.coinsPerUtxoByte !== undefined) {
    body.outputs().forEach((o, i) => {
      const min = BigInt(160 + o.toCbor().length / 2) * BigInt(expect.coinsPerUtxoByte as number)
      const has = o.amount().coin()
      if (has < min) throw new TxRuleError(`output ${i} holds ${has} lovelace, under its ${min} minimum: this split would be refused by the ledger`)
    })
  }
}

// The minimum lovelace an output needs, for a check made before a tx is built (e.g. a proposed split).
export const minLovelaceFor = (outputCborBytes: number, coinsPerUtxoByte: number): bigint => BigInt(160 + outputCborBytes) * BigInt(coinsPerUtxoByte)

let params: Promise<Protocol> | null = null
// A failed fetch is not cached: the next build retries (an HTTP error is a hole, never a cached value).
export const protocol = (): Promise<Protocol> =>
  (params ??= preprodChain().fetchProtocolParameters().catch((error: unknown) => {
    params = null
    throw error
  }))

export async function buildPlain(spec: PlainTx): Promise<Built> {
  assertPreprod(spec.network)
  if (spec.inputs.length === 0) throw new TxRuleError('no inputs given')
  for (const u of spec.inputs) assertPreprodAddress(u.output.address)
  for (const o of spec.outputs) assertPreprodAddress(o.address)
  assertPreprodAddress(spec.changeAddress)
  // The fetcher only completes the given inputs; no input selection is ever called on this builder.
  const pp = await protocol()
  const b = new mesh.MeshTxBuilder({ fetcher: preprodChain(), params: pp }).setNetwork('preprod')
  for (const u of spec.inputs) b.txIn(u.input.txHash, u.input.outputIndex, u.output.amount, u.output.address)
  for (const o of spec.outputs) {
    b.txOut(o.address, o.amount)
    if (o.datumCbor) b.txOutInlineDatumValue(o.datumCbor, 'CBOR')
  }
  for (const s of spec.signers) b.requiredSignerHash(s.pkh)
  b.invalidBefore(spec.window.fromSlot).invalidHereafter(spec.window.toSlot).changeAddress(spec.changeAddress)
  const cborHex = await b.complete()
  checkTx(cborHex, { signers: spec.signers.map((s) => s.pkh), inputs: spec.inputs.map((u) => `${u.input.txHash}#${u.input.outputIndex}`), window: spec.window, maxScriptOutputs: spec.maxScriptOutputs ?? 0, scriptAddress: spec.scriptAddress, coinsPerUtxoByte: Number(pp.coinsPerUtxoSize) })
  return { cborHex, txHash: mesh.resolveTxHash(cborHex) }
}

// Adds one party's witness. The body, hence the hash, must not move: leg 2 is signed against leg 1's hash.
export async function addWitness(built: Built, by: Party): Promise<Built> {
  const signed = await by.wallet.signTx(built.cborHex, true)
  const txHash = mesh.resolveTxHash(signed)
  if (txHash !== built.txHash) throw new TxRuleError(`signing changed the tx hash (${built.txHash.slice(0, 8)}… → ${txHash.slice(0, 8)}…)`)
  return { cborHex: signed, txHash }
}

const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex')

// True iff the tx carries a witness from key hash `pkh` whose signature verifies over this tx's body hash.
// This, never Proposal.signedBy, is what submit() trusts.
export function hasValidWitness(cborHex: string, pkh: string): boolean {
  const txHash = Buffer.from(mesh.resolveTxHash(cborHex), 'hex')
  for (const w of cst.deserializeTx(cborHex).witnessSet().vkeys()?.values() ?? []) {
    const vkey = Buffer.from(w.vkey(), 'hex')
    if (cst.blake2b(28).update(vkey).digest('hex') !== pkh) continue
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, vkey]), format: 'der', type: 'spki' })
    if (verify(null, txHash, key, Buffer.from(w.signature(), 'hex'))) return true
  }
  return false
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

type LogBase = Pick<TxLogEntry, 'step' | 'network' | 'scriptHash' | 'txHash' | 'atMs' | 'via'>

// Hands the tx to one node. A ledger rejection becomes a refused entry with its phase; a transport failure
// (SubmitTransportError) is thrown: it is a hole, and must never be logged or shown as a refusal.
// An AmbiguousSubmit is settled by the chain, never by the HTTP status: seen in the mempool or a block → submitted (null);
// not seen → rethrown, and the caller must treat the tx as possibly live (never "prepare again" over it).
export async function submitOnly(signed: Built, submitter: Submitter, base: LogBase): Promise<TxLogEntry | null> {
  try {
    // Recorded before the call: once the bytes may have reached a node, these inputs are ours to treat as spent.
    markSpent(cst.deserializeTx(signed.cborHex).body().inputs().toCore().map((i) => `${i.txId}#${i.index}`))
    const returned = await submitter.submitTx(signed.cborHex)
    if (returned && returned !== signed.txHash) throw new TxRuleError(`submitter returned ${returned}, expected ${signed.txHash}`)
    return null
  } catch (error: unknown) {
    if (error instanceof AmbiguousSubmit) {
      if (await seenByChain(signed.txHash)) return null
      throw error
    }
    if (!(error instanceof LedgerRejection)) throw error
    if (!/BadInputsUTxO|All inputs are spent/i.test(error.message)) unmarkSpent(cst.deserializeTx(signed.cborHex).body().inputs().toCore().map((i) => `${i.txId}#${i.index}`))
    return { ...base, status: 'refused', stage: 'submit', refusal: { phase: refusalPhase(error.message), ledgerError: error.message }, error: error.message.slice(0, 600) }
  }
}

// Waits for the tx to be in a block on Blockfrost and pins it to that block. A read error is a hole: it keeps polling,
// and the caller always gets an entry for a submitted tx.
export async function confirmTx(base: LogBase, timeoutMs = 300_000): Promise<TxLogEntry> {
  const deadline = Date.now() + timeoutMs
  let holes = 0
  for (let wait = 5_000; Date.now() < deadline; wait = Math.min(wait * 2, 20_000)) {
    await sleep(wait)
    let tx: { block: string; block_height: number; slot: number; valid_contract: boolean } | null
    try {
      tx = await blockfrostGet(`/txs/${base.txHash}`)
    } catch {
      holes++
      continue
    }
    if (tx) {
      const entry: TxLogEntry = { ...base, status: 'accepted', stage: 'confirm', block: { height: tx.block_height, hash: tx.block, slot: tx.slot } }
      // valid_contract false = phase 2 failed on chain and collateral was taken: never report that as accepted.
      return tx.valid_contract ? entry : { ...entry, status: 'refused', refusal: { phase: 2, ledgerError: 'valid_contract=false (collateral consumed)' } }
    }
  }
  return { ...base, status: 'accepted', stage: 'submit', error: `submitted, not seen in a block within ${timeoutMs / 1000} s (${holes} read holes): pending, not confirmed` }
}

// scriptHash: the validator the tx ran, '' when none.
export async function submitAndConfirm(signed: Built, submitter: Submitter, step: string, atMs: number, scriptHash = '', timeoutMs = 300_000): Promise<TxLogEntry> {
  const base: LogBase = { step, network: 'preprod', scriptHash, txHash: signed.txHash, atMs, via: submitter.via }
  return (await submitOnly(signed, submitter, base)) ?? confirmTx(base, timeoutMs)
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
