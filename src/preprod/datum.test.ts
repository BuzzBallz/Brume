import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { STATE, type Datum } from '../../shared/types.ts'
import { DatumError, encodeDatum, fieldSpans, patchDatum, readDatum } from './datum.ts'

const json = (name: string): any => JSON.parse(readFileSync(new URL(`../../shared/mock/${name}`, import.meta.url), 'utf8'))
const UTXO = json('utxo-disputed.mock.json').utxo
const DECODED = json('datum-disputed.mock.json').datum
// Real mainnet inline datum (Koios, 6 Oct): 16 fields, fields 3 and 4 chunked.
const REAL: string = UTXO.inline_datum.bytes
const KOIOS_FIELDS: { bytes?: string }[] = UTXO.inline_datum.value.fields

// Rebuilds the real datum from its own field slices, with a chosen outer framing or field list.
const fieldsOf = (hex: string): string[] => fieldSpans(hex).map((s) => hex.slice(s.start, s.end))
const indefinite = (fields: string[]): string => 'd8799f' + fields.join('') + 'ff'

test('readDatum: the real mainnet datum gives the hand-decoded values', () => {
  const d = readDatum(REAL)
  assert.deepEqual(d.buyer, DECODED.buyer)
  assert.deepEqual(d.seller, DECODED.seller)
  assert.equal(d.buyerNonce, DECODED.buyerNonce)
  assert.equal(d.collateralReturnLovelace, 4029850)
  assert.equal(d.collateralReturnLovelace, DECODED.collateralReturnLovelace)
  assert.equal(d.inputHash, DECODED.inputHash)
  assert.equal(d.resultHash, DECODED.resultHash)
  for (const k of ['payByTime', 'submitResultTime', 'unlockTime', 'externalDisputeUnlockTime', 'sellerCooldownTime', 'buyerCooldownTime'] as const) {
    assert.equal(d[k], DECODED[k], k)
  }
  assert.equal(d.state, 'Disputed')
})

test('readDatum: fields 2-4 are the concatenated chunk bytes (Koios decoding as the reference)', () => {
  const d = readDatum(REAL)
  assert.equal(d.referenceKey, KOIOS_FIELDS[2]!.bytes)
  assert.equal(d.referenceSignature, KOIOS_FIELDS[3]!.bytes)
  assert.equal(d.sellerNonce, KOIOS_FIELDS[4]!.bytes)
  const f = fieldsOf(REAL)
  // Positive control that the chunked path was really exercised: fields 3 and 4 are indefinite bytestrings on chain.
  assert.ok(f[3]!.startsWith('5f5840') && f[3]!.endsWith('ff'))
  assert.ok(f[4]!.startsWith('5f5840') && f[4]!.endsWith('ff'))
  assert.ok(d.referenceSignature.length / 2 > 64 && d.sellerNonce.length / 2 > 64)
  assert.ok(f[2]!.startsWith('582a'), 'field 2 is a definite 42-byte string')
})

test('fieldSpans: 16 contiguous hex-char spans covering the datum between header and break', () => {
  const spans = fieldSpans(REAL)
  assert.equal(spans.length, 16)
  assert.equal(spans[0]!.start, 6) // after d8799f
  for (let i = 1; i < 16; i++) assert.equal(spans[i]!.start, spans[i - 1]!.end)
  assert.equal(spans[15]!.end, REAL.length - 2) // before ff
  assert.equal(REAL.slice(spans[15]!.start, spans[15]!.end), 'd87c80')
  assert.equal(REAL.slice(spans[6]!.start, spans[6]!.end), '1a003d7d9a')
})

test('encodeDatum reproduces the real mainnet bytes exactly', () => {
  assert.equal(encodeDatum(readDatum(REAL)), REAL)
})

test('patchDatum: the continuation patch reads back, every other field is byte-identical', () => {
  const X = 1_791_262_222_000
  const out = patchDatum(REAL, { resultHash: '', sellerCooldownTime: X, buyerCooldownTime: 0, state: 'RefundRequested' })
  const d = readDatum(out)
  const before = readDatum(REAL)
  assert.equal(d.resultHash, '')
  assert.equal(d.sellerCooldownTime, X)
  assert.equal(d.buyerCooldownTime, 0)
  assert.equal(d.state, 'RefundRequested')
  assert.deepEqual({ ...d, resultHash: before.resultHash, sellerCooldownTime: before.sellerCooldownTime, buyerCooldownTime: before.buyerCooldownTime, state: before.state }, before)
  const a = fieldsOf(REAL)
  const b = fieldsOf(out)
  for (const i of [0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12]) assert.equal(b[i], a[i], `field ${i}`)
  assert.equal(b[8], '40')
  assert.equal(b[13], '1b000001a10f8c66b0')
  assert.equal(b[14], '00')
  assert.equal(b[15], 'd87b80')
  // Outer framing copied too, and the patched fields really differ (positive control on the comparison above).
  assert.equal(out.slice(0, 6), REAL.slice(0, 6))
  assert.equal(out.slice(-2), 'ff')
  assert.notEqual(b[8], a[8])
  assert.notEqual(b[13], a[13])
  assert.notEqual(b[15], a[15])
})

