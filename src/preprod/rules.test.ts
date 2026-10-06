// Offline: hasValidWitness, checkTx's min-UTxO rule and splitPot, on throwaway keys and on the two real preprod legs
// captured once from Koios (testdata/real-legs.json, both accepted in block 5259570).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { MeshWallet } from '@meshsdk/core'
import { V1_ADDRESS } from '../../shared/constants.ts'
import { msAt } from './chain.ts'
import { readDatum } from './datum.ts'
import { cst, mesh } from './mesh.ts'
import { SettleError, splitPot } from './settle.ts'
import { checkTx, hasValidWitness, minLovelaceFor, TxRuleError, type TxWindow } from './tx.ts'

type RealLeg = { leg: 1 | 2; tx_hash: string; block_height: number; cbor: string }
const LEGS = (JSON.parse(readFileSync(new URL('./testdata/real-legs.json', import.meta.url), 'utf8')) as { legs: RealLeg[] }).legs
const LEG1 = LEGS.find((l) => l.leg === 1)!
const LEG2 = LEGS.find((l) => l.leg === 2)!
const EPOCH317 = JSON.parse(readFileSync(new URL('./testdata/costmodel-epoch317.json', import.meta.url), 'utf8')) as { coins_per_utxo_size: string }
const COINS_PER_BYTE = Number(EPOCH317.coins_per_utxo_size) // 4310 on preprod, epoch 317

const W: TxWindow = { fromSlot: 135_579_000, toSlot: 135_579_300, fromMs: msAt(135_579_000), toMs: msAt(135_579_300) }
const IN = ['aa'.repeat(32) + '#0']

type Key = { wallet: MeshWallet; address: string; pkh: string }
async function throwaway(): Promise<Key> {
  const wallet = new mesh.MeshWallet({ networkId: 0, key: { type: 'root', bech32: mesh.MeshWallet.brew(true) as string } })
  await wallet.init()
  const address = await wallet.getChangeAddress()
  return { wallet, address, pkh: mesh.deserializeAddress(address).pubKeyHash }
}

// Offline body: one explicit input, one output of `quantity` lovelace to `to`, change back to `a`.
function body(a: { address: string; pkh: string }, quantity = '3000000', to = a.address): string {
  return new mesh.MeshTxBuilder({}).setNetwork('preprod')
    .txIn('aa'.repeat(32), 0, [{ unit: 'lovelace', quantity: '20000000' }], a.address, 0)
    .txOut(to, [{ unit: 'lovelace', quantity }])
    .requiredSignerHash(a.pkh)
    .invalidBefore(W.fromSlot)
    .invalidHereafter(W.toSlot)
    .changeAddress(a.address)
    .completeSync()
}

const pkhOf = (vkeyHex: string): string => cst.blake2b(28).update(Buffer.from(vkeyHex, 'hex')).digest('hex')
// The same body with another tx's witness set grafted on: the signature then covers a different body hash.
const graft = (bodyOf: string, witnessesOf: string): string =>
  new cst.Transaction(cst.deserializeTx(bodyOf).body(), cst.deserializeTx(witnessesOf).witnessSet(), cst.deserializeTx(bodyOf).auxiliaryData()).toCbor()
const datumOf = (cborHex: string) => readDatum(cst.deserializeTx(cborHex).body().outputs()[0]!.datum()!.asInlineData()!.toCbor())

// --- hasValidWitness ---

test('hasValidWitness: a throwaway buyer\'s witness verifies; the unsigned body has none (positive and negative)', async () => {
  const buyer = await throwaway()
  const unsigned = body(buyer)
  const signed = await buyer.wallet.signTx(unsigned, true)
  assert.equal(mesh.resolveTxHash(signed), mesh.resolveTxHash(unsigned), 'signing does not move the hash')
  assert.equal(hasValidWitness(signed, buyer.pkh), true)
  assert.equal(hasValidWitness(unsigned, buyer.pkh), false)
})

