import assert from 'node:assert/strict'
import { test } from 'node:test'
import { V1_ADDRESS } from '../../shared/constants.ts'
import { assertPreprod, assertPreprodAddress, msAt, PreprodOnlyError, refusalPhase, slotAt } from './chain.ts'
import { EnvError, loadEnv, rootKey } from './env.ts'
import { mesh } from './mesh.ts'
import { checkTx, cooldownFrom, COOLDOWN_MARGIN_MS, TxRuleError, txWindow, type TxWindow } from './tx.ts'
import { party } from './wallet.ts'

const MAINNET_ADDR = 'addr1qyfuahzn3rpnlah2ctcdjxdfl4230ygdar00qxc32guetexyg7nun6hggw9g2gpnayzf22sksr0aqdgkdcvqpc2stwtqgrp4f9'
const W: TxWindow = { fromSlot: 135_579_000, toSlot: 135_579_300, fromMs: msAt(135_579_000), toMs: msAt(135_579_300) }
const IN = ['aa'.repeat(32) + '#0']

async function throwaway(): Promise<{ address: string; pkh: string }> {
  const w = new mesh.MeshWallet({ networkId: 0, key: { type: 'root', bech32: mesh.MeshWallet.brew(true) as string } })
  await w.init()
  const address = await w.getChangeAddress()
  return { address, pkh: mesh.deserializeAddress(address).pubKeyHash }
}
const ok = (a: { pkh: string }, more: Partial<Parameters<typeof checkTx>[1]> = {}): Parameters<typeof checkTx>[1] => ({ signers: [a.pkh], inputs: IN, window: W, ...more })

// Offline body (explicit input, no fetcher). Each flag removes one rule so the guard can be shown to refuse it.
function body(a: { address: string; pkh: string }, o: { upper?: boolean; lower?: boolean; signer?: boolean; to?: string } = {}): string {
  const b = new mesh.MeshTxBuilder({}).setNetwork('preprod')
    .txIn('aa'.repeat(32), 0, [{ unit: 'lovelace', quantity: '20000000' }], a.address, 0)
    .txOut(o.to ?? a.address, [{ unit: 'lovelace', quantity: '3000000' }])
  if (o.lower !== false) b.invalidBefore(W.fromSlot)
  if (o.signer !== false) b.requiredSignerHash(a.pkh)
  if (o.upper !== false) b.invalidHereafter(W.toSlot)
  return b.changeAddress(a.address).completeSync()
}

test('Q-H: preprod slot constants reproduce the measured tip (Koios block 5259347)', () => {
  assert.equal(slotAt(1_791_262_222_000, 'down'), 135_579_022)
  assert.equal(msAt(135_579_022), 1_791_262_222_000)
  assert.equal(slotAt(1_791_262_222_400, 'down'), 135_579_022)
  assert.equal(slotAt(1_791_262_222_400, 'up'), 135_579_023)
})

test('window: ±150 s, each bound nudged one slot outward', () => {
  const now = 1_791_262_222_500
  const w = txWindow(now)
  assert.ok(w.fromMs <= now - 150_000 - 1_000 && w.fromMs > now - 150_000 - 2_000)
  assert.ok(w.toMs >= now + 150_000 + 1_000 && w.toMs < now + 150_000 + 2_000)
  assert.equal(w.fromMs, msAt(w.fromSlot))
  assert.equal(w.toMs, msAt(w.toSlot))
})

test('cooldown is written from the upper bound, never from now', () => {
  const now = 1_791_262_222_000
  const wide = txWindow(now, 150_000, 30 * 60_000)
  assert.equal(cooldownFrom(wide), wide.toMs + COOLDOWN_MARGIN_MS)
  assert.ok(cooldownFrom(wide) >= wide.toMs + 420_000, 'covers the 7-minute V1 period past current_time')
})

test('preprod guard refuses mainnet', () => {
  assert.throws(() => assertPreprod('mainnet'), PreprodOnlyError)
  assert.throws(() => assertPreprodAddress(MAINNET_ADDR), PreprodOnlyError)
  assertPreprod('preprod')
  assertPreprodAddress(V1_ADDRESS.preprod)
})

test('checkTx: no tx without an upper bound (with its positive control)', async () => {
  const a = await throwaway()
  checkTx(body(a), ok(a)) // positive control: the complete body passes
  assert.throws(() => checkTx(body(a, { upper: false }), ok(a)), (e: unknown) => e instanceof TxRuleError && /upper validity bound/.test(e.message))
})

test('checkTx: no tx without a lower bound', async () => {
  const a = await throwaway()
  assert.throws(() => checkTx(body(a, { lower: false }), ok(a)), (e: unknown) => e instanceof TxRuleError && /lower validity bound/.test(e.message))
})

