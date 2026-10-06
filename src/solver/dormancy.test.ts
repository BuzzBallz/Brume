import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import type { Tip } from '../../shared/types.ts'
import { ARBITER_LAST_ACTION_MS, SCRIPT_HASH } from '../../shared/constants.ts'
import { BOUNDARY_HEIGHT, BOUNDARY_TX, classify, CONTROL_HEIGHT, CONTROL_TX, koiosListing, PIN, pinnedDormancy, runCheck, type Spend, type Walk } from './dormancy.ts'

// --- classify(): pure ---
const TIP: Tip = { height: PIN.height + 100, hash: 'tip', timeMs: PIN.timeMs + 3_600_000 }
const spend = (txHash: string, height: number, redeemer: number, validContract = true): Spend => ({ txHash, height, timeMs: PIN.timeMs + (height - PIN.height) * 20_000, redeemer, validContract })
const walk = (provider: Walk['provider'], over: Partial<Walk> = {}): Walk => ({
  provider, tip: TIP, txs: 2, spends: [spend('h1', PIN.height + 10, 5), spend('h2', PIN.height + 20, 3)], holes: 0, controls: { decode: true, listing: true }, errors: [], ...over,
})

test('classify: a clean walk on both providers is silent through the tip, both named', () => {
  const d = classify([walk('koios'), walk('blockfrost')])
  assert.equal(d.status, 'silent')
  assert.equal(d.method, 'live')
  assert.deepEqual(d.through, TIP)
  assert.deepEqual(d.providers, ['koios', 'blockfrost'])
  assert.equal(d.lastActionMs, ARBITER_LAST_ACTION_MS)
  assert.deepEqual(d.acted, [])
  assert.deepEqual(d.pin, { ...PIN })
})

test('classify: one provider only is never named as two', () => {
  const d = classify([walk('koios')])
  assert.equal(d.status, 'silent')
  assert.deepEqual(d.providers, ['koios'])
})

test('classify: an unverified receipt is pinned (method pin), a silent one live', () => {
  const silent = classify([walk('koios')])
  assert.deepEqual([silent.status, silent.method], ['silent', 'live'])
  const holed = classify([walk('koios', { holes: 1 })])
  assert.deepEqual([holed.status, holed.method], ['unverified', 'pin'])
  assert.deepEqual(holed.through, holed.pin)
})

test('classify: a hole makes it unverified and through stays at the pin', () => {
  const d = classify([walk('koios'), walk('blockfrost', { holes: 1 })])
  assert.equal(d.status, 'unverified')
  assert.deepEqual(d.through, { ...PIN })
  assert.equal(d.holes, 1)
  assert.deepEqual(d.providers, ['koios']) // the complete walk is still named
})

test('classify: a failed decode control or a failed listing control makes it unverified', () => {
  for (const controls of [{ decode: false, listing: true }, { decode: true, listing: false }]) {
    const d = classify([walk('koios', { controls })])
    assert.equal(d.status, 'unverified')
    assert.deepEqual(d.through, { ...PIN })
    assert.deepEqual(d.providers, [])
  }
})

test('classify: a provider diff makes it unverified, listed both ways; spends above the lower tip are not a diff', () => {
  const d = classify([walk('koios'), walk('blockfrost', { spends: [spend('h1', PIN.height + 10, 5), spend('h9', PIN.height + 30, 5)] })])
  assert.equal(d.status, 'unverified')
  assert.deepEqual(d.through, { ...PIN })
  assert.deepEqual(d.diff.sort(), ['h2 (koios only)', 'h9 (blockfrost only)'])
  // Blockfrost's tip is lower: Koios's spend above it is outside the compared window, and through = the lower tip
  const low = { ...TIP, height: PIN.height + 25, hash: 'low' }
  const ok = classify([walk('koios', { spends: [...walk('koios').spends, spend('h3', PIN.height + 50, 5)] }), walk('blockfrost', { tip: low })])
  assert.equal(ok.status, 'silent')
  assert.deepEqual(ok.diff, [])
  assert.deepEqual(ok.through, low)
})

