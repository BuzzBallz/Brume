import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { USDM } from '../../shared/constants.ts'
import type { Datum, RawUtxo, Read } from '../../shared/types.ts'
import { buildCensus, compare, sum } from './census.ts'
import { decodeDatum, parsePlutus, type Plutus } from './decode.ts'

const mock = (name: string) => JSON.parse(readFileSync(new URL(`../../shared/mock/${name}.mock.json`, import.meta.url), 'utf8'))
const real = mock('utxo-disputed').utxo
const datumMock = mock('datum-disputed').datum
const HEX: string = real.inline_datum.bytes
const DISPUTED_TAIL = 'd87c80ff'

// Koios' own decoding of the same bytes, as an independent check on the tag/constructor handling.
const koiosShape = (p: Plutus): unknown =>
  'constr' in p ? { constructor: p.constr, fields: p.fields.map(koiosShape) }
  : 'list' in p ? p.list.map(koiosShape)
  : 'bytes' in p ? { bytes: p.bytes }
  : { int: Number(p.int) }

const utxo = (ref: string, hex: string | null, value = { lovelace: '4029850', [USDM]: '2000000' }): RawUtxo => ({ ref, address: 'addr', value, inlineDatumCbor: hex })
const withState = (tag: string) => HEX.replace(DISPUTED_TAIL, `${tag}80ff`)

test('real mainnet datum: tags are read as constructors, not integers', () => {
  assert.ok(HEX.endsWith(DISPUTED_TAIL))
  assert.deepEqual(koiosShape(parsePlutus(HEX)), real.inline_datum.value)
})

test('real mainnet datum decodes to the 16 fields', () => {
  const d = decodeDatum(HEX)
  const handMade = new Set(['referenceKey', 'referenceSignature', 'sellerNonce'])
  for (const k of Object.keys(datumMock)) if (!handMade.has(k)) assert.deepEqual(d[k as keyof Datum], datumMock[k], k)
  assert.equal(d.referenceKey.length, 84)
  assert.ok(d.referenceSignature.length > 128 && d.sellerNonce.length > 128, 'chunked bytes are joined')
  assert.equal(d.state, 'Disputed')
})

test('corrupted datum fails to decode (negative control)', () => {
  const cases: Record<string, string> = {
    truncated: HEX.slice(0, -2),
    'trailing byte': HEX + '00',
    'state as integer': HEX.replace(DISPUTED_TAIL, '03ff'),
    'unknown state': withState('d87d'),
    'not hex': 'zz',
    '15 fields': 'd8799f' + '00'.repeat(15) + 'ff',
    '11 fields (upstream example shape)': 'd8799f' + '00'.repeat(11) + 'ff',
  }
  for (const [name, hex] of Object.entries(cases)) assert.throws(() => decodeDatum(hex), Error, name)
})

test('census counts the undecodable row and keeps it', () => {
  const read: Read<RawUtxo[]> = {
    provider: 'koios',
    holes: 0,
    data: [utxo('b#0', HEX), utxo('a#0', withState('d879')), utxo('c#0', HEX.slice(0, -2)), utxo('d#0', null)],
  }
  const c = buildCensus('mainnet', { height: 1, hash: 'h', timeMs: 0 }, read)
  assert.deepEqual([c.open, c.decoded, c.undecodable], [4, 2, 2])
  assert.deepEqual(c.byState, { FundsLocked: 1, ResultSubmitted: 0, RefundRequested: 0, Disputed: 1 })
  assert.deepEqual(c.rows.map((r) => [r.ref, r.state]), [['a#0', 'FundsLocked'], ['b#0', 'Disputed'], ['c#0', null], ['d#0', null]])
  assert.deepEqual(c.disputedTotals, { lovelace: '4029850', [USDM]: '2000000' })
})

test('disputed total is the sum of the UTxO set, and the two providers reconcile', () => {
  const a: Read<RawUtxo[]> = { provider: 'koios', holes: 0, data: [utxo('a#0', HEX), utxo('b#0', HEX), utxo('c#0', withState('d879'))] }
  const b: Read<RawUtxo[]> = { provider: 'blockfrost', holes: 0, data: [...a.data].reverse().map((u) => ({ ...u, inlineDatumCbor: u.inlineDatumCbor?.toUpperCase() ?? null })) }
  const c = buildCensus('mainnet', { height: 1, hash: 'h', timeMs: 0 }, a)
  assert.equal(c.disputedTotals.lovelace, '8059700')
  assert.equal(sum(a.data.map((u) => u.value)).lovelace, '12089550')
  assert.deepEqual(compare(a, b), [])

  const moved: Read<RawUtxo[]> = { ...b, data: [...a.data.slice(0, 2), utxo('c#0', withState('d879'), { lovelace: '1', [USDM]: '2000000' })] }
  assert.deepEqual(compare(a, moved), ['c#0 value differs', 'total lovelace: koios 12089550 vs blockfrost 8059701'])
})