test('patchDatum: an empty patch returns the input; a definite-framed input keeps its framing', () => {
  assert.equal(patchDatum(REAL, {}), REAL)
  // d87990 = constructor 0 with a definite 16-item list. A re-encoder would turn it into d8799f…ff; the patch must not.
  const definite = 'd87990' + fieldsOf(REAL).join('')
  assert.deepEqual(readDatum(definite), readDatum(REAL))
  const out = patchDatum(definite, { state: 'FundsLocked' })
  assert.equal(out.slice(0, 6), 'd87990')
  assert.equal(out, definite.slice(0, -6) + 'd87980')
  assert.equal(patchDatum(REAL.toUpperCase(), { state: 'Disputed' }), REAL, 'hex comes back lowercase')
})

test('patchDatum refuses unknown fields and bad values', () => {
  assert.throws(() => patchDatum(REAL, { buyerNonce: '00' } as never), DatumError)
  assert.throws(() => patchDatum(REAL, { sellerCooldownTime: -1 }), DatumError)
  assert.throws(() => patchDatum(REAL, { sellerCooldownTime: 1.5 }), DatumError)
  assert.throws(() => patchDatum(REAL, { resultHash: 'abc' }), DatumError)
  assert.throws(() => patchDatum(REAL, { state: 'Withdrawn' as never }), DatumError)
})

const KEY = (b: string): string => b.repeat(28)
function sample(over: Partial<Datum> = {}): Datum {
  return {
    buyer: { payment: { type: 'key', hash: KEY('11') }, stake: { type: 'key', hash: KEY('22') } },
    seller: { payment: { type: 'script', hash: KEY('33') }, stake: null },
    referenceKey: 'ab'.repeat(64), // exactly 64: the largest definite bytestring
    referenceSignature: 'cd'.repeat(65), // 65: one full chunk + one byte
    sellerNonce: 'ef'.repeat(200), // 3 full chunks + 8 bytes
    buyerNonce: '',
    collateralReturnLovelace: 23,
    inputHash: '01'.repeat(32),
    resultHash: '',
    payByTime: 24,
    submitResultTime: 0xffff,
    unlockTime: 0x10000,
    externalDisputeUnlockTime: Number.MAX_SAFE_INTEGER,
    sellerCooldownTime: 0,
    buyerCooldownTime: 1_759_237_196_700,
    state: 'FundsLocked',
    ...over,
  }
}

test('encodeDatum -> readDatum round trip: chunking, empty bytes, stake None/Some, every state', () => {
  for (const state of STATE) {
    const d = sample({ state })
    const hex = encodeDatum(d)
    assert.deepEqual(readDatum(hex), d, state)
    assert.equal(fieldsOf(hex)[15], `d87${(9 + STATE.indexOf(state)).toString(16)}80`)
  }
  const d = sample({ buyer: { payment: { type: 'key', hash: KEY('44') }, stake: { type: 'script', hash: KEY('55') } } })
  assert.deepEqual(readDatum(encodeDatum(d)), d, 'script stake credential')
  const f = fieldsOf(encodeDatum(sample()))
  assert.equal(f[2], '5840' + 'ab'.repeat(64))
  assert.equal(f[3], '5f5840' + 'cd'.repeat(64) + '41cd' + 'ff')
  assert.equal(f[4], '5f' + ('5840' + 'ef'.repeat(64)).repeat(3) + '48' + 'ef'.repeat(8) + 'ff')
  assert.equal(f[5], '40')
  assert.equal(f[8], '40')
  assert.equal(f[1], 'd8799fd87a9f581c' + KEY('33') + 'ffd87a80ff', 'script payment, stake None = d87a80')
  assert.equal(f[0], 'd8799fd8799f581c' + KEY('11') + 'ffd8799fd8799fd8799f581c' + KEY('22') + 'ffffffff')
  assert.equal(f[6], '17')
  assert.equal(f[9], '1818')
  assert.equal(f[10], '19ffff')
  assert.equal(f[11], '1a00010000')
  assert.equal(f[12], '1b001fffffffffffff')
  assert.equal(encodeDatum({ ...sample(), inputHash: 'AB'.repeat(32) }), encodeDatum({ ...sample(), inputHash: 'ab'.repeat(32) }))
})

