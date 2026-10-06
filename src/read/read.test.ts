import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import * as koios from './koios.ts'
import { stats } from './http.ts'

const row = { tx_hash: 'aa', tx_index: 0, address: 'addr', value: '5', asset_list: [{ policy_id: 'p', asset_name: 'n', quantity: '7' }], inline_datum: { bytes: 'd8' } }

async function serve(handler: (path: string, n: number) => [number, unknown]) {
  let n = 0
  const srv = createServer((req, res) => {
    const [code, body] = handler(req.url ?? '', n++)
    res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  })
  await new Promise<void>((r) => srv.listen(0, r))
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`
  return { base, close: () => srv.close() }
}

test('429 is retried and counted, data still arrives, no hole', async () => {
  const s = await serve((_p, n) => (n < 2 ? [429, {}] : [200, [row]]))
  const before = { ...stats }
  const r = await koios.utxosAt('mainnet', 'addr', { base: s.base, backoffMs: 1 })
  s.close()
  assert.equal(r.holes, 0)
  assert.equal(r.data.length, 1)
  assert.deepEqual(r.data[0].value, { lovelace: '5', pn: '7' })
  assert.equal(r.data[0].inlineDatumCbor, 'd8')
  assert.equal(stats.retries - before.retries, 2)
})

test('persistent 429 becomes a printed hole, never an empty success', async () => {
  const s = await serve(() => [429, {}])
  const before = stats.holes
  const r = await koios.utxosAt('mainnet', 'addr', { base: s.base, backoffMs: 1 })
  s.close()
  assert.equal(r.holes, 1)
  assert.equal(stats.holes - before, 1)
})

test('nonexistent reference returns null with zero holes', async () => {
  const s = await serve(() => [200, []])
  const r = await koios.utxo('mainnet', 'ff#0', { base: s.base, backoffMs: 1 })
  s.close()
  assert.equal(r.data, null)
  assert.equal(r.holes, 0)
})