test('hasValidWitness: a valid witness from another key is not the buyer\'s', async () => {
  const buyer = await throwaway()
  const other = await throwaway()
  const signedByOther = await other.wallet.signTx(body(buyer), true)
  assert.equal(hasValidWitness(signedByOther, other.pkh), true) // positive control: the witness itself is valid
  assert.equal(hasValidWitness(signedByOther, buyer.pkh), false)
})

test('hasValidWitness: the buyer\'s witness over a different body does not count', async () => {
  const buyer = await throwaway()
  const a = body(buyer, '3000000')
  const b = body(buyer, '3000001')
  assert.notEqual(mesh.resolveTxHash(a), mesh.resolveTxHash(b))
  const signedA = await buyer.wallet.signTx(a, true)
  const bWithAsWitness = graft(b, signedA)
  // The vkey is the buyer's, so only the signature check can refuse it.
  assert.deepEqual([...(cst.deserializeTx(bWithAsWitness).witnessSet().vkeys()?.values() ?? [])].map((w) => pkhOf(w.vkey())), [buyer.pkh])
  assert.equal(hasValidWitness(bWithAsWitness, buyer.pkh), false)
  assert.equal(hasValidWitness(await buyer.wallet.signTx(b, true), buyer.pkh), true) // positive control on body b
})

test('hasValidWitness: the real preprod leg 2 carries valid buyer and seller witnesses; a third key does not', async () => {
  const d = datumOf(LEG1.cbor) // leg 1's escrow output names the parties
  assert.equal(mesh.resolveTxHash(LEG2.cbor), LEG2.tx_hash)
  assert.equal(hasValidWitness(LEG2.cbor, d.buyer.payment.hash), true)
  assert.equal(hasValidWitness(LEG2.cbor, d.seller.payment.hash), true)
  assert.equal(hasValidWitness(LEG1.cbor, d.seller.payment.hash), true)
  assert.equal(hasValidWitness(LEG1.cbor, d.buyer.payment.hash), false) // leg 1 is the seller's alone
  assert.equal(hasValidWitness(LEG2.cbor, (await throwaway()).pkh), false)
  // The real leg-1 witnesses grafted onto leg 2: the seller's vkey is there, its signature is over another body.
  assert.equal(hasValidWitness(graft(LEG2.cbor, LEG1.cbor), d.seller.payment.hash), false)
})

// --- checkTx: min-UTxO ---

const ok = (a: { pkh: string }, coinsPerUtxoByte?: number): Parameters<typeof checkTx>[1] => ({ signers: [a.pkh], inputs: IN, window: W, coinsPerUtxoByte })
const outputBytes = (cborHex: string, i: number): number => cst.deserializeTx(cborHex).body().outputs()[i]!.toCbor().length / 2

test('checkTx min-UTxO: an output at exactly (160 + size) × coinsPerUtxoByte passes, one lovelace under throws', async () => {
  const a = await throwaway()
  const size = outputBytes(body(a, '1000000'), 0)
  const min = minLovelaceFor(size, COINS_PER_BYTE)
  assert.equal(min, BigInt(160 + size) * 4310n)
  const at = body(a, min.toString())
  const under = body(a, (min - 1n).toString())
  // Same CBOR width for both quantities, so the minimum is the same for both outputs.
  assert.equal(outputBytes(at, 0), size)
  assert.equal(outputBytes(under, 0), size)
  checkTx(at, ok(a, COINS_PER_BYTE))
  checkTx(body(a, (min + 1n).toString()), ok(a, COINS_PER_BYTE))
  assert.throws(() => checkTx(under, ok(a, COINS_PER_BYTE)), (e: unknown) => e instanceof TxRuleError && e.message.includes(`output 0 holds ${min - 1n} lovelace, under its ${min} minimum`))
})

