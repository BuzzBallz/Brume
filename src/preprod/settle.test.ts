// Offline: settle.ts checkBeforeConcession and witness(), on the two real preprod legs (testdata/real-legs.json) and on
// throwaway-key legs built without a fetcher. Koios utxo_info is answered by a stubbed fetch; nothing is signed with a
// real key, nothing is submitted, and no file is written (each witness() test checks the seller record stays absent).
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import type { MeshWallet } from '@meshsdk/core'
import type { Proposal } from '../../shared/types.ts'
import { V1_ADDRESS } from '../../shared/constants.ts'
import { msAt } from './chain.ts'
import { encodeDatum, readDatum } from './datum.ts'
import { ROOT } from './env.ts'
import { fixtureDatum, MIN } from './fixture.ts'
import { cst, mesh } from './mesh.ts'
import { bech32Of, checkBeforeConcession, CONFIRM_MARGIN_MS, LEG1_WINDOW_MS, LEG2_AFTER_LEG1_MS, SettleError, witness } from './settle.ts'
import { hasValidWitness, txWindow, type Built } from './tx.ts'

const KOIOS_UTXO_INFO = 'https://preprod.koios.rest/api/v1/utxo_info'
const V1 = V1_ADDRESS.preprod
type SellerRecord = Parameters<typeof checkBeforeConcession>[1]
type Info = { spent: boolean; address: string }

// --- stubs ---

// Koios utxo_info answered from `known`: a ref absent from it is absent from the answer (unknown to Koios).
function stubUtxoInfo(t: TestContext, known: Map<string, Info>, status = 200): string[][] {
  const real = globalThis.fetch
  const asked: string[][] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url !== KOIOS_UTXO_INFO) throw new Error(`unexpected fetch in an offline test: ${url}`)
    const refs = (JSON.parse(String(init?.body)) as { _utxo_refs: string[] })._utxo_refs
    asked.push(refs)
    if (status !== 200) return new Response('upstream error', { status })
    const rows = refs.flatMap((r) => {
      const i = known.get(r)
      const [hash, idx] = r.split('#')
      return i ? [{ tx_hash: hash, tx_index: Number(idx), is_spent: i.spent, address: i.address }] : []
    })
    return new Response(JSON.stringify(rows), { status: 200 })
  }) as typeof fetch
  t.after(() => {
    globalThis.fetch = real
  })
  return asked
}

const rejectsWith = (p: Promise<unknown>, text: string): Promise<void> =>
  assert.rejects(p, (e: unknown) => e instanceof SettleError && e.message.includes(text))
const freshRef = (): string => randomBytes(32).toString('hex') + '#0'
const pkhOf = (vkeyHex: string): string => cst.blake2b(28).update(Buffer.from(vkeyHex, 'hex')).digest('hex')
const refsOf = (cborHex: string, part: 'inputs' | 'collateral'): string[] => {
  const b = cst.deserializeTx(cborHex).body()
  return ((part === 'inputs' ? b.inputs() : b.collateral())?.toCore() ?? []).map((i) => `${i.txId}#${i.index}`)
}
// The tx with only the vkey witnesses `keep` accepts; the body (hence the hash) is unchanged.
function keepWitnesses(cborHex: string, keep: (pkh: string) => boolean): string {
  const tx = cst.deserializeTx(cborHex)
  const ws = cst.Serialization.TransactionWitnessSet.fromCbor(tx.witnessSet().toCbor())
  const kept = [...(ws.vkeys()?.values() ?? [])].filter((w) => keep(pkhOf(w.vkey())))
  ws.setVkeys(cst.Serialization.CborSet.fromCore(kept.map((w) => w.toCore()), cst.Serialization.VkeyWitness.fromCore))
  const out = new cst.Transaction(tx.body(), ws, tx.auxiliaryData()).toCbor()
  assert.equal(mesh.resolveTxHash(out), mesh.resolveTxHash(cborHex))
  return out
}
const witnessSetOf = (signedCbor: string): string => cst.deserializeTx(signedCbor).witnessSet().toCbor()

