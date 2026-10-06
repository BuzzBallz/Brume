// Offline: the pure parts of history.ts on two real mainnet WithdrawDisputed txs (testdata/withdraw-disputed.json: the last
// arbitration on record, a full refund; and one where the token reached neither party) and on edits of them. No fetch.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { Datum } from '../../shared/types.ts'
import { SCRIPT_HASH, USDM } from '../../shared/constants.ts'
import { readDatum } from '../preprod/datum.ts'
import { againstConstants, arbitrationClock, flows, HistoryError, type KTx, minus, plus, summarize, valueOf } from './history.ts'
import { CONTROL_TX } from './dormancy.ts'

const DATA = JSON.parse(readFileSync(new URL('./testdata/withdraw-disputed.json', import.meta.url), 'utf8')) as { txs: KTx[]; datums: Record<string, string> }
const datumOf = (hash: string): Datum => readDatum(DATA.datums[hash])
const FULL = DATA.txs.find((t) => t.tx_hash === CONTROL_TX)!
const PARTIAL = DATA.txs.find((t) => t.tx_hash.startsWith('00b64e1d'))!
const copy = (t: KTx): KTx => JSON.parse(JSON.stringify(t)) as KTx
const DAY = 86_400_000

test('values: lovelace and every asset summed per unit, zeros dropped', () => {
  assert.deepEqual(valueOf({ value: '5', asset_list: [{ policy_id: 'aa', asset_name: '01', quantity: '2' }, { policy_id: 'aa', asset_name: '01', quantity: '3' }] }), { lovelace: '5', aa01: '5' })
  assert.deepEqual(valueOf({ value: '0', asset_list: null }), {})
  assert.deepEqual(minus(plus({ lovelace: '7' }, { x: '1' }), { lovelace: '7' }), { x: '1' })
})

test('flows, the last arbitration on record (20fa8df4…): the buyer got the whole pot, the seller nothing, nothing in between', () => {
  const a = flows(FULL, datumOf)
  assert.equal(a.validContract, true)
  assert.equal(a.height, 12704767)
  assert.equal(a.time, '2025-11-27T22:27:00.000Z')
  assert.deepEqual(a.pot, { lovelace: '4029850', [USDM]: '3000000' })
  assert.deepEqual(a.buyer, a.pot)
  assert.deepEqual(a.seller, {})
  assert.deepEqual(a.neither, {})
  assert.equal(a.escrows.length, 1)
})

test('flows, 00b64e1d…: the buyer got the ADA only, the 10 USDM reached neither party', () => {
  const a = flows(PARTIAL, datumOf)
  assert.deepEqual(a.pot, { lovelace: '3754010', [USDM]: '10000000' })
  assert.deepEqual(a.buyer, { lovelace: '3754010' })
  assert.deepEqual(a.seller, {})
  assert.deepEqual(a.neither, { [USDM]: '10000000' })
})

test('flows: a seller output is seen, net of the seller\'s own inputs', () => {
  const t = copy(PARTIAL)
  const seller = datumOf(t.inputs!.find((i) => i.payment_addr?.cred === SCRIPT_HASH)!.datum_hash!).seller.payment.hash
  const admin = t.outputs!.find((o) => o.asset_list?.length)!
  admin.asset_list![0].quantity = String(BigInt(admin.asset_list![0].quantity) - 4_000_000n)
  t.outputs!.push({ tx_hash: t.tx_hash, tx_index: 9, value: '1500000', asset_list: [{ policy_id: USDM.slice(0, 56), asset_name: USDM.slice(56), quantity: '4000000' }], payment_addr: { cred: seller }, datum_hash: null })
  t.inputs!.push({ tx_hash: 'ee'.repeat(32), tx_index: 0, value: '1500000', asset_list: [], payment_addr: { cred: seller }, datum_hash: null })
  const a = flows(t, datumOf)
  assert.deepEqual(a.seller, { [USDM]: '4000000' }) // its own 1.5 ADA came back, only the token is received
  assert.equal(summarize([a]).sellerReceivedIn, 1)
})

test('flows: a phase-2-failed attempt moved nothing', () => {
  const t = copy(FULL)
  t.plutus_contracts![0].valid_contract = false
  const a = flows(t, datumOf)
  assert.equal(a.validContract, false)
  assert.deepEqual([a.buyer, a.seller, a.neither], [{}, {}, {}])
  const r = summarize([a, flows(FULL, datumOf)])
  assert.deepEqual([r.arbitrations, r.valid, r.failedPhase2], [2, 1, 1])
})

