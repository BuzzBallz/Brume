// Offline: postCbor (through preprodSubmitter), submitOnly and confirmTx against a stubbed fetch and a fast clock.
// Nothing here reaches a network: every fetch is answered by the stub, and an unexpected URL fails the test.
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { AmbiguousSubmit, LedgerRejection, preprodSubmitter, SubmitTransportError, type Submitter } from './chain.ts'
import { loadEnv } from './env.ts'
import { confirmTx, submitOnly, TxRuleError } from './tx.ts'

const BF = 'https://cardano-preprod.blockfrost.io/api/v0'
const KOIOS_SUBMIT = 'https://preprod.koios.rest/api/v1/submittx'
// Built at runtime so no committed line looks like a project id to the pre-commit hook.
const FAKE_ID = 'pre' + 'prod' + 'x'.repeat(32)
const CBOR = '84a300d90102818258200000000000000000000000000000000000000000000000000000000000000000000181a200581d6000000000000000000000000000000000000000000000000000000000011a000f42400200a0f5f6'
const HASH = 'ab'.repeat(32)
const PHASE1 = 'ConwayUtxowFailure (UtxoFailure (BadInputsUTxO (fromList [TxIn (TxId {unTxId = SafeHash "aa"}) (TxIx 0)])))'
const PHASE2 = 'ConwayUtxowFailure (UtxoFailure (UtxosFailure (ValidationTagMismatch (IsValid True) (FailedUnexpectedly (PlutusFailure "boom" :| [])))))'

type Call = { url: string; init?: RequestInit }
type Handler = (url: string, n: number, init?: RequestInit) => Response | Promise<Response>

// A fake globalThis.fetch for one test; restored after it. `n` counts calls from 0.
function stubFetch(t: TestContext, handler: Handler): Call[] {
  const real = globalThis.fetch
  const calls: Call[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, init })
    return handler(url, calls.length - 1, init)
  }) as typeof fetch
  t.after(() => {
    globalThis.fetch = real
  })
  return calls
}

// setTimeout fires at once and advances a fake Date.now by the requested delay, so backoff and polling deadlines are
// exercised without waiting. Restored after the test.
function fastClock(t: TestContext): { elapsed: () => number } {
  const realSetTimeout = globalThis.setTimeout
  const realNow = Date.now
  const start = realNow()
  let now = start
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    now += ms ?? 0
    return realSetTimeout(fn, 0, ...args)
  }) as typeof setTimeout
  Date.now = () => now
  t.after(() => {
    globalThis.setTimeout = realSetTimeout
    Date.now = realNow
  })
  return { elapsed: () => now - start }
}

// The real .env is loaded first (as tx.test.ts does), then the id is replaced in memory by a fake one and restored.
function fakeBlockfrostId(t: TestContext): void {
  loadEnv()
  const saved = process.env.BLOCKFROST_PREPROD_PROJECT_ID
  process.env.BLOCKFROST_PREPROD_PROJECT_ID = FAKE_ID
  t.after(() => {
    if (saved === undefined) delete process.env.BLOCKFROST_PREPROD_PROJECT_ID
    else process.env.BLOCKFROST_PREPROD_PROJECT_ID = saved
  })
}

const res = (status: number, body: string): Response => new Response(body, { status })
const unexpected = (url: string): never => {
  throw new Error(`unexpected fetch in an offline test: ${url}`)
}
const header = (c: Call, name: string): string | undefined => (c.init?.headers as Record<string, string> | undefined)?.[name]
const bodyHex = (c: Call): string => Buffer.from(c.init?.body as Buffer).toString('hex')

const VIAS = ['koios', 'blockfrost'] as const
const SUBMIT_URL = { koios: KOIOS_SUBMIT, blockfrost: `${BF}/tx/submit` }

// --- postCbor through preprodSubmitter ---

