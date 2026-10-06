// Negative control for escrow.test.ts, in its own file because the chain cost model is cached once per process:
// with Mesh beta.96's 297-entry PlutusV3 model (the chain's first 297 entries) the recomputed hash is NOT the one the
// ledger accepted, so the restore in escrow.test.ts really depends on the epoch-317 model.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { withChainScriptDataHash } from './escrow.ts'
import { loadEnv } from './env.ts'
import { builderCst, cst } from './mesh.ts'

type RealLeg = { leg: 1 | 2; tx_hash: string; cbor: string }
const LEGS = (JSON.parse(readFileSync(new URL('./testdata/real-legs.json', import.meta.url), 'utf8')) as { legs: RealLeg[] }).legs
const EPOCH317 = JSON.parse(readFileSync(new URL('./testdata/costmodel-epoch317.json', import.meta.url), 'utf8')) as { PlutusV3: number[] }

test('withChainScriptDataHash: a stale 297-entry cost model does not reproduce the accepted script_data_hash', async (t) => {
  loadEnv()
  const savedId = process.env.BLOCKFROST_PREPROD_PROJECT_ID
  const realFetch = globalThis.fetch
  process.env.BLOCKFROST_PREPROD_PROJECT_ID = 'pre' + 'prod' + 'x'.repeat(32)
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url !== 'https://cardano-preprod.blockfrost.io/api/v0/epochs/latest/parameters') throw new Error(`unexpected fetch: ${url}`)
    return new Response(JSON.stringify({ cost_models_raw: { PlutusV3: EPOCH317.PlutusV3.slice(0, 297) } }), { status: 200 })
  }) as typeof fetch
  t.after(() => {
    globalThis.fetch = realFetch
    if (savedId === undefined) delete process.env.BLOCKFROST_PREPROD_PROJECT_ID
    else process.env.BLOCKFROST_PREPROD_PROJECT_ID = savedId
  })
  for (const leg of LEGS) {
    const onChain = cst.deserializeTx(leg.cbor).body().scriptDataHash()
    const tx = builderCst.deserializeTx(leg.cbor)
    const body = tx.body()
    body.setScriptDataHash(builderCst.Hash32ByteBase16('00'.repeat(32)))
    const tampered = new builderCst.Transaction(body, tx.witnessSet(), tx.auxiliaryData()).toCbor()
    const stale = await withChainScriptDataHash(tampered)
    const got = cst.deserializeTx(stale).body().scriptDataHash()
    assert.match(got ?? '', /^[0-9a-f]{64}$/)
    assert.notEqual(got, '00'.repeat(32))
    assert.notEqual(got, onChain, `leg ${leg.leg}: a stale model gives another hash (ScriptIntegrityHashMismatch on chain)`)
  }
})