test('checkTx: the body carries the window the datum was computed from', async () => {
  const a = await throwaway()
  const later: TxWindow = { ...W, toSlot: W.toSlot + 1800, toMs: msAt(W.toSlot + 1800) }
  assert.throws(() => checkTx(body(a), ok(a, { window: later })), (e: unknown) => e instanceof TxRuleError && /upper bound/.test(e.message))
})

test('checkTx: signer must be declared in required signers', async () => {
  const a = await throwaway()
  assert.throws(() => checkTx(body(a, { signer: false }), ok(a)), TxRuleError)
})

test('checkTx: refuses mainnet outputs and unexpected escrow outputs', async () => {
  const a = await throwaway()
  assert.throws(() => checkTx(body(a, { to: MAINNET_ADDR }), ok(a)), PreprodOnlyError)
  assert.throws(() => checkTx(body(a, { to: V1_ADDRESS.preprod }), ok(a)), TxRuleError)
  checkTx(body(a, { to: V1_ADDRESS.preprod }), ok(a, { maxScriptOutputs: 1 }))
})

test('checkTx: the body spends exactly the inputs given', async () => {
  const a = await throwaway()
  checkTx(body(a), ok(a))
  assert.throws(() => checkTx(body(a), ok(a, { inputs: ['bb'.repeat(32) + '#0'] })), TxRuleError)
})

test('keys: a mnemonic is refused and never echoed', () => {
  loadEnv() // load the real file first, so the in-memory values below are not overwritten by it
  const saved = process.env.PREPROD_ADMIN_SKEY
  try {
    process.env.PREPROD_ADMIN_SKEY = 'abandon '.repeat(23) + 'art'
    assert.throws(() => rootKey('admin'), (e: unknown) => e instanceof EnvError && !e.message.includes('abandon'))
    const key = mesh.MeshWallet.brew(true) as string
    process.env.PREPROD_ADMIN_SKEY = key
    assert.ok(rootKey('admin') === key, 'a bech32 root key is accepted') // boolean only: a failure never prints a key
  } finally {
    if (saved === undefined) delete process.env.PREPROD_ADMIN_SKEY
    else process.env.PREPROD_ADMIN_SKEY = saved
  }
})

test('keys: a key with a bad checksum is refused without quoting it (message or stack)', async () => {
  loadEnv()
  const saved = process.env.PREPROD_ADMIN_SKEY
  try {
    const key = mesh.MeshWallet.brew(true) as string
    const i = key.length - 3
    const bad = key.slice(0, i) + (key[i] === 'q' ? 'p' : 'q') + key.slice(i + 1) // still in the bech32 charset
    process.env.PREPROD_ADMIN_SKEY = bad
    let caught: unknown = null
    await party('admin').catch((e: unknown) => (caught = e))
    assert.ok(caught instanceof EnvError, 'a decoding failure becomes an EnvError')
    const text = caught instanceof Error ? `${caught.message}\n${caught.stack ?? ''}` : ''
    assert.ok(!text.includes(bad.slice(8, 40)), 'neither message nor stack contains the key') // boolean only
  } finally {
    if (saved === undefined) delete process.env.PREPROD_ADMIN_SKEY
    else process.env.PREPROD_ADMIN_SKEY = saved
  }
})

test('refusal phase: only a script failure is a validator refusal (real Conway texts)', () => {
  // Phase 1, seen on preprod on 6 Oct: Mesh's stale cost model.
  assert.equal(refusalPhase('ConwayUtxowFailure (ScriptIntegrityHashMismatch Mismatch (RelEQ) {supplied: SJust (SafeHash "bf9d…"), expected: SJust (SafeHash "7603…")}'), 1)
  assert.equal(refusalPhase('ConwayUtxowFailure (UtxoFailure (BadInputsUTxO (fromList [TxIn (TxId {unTxId = SafeHash "aa…"}) (TxIx 0)])))'), 1)
  assert.equal(refusalPhase('ConwayUtxowFailure (UtxoFailure (OutsideValidityIntervalUTxO (ValidityInterval …) (SlotNo 1)))'), 1)
  assert.equal(refusalPhase('ConwayUtxowFailure (ScriptWitnessNotValidatingUTXOW (fromList [ScriptHash "bd2a…"]))'), 1)
  assert.equal(refusalPhase('ConwayUtxowFailure (UtxoFailure (UtxosFailure (ValidationTagMismatch (IsValid False) PassedUnexpectedly)))'), 1)
  // Phase 2: the script ran and failed.
  assert.equal(refusalPhase('ConwayUtxowFailure (UtxoFailure (UtxosFailure (ValidationTagMismatch (IsValid True) (FailedUnexpectedly (PlutusFailure "…" :| [])))))'), 2)
  assert.equal(refusalPhase('ConwayUtxowFailure (UtxoFailure (UtxosFailure (CollectErrors [] ) PlutusFailure …'), 2)
})