test('classify: a WithdrawDisputed since the pin is acted, a phase-2-failed attempt included, and T restarts at it', () => {
  const failed = spend('a2', PIN.height + 40, 4, false)
  const d = classify([walk('koios', { spends: [...walk('koios').spends, spend('a1', PIN.height + 30, 4), failed] }), walk('blockfrost', { holes: 2 })])
  assert.equal(d.status, 'acted') // acted wins over the holes
  assert.deepEqual(d.acted.map((a) => [a.txHash, a.validContract]), [['a2', false], ['a1', true]])
  assert.equal(d.lastActionMs, failed.timeMs)
  assert.deepEqual(d.through, TIP)
  // a 4 at or below the pin is the pinned history, not a new action
  assert.equal(classify([walk('koios', { spends: [spend('old', PIN.height, 4)] })]).status, 'silent')
})

test('classify: no walk, or no tip, claims nothing past the pin', () => {
  assert.equal(classify([]).status, 'unverified')
  const d = classify([walk('koios', { tip: null })])
  assert.equal(d.status, 'unverified')
  assert.deepEqual(d.through, { ...PIN })
})

test('the offline pin: silent through block 14031823, no live provider claimed', () => {
  const d = pinnedDormancy()
  assert.equal(d.method, 'pin')
  assert.equal(d.status, 'silent')
  assert.deepEqual(d.through, d.pin)
  assert.deepEqual(d.providers, [])
  assert.equal(d.pin.height, 14031823)
  assert.equal(d.pin.timeMs, Date.parse('2026-10-06T04:48:28Z'))
})

// --- the live walk against local mock providers ---
type Tx = { hash: string; height: number; redeemers: number[]; valid?: boolean }
const CHAIN: Tx[] = [
  { hash: CONTROL_TX, height: CONTROL_HEIGHT, redeemers: [4] },
  { hash: BOUNDARY_TX, height: BOUNDARY_HEIGHT, redeemers: [0] },
  { hash: 'pinrow', height: PIN.height, redeemers: [] }, // a lock in the pin block: listed by credential, outside the window
  { hash: 'h1', height: PIN.height + 10, redeemers: [5] },
  { hash: 'h2', height: PIN.height + 20, redeemers: [3, 3] }, // one tx spending two escrows
  { hash: 'lock', height: PIN.height + 30, redeemers: [] }, // a lock pays to the script and runs no redeemer
  { hash: 'above', height: TIP.height + 5, redeemers: [4] }, // after the tip read first: outside the claim
]
const timeOf = (h: number): number => Math.floor((PIN.timeMs + (h - PIN.height) * 20_000) / 1000)