function proposalOf(escrowRef: string, leg1: Built, leg2: Built, validToMs = Date.now() + LEG1_WINDOW_MS): Proposal {
  const leg = (b: Built, redeemer: 'AuthorizeRefund' | 'WithdrawRefund', toMs: number) => ({ redeemer, cborHex: b.cborHex, txHash: b.txHash, validFromMs: 0, validToMs: toMs, inputs: refsOf(b.cborHex, 'inputs') })
  return { escrowRef, network: 'preprod', path: 'B', sellerShare: 0.4, payout: { buyer: {}, seller: {}, fee: {} }, leg1: leg(leg1, 'AuthorizeRefund', validToMs), leg2: leg(leg2, 'WithdrawRefund', validToMs + LEG2_AFTER_LEG1_MS), signedBy: [] }
}
const recordOf = (p: Proposal, leg2Funding: string[] = []): SellerRecord => ({ escrowRef: p.escrowRef, leg1Hash: p.leg1!.txHash, leg2Hash: p.leg2!.txHash, leg2Funding })

// --- the real preprod legs ---

type RealLeg = { leg: 1 | 2; tx_hash: string; cbor: string }
const LEGS = (JSON.parse(readFileSync(new URL('./testdata/real-legs.json', import.meta.url), 'utf8')) as { legs: RealLeg[] }).legs
const R1: Built = { cborHex: LEGS.find((l) => l.leg === 1)!.cbor, txHash: LEGS.find((l) => l.leg === 1)!.tx_hash }
const R2: Built = { cborHex: LEGS.find((l) => l.leg === 2)!.cbor, txHash: LEGS.find((l) => l.leg === 2)!.tx_hash }
const RD = readDatum(cst.deserializeTx(R1.cborHex).body().outputs()[0]!.datum()!.asInlineData()!.toCbor())
const R_SELLER = bech32Of(RD.seller)
const R_BUYER = bech32Of(RD.buyer)
const R_T1 = msAt(Number(cst.deserializeTx(R1.cborHex).body().ttl()))
const R_NOW = R_T1 - 5 * MIN // a moment when leg 1 still had more than a minute to run
const R_ESCROW = refsOf(R1.cborHex, 'inputs').find((r) => !refsOf(R1.cborHex, 'collateral').includes(r))! // the escrow: leg 1's input that is not its collateral

// Koios as it was before leg 1: every input unspent, the seller's at the seller's address, the escrow at V1.
function realInfo(): Map<string, Info> {
  const m = new Map<string, Info>()
  for (const r of [...refsOf(R1.cborHex, 'inputs'), ...refsOf(R2.cborHex, 'inputs'), ...refsOf(R2.cborHex, 'collateral')]) {
    if (r === `${R1.txHash}#0`) continue // leg 1's output does not exist yet
    m.set(r, { spent: false, address: r === R_ESCROW ? V1 : R_SELLER })
  }
  return m
}
const realProposal = (escrowRef = freshRef(), leg2 = R2): Proposal => proposalOf(escrowRef, R1, leg2, R_T1)
const R2_FUNDING = refsOf(R2.cborHex, 'inputs').filter((r) => r !== `${R1.txHash}#0`)

test('real legs: the captured pair is what checkBeforeConcession expects to see', () => {
  assert.deepEqual(refsOf(R2.cborHex, 'inputs').filter((r) => r === `${R1.txHash}#0`), [`${R1.txHash}#0`], 'leg 2 spends leg1#0')
  assert.equal(cst.deserializeTx(R1.cborHex).body().outputs()[1]!.address().toBech32(), R_SELLER, 'leg 1 change goes to the datum seller')
  assert.ok(cst.deserializeTx(R2.cborHex).body().outputs().some((o) => o.address().toBech32() === R_BUYER))
  assert.equal(R2_FUNDING.length, 1)
  assert.deepEqual(refsOf(R2.cborHex, 'collateral'), R2_FUNDING)
  assert.equal(R_ESCROW.split('#')[1], '0')
})

test('checkBeforeConcession (real legs): the accepted pair passes (positive control)', async (t) => {
  const asked = stubUtxoInfo(t, realInfo())
  await checkBeforeConcession(realProposal(), recordOf(realProposal(), R2_FUNDING), R_SELLER, R_NOW)
  assert.equal(asked.length, 1)
  assert.deepEqual(new Set(asked[0]), new Set([...refsOf(R1.cborHex, 'inputs'), ...R2_FUNDING]))
})

