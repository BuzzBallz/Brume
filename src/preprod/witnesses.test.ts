// Offline: witnesses.ts summarize() and paidOf() on a hand-written leg pair shaped like the chain walk of a real
// seller-first settlement (fixtures/preprod/witnesses-9e7c…_0.json), and witnessSummary()'s refusal to keep a failed read.
// No fetch is made: the summary is pure, and the failing read stops at the missing local log before any network call.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PARAMS, TUSDM, V1_ADDRESS } from '../../shared/constants.ts'
import { paidOf, summarize, witnessSummary, type LegWalk, type Settlement } from './witnesses.ts'

const BUYER = 'aa'.repeat(28)
const SELLER = 'bb'.repeat(28)
const ADMIN = PARAMS.adminKeyHashes[0]
const BUYER_ADDR = 'addr_test1qbuyer'
const SELLER_ADDR = 'addr_test1qseller'
const H1 = '11'.repeat(32)
const H2 = '22'.repeat(32)
const ESCROW = `${'0e'.repeat(32)}#0`
const POT = { lovelace: '20000000', [TUSDM]: '2000000' }
type Out = LegWalk['outputs'][number]

function legs(): [LegWalk, LegWalk] {
  return [
    {
      leg: 1, txHash: H1, block: { height: 5260001, slot: 108_000_001 },
      redeemer: { name: 'AuthorizeRefund', constructor: 6, spends: ESCROW },
      escrowBefore: { ref: ESCROW, state: 'Disputed' },
      escrowAfter: { ref: `${H1}#0`, state: 'RefundRequested' },
      outputs: [
        { address: V1_ADDRESS.preprod, party: 'script', value: { ...POT } },
        { address: SELLER_ADDR, party: 'seller', value: { lovelace: '12541514' } }, // the seller's change, not a payout
      ],
      requiredSigners: [{ keyHash: SELLER, party: 'seller' }],
      witnesses: [{ keyHash: SELLER, party: 'seller' }],
      adminKeysSigned: [],
      collateral: [`${'33'.repeat(32)}#1`],
    },
    {
      leg: 2, txHash: H2, block: { height: 5260001, slot: 108_000_001 },
      redeemer: { name: 'WithdrawRefund', constructor: 3, spends: `${H1}#0` },
      escrowBefore: { ref: `${H1}#0`, state: 'RefundRequested' },
      escrowAfter: null,
      outputs: [
        { address: BUYER_ADDR, party: 'buyer', value: { lovelace: '12000000', [TUSDM]: '1200000' } },
        { address: SELLER_ADDR, party: 'seller', value: { lovelace: '8000000', [TUSDM]: '800000' } }, // the payout
        { address: SELLER_ADDR, party: 'seller', value: { lovelace: '12554377' } }, // the change
      ],
      requiredSigners: [{ keyHash: BUYER, party: 'buyer' }],
      witnesses: [{ keyHash: BUYER, party: 'buyer' }, { keyHash: SELLER, party: 'seller' }],
      adminKeysSigned: [],
      collateral: [`${'44'.repeat(32)}#2`],
    },
  ]
}
const walk = (l: [LegWalk, LegWalk] = legs()): Settlement => ({ escrowRef: ESCROW, parties: { buyer: BUYER, seller: SELLER }, legs: l })

test('summarize: each leg keeps its tx, block, redeemer, the escrow it spends and leaves, and who signed', () => {
  const s = summarize(walk())
  assert.equal(s.escrowRef, ESCROW)
  assert.equal(s.adminKeys, 3)
  assert.equal(s.legs.length, 2)
  const [l1, l2] = s.legs
  assert.deepEqual(
    { leg: l1.leg, txHash: l1.txHash, block: l1.block, redeemer: l1.redeemer, spends: l1.spends, leaves: l1.leaves, requiredSigners: l1.requiredSigners, witnesses: l1.witnesses, adminKeysSigned: l1.adminKeysSigned },
    { leg: 1, txHash: H1, block: { height: 5260001, slot: 108_000_001 }, redeemer: { name: 'AuthorizeRefund', constructor: 6 }, spends: { ref: ESCROW, state: 'Disputed' }, leaves: { ref: `${H1}#0`, state: 'RefundRequested' }, requiredSigners: ['seller'], witnesses: ['seller'], adminKeysSigned: [] },
  )
  assert.deepEqual(l2.redeemer, { name: 'WithdrawRefund', constructor: 3 })
  assert.deepEqual(l2.spends, { ref: `${H1}#0`, state: 'RefundRequested' })
  assert.equal(l2.leaves, null)
  assert.deepEqual(l2.requiredSigners, ['buyer'])
  assert.deepEqual(l2.witnesses, ['buyer', 'seller'])
  assert.equal(s.noAdminKey, true)
})