type Mock = { chain?: Tx[]; fail?: (path: string, n: number) => number | null; drop?: string[]; listingOmits?: string[]; nullConstructor?: string[]; omitContracts?: string[] }
async function koiosMock(m: Mock = {}) {
  const chain = m.chain ?? CHAIN
  const listings: number[] = []
  let n = 0
  const srv = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c)).on('end', () => {
      const url = new URL(req.url ?? '', 'http://x')
      const send = (code: number, body: unknown) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body))
      const code = m.fail?.(url.pathname, n++)
      if (code) return send(code, {})
      const body = raw ? JSON.parse(raw) : {}
      if (url.pathname === '/tip') return send(200, [{ block_no: TIP.height, hash: TIP.hash, block_time: TIP.timeMs / 1000 }])
      if (url.pathname === '/credential_txs') {
        assert.deepEqual(body._payment_credentials, [SCRIPT_HASH])
        assert.equal(url.searchParams.get('order'), 'block_height.asc,tx_hash.asc')
        listings.push(body._after_block_height)
        // Koios semantics, verified on mainnet 6 Oct: _after_block_height is inclusive
        const rows = chain.filter((t) => t.height >= body._after_block_height && !(m.listingOmits ?? []).includes(t.hash)).sort((a, b) => a.height - b.height || a.hash.localeCompare(b.hash))
        const offset = Number(url.searchParams.get('offset')), limit = Number(url.searchParams.get('limit'))
        return send(200, rows.slice(offset, offset + limit).map((t) => ({ tx_hash: t.hash, block_height: t.height, block_time: timeOf(t.height) })))
      }
      if (url.pathname === '/tx_info') {
        assert.ok(body._tx_hashes.length <= 20)
        assert.equal(body._scripts, true)
        const rows = chain.filter((t) => body._tx_hashes.includes(t.hash) && !(m.drop ?? []).includes(t.hash))
        return send(200, rows.map((t) => ({
          tx_hash: t.hash, block_height: t.height, tx_timestamp: timeOf(t.height),
          inputs: t.redeemers.map(() => ({ payment_addr: { cred: SCRIPT_HASH, bech32: 'addr1script' } })).concat([{ payment_addr: { cred: 'aa'.repeat(28), bech32: 'addr1key' } }]),
          plutus_contracts: (m.omitContracts ?? []).includes(t.hash) ? null : t.redeemers.map((k) => ({ script_hash: SCRIPT_HASH, valid_contract: t.valid ?? true, input: { redeemer: { purpose: 'spend', datum: { value: { constructor: (m.nullConstructor ?? []).includes(t.hash) ? null : k, fields: [] } } } } })),
        })))
      }
      send(404, {})
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  return { base: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, listings, close: () => srv.close() }
}

async function blockfrostMock(chain: Tx[] = CHAIN) {
  const srv = createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://x')
    const send = (code: number, body: unknown) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    const p = url.pathname
    if (p === '/blocks/latest') return send(200, { height: TIP.height, hash: TIP.hash, time: TIP.timeMs / 1000 })
    if (p === `/scripts/${SCRIPT_HASH}/redeemers`) {
      assert.equal(url.searchParams.get('order'), 'desc')
      const rows = [...chain].sort((a, b) => b.height - a.height).flatMap((t) => t.redeemers.map((k) => ({ tx_hash: t.hash, purpose: 'spend', redeemer_data_hash: `d${k}` })))
      const page = Number(url.searchParams.get('page')), count = Number(url.searchParams.get('count'))
      return send(200, rows.slice((page - 1) * count, page * count))
    }
    const tx = /^\/txs\/([^/]+)(\/redeemers)?$/.exec(p)
    if (tx) {
      const t = chain.find((x) => x.hash === tx[1])
      if (!t) return send(404, {})
      if (tx[2]) return send(200, t.redeemers.map((k) => ({ script_hash: SCRIPT_HASH, purpose: 'spend', redeemer_data_hash: `d${k}` })))
      return send(200, { block_height: t.height, block_time: timeOf(t.height), valid_contract: t.valid ?? true })
    }
    const datum = /^\/scripts\/datum\/d(\d)$/.exec(p)
    if (datum && datum[1] === '9') return send(200, { json_value: null }) // redeemer data that does not resolve
    if (datum) return send(200, { json_value: { constructor: Number(datum[1]), fields: [] } })
    send(404, {})
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  return { base: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, close: () => srv.close() }
}

test('Koios _after_block_height is inclusive, so the walk asks from the pin + 1 and never re-reads the pin block', async () => {
  const k = await koiosMock()
  try {
    // positive control: asked from the pin itself, the (inclusive) listing does return the pin block's tx
    assert.ok((await koiosListing(k.base, PIN.height, 0, 1000, 1))?.some((r) => r.tx_hash === 'pinrow'))
    assert.ok(!(await koiosListing(k.base, PIN.height + 1, 0, 1000, 1))?.some((r) => r.tx_hash === 'pinrow'))
    k.listings.length = 0
    const r = await runCheck({ koiosBase: k.base, blockfrost: false, backoffMs: 1 })
    assert.deepEqual(k.listings, [PIN.height + 1, CONTROL_HEIGHT]) // the walk, then the listing control
    assert.equal(r.walks[0].txs, 3) // h1, h2, lock: the pin block's tx is not re-read
  } finally {
    k.close()
  }
})