test('checkBeforeConcession (real legs): legs that differ from the seller record are refused', async (t) => {
  stubUtxoInfo(t, realInfo())
  const p = realProposal()
  await rejectsWith(checkBeforeConcession(p, { ...recordOf(p), leg1Hash: 'ff'.repeat(32) }, R_SELLER, R_NOW), 'not the ones this seller prepared')
  await rejectsWith(checkBeforeConcession(p, { ...recordOf(p), leg2Hash: 'ff'.repeat(32) }, R_SELLER, R_NOW), 'not the ones this seller prepared')
  // The proposal's hash matches the record but its body is another tx: refused on the body.
  const swapped: Proposal = { ...p, leg2: { ...p.leg2!, cborHex: R1.cborHex } }
  await rejectsWith(checkBeforeConcession(swapped, recordOf(p), R_SELLER, R_NOW), 'body was changed')
})

test('checkBeforeConcession (real legs): a leg 2 without the buyer\'s witness is refused (seller witness alone)', async (t) => {
  stubUtxoInfo(t, realInfo())
  const sellerOnly = { ...R2, cborHex: keepWitnesses(R2.cborHex, (pkh) => pkh !== RD.buyer.payment.hash) }
  assert.equal(hasValidWitness(sellerOnly.cborHex, RD.seller.payment.hash), true)
  const p = realProposal(freshRef(), sellerOnly)
  await rejectsWith(checkBeforeConcession(p, recordOf(p), R_SELLER, R_NOW), 'must be signed by the buyer')
  const none = realProposal(freshRef(), { ...R2, cborHex: keepWitnesses(R2.cborHex, () => false) })
  await rejectsWith(checkBeforeConcession(none, recordOf(none), R_SELLER, R_NOW), 'must be signed by the buyer')
})

test('checkBeforeConcession (real legs): leg 1 under a minute from expiry, or expired, is refused', async (t) => {
  stubUtxoInfo(t, realInfo())
  const p = realProposal()
  await rejectsWith(checkBeforeConcession(p, recordOf(p), R_SELLER, R_T1 - 30_000), 'Leg 1 expired')
  await rejectsWith(checkBeforeConcession(p, recordOf(p), R_SELLER, R_T1 + MIN), 'Leg 1 expired')
  await checkBeforeConcession(p, recordOf(p), R_SELLER, R_T1 - MIN) // exactly one minute left: still allowed
})

test('checkBeforeConcession (real legs): a leg-2 input not at the seller address is refused', async (t) => {
  const info = realInfo()
  info.set(R2_FUNDING[0]!, { spent: false, address: R_BUYER })
  stubUtxoInfo(t, info)
  const p = realProposal()
  await rejectsWith(checkBeforeConcession(p, recordOf(p), R_SELLER, R_NOW), 'funded by the seller alone')
})

test('checkBeforeConcession (real legs): a spent or unknown input of either leg is refused', async (t) => {
  const spent2 = realInfo()
  spent2.set(R2_FUNDING[0]!, { spent: true, address: R_SELLER })
  const unknown2 = realInfo()
  unknown2.delete(R2_FUNDING[0]!)
  const spentEscrow = realInfo()
  spentEscrow.set(R_ESCROW, { spent: true, address: V1 })
  const unknownEscrow = realInfo()
  unknownEscrow.delete(R_ESCROW)
  const cases: [Map<string, Info>, string][] = [[spent2, 'input of leg 2 is already spent'], [unknown2, 'input of leg 2 is already spent'], [spentEscrow, 'input of leg 1 is already spent'], [unknownEscrow, 'input of leg 1 is already spent']]
  const current = new Map<string, Info>()
  stubUtxoInfo(t, current) // answers from `current`, refilled per case
  for (const [info, text] of cases) {
    current.clear()
    for (const [k, v] of info) current.set(k, v)
    const p = realProposal()
    await rejectsWith(checkBeforeConcession(p, recordOf(p), R_SELLER, R_NOW), text)
  }
})

test('checkBeforeConcession (real legs): a Koios failure is a hole, thrown as such, never a pass', async (t) => {
  stubUtxoInfo(t, realInfo(), 503)
  const p = realProposal()
  await assert.rejects(checkBeforeConcession(p, recordOf(p), R_SELLER, R_NOW), (e: unknown) => e instanceof Error && !(e instanceof SettleError) && /utxo_info HTTP 503/.test(e.message))
})

// --- throwaway-key legs, built offline ---

