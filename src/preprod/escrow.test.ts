// Offline: withChainScriptDataHash against the two real preprod script txs (testdata/real-legs.json, accepted in block
// 5259570, epoch 317) and the epoch-317 PlutusV3 cost model (testdata/costmodel-epoch317.json), both captured once from
// Koios. Blockfrost's /epochs/latest/parameters is answered by a stubbed fetch.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test, type TestContext } from 'node:test'
import { withChainScriptDataHash } from './escrow.ts'
import { loadEnv } from './env.ts'
import { builderCst, cst, mesh } from './mesh.ts'
import { TxRuleError } from './tx.ts'

type RealLeg = { leg: 1 | 2; tx_hash: string; epoch_no: number; cbor: string }
const LEGS = (JSON.parse(readFileSync(new URL('./testdata/real-legs.json', import.meta.url), 'utf8')) as { legs: RealLeg[] }).legs
const EPOCH317 = JSON.parse(readFileSync(new URL('./testdata/costmodel-epoch317.json', import.meta.url), 'utf8')) as { epoch_no: number; PlutusV3: number[] }
const PARAMS_URL = 'https://cardano-preprod.blockfrost.io/api/v0/epochs/latest/parameters'
const FAKE_ID = 'pre' + 'prod' + 'x'.repeat(32) // built at runtime: no committed line looks like a project id

function stubFetch(t: TestContext, handler: (url: string, n: number) => Response): string[] {
  const real = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    urls.push(url)
    return handler(url, urls.length - 1)
  }) as typeof fetch
  t.after(() => {
    globalThis.fetch = real
  })
  return urls
}

function fastClock(t: TestContext): void {
  const real = globalThis.setTimeout
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, _ms?: number, ...args: unknown[]) => real(fn, 0, ...args)) as typeof setTimeout
  t.after(() => {
    globalThis.setTimeout = real
  })
}

function fakeBlockfrostId(t: TestContext): void {
  loadEnv()
  const saved = process.env.BLOCKFROST_PREPROD_PROJECT_ID
  process.env.BLOCKFROST_PREPROD_PROJECT_ID = FAKE_ID
  t.after(() => {
    if (saved === undefined) delete process.env.BLOCKFROST_PREPROD_PROJECT_ID
    else process.env.BLOCKFROST_PREPROD_PROJECT_ID = saved
  })
}

const unexpected = (url: string): never => {
  throw new Error(`unexpected fetch in an offline test: ${url}`)
}
const params = (): Response => new Response(JSON.stringify({ epoch: EPOCH317.epoch_no, cost_models_raw: { PlutusV3: EPOCH317.PlutusV3 } }), { status: 200 })
const sdh = (cborHex: string): string | undefined => cst.deserializeTx(cborHex).body().scriptDataHash()

// The same tx with its script_data_hash replaced, re-encoded with the builder's core-cst (as the function does).
function withHash(cborHex: string, hash: string): string {
  const tx = builderCst.deserializeTx(cborHex)
  const body = tx.body()
  body.setScriptDataHash(builderCst.Hash32ByteBase16(hash))
  return new builderCst.Transaction(body, tx.witnessSet(), tx.auxiliaryData()).toCbor()
}

// Runs first in this file: chainCostModelV3 is cached per process, and a failed read must not be.
test('withChainScriptDataHash: a missing cost model is a refusal and is not cached (the next call reads again)', async (t) => {
  fakeBlockfrostId(t)
  fastClock(t)
  const leg = LEGS[0]!
  const urls = stubFetch(t, (url, n) => (url !== PARAMS_URL ? unexpected(url) : n === 0 ? new Response('{}', { status: 200 }) : params()))
  await assert.rejects(withChainScriptDataHash(withHash(leg.cbor, '00'.repeat(32))), (e: unknown) => e instanceof TxRuleError && /no PlutusV3 cost model/.test(e.message))
  assert.equal(await withChainScriptDataHash(withHash(leg.cbor, '00'.repeat(32))), leg.cbor)
  assert.equal(urls.length, 2)
})

for (const leg of LEGS) {
  test(`withChainScriptDataHash: real leg ${leg.leg} (${leg.tx_hash.slice(0, 8)}…) gets its on-chain script_data_hash back, same size, same bytes`, async (t) => {
    fakeBlockfrostId(t)
    stubFetch(t, (url) => (url === PARAMS_URL ? params() : unexpected(url)))
    assert.equal(leg.epoch_no, EPOCH317.epoch_no, 'the cost model is the one of the epoch the tx landed in')
    assert.equal(EPOCH317.PlutusV3.length, 350)
    const onChain = sdh(leg.cbor)
    assert.match(onChain ?? '', /^[0-9a-f]{64}$/)
    assert.ok((cst.deserializeTx(leg.cbor).witnessSet().redeemers()?.size() ?? 0) > 0, 'a script tx: redeemers present')
    for (const wrong of ['00'.repeat(32), 'ff'.repeat(32), onChain!.slice(0, 62) + (onChain!.endsWith('00') ? '01' : '00')]) {
      const tampered = withHash(leg.cbor, wrong)
      assert.equal(sdh(tampered), wrong)
      assert.notEqual(mesh.resolveTxHash(tampered), leg.tx_hash) // the hash is in the body, so the tx hash moved
      const fixed = await withChainScriptDataHash(tampered)
      assert.equal(sdh(fixed), onChain)
      assert.equal(fixed.length, tampered.length)
      assert.equal(fixed, leg.cbor, 'byte for byte the accepted tx, witnesses kept')
      assert.equal(mesh.resolveTxHash(fixed), leg.tx_hash)
    }
    // Idempotent on a tx whose hash is already the chain's.
    assert.equal(await withChainScriptDataHash(leg.cbor), leg.cbor)
  })
}

test('withChainScriptDataHash: a tx without redeemers is returned untouched, without reading the chain', async (t) => {
  const urls = stubFetch(t, (url) => unexpected(url))
  const a = await (async () => {
    const w = new mesh.MeshWallet({ networkId: 0, key: { type: 'root', bech32: mesh.MeshWallet.brew(true) as string } })
    await w.init()
    return w.getChangeAddress()
  })()
  const plain = new mesh.MeshTxBuilder({}).setNetwork('preprod')
    .txIn('aa'.repeat(32), 0, [{ unit: 'lovelace', quantity: '20000000' }], a, 0)
    .txOut(a, [{ unit: 'lovelace', quantity: '3000000' }])
    .invalidHereafter(135_579_300)
    .changeAddress(a)
    .completeSync()
  assert.equal(await withChainScriptDataHash(plain), plain)
  assert.equal(urls.length, 0)
})
