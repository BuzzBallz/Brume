import assert from 'node:assert/strict'
import { test } from 'node:test'
import { V1_ADDRESS } from '../../shared/constants.ts'
import { assertPreprod, assertPreprodAddress, msAt, PreprodOnlyError, refusalPhase, slotAt } from './chain.ts'
import { EnvError, loadEnv, rootKey } from './env.ts'
import { mesh } from './mesh.ts'
import { checkTx, cooldownFrom, COOLDOWN_MARGIN_MS, TxRuleError, txWindow } from './tx.ts'

const MAINNET_ADDR = 'addr1qyfuahzn3rpnlah2ctcdjxdfl4230ygdar00qxc32guetexyg7nun6hggw9g2gpnayzf22sksr0aqdgkdcvqpc2stwtqgrp4f9'

async function throwaway(): Promise<{ address: string; pkh: string }> {
  const w = new mesh.MeshWallet({ networkId: 0, key: { type: 'root', bech32: mesh.MeshWallet.brew(true) as string } })
  await w.init()
  const address = await w.getChangeAddress()
  return { address, pkh: mesh.deserializeAddress(address).pubKeyHash }
}

// Offline body (explicit input, no fetcher). Each flag removes one rule so the guard can be shown to refuse it.
function body(a: { address: string; pkh: string }, o: { upper?: boolean; signer?: boolean; to?: string } = {}): string {
  const b = new mesh.MeshTxBuilder({}).setNetwork('preprod')
    .txIn('aa'.repeat(32), 0, [{ unit: 'lovelace', quantity: '20000000' }], a.address)
    .txOut(o.to ?? a.address, [{ unit: 'lovelace', quantity: '3000000' }])
    .invalidBefore(135_579_000)
  if (o.signer !== false) b.requiredSignerHash(a.pkh)
  if (o.upper !== false) b.invalidHereafter(135_579_300)
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
  checkTx(body(a), { signers: [a.pkh] }) // positive control: the complete body passes
  assert.throws(() => checkTx(body(a, { upper: false }), { signers: [a.pkh] }), (e: unknown) => e instanceof TxRuleError && /upper validity bound/.test(e.message))
})

test('checkTx: signer must be declared in required signers', async () => {
  const a = await throwaway()
  assert.throws(() => checkTx(body(a, { signer: false }), { signers: [a.pkh] }), TxRuleError)
})

test('checkTx: refuses mainnet outputs and unexpected escrow outputs', async () => {
  const a = await throwaway()
  assert.throws(() => checkTx(body(a, { to: MAINNET_ADDR }), { signers: [a.pkh] }), PreprodOnlyError)
  assert.throws(() => checkTx(body(a, { to: V1_ADDRESS.preprod }), { signers: [a.pkh] }), TxRuleError)
  checkTx(body(a, { to: V1_ADDRESS.preprod }), { signers: [a.pkh], maxScriptOutputs: 1 })
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

test("checkTx: the body spends exactly the inputs given", async () => {
  const a = await throwaway()
  checkTx(body(a), { signers: [a.pkh], inputs: ['aa'.repeat(32) + '#0'] })
  assert.throws(() => checkTx(body(a), { signers: [a.pkh], inputs: ['bb'.repeat(32) + '#0'] }), TxRuleError)
})

test("refusal phase: only a script failure is a validator refusal", () => {
  assert.equal(refusalPhase('ConwayUtxowFailure (UtxoFailure (BadInputsUTxO (fromList [...])))'), 1)
  assert.equal(refusalPhase('ConwayUtxowFailure (UtxoFailure (UtxosFailure (ValidationTagMismatch (IsValid True) (FailedUnexpectedly (PlutusFailure ...'), 2)
  assert.equal(refusalPhase('OutsideValidityIntervalUTxO'), 1)
})