for (const via of VIAS) {
  test(`postCbor (${via}): 200 returns the hash, unquoted, after one POST of the raw bytes`, async (t) => {
    fakeBlockfrostId(t)
    const calls = stubFetch(t, (url) => (url === SUBMIT_URL[via] ? res(200, `"${HASH}"\n`) : unexpected(url)))
    const s = preprodSubmitter(via)
    assert.equal(s.via, via)
    assert.equal(await s.submitTx(CBOR), HASH)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.init?.method, 'POST')
    assert.equal(header(calls[0]!, 'content-type'), 'application/cbor')
    assert.equal(bodyHex(calls[0]!), CBOR)
    // Koios is keyless: no auth header at all. Blockfrost carries the (fake) project id.
    if (via === 'koios') assert.equal(header(calls[0]!, 'project_id'), undefined)
    else assert.ok(header(calls[0]!, 'project_id') === FAKE_ID, 'the in-memory project id is the one sent') // boolean only
  })

  test(`postCbor (${via}): first-attempt 400 naming a ledger rule is a LedgerRejection, not retried`, async (t) => {
    fakeBlockfrostId(t)
    fastClock(t)
    const calls = stubFetch(t, (url) => (url === SUBMIT_URL[via] ? res(400, PHASE1) : unexpected(url)))
    await assert.rejects(preprodSubmitter(via).submitTx(CBOR), (e: unknown) => e instanceof LedgerRejection && e.message.includes('BadInputsUTxO'))
    assert.equal(calls.length, 1)
  })

  test(`postCbor (${via}): first-attempt 400 without a ledger rule is a SubmitTransportError`, async (t) => {
    fakeBlockfrostId(t)
    fastClock(t)
    const calls = stubFetch(t, (url) => (url === SUBMIT_URL[via] ? res(400, '{"error":"Bad Request","message":"Could not decode the CBOR"}') : unexpected(url)))
    await assert.rejects(preprodSubmitter(via).submitTx(CBOR), (e: unknown) => e instanceof SubmitTransportError && !(e instanceof LedgerRejection))
    assert.equal(calls.length, 1)
  })

  test(`postCbor (${via}): 504 then 400 'All inputs are spent' is AmbiguousSubmit (the first copy may be live)`, async (t) => {
    fakeBlockfrostId(t)
    fastClock(t)
    const calls = stubFetch(t, (url, n) => (url !== SUBMIT_URL[via] ? unexpected(url) : n === 0 ? res(504, 'Gateway Timeout') : res(400, 'All inputs are spent. Transaction has probably already been included')))
    await assert.rejects(preprodSubmitter(via).submitTx(CBOR), AmbiguousSubmit)
    assert.equal(calls.length, 2)
  })

  test(`postCbor (${via}): a network error on all 4 attempts is AmbiguousSubmit, after the 1 + 2 + 4 s backoff`, async (t) => {
    fakeBlockfrostId(t)
    const clock = fastClock(t)
    const calls = stubFetch(t, (url) => {
      if (url !== SUBMIT_URL[via]) unexpected(url)
      throw new TypeError('fetch failed')
    })
    await assert.rejects(preprodSubmitter(via).submitTx(CBOR), (e: unknown) => e instanceof AmbiguousSubmit && /no answer/.test(e.message))
    assert.equal(calls.length, 4)
    assert.equal(clock.elapsed(), 7_000)
  })

  test(`postCbor (${via}): 403 is a SubmitTransportError (a hole, never a refusal), not retried`, async (t) => {
    fakeBlockfrostId(t)
    fastClock(t)
    const calls = stubFetch(t, (url) => (url === SUBMIT_URL[via] ? res(403, 'Forbidden') : unexpected(url)))
    await assert.rejects(preprodSubmitter(via).submitTx(CBOR), (e: unknown) => e instanceof SubmitTransportError && /HTTP 403/.test(e.message))
    assert.equal(calls.length, 1)
  })

  test(`postCbor (${via}): transient failures are retried, then the hash comes back (positive control for the retries)`, async (t) => {
    fakeBlockfrostId(t)
    fastClock(t)
    const calls = stubFetch(t, (url, n) => {
      if (url !== SUBMIT_URL[via]) unexpected(url)
      if (n === 0) throw new TypeError('fetch failed')
      if (n === 1) return res(429, 'Too Many Requests')
      return res(200, HASH)
    })
    assert.equal(await preprodSubmitter(via).submitTx(CBOR), HASH)
    assert.equal(calls.length, 3)
  })
}

test('postCbor: 5xx on every attempt is AmbiguousSubmit, never a transport error', async (t) => {
  fastClock(t)
  const calls = stubFetch(t, (url) => (url === KOIOS_SUBMIT ? res(502, 'Bad Gateway') : unexpected(url)))
  await assert.rejects(preprodSubmitter('koios').submitTx(CBOR), AmbiguousSubmit)
  assert.equal(calls.length, 4)
})