type Key = { wallet: MeshWallet; address: string; pkh: string }
async function throwaway(): Promise<Key> {
  const wallet = new mesh.MeshWallet({ networkId: 0, key: { type: 'root', bech32: mesh.MeshWallet.brew(true) as string } })
  await wallet.init()
  const address = await wallet.getChangeAddress()
  return { wallet, address, pkh: mesh.deserializeAddress(address).pubKeyHash }
}
type U = { ref: string; address: string; lovelace: string }
const u = (address: string, lovelace = '10000000'): U => ({ ref: freshRef(), address, lovelace })
const txIn = (x: U): [string, number, { unit: string; quantity: string }[], string, number] => [x.ref.split('#')[0]!, Number(x.ref.split('#')[1]), [{ unit: 'lovelace', quantity: x.lovelace }], x.address, 0]

type Pair = { leg1: Built; leg2: Built; escrow: U; s1: U; s2: U; collateral: U; info: Map<string, Info>; t1: number; t2: number }
type PairOpts = {
  leg2Signer?: Key | null // who signs leg 2 (default: the buyer); null = nobody
  leg2Spends?: 'leg1#0' | 'elsewhere'
  leg2Funding?: 's2' | 's1' // s1 = leg 1's own funding input
  leg2Collateral?: 's2' | 's1' | 'buyer'
  leg2AfterLeg1Ms?: number
}

// Leg 1: escrow (at V1) + seller funding s1 → output 0 back to V1 with a 16-field datum naming the parties.
// Leg 2: leg1#0 + seller funding s2 (collateral s2) → buyer and seller payouts; required signer = the datum buyer.
async function pair(buyer: Key, seller: Key, nowMs: number, o: PairOpts = {}): Promise<Pair> {
  const w1 = txWindow(nowMs, 150_000, LEG1_WINDOW_MS)
  const w2 = txWindow(nowMs, 150_000, LEG1_WINDOW_MS + (o.leg2AfterLeg1Ms ?? LEG2_AFTER_LEG1_MS))
  const named = buyer // leg 1's datum names `buyer`; leg 2 requires its signature
  const escrow = u(V1, '20000000'), s1 = u(seller.address), s2 = u(seller.address), b1 = u(buyer.address, '6000000')
  const datum = encodeDatum(fixtureDatum(named.address, seller.address, nowMs, { state: 'Disputed', unlock: 'future', collateralReturnLovelace: 0 }))
  const c1 = new mesh.MeshTxBuilder({}).setNetwork('preprod')
    .txIn(...txIn(escrow)).txIn(...txIn(s1))
    .txOut(V1, [{ unit: 'lovelace', quantity: escrow.lovelace }]).txOutInlineDatumValue(datum, 'CBOR')
    .requiredSignerHash(seller.pkh).invalidBefore(w1.fromSlot).invalidHereafter(w1.toSlot).changeAddress(seller.address)
    .completeSync()
  const leg1: Built = { cborHex: c1, txHash: mesh.resolveTxHash(c1) }
  const spent: U = o.leg2Spends === 'elsewhere' ? u(V1, '20000000') : { ref: `${leg1.txHash}#0`, address: V1, lovelace: escrow.lovelace }
  const funding = o.leg2Funding === 's1' ? s1 : s2
  const collateral = o.leg2Collateral === 's1' ? s1 : o.leg2Collateral === 'buyer' ? b1 : s2
  const [ch, ci, ca, caddr] = txIn(collateral)
  const c2 = new mesh.MeshTxBuilder({}).setNetwork('preprod')
    .txIn(...txIn(spent)).txIn(...txIn(funding)).txInCollateral(ch, ci, ca, caddr)
    .txOut(named.address, [{ unit: 'lovelace', quantity: '12000000' }]).txOut(seller.address, [{ unit: 'lovelace', quantity: '8000000' }])
    .requiredSignerHash(named.pkh).invalidBefore(w2.fromSlot).invalidHereafter(w2.toSlot).changeAddress(seller.address)
    .completeSync()
  const signer = o.leg2Signer === undefined ? buyer : o.leg2Signer
  const signed2 = signer ? await signer.wallet.signTx(c2, true) : c2
  const leg2: Built = { cborHex: signed2, txHash: mesh.resolveTxHash(signed2) }
  assert.equal(leg2.txHash, mesh.resolveTxHash(c2))
  const info = new Map<string, Info>([[escrow.ref, { spent: false, address: V1 }], [s1.ref, { spent: false, address: seller.address }], [s2.ref, { spent: false, address: seller.address }], [b1.ref, { spent: false, address: buyer.address }]])
  if (o.leg2Spends === 'elsewhere') info.set(spent.ref, { spent: false, address: V1 })
  return { leg1, leg2, escrow, s1, s2, collateral, info, t1: w1.toMs, t2: w2.toMs }
}