test('flows: refuses a reading it cannot make unambiguously', () => {
  const other = copy(FULL)
  other.plutus_contracts![0].input!.redeemer!.datum!.value!.constructor = 0
  assert.throws(() => flows(other, datumOf), HistoryError) // no WithdrawDisputed in its own decoding
  const unpaired = copy(FULL)
  unpaired.plutus_contracts![0].spends_input = { tx_hash: 'ff'.repeat(32), tx_index: 0 }
  assert.throws(() => flows(unpaired, datumOf), /not paired/)
  const extra = copy(FULL)
  extra.inputs!.push({ ...extra.inputs!.find((i) => i.payment_addr?.cred === SCRIPT_HASH)!, tx_index: 7 })
  assert.throws(() => flows(extra, datumOf), /not paired/)
  const mixed = copy(FULL)
  mixed.inputs!.push({ ...mixed.inputs!.find((i) => i.payment_addr?.cred === SCRIPT_HASH)!, tx_index: 7 })
  mixed.plutus_contracts!.push({ ...mixed.plutus_contracts![0], spends_input: { tx_hash: mixed.plutus_contracts![0].spends_input!.tx_hash, tx_index: 7 }, input: { redeemer: { purpose: 'spend', datum: { value: { constructor: 0 } } } } })
  assert.throws(() => flows(mixed, datumOf), /another redeemer/)
  const noDatum = copy(FULL)
  noDatum.inputs!.find((i) => i.payment_addr?.cred === SCRIPT_HASH)!.datum_hash = null
  assert.throws(() => flows(noDatum, datumOf), /no datum/)
  const both = (h: string): Datum => { const d = datumOf(h); return { ...d, seller: d.buyer } }
  assert.throws(() => flows(FULL, both), /buyer and a seller/)
})

test('summarize: shares are Σ buyer / Σ pot per unit; the record holds first and last by height', () => {
  const r = summarize([flows(PARTIAL, datumOf), flows(FULL, datumOf)])
  assert.equal(r.valid, 2)
  assert.equal(r.sellerReceivedIn, 0)
  assert.equal(r.buyerWholePotIn, 1)
  assert.equal(r.buyerShare.lovelace, 1)
  assert.equal(r.buyerShare[USDM], 0.2308) // 3 of 13
  assert.equal(r.neitherShare[USDM], 0.7692)
  assert.equal(r.first?.txHash, PARTIAL.tx_hash)
  assert.equal(r.last?.txHash, CONTROL_TX)
  assert.deepEqual(summarize([]).last, null)
})

test('againstConstants: D14 and C3 as shared/constants.ts carries them', () => {
  const r = summarize([flows(FULL, datumOf)])
  const lifetime = { ...r, buyerShare: { lovelace: 1, [USDM]: 0.7364 } }
  assert.deepEqual(againstConstants(lifetime), { buyerAda: true, buyerToken: true, sellerNothing: true, lastAction: true })
  assert.equal(againstConstants(r).buyerToken, false) // 1.0 is not 0.736
  assert.equal(againstConstants({ ...lifetime, sellerReceivedIn: 1 }).sellerNothing, false)
  assert.equal(againstConstants({ ...lifetime, last: { ...lifetime.last!, time: '2026-01-01T00:00:00.000Z' } }).lastAction, false)
})

test('arbitrationClock: days since external_dispute_unlock_time; median of odd and even sets', () => {
  const d = datumOf(FULL.inputs!.find((i) => i.payment_addr?.cred === SCRIPT_HASH)!.datum_hash!)
  const at = (days: number): Datum => ({ ...d, externalDisputeUnlockTime: 1_000 * DAY - days * DAY })
  assert.deepEqual(arbitrationClock([at(1), at(3), at(2)], 1_000 * DAY), { n: 3, pastOpen: 3, medianDays: 2, minDays: 1, maxDays: 3 })
  assert.equal(arbitrationClock([at(1), at(4), at(2), at(3)], 1_000 * DAY)?.medianDays, 2.5)
  assert.equal(arbitrationClock([at(-1), at(5)], 1_000 * DAY)?.pastOpen, 1) // one not yet open
  assert.equal(arbitrationClock([], 0), null)
})
