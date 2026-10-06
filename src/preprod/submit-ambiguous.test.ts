// Offline: an outcome the submit cannot know stays possibly live. A read hole while settling an AmbiguousSubmit, and a
// response body that cannot be read after its status came back, are both AmbiguousSubmit, never a plain error a caller
// could take for "not sent". Every fetch is stubbed and the clock is fast.
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { AmbiguousSubmit, preprodSubmitter, type Submitter } from './chain.ts'
import { loadEnv } from './env.ts'
import { submitOnly } from './tx.ts'

const BF = 'https://cardano-preprod.blockfrost.io/api/v0'
const FAKE_ID = 'pre' + 'prod' + 'y'.repeat(32)
const CBOR = '84a300d90102818258200000000000000000000000000000000000000000000000000000000000000000000181a200581d6000000000000000000000000000000000000000000000000000000000011a000f42400200a0f5f6'
const HASH = 'ef'.repeat(32)
const SIGNED = { cborHex: CBOR, txHash: HASH }
const BASE = { step: 'test step', network: 'preprod' as const, scriptHash: '', txHash: HASH, atMs: 1_791_262_222_000, via: 'koios' as const }

function stubFetch(t: TestContext, handler: (url: string) => Response): void {
  const real = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request) => handler(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)) as typeof fetch
  t.after(() => {
    globalThis.fetch = real
  })
}
function fastClock(t: TestContext): void {
  const realSetTimeout = globalThis.setTimeout
  const realNow = Date.now
  let now = realNow()
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    now += ms ?? 0
    return realSetTimeout(fn, 0, ...args)
  }) as typeof setTimeout
  Date.now = () => now
  t.after(() => {
    globalThis.setTimeout = realSetTimeout
    Date.now = realNow
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

test('submitOnly: AmbiguousSubmit, then Blockfrost answers 500 every time → still AmbiguousSubmit, naming the read hole', async (t) => {
  fakeBlockfrostId(t)
  fastClock(t)
  stubFetch(t, (url) => (url.startsWith(BF) ? new Response('upstream error', { status: 500 }) : new Response('unexpected', { status: 418 })))
  const failing: Submitter = { via: 'koios', submitTx: async () => { throw new AmbiguousSubmit('no answer from the submit endpoint') } }
  await assert.rejects(submitOnly(SIGNED, failing, BASE), (e: unknown) => e instanceof AmbiguousSubmit && /could not be read to settle it/.test(e.message))
})

test('postCbor: a 200 whose body cannot be read is AmbiguousSubmit, not a plain error', async (t) => {
  fastClock(t)
  stubFetch(t, () => new Response(new ReadableStream({ start: (c) => c.error(new Error('connection reset')) }), { status: 200 }))
  await assert.rejects(preprodSubmitter('koios').submitTx(CBOR), (e: unknown) => e instanceof AmbiguousSubmit && /body could not be read/.test(e.message))
})