test('postCbor: 429 on every attempt is a SubmitTransportError (never reached a node)', async (t) => {
  fastClock(t)
  const calls = stubFetch(t, (url) => (url === KOIOS_SUBMIT ? res(429, 'Too Many Requests') : unexpected(url)))
  await assert.rejects(preprodSubmitter('koios').submitTx(CBOR), (e: unknown) => e instanceof SubmitTransportError && /HTTP 429/.test(e.message))
  assert.equal(calls.length, 4)
})

// --- submitOnly ---

const SIGNED = { cborHex: CBOR, txHash: HASH }
const BASE = { step: 'test step', network: 'preprod' as const, scriptHash: '', txHash: HASH, atMs: 1_791_262_222_000, via: 'koios' as const }
const failing = (error: Error): Submitter => ({ via: 'koios', submitTx: async () => { throw error } })

test('submitOnly: a successful submit returns null (positive control)', async () => {
  assert.equal(await submitOnly(SIGNED, { via: 'koios', submitTx: async () => HASH }, BASE), null)
})

test('submitOnly: a submitter that returns another hash is refused', async () => {
  await assert.rejects(submitOnly(SIGNED, { via: 'koios', submitTx: async () => 'cd'.repeat(32) }, BASE), TxRuleError)
})

test('submitOnly: AmbiguousSubmit, then the tx is seen in a block → null (submitted)', async (t) => {
  fakeBlockfrostId(t)
  fastClock(t)
  const calls = stubFetch(t, (url) => (url === `${BF}/txs/${HASH}` ? res(200, JSON.stringify({ hash: HASH })) : unexpected(url)))
  assert.equal(await submitOnly(SIGNED, failing(new AmbiguousSubmit('timeout')), BASE), null)
  assert.equal(calls.length, 1)
  assert.ok(header(calls[0]!, 'project_id') === FAKE_ID)
})

test('submitOnly: AmbiguousSubmit, then the tx is seen only in the mempool → null (submitted)', async (t) => {
  fakeBlockfrostId(t)
  fastClock(t)
  const calls = stubFetch(t, (url, n) => {
    if (url === `${BF}/txs/${HASH}`) return res(404, '{"status_code":404}')
    if (url === `${BF}/mempool/${HASH}`) return n < 3 ? res(404, '{"status_code":404}') : res(200, JSON.stringify({ tx: { hash: HASH } }))
    return unexpected(url)
  })
  assert.equal(await submitOnly(SIGNED, failing(new AmbiguousSubmit('timeout')), BASE), null)
  assert.deepEqual(calls.map((c) => c.url.slice(BF.length).split('/')[1]), ['txs', 'mempool', 'txs', 'mempool'])
})

test('submitOnly: AmbiguousSubmit and never seen in 90 s → the AmbiguousSubmit is rethrown, never a refusal', async (t) => {
  fakeBlockfrostId(t)
  const clock = fastClock(t)
  const calls = stubFetch(t, (url) => (url === `${BF}/txs/${HASH}` || url === `${BF}/mempool/${HASH}` ? res(404, '{"status_code":404}') : unexpected(url)))
  const ambiguous = new AmbiguousSubmit('no answer from the submit endpoint')
  await assert.rejects(submitOnly(SIGNED, failing(ambiguous), BASE), (e: unknown) => e === ambiguous)
  assert.ok(clock.elapsed() >= 90_000, 'polled until the deadline')
  assert.equal(calls.length, 2 * 18) // one /txs and one /mempool read every 5 s for 90 s
})

test('submitOnly: a LedgerRejection becomes a refused entry with its phase (1 and 2)', async () => {
  const p1 = await submitOnly(SIGNED, failing(new LedgerRejection(PHASE1)), BASE)
  assert.deepEqual(p1, { ...BASE, status: 'refused', stage: 'submit', refusal: { phase: 1, ledgerError: PHASE1 }, error: PHASE1 })
  const p2 = await submitOnly(SIGNED, failing(new LedgerRejection(PHASE2)), BASE)
  assert.equal(p2?.status, 'refused')
  assert.equal(p2?.refusal?.phase, 2)
  assert.equal(p2?.refusal?.ledgerError, PHASE2)
})

test('submitOnly: a SubmitTransportError is thrown (a hole), never logged as a refusal', async () => {
  const hole = new SubmitTransportError('submit HTTP 403: Forbidden')
  await assert.rejects(submitOnly(SIGNED, failing(hole), BASE), (e: unknown) => e === hole)
})