test('live walk, Koios only: silent through the tip read first, rows above it ignored, both controls fired', async () => {
  const k = await koiosMock()
  try {
    const r = await runCheck({ koiosBase: k.base, blockfrost: false, backoffMs: 1 })
    const w = r.walks[0]
    assert.equal(w.txs, 3) // h1, h2, lock
    assert.deepEqual(w.spends.map((s) => [s.txHash, s.redeemer]), [['h1', 5], ['h2', 3], ['h2', 3]])
    assert.deepEqual(w.controls, { decode: true, listing: true })
    assert.equal(w.holes, 0)
    assert.equal(r.dormancy.status, 'silent')
    assert.deepEqual(r.dormancy.through, TIP)
    assert.deepEqual(r.dormancy.providers, ['koios'])
    assert.equal(r.skipped.length, 1) // the single-provider claim says so
  } finally {
    k.close()
  }
})

test('live walk: a 429 is retried and is not a hole; a persistent 500 is a hole and T stays at the pin', async () => {
  const k = await koiosMock({ fail: (p, n) => (p === '/credential_txs' && n < 3 ? 429 : null) })
  try {
    const r = await runCheck({ koiosBase: k.base, blockfrost: false, backoffMs: 1 })
    assert.equal(r.walks[0].holes, 0)
    assert.equal(r.dormancy.status, 'silent')
  } finally {
    k.close()
  }
  const bad = await koiosMock({ fail: (p) => (p === '/credential_txs' ? 500 : null) })
  try {
    const r = await runCheck({ koiosBase: bad.base, blockfrost: false, backoffMs: 1 })
    assert.ok(r.walks[0].holes >= 1)
    assert.equal(r.dormancy.status, 'unverified')
    assert.deepEqual(r.dormancy.through, { ...PIN })
  } finally {
    bad.close()
  }
})

test('live walk: a listed tx missing from tx_info is a hole, never silence', async () => {
  const k = await koiosMock({ drop: ['h2'] })
  try {
    const r = await runCheck({ koiosBase: k.base, blockfrost: false, backoffMs: 1 })
    assert.equal(r.walks[0].holes, 1)
    assert.equal(r.dormancy.status, 'unverified')
    assert.deepEqual(r.dormancy.through, { ...PIN })
  } finally {
    k.close()
  }
})

test('live walk: the decode control and the listing control each fail on their own', async () => {
  const wrong = CHAIN.map((t) => (t.hash === CONTROL_TX ? { ...t, redeemers: [5] } : t))
  const k = await koiosMock({ chain: wrong })
  try {
    const r = await runCheck({ koiosBase: k.base, blockfrost: false, backoffMs: 1 })
    assert.deepEqual(r.walks[0].controls, { decode: false, listing: true })
    assert.equal(r.dormancy.status, 'unverified')
  } finally {
    k.close()
  }
  const l = await koiosMock({ listingOmits: [CONTROL_TX] })
  try {
    const r = await runCheck({ koiosBase: l.base, blockfrost: false, backoffMs: 1 })
    assert.deepEqual(r.walks[0].controls, { decode: true, listing: false })
    assert.equal(r.dormancy.status, 'unverified')
    assert.deepEqual(r.dormancy.through, { ...PIN })
  } finally {
    l.close()
  }
})