const NOW = Date.now()

test('checkBeforeConcession (offline legs): a well-formed throwaway pair passes (positive control)', async (t) => {
  const buyer = await throwaway(), seller = await throwaway()
  const x = await pair(buyer, seller, NOW)
  stubUtxoInfo(t, x.info)
  const p = proposalOf(freshRef(), x.leg1, x.leg2)
  await checkBeforeConcession(p, recordOf(p, [x.s2.ref]), seller.address, NOW)
})

test('checkBeforeConcession (offline legs): a leg 2 that does not spend leg1#0 is refused', async (t) => {
  const buyer = await throwaway(), seller = await throwaway()
  const x = await pair(buyer, seller, NOW, { leg2Spends: 'elsewhere' })
  assert.equal(hasValidWitness(x.leg2.cborHex, buyer.pkh), true) // the earlier buyer-witness check passes
  stubUtxoInfo(t, x.info)
  const p = proposalOf(freshRef(), x.leg1, x.leg2)
  await rejectsWith(checkBeforeConcession(p, recordOf(p), seller.address, NOW), 'does not spend leg 1\'s escrow output')
})

test('checkBeforeConcession (offline legs): a leg 2 signed by someone other than the datum buyer is refused', async (t) => {
  const buyer = await throwaway(), seller = await throwaway(), stranger = await throwaway()
  const x = await pair(buyer, seller, NOW, { leg2Signer: stranger })
  stubUtxoInfo(t, x.info)
  const p = proposalOf(freshRef(), x.leg1, x.leg2)
  await rejectsWith(checkBeforeConcession(p, recordOf(p), seller.address, NOW), 'must be signed by the buyer')
  const unsigned = await pair(buyer, seller, NOW, { leg2Signer: null })
  const q = proposalOf(freshRef(), unsigned.leg1, unsigned.leg2)
  await rejectsWith(checkBeforeConcession(q, recordOf(q), seller.address, NOW), 'must be signed by the buyer')
})

test('checkBeforeConcession (offline legs): leg 1 spending leg 2\'s funding input or collateral is refused', async (t) => {
  const buyer = await throwaway(), seller = await throwaway()
  const sharedInput = await pair(buyer, seller, NOW, { leg2Funding: 's1' })
  const sharedCollateral = await pair(buyer, seller, NOW, { leg2Collateral: 's1' })
  assert.ok(refsOf(sharedCollateral.leg2.cborHex, 'collateral').includes(sharedCollateral.s1.ref))
  assert.ok(!refsOf(sharedCollateral.leg2.cborHex, 'inputs').includes(sharedCollateral.s1.ref), 'overlap through the collateral only')
  stubUtxoInfo(t, new Map([...sharedInput.info, ...sharedCollateral.info]))
  for (const x of [sharedInput, sharedCollateral]) {
    const p = proposalOf(freshRef(), x.leg1, x.leg2)
    await rejectsWith(checkBeforeConcession(p, recordOf(p), seller.address, NOW), 'Leg 1 spends an input leg 2 needs')
  }
})

test('checkBeforeConcession (offline legs): a leg-2 collateral not at the seller address is refused', async (t) => {
  const buyer = await throwaway(), seller = await throwaway()
  const x = await pair(buyer, seller, NOW, { leg2Collateral: 'buyer' })
  stubUtxoInfo(t, x.info)
  const p = proposalOf(freshRef(), x.leg1, x.leg2)
  await rejectsWith(checkBeforeConcession(p, recordOf(p), seller.address, NOW), 'funded by the seller alone')
})

test('checkBeforeConcession (offline legs): leg 2 must outlive leg 1 by the confirmation margin', async (t) => {
  const buyer = await throwaway(), seller = await throwaway()
  const short = await pair(buyer, seller, NOW, { leg2AfterLeg1Ms: CONFIRM_MARGIN_MS - 3 * MIN })
  assert.ok(short.t2 - short.t1 < CONFIRM_MARGIN_MS)
  const enough = await pair(buyer, seller, NOW, { leg2AfterLeg1Ms: CONFIRM_MARGIN_MS })
  assert.ok(enough.t2 - enough.t1 >= CONFIRM_MARGIN_MS)
  stubUtxoInfo(t, new Map([...short.info, ...enough.info]))
  const p = proposalOf(freshRef(), short.leg1, short.leg2)
  await rejectsWith(checkBeforeConcession(p, recordOf(p), seller.address, NOW), 'stay valid well after leg 1')
  const q = proposalOf(freshRef(), enough.leg1, enough.leg2)
  await checkBeforeConcession(q, recordOf(q), seller.address, NOW) // positive control at the margin
})