test('submitOnly + preprodSubmitter: a real first-attempt ledger 400 ends as a phase-1 refused entry', async (t) => {
  fastClock(t)
  stubFetch(t, (url) => (url === KOIOS_SUBMIT ? res(400, PHASE1) : unexpected(url)))
  const e = await submitOnly(SIGNED, preprodSubmitter('koios'), BASE)
  assert.equal(e?.status, 'refused')
  assert.equal(e?.refusal?.phase, 1)
})

// --- confirmTx ---

const BLOCK = { block: 'cd'.repeat(32), block_height: 5_259_570, slot: 135_583_699 }

test('confirmTx: in a block with valid_contract true → accepted at confirm, pinned to the block (positive control)', async (t) => {
  fakeBlockfrostId(t)
  fastClock(t)
  stubFetch(t, (url) => (url === `${BF}/txs/${HASH}` ? res(200, JSON.stringify({ ...BLOCK, valid_contract: true })) : unexpected(url)))
  const e = await confirmTx(BASE)
  assert.deepEqual(e, { ...BASE, status: 'accepted', stage: 'confirm', block: { height: BLOCK.block_height, hash: BLOCK.block, slot: BLOCK.slot } })
})

test('confirmTx: valid_contract false → refused, phase 2 (collateral consumed), still pinned to its block', async (t) => {
  fakeBlockfrostId(t)
  fastClock(t)
  stubFetch(t, (url) => (url === `${BF}/txs/${HASH}` ? res(200, JSON.stringify({ ...BLOCK, valid_contract: false })) : unexpected(url)))
  const e = await confirmTx(BASE)
  assert.equal(e.status, 'refused')
  assert.equal(e.stage, 'confirm')
  assert.equal(e.refusal?.phase, 2)
  assert.match(e.refusal?.ledgerError ?? '', /valid_contract=false/)
  assert.equal(e.block?.height, BLOCK.block_height)
})

test('confirmTx: a read error (5 failed fetches = one hole) then the block → confirmed with its block', async (t) => {
  fakeBlockfrostId(t)
  fastClock(t)
  const calls = stubFetch(t, (url, n) => {
    if (url !== `${BF}/txs/${HASH}`) unexpected(url)
    if (n < 5) throw new TypeError('fetch failed') // blockfrostGet: 1 attempt + 4 retries, then throws
    return res(200, JSON.stringify({ ...BLOCK, valid_contract: true }))
  })
  const e = await confirmTx(BASE)
  assert.equal(e.status, 'accepted')
  assert.equal(e.stage, 'confirm')
  assert.deepEqual(e.block, { height: BLOCK.block_height, hash: BLOCK.block, slot: BLOCK.slot })
  assert.equal(calls.length, 6)
})

test('confirmTx: 5xx holes then 404 then the block → confirmed (a 404 is "not yet", a 5xx is a hole)', async (t) => {
  fakeBlockfrostId(t)
  fastClock(t)
  stubFetch(t, (url, n) => {
    if (url !== `${BF}/txs/${HASH}`) unexpected(url)
    if (n < 5) return res(503, 'unavailable')
    if (n === 5) return res(404, '{"status_code":404}')
    return res(200, JSON.stringify({ ...BLOCK, valid_contract: true }))
  })
  const e = await confirmTx(BASE)
  assert.equal(e.stage, 'confirm')
  assert.equal(e.block?.hash, BLOCK.block)
})

test('confirmTx: never seen → accepted at stage submit, flagged pending, never confirmed', async (t) => {
  fakeBlockfrostId(t)
  fastClock(t)
  stubFetch(t, (url) => (url === `${BF}/txs/${HASH}` ? res(404, '{"status_code":404}') : unexpected(url)))
  const e = await confirmTx(BASE, 60_000)
  assert.equal(e.status, 'accepted')
  assert.equal(e.stage, 'submit')
  assert.equal(e.block, undefined)
  assert.match(e.error ?? '', /pending/)
  assert.match(e.error ?? '', /0 read holes/)
})

test('confirmTx: never seen with read holes → the holes are counted in the pending entry', async (t) => {
  fakeBlockfrostId(t)
  fastClock(t)
  stubFetch(t, (url) => {
    if (url !== `${BF}/txs/${HASH}`) unexpected(url)
    throw new TypeError('fetch failed')
  })
  const e = await confirmTx(BASE, 30_000)
  assert.equal(e.stage, 'submit')
  assert.match(e.error ?? '', /pending/)
  assert.doesNotMatch(e.error ?? '', /\(0 read holes\)/)
})