test('summarize: the seller change is not a payout (leg 1 pays nobody, leg 2 pays the split only)', () => {
  const [l1, l2] = summarize(walk()).legs
  assert.deepEqual(l1.paid, { buyer: {}, seller: {} })
  assert.deepEqual(l2.paid, { buyer: { lovelace: '12000000', [TUSDM]: '1200000' }, seller: { lovelace: '8000000', [TUSDM]: '800000' } })
  // Together the payouts are the whole pot leg 1 continued, nothing more: the change (12.55 tADA) stayed out.
  const total = Object.fromEntries(Object.keys(POT).map((u) => [u, String(BigInt(l2.paid.buyer[u] ?? '0') + BigInt(l2.paid.seller[u] ?? '0'))]))
  assert.deepEqual(total, POT)
})

test('paidOf: outputs to one party are summed per unit; only the last output, when it is the seller\'s, is change', () => {
  const s = (lovelace: string, extra: Record<string, string> = {}): Out => ({ address: SELLER_ADDR, party: 'seller', value: { lovelace, ...extra } })
  const b = (lovelace: string, extra: Record<string, string> = {}): Out => ({ address: BUYER_ADDR, party: 'buyer', value: { lovelace, ...extra } })
  assert.deepEqual(paidOf([b('1000000'), b('2500000', { [TUSDM]: '7' }), s('3000000', { [TUSDM]: '5' }), s('4000000'), s('9999999')]), {
    buyer: { lovelace: '3500000', [TUSDM]: '7' },
    seller: { lovelace: '7000000', [TUSDM]: '5' },
  })
  // Positive control: when the last output is the buyer's there is no seller change, so every seller output is a payout.
  assert.deepEqual(paidOf([s('3000000'), s('4000000'), b('1000000')]), { buyer: { lovelace: '1000000' }, seller: { lovelace: '7000000' } })
  // Script and unknown outputs are nobody's payout.
  assert.deepEqual(paidOf([{ address: V1_ADDRESS.preprod, party: 'script', value: { lovelace: '5' } }, { address: 'addr_test1qx', party: 'other', value: { lovelace: '6' } }]), { buyer: {}, seller: {} })
})

test('summarize: an admin key anywhere makes noAdminKey false (witness, required signer, or adminKeysSigned)', () => {
  const asWitness = legs()
  asWitness[1].witnesses.push({ keyHash: ADMIN, party: 'admin' })
  assert.equal(summarize(walk(asWitness)).noAdminKey, false)
  const asSigner = legs()
  asSigner[0].requiredSigners.push({ keyHash: ADMIN, party: 'admin' })
  assert.equal(summarize(walk(asSigner)).noAdminKey, false)
  const listed = legs()
  listed[1].adminKeysSigned = [ADMIN]
  const s = summarize(walk(listed))
  assert.equal(s.noAdminKey, false)
  assert.deepEqual(s.legs[1].adminKeysSigned, [ADMIN])
  // Control: the untouched pair still reads as no admin key.
  assert.equal(summarize(walk()).noAdminKey, true)
})

test('summarize: the summary is a copy, never an alias of the walk', () => {
  const w = walk()
  const s = summarize(w)
  s.legs[0].spends.state = 'changed'
  s.legs[1].adminKeysSigned.push('x')
  assert.equal(w.legs[0].escrowBefore.state, 'Disputed')
  assert.deepEqual(w.legs[1].adminKeysSigned, [])
})

test('witnessSummary: a failed read is not cached, so the next call reads again', async () => {
  const ref = `${'ff'.repeat(32)}#9` // no local log for it: walkSettlement throws before any network call
  const first = witnessSummary(ref)
  await assert.rejects(first, /ENOENT|no such file/)
  const second = witnessSummary(ref)
  assert.notEqual(second, first)
  await assert.rejects(second, /ENOENT|no such file/)
  // Control: while a read is in flight, a second call for the same escrow gets the same promise.
  const a = witnessSummary(ref)
  const b = witnessSummary(ref)
  assert.equal(a, b)
  await assert.rejects(a)
})