test('checkBeforeConcession (offline legs): an expired leg 1 is refused', async (t) => {
  const buyer = await throwaway(), seller = await throwaway()
  const x = await pair(buyer, seller, NOW)
  stubUtxoInfo(t, x.info)
  const p = proposalOf(freshRef(), x.leg1, x.leg2)
  await rejectsWith(checkBeforeConcession(p, recordOf(p), seller.address, x.t1 + 1), 'Leg 1 expired')
})

// The parties are cached per escrowRef from whichever proposal was read last (proposalPkh), not from the leg 1 being
// checked. A forged proposal sent through witness() with the same escrowRef names an attacker as buyer; the real
// proposal's leg 2 then passes with the attacker's witness instead of the buyer's, and the seller would sign leg 1.
test('checkBeforeConcession: control for the cache case below, a leg 2 signed by the wrong key is refused on a fresh ref', async (t) => {
  const buyer = await throwaway(), seller = await throwaway(), attacker = await throwaway()
  const real = await pair(buyer, seller, NOW, { leg2Signer: attacker })
  stubUtxoInfo(t, real.info)
  const p = proposalOf(freshRef(), real.leg1, real.leg2)
  await rejectsWith(checkBeforeConcession(p, recordOf(p), seller.address, NOW), 'must be signed by the buyer')
})

test('checkBeforeConcession: the buyer is read from this proposal\'s leg 1, not from a forged proposal cached under the same escrowRef', async (t) => {
  const buyer = await throwaway(), seller = await throwaway(), attacker = await throwaway()
  const ref = freshRef()
  // 1. A forged proposal, same escrowRef, whose leg 1 datum names the attacker as buyer; the attacker witnesses its leg 2.
  const forged = await pair(attacker, seller, NOW, { leg2Signer: null })
  const f = proposalOf(ref, forged.leg1, forged.leg2)
  witness(f, 'buyer', 2, witnessSetOf(await attacker.wallet.signTx(forged.leg2.cborHex, true)))
  // 2. The real proposal for that escrow: the datum buyer is `buyer`, but leg 2 carries only the attacker's witness.
  const real = await pair(buyer, seller, NOW, { leg2Signer: attacker })
  assert.equal(hasValidWitness(real.leg2.cborHex, buyer.pkh), false)
  stubUtxoInfo(t, real.info)
  const p = proposalOf(ref, real.leg1, real.leg2)
  await rejectsWith(checkBeforeConcession(p, recordOf(p), seller.address, NOW), 'must be signed by the buyer')
})

// --- witness() ---

const recordPath = (ref: string): string => join(ROOT, 'out', 'seller', `${ref.replace('#', '_')}.json`)

test('witness: the same buyer witness merged twice gives the same CBOR (idempotent), and it verifies', async () => {
  const buyer = await throwaway(), seller = await throwaway()
  const x = await pair(buyer, seller, Date.now(), { leg2Signer: null })
  const p = proposalOf(freshRef(), x.leg1, x.leg2)
  const ws = witnessSetOf(await buyer.wallet.signTx(x.leg2.cborHex, true))
  const once = witness(p, 'buyer', 2, ws)
  const twice = witness(once, 'buyer', 2, ws)
  assert.notEqual(once.leg2!.cborHex, p.leg2!.cborHex) // positive control: the first merge did add a witness
  assert.equal(twice.leg2!.cborHex, once.leg2!.cborHex)
  assert.equal(once.leg2!.txHash, p.leg2!.txHash)
  assert.equal(hasValidWitness(twice.leg2!.cborHex, buyer.pkh), true)
  assert.equal(cst.deserializeTx(twice.leg2!.cborHex).witnessSet().vkeys()?.size(), 1)
  assert.deepEqual(twice.signedBy, ['buyer'])
  assert.equal(twice.leg1!.cborHex, p.leg1!.cborHex, 'leg 1 is never touched')
})