test('encodeDatum refuses values the datum cannot carry', () => {
  assert.throws(() => encodeDatum(sample({ payByTime: -1 })), DatumError)
  assert.throws(() => encodeDatum(sample({ payByTime: Number.MAX_SAFE_INTEGER + 1 })), DatumError)
  assert.throws(() => encodeDatum(sample({ inputHash: 'zz' })), DatumError)
  assert.throws(() => encodeDatum(sample({ buyer: { payment: { type: 'key', hash: '11' }, stake: null } })), DatumError)
  assert.throws(() => encodeDatum(sample({ state: 'Gone' as never })), DatumError)
})

test('negative: a 15-field datum throws (positive control: the same 16 fields read)', () => {
  const f = fieldsOf(REAL)
  assert.doesNotThrow(() => readDatum(indefinite(f)))
  assert.throws(() => readDatum(indefinite(f.slice(0, 15))), DatumError)
  assert.throws(() => readDatum(indefinite([...f, '00'])), DatumError, '17 fields')
  assert.throws(() => fieldSpans(indefinite(f.slice(0, 15))), DatumError)
})

test('negative: state constructor 4 throws (positive control: constructor 3 reads)', () => {
  const f = fieldsOf(REAL)
  assert.equal(readDatum(indefinite([...f.slice(0, 15), 'd87c80'])).state, 'Disputed')
  assert.throws(() => readDatum(indefinite([...f.slice(0, 15), 'd87d80'])), /constructor 4 is not a V1 state/)
  assert.throws(() => readDatum(indefinite([...f.slice(0, 15), 'd87c9f00ff'])), DatumError, 'a state with fields')
})

test('negative: truncated CBOR throws (positive control: the full datum reads)', () => {
  assert.doesNotThrow(() => readDatum(REAL))
  assert.throws(() => readDatum(REAL.slice(0, -2)), /truncated/)
  assert.throws(() => readDatum(REAL.slice(0, 400)), /truncated/)
  assert.throws(() => readDatum(REAL.slice(0, 7)), DatumError, 'odd length')
  assert.throws(() => readDatum(''), /truncated/)
  assert.throws(() => readDatum(REAL + '00'), /trailing/)
})

test('negative: Address shape, integers and CBOR types outside the V1 datum', () => {
  const f = fieldsOf(REAL)
  const withField = (i: number, cbor: string): string => indefinite(f.map((x, j) => (j === i ? cbor : x)))
  const cred = (c: string): string => `d8799f581c${KEY('11')}ff`.replace('d879', c)
  // Positive control for the helper: putting back a valid address reads.
  assert.doesNotThrow(() => readDatum(withField(0, `d8799f${cred('d879')}d87a80ff`)))
  assert.equal(readDatum(withField(0, `d8799f${cred('d87a')}d87a80ff`)).buyer.payment.type, 'script')
  assert.throws(() => readDatum(withField(0, `d8799f${cred('d87b')}d87a80ff`)), DatumError, 'credential constructor 2')
  assert.throws(() => readDatum(withField(0, `d8799fd8799f4111ffd87a80ff`)), DatumError, '1-byte hash')
  assert.throws(() => readDatum(withField(0, `d8799f${cred('d879')}d87a9f00ffff`)), DatumError, 'None with a field')
  assert.throws(() => readDatum(withField(0, `d8799f${cred('d879')}d8799fd87a9f000102ffffff`)), /pointer/, 'pointer stake')
  assert.throws(() => readDatum(withField(0, `d87a9f${cred('d879')}d87a80ff`)), DatumError, 'address constructor 1')
  assert.throws(() => readDatum(withField(6, '20')), /negative/)
  assert.throws(() => readDatum(withField(6, '1b0020000000000000')), /MAX_SAFE_INTEGER/)
  assert.equal(readDatum(withField(6, '1b001fffffffffffff')).collateralReturnLovelace, Number.MAX_SAFE_INTEGER)
  assert.throws(() => readDatum(withField(6, '40')), DatumError, 'bytes where an int belongs')
  assert.throws(() => readDatum(withField(2, '00')), DatumError, 'int where bytes belong')
  assert.throws(() => readDatum(withField(2, 'a0')), DatumError, 'a map')
  assert.throws(() => readDatum(withField(2, 'c249010000000000000000')), /tag 2/, 'a bignum')
  assert.throws(() => readDatum(withField(3, '5f5f4100ffff')), DatumError, 'nested indefinite chunk')
  assert.equal(readDatum(withField(3, '5f4101420203ff')).referenceSignature, '010203')
  assert.throws(() => readDatum('d87a9f' + f.join('') + 'ff'), /constructor 0/)
})