test('checkTx min-UTxO: a far-under output throws; without coinsPerUtxoByte the rule is not applied', async () => {
  const a = await throwaway()
  const tiny = body(a, '500000')
  assert.throws(() => checkTx(tiny, ok(a, COINS_PER_BYTE)), (e: unknown) => e instanceof TxRuleError && /under its .* minimum/.test(e.message))
  checkTx(tiny, ok(a)) // no coinsPerUtxoByte: only the other rules run
})

test('checkTx: both real preprod legs pass every rule, min-UTxO included, with their own window', () => {
  for (const l of [LEG1, LEG2]) {
    const b = cst.deserializeTx(l.cbor).body()
    const fromSlot = Number(b.validityStartInterval()), toSlot = Number(b.ttl())
    checkTx(l.cbor, {
      signers: b.requiredSigners()!.toCore(),
      inputs: b.inputs().toCore().map((i) => `${i.txId}#${i.index}`),
      window: { fromSlot, toSlot, fromMs: msAt(fromSlot), toMs: msAt(toSlot) },
      maxScriptOutputs: l.leg === 1 ? 1 : 0,
      scriptAddress: V1_ADDRESS.preprod,
      coinsPerUtxoByte: COINS_PER_BYTE,
    })
  }
})

// --- splitPot ---

const TOKEN = '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d'
const qty = (assets: { unit: string; quantity: string }[], unit: string): bigint => BigInt(assets.find((a) => a.unit === unit)?.quantity ?? '0')

test('splitPot: the seller gets floor(q × share) of every asset, the buyer the rest, nothing lost', () => {
  const pot = [{ unit: 'lovelace', quantity: '10' }, { unit: TOKEN, quantity: '7' }]
  const s = splitPot(pot, 0.25)
  assert.equal(qty(s.seller, 'lovelace'), 2n) // floor(2.5)
  assert.equal(qty(s.buyer, 'lovelace'), 8n)
  assert.equal(qty(s.seller, TOKEN), 1n) // floor(1.75)
  assert.equal(qty(s.buyer, TOKEN), 6n)
  const big = [{ unit: 'lovelace', quantity: '20000000000000000001' }, { unit: TOKEN, quantity: '3' }]
  const b = splitPot(big, 1 / 3)
  for (const a of big) assert.equal(qty(b.seller, a.unit) + qty(b.buyer, a.unit), BigInt(a.quantity), a.unit)
  assert.equal(qty(b.seller, TOKEN), 0n) // floor(0.999999) = 0: a zero side is omitted, not written as "0"
  assert.equal(b.seller.find((a) => a.unit === TOKEN), undefined)
})

test('splitPot: share 0 pays everything to the buyer, share 1 everything to the seller', () => {
  const pot = [{ unit: 'lovelace', quantity: '20000000' }, { unit: TOKEN, quantity: '5000000' }]
  assert.deepEqual(splitPot(pot, 0), { buyer: pot, seller: [] })
  assert.deepEqual(splitPot(pot, 1), { buyer: [], seller: pot })
})

test('splitPot: share 0.4 of the real 20 tADA pot gives the 12 / 8 tADA outputs leg 2 paid on preprod', () => {
  const s = splitPot([{ unit: 'lovelace', quantity: '20000000' }], 0.4)
  const outs = cst.deserializeTx(LEG2.cbor).body().outputs()
  const d = datumOf(LEG1.cbor)
  const toBuyer = outs.find((o) => mesh.deserializeAddress(o.address().toBech32()).pubKeyHash === d.buyer.payment.hash)!
  assert.equal(qty(s.buyer, 'lovelace'), toBuyer.amount().coin())
  assert.equal(qty(s.seller, 'lovelace'), 8_000_000n)
  assert.ok(outs.some((o) => o.amount().coin() === 8_000_000n))
})

test('splitPot: a share outside [0, 1] or not a number is refused with a readable sentence', () => {
  const pot = [{ unit: 'lovelace', quantity: '10' }]
  for (const bad of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => splitPot(pot, bad), (e: unknown) => e instanceof SettleError && e.message === 'The seller share must be between 0 and 1.', String(bad))
  }
})