test('witness: a witness from a key that is not the buyer\'s is refused with the readable sentence', async () => {
  const buyer = await throwaway(), seller = await throwaway(), stranger = await throwaway()
  const x = await pair(buyer, seller, Date.now(), { leg2Signer: null })
  const p = proposalOf(freshRef(), x.leg1, x.leg2)
  for (const wrong of [seller, stranger]) {
    const ws = witnessSetOf(await wrong.wallet.signTx(x.leg2.cborHex, true))
    assert.throws(() => witness(p, 'buyer', 2, ws), (e: unknown) => e instanceof SettleError && e.message === 'This key is not the buyer\'s for leg 2.')
  }
})

test('witness: the buyer\'s own key over another body is refused (signature does not match this leg)', async () => {
  const buyer = await throwaway(), seller = await throwaway()
  const x = await pair(buyer, seller, Date.now(), { leg2Signer: null })
  const other = await pair(buyer, seller, Date.now(), { leg2Signer: null })
  const p = proposalOf(freshRef(), x.leg1, x.leg2)
  const ws = witnessSetOf(await buyer.wallet.signTx(other.leg2.cborHex, true))
  assert.throws(() => witness(p, 'buyer', 2, ws), (e: unknown) => e instanceof SettleError && e.message === 'Signature does not match this leg\'s body.')
})

test('witness: the seller\'s leg-1 witness is refused before the buyer\'s leg-2 witness, and gets past that check after it', async () => {
  const buyer = await throwaway(), seller = await throwaway()
  const x = await pair(buyer, seller, Date.now(), { leg2Signer: null })
  const ref = freshRef()
  assert.equal(existsSync(recordPath(ref)), false)
  const p = proposalOf(ref, x.leg1, x.leg2)
  const sellerLeg1 = witnessSetOf(await seller.wallet.signTx(x.leg1.cborHex, true))
  assert.throws(() => witness(p, 'seller', 1, sellerLeg1), (e: unknown) => e instanceof SettleError && e.message === 'Leg 2 must be signed by the buyer before the seller signs leg 1.')
  // Positive control: once leg 2 carries the buyer's witness, the same call passes that check and stops at the next one
  // (no seller record on disk for this ref, so nothing is written).
  const withBuyer = witness(p, 'buyer', 2, witnessSetOf(await buyer.wallet.signTx(x.leg2.cborHex, true)))
  assert.throws(() => witness(withBuyer, 'seller', 1, sellerLeg1), (e: unknown) => e instanceof SettleError && /not prepared by this seller/.test(e.message))
  assert.equal(existsSync(recordPath(ref)), false)
})

test('witness: a buyer witness on leg 1 is refused, and so is an empty witness set', async () => {
  const buyer = await throwaway(), seller = await throwaway()
  const x = await pair(buyer, seller, Date.now(), { leg2Signer: null })
  const p = proposalOf(freshRef(), x.leg1, x.leg2)
  const buyerLeg1 = witnessSetOf(await buyer.wallet.signTx(x.leg1.cborHex, true))
  assert.throws(() => witness(p, 'buyer', 1, buyerLeg1), (e: unknown) => e instanceof SettleError && e.message === 'Only the seller signs leg 1.')
  const empty = new cst.Serialization.TransactionWitnessSet().toCbor()
  assert.throws(() => witness(p, 'buyer', 2, empty), (e: unknown) => e instanceof SettleError && e.message === 'The wallet returned no signature.')
})

test('witness: an expired proposal is refused before any key is read', async () => {
  const buyer = await throwaway(), seller = await throwaway()
  const x = await pair(buyer, seller, Date.now(), { leg2Signer: null })
  const p = proposalOf(freshRef(), x.leg1, x.leg2, Date.now() - 1)
  const ws = witnessSetOf(await buyer.wallet.signTx(x.leg2.cborHex, true))
  assert.throws(() => witness(p, 'buyer', 2, ws), (e: unknown) => e instanceof SettleError && /^Leg 1 expired at/.test(e.message))
})