test('live walk: a phase-2-failed WithdrawDisputed since the pin is acted', async () => {
  const chain = [...CHAIN, { hash: 'arb', height: PIN.height + 40, redeemers: [4], valid: false }]
  const k = await koiosMock({ chain })
  try {
    const r = await runCheck({ koiosBase: k.base, blockfrost: false, backoffMs: 1 })
    assert.equal(r.dormancy.status, 'acted')
    assert.deepEqual(r.dormancy.acted, [{ txHash: 'arb', height: PIN.height + 40, timeMs: timeOf(PIN.height + 40) * 1000, validContract: false }])
    assert.equal(r.dormancy.lastActionMs, timeOf(PIN.height + 40) * 1000)
  } finally {
    k.close()
  }
})

test('live walk on both providers: two methods agree, both named; Blockfrost not reaching the boundary fails its listing control', async (t) => {
  const k = await koiosMock()
  t.after(() => k.close()) // closed whatever fails first, so a red assertion never hangs the run
  const b = await blockfrostMock()
  try {
    const r = await runCheck({ koiosBase: k.base, blockfrostBase: b.base, blockfrost: true, backoffMs: 1 })
    const bf = r.walks[1]
    assert.equal(bf.provider, 'blockfrost')
    assert.deepEqual(bf.controls, { decode: true, listing: true })
    assert.deepEqual(bf.spends.map((s) => s.txHash), ['h2', 'h2', 'h1'])
    assert.equal(r.dormancy.status, 'silent')
    assert.deepEqual(r.dormancy.providers, ['koios', 'blockfrost'])
    assert.deepEqual(r.dormancy.diff, [])
    assert.deepEqual(r.skipped, [])
  } finally {
    b.close()
  }
  const short = await blockfrostMock(CHAIN.filter((t) => t.hash !== BOUNDARY_TX))
  try {
    const r = await runCheck({ koiosBase: k.base, blockfrostBase: short.base, blockfrost: true, backoffMs: 1 })
    assert.equal(r.walks[1].controls.listing, false)
    assert.equal(r.dormancy.status, 'unverified')
    assert.deepEqual(r.dormancy.providers, ['koios'])
  } finally {
    short.close()
  }
})

test('live walk: a V1 redeemer that does not decode is a hole on either provider, never silence', async (t) => {
  const k = await koiosMock({ nullConstructor: ['h1'] })
  t.after(() => k.close())
  const r = await runCheck({ koiosBase: k.base, blockfrost: false, backoffMs: 1 })
  assert.equal(r.walks[0].holes, 1)
  assert.deepEqual([r.dormancy.status, r.dormancy.method], ['unverified', 'pin'])
  assert.deepEqual(r.dormancy.through, { ...PIN })
  const odd = [...CHAIN, { hash: 'odd', height: PIN.height + 15, redeemers: [9] }] // constructor 9: no V1 redeemer
  const k2 = await koiosMock({ chain: odd })
  t.after(() => k2.close())
  const r2 = await runCheck({ koiosBase: k2.base, blockfrost: false, backoffMs: 1 })
  assert.equal(r2.walks[0].holes, 1)
  assert.equal(r2.dormancy.status, 'unverified')
  const b = await blockfrostMock(odd)
  t.after(() => b.close())
  const r3 = await runCheck({ koiosBase: k.base, blockfrostBase: b.base, blockfrost: true, backoffMs: 1 })
  assert.ok(r3.walks[1].errors.some((e) => e.includes('odd') && e.includes('does not decode')))
  assert.equal(r3.dormancy.status, 'unverified')
})

test('live walk: a script spend whose contract data Koios omits is a hole; a lock with no script input is not', async (t) => {
  const k = await koiosMock({ omitContracts: ['h2'] })
  t.after(() => k.close())
  const r = await runCheck({ koiosBase: k.base, blockfrost: false, backoffMs: 1 })
  assert.equal(r.walks[0].holes, 1) // h2 spends two script inputs and shows no V1 redeemer; 'lock' shows none and needs none
  assert.ok(r.walks[0].errors.some((e) => e.includes('h2') && e.includes('script inputs')))
  assert.equal(r.dormancy.status, 'unverified')
})