test('lock: a dead owner\'s or an expired lock is stale; a live one blocks, with its owner named', async () => {
  const { lock, isStale, LOCK_STALE_MS } = await import('./settle.ts')
  const { hostname } = await import('node:os')
  const now = Date.now()
  assert.equal(isStale({ pid: process.pid, host: hostname(), atMs: now }, now), false) // this process: alive
  assert.equal(isStale({ pid: 2 ** 22 + 12345, host: hostname(), atMs: now }, now), true) // no such process
  assert.equal(isStale({ pid: process.pid, host: 'another-host', atMs: now - LOCK_STALE_MS - 1 }, now), true) // not refreshed for 2 min, whatever the pid
  assert.equal(isStale({ pid: 1, host: 'another-host', atMs: now }, now), false) // another host, recent: respected
  assert.equal(isStale(null, now), true)
  const ref = 'ee'.repeat(32) + '#9'
  const release = lock(ref)
  assert.throws(() => lock(ref), /already running \(process \d+ on .+, since .+ SGT\)/)
  release()
  const again = lock(ref) // released: free again
  again()
})

test('upsertTxLog: a pending acceptance gives way to a front-run, an expiry alert or a phase-2 failure; a tx in a block is final', async () => {
  const { upsertTxLog, txLogFile } = await import('./settle.ts')
  const { rmSync } = await import('node:fs')
  const ref = 'fd'.repeat(32) + '#7'
  const base = { step: 'WithdrawRefund (leg 2, pre-signed)', network: 'preprod' as const, scriptHash: '', txHash: 'ab'.repeat(32), atMs: 1, expected: 'accept' as const }
  const block = { height: 1, hash: 'cd'.repeat(32), slot: 1 }
  try {
    upsertTxLog(ref, { ...base, status: 'accepted', stage: 'submit', error: 'sending; retried until it lands or expires' })
    const fr = upsertTxLog(ref, { ...base, status: 'refused', stage: 'submit', error: 'FRONT-RUN: leg 1\'s escrow output was spent by x' })
    assert.equal(fr.status, 'refused') // returned as written, so landLeg2 stops on it
    upsertTxLog(ref, { ...base, status: 'accepted', stage: 'submit', error: 'sending' })
    upsertTxLog(ref, { ...base, status: 'refused', stage: 'submit', error: 'ALERT: leg 2 not in a block before it expired' })
    upsertTxLog(ref, { ...base, status: 'accepted', stage: 'submit', error: 'sending' })
    const p2 = upsertTxLog(ref, { ...base, status: 'refused', stage: 'confirm', block, refusal: { phase: 2, ledgerError: 'valid_contract=false (collateral consumed)' } })
    assert.equal(p2.status, 'refused')
    upsertTxLog(ref, { ...base, status: 'accepted', stage: 'confirm', block })
    const kept = upsertTxLog(ref, { ...base, status: 'refused', stage: 'submit', error: 'All inputs are spent' }) // a resubmission
    assert.equal(kept.status, 'accepted')
    assert.equal(upsertTxLog(ref, { ...base, status: 'accepted', stage: 'submit', error: 'sending' }).block?.height, 1) // no downgrade to a marker
    const rb = upsertTxLog(ref, { ...base, status: 'accepted', stage: 'confirm', block, readback: { provider: 'koios', validContract: true } })
    assert.equal(rb.readback?.provider, 'koios') // a confirmed entry is still enriched
    const log = JSON.parse(readFileSync(txLogFile(ref), 'utf8')) as unknown[]
    assert.equal(log.length, 1)
  } finally {
    rmSync(txLogFile(ref), { force: true })
  }
})

test('lock: a dead owner\'s lock is taken over; release never removes a lock another process holds', async () => {
  const { lock } = await import('./settle.ts')
  const { hostname } = await import('node:os')
  const { writeFileSync, rmSync } = await import('node:fs')
  const ref = 'fe'.repeat(32) + '#3'
  const file = join(ROOT, 'out', 'seller', `${ref.replace('#', '_')}.lock`)
  try {
    writeFileSync(file, JSON.stringify({ pid: 2 ** 22 + 4321, host: hostname(), atMs: Date.now(), id: 'dead' }))
    const release = lock(ref) // the dead owner's lock is moved aside and replaced
    assert.notEqual((JSON.parse(readFileSync(file, 'utf8')) as { id: string }).id, 'dead')
    writeFileSync(file, JSON.stringify({ pid: process.pid, host: 'another-host', atMs: Date.now(), id: 'other' }))
    release() // not ours any more: left in place
    assert.equal((JSON.parse(readFileSync(file, 'utf8')) as { id: string }).id, 'other')
    assert.throws(() => lock(ref), /already running \(process \d+ on another-host/)
  } finally {
    rmSync(file, { force: true })
  }
})
