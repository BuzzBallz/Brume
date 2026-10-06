// Offline: the pure parts of preflight.ts. The status rules (clock, script pot), the readers of what the network returns
// (the registration's 721 metadata, Sokosumi's vendors page, the V1 census by state, on the real mainnet datum of
// shared/mock) and the secret scrub every printed line goes through. No fetch, no key.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { TUSDM } from '../../shared/constants.ts'
import { patchDatum } from './datum.ts'
import { apiBaseUrl, bankRows, clockStatus, countStates, dateSkew, format, isAvailable, isScriptPot, REGISTRATION, scrub, shortRef, tally, tipStatus, vendorCounts, VIDEO } from './preflight.ts'

const REAL: string = JSON.parse(readFileSync(new URL('../../shared/mock/utxo-disputed.mock.json', import.meta.url), 'utf8')).utxo.inline_datum.bytes
const POLICY = REGISTRATION.slice(0, 56)
const NAME = REGISTRATION.slice(56)

test('clockStatus: under 30 s PASS, under 90 s WARN, else FAIL, in either direction (windows are ± 150 s)', () => {
  assert.equal(clockStatus(0), 'PASS')
  assert.equal(clockStatus(29_999), 'PASS')
  assert.equal(clockStatus(-29_999), 'PASS')
  assert.equal(clockStatus(30_000), 'WARN')
  assert.equal(clockStatus(-89_999), 'WARN')
  assert.equal(clockStatus(90_000), 'FAIL')
  assert.equal(clockStatus(-3_600_000), 'FAIL')
})

test('tipStatus: a 60 s block gap is no stall; 3 min WARN, 10 min FAIL', () => {
  assert.equal(tipStatus(60_000), 'PASS') // the gaps that made the old clock check WARN on a good clock
  assert.equal(tipStatus(179_999), 'PASS')
  assert.equal(tipStatus(180_000), 'WARN')
  assert.equal(tipStatus(600_000), 'FAIL')
})

test('dateSkew: the local mid round trip against the middle of the Date header second; null without a date', () => {
  const header = 'Wed, 07 Oct 2026 01:00:00 GMT'
  const server = Date.parse(header)
  assert.equal(dateSkew(server + 400, server + 600, header), 0) // mid 500 ms into the second: no skew
  assert.equal(dateSkew(server + 40_500, server + 40_500, header), 40_000) // 40 s fast
  assert.equal(dateSkew(server - 99_500, server - 99_500, header), -100_000) // 100 s slow
  assert.equal(dateSkew(0, 1, null), null)
  assert.equal(dateSkew(0, 1, 'not a date'), null)
})

test('isAvailable: only a MIP-003 availability body counts, not any 200', () => {
  assert.equal(isAvailable('{"status":"available","type":"masumi-agent"}'), true)
  assert.equal(isAvailable('{"status":"available","type":"masumi-agent","message":"Brume reads a V1 escrow"}'), true)
  assert.equal(isAvailable('{"status":"unavailable","type":"masumi-agent"}'), false)
  assert.equal(isAvailable('{"status":"available"}'), false)
  assert.equal(isAvailable('<html>cloudflare error page</html>'), false)
  assert.equal(isAvailable(''), false)
  assert.equal(isAvailable('null'), false)
})

test('bankRows: the bank array of /api/bank, or null for any other shape', () => {
  assert.deepEqual(bankRows('{"bank":[{"ref":"ab#0","state":"Disputed"}]}'), [{ ref: 'ab#0', state: 'Disputed' }])
  assert.deepEqual(bankRows('{"bank":[]}'), [])
  assert.equal(bankRows('{"rows":[]}'), null)
  assert.equal(bankRows('{"bank":[{"state":"Disputed"}]}'), null)
  assert.equal(bankRows('{"bank":[null]}'), null)
  assert.equal(bankRows('<html>oops</html>'), null)
  assert.equal(bankRows('null'), null)
})

test('isScriptPot: exactly 20 tADA and 10 tUSDM, nothing more and nothing less', () => {
  assert.equal(isScriptPot({ lovelace: '20000000', [TUSDM]: '10000000' }), true)
  assert.equal(isScriptPot({ lovelace: '20000000', [TUSDM]: '2000000' }), false) // the 2 tUSDM pots of the later takes
  assert.equal(isScriptPot({ lovelace: '20000000' }), false)
  assert.equal(isScriptPot({ lovelace: '20000001', [TUSDM]: '10000000' }), false)
  assert.equal(isScriptPot({ lovelace: '20000000', [TUSDM]: '10000000', ['ab'.repeat(28) + '01']: '1' }), false)
  assert.equal(isScriptPot({ lovelace: '20000000', [TUSDM]: '10000000', ['ab'.repeat(28) + '01']: '0' }), true) // a zero is no asset
})

test('apiBaseUrl: joins a split CIP-25 string, reads only our asset under our policy', () => {
  const meta = {
    '674': { msg: ['Masumi', 'UpdateAgent'] },
    '721': {
      version: '1',
      [POLICY]: {
        [NAME]: { name: ['Brume'], api_base_url: ['https://trademark-delivery-deposits-weights.trycloudflare.co', 'm'] },
        ['00'.repeat(32)]: { api_base_url: 'https://someone-else.example' },
      },
    },
  }
  assert.equal(apiBaseUrl(meta, POLICY, NAME), 'https://trademark-delivery-deposits-weights.trycloudflare.com')
  assert.equal(apiBaseUrl(meta, POLICY, '00'.repeat(32)), 'https://someone-else.example') // a plain string is kept as is
  assert.equal(apiBaseUrl(meta, POLICY, '11'.repeat(32)), null) // another asset's URL is never taken for ours
  assert.equal(apiBaseUrl(meta, 'ff'.repeat(28), NAME), null)
  assert.equal(apiBaseUrl({ '721': { [POLICY]: { [NAME]: { api_base_url: [1, 2] } } } }, POLICY, NAME), null)
  assert.equal(apiBaseUrl(null, POLICY, NAME), null)
})

test('vendorCounts: the three numbers out of the page text, tags and whitespace in between', () => {
  const html = '<main><p>Pick a vendor.</p><div><span class="n">9</span> <span>Vendors</span></div>\n<div><b>12</b>&nbsp;AI Coworkers</div><div>41 <i>marketplace agents</i></div><script>var x = "1 Vendors 2 AI Coworkers 3 marketplace agents"</script></main>'
  assert.deepEqual(vendorCounts(html), { vendors: 9, coworkers: 12, agents: 41 })
  assert.deepEqual(vendorCounts('<p>1 Vendor 1 AI Coworker 1 marketplace agent</p>'), { vendors: 1, coworkers: 1, agents: 1 })
  assert.equal(vendorCounts('<p>9 Vendors and 12 coworkers</p>'), null)
  // The numbers in a script block are not the page's.
  assert.equal(vendorCounts('<script>"1 Vendors 2 AI Coworkers 3 marketplace agents"</script>'), null)
  assert.deepEqual(VIDEO, { disputed: 61, refundRequested: 4, vendors: 9, coworkers: 12, agents: 41 })
})

test('countStates: counts by decoded state, keeps the undecodable rows apart', () => {
  const refund = patchDatum(REAL, { state: 'RefundRequested' })
  const rows = [{ inline_datum: { bytes: REAL } }, { inline_datum: { bytes: REAL } }, { inline_datum: { bytes: refund } }, { inline_datum: null }, { inline_datum: { bytes: 'd87980' } }]
  const { byState, undecodable } = countStates(rows)
  assert.deepEqual(byState, { FundsLocked: 0, ResultSubmitted: 0, RefundRequested: 1, Disputed: 2 })
  assert.equal(undecodable, 2)
  assert.deepEqual(countStates([]), { byState: { FundsLocked: 0, ResultSubmitted: 0, RefundRequested: 0, Disputed: 0 }, undecodable: 0 })
})

test('scrub: secret env values are cut out of a line, other values are left alone', () => {
  const env = { BLOCKFROST_PREPROD_PROJECT_ID: 'preprodAbCdEf123456', KOIOS_PREPROD_API_TOKEN: 'eyJhbGciOi.token.value', PREPROD_SELLER_SKEY: 'root-key-material-0001', AGENT_IDENTIFIER: REGISTRATION, SHORT_KEY: 'abc' }
  const line = `HTTP 403 for preprodAbCdEf123456 with eyJhbGciOi.token.value and root-key-material-0001 on ${REGISTRATION} abc`
  const out = scrub(line, env)
  assert.equal(out, `HTTP 403 for <redacted> with <redacted> and <redacted> on ${REGISTRATION} abc`)
  // Control: with no secret in the environment the line is unchanged.
  assert.equal(scrub(line, {}), line)
})

test('format and tally: one line per check, INFO not counted', () => {
  const lines = [
    { status: 'PASS', check: 'keys', reason: 'a' },
    { status: 'WARN', check: 'agent', reason: 'b' },
    { status: 'FAIL', check: 'registered endpoint', reason: 'c' },
    { status: 'FAIL', check: 'census', reason: 'd' },
    { status: 'INFO', check: 'sokosumi listing', reason: 'e' },
  ] as const
  assert.equal(format(lines[2]), 'FAIL  registered endpoint: c')
  assert.deepEqual(tally([...lines]), { pass: 1, warn: 1, fail: 2, text: '1 PASS, 1 WARN, 2 FAIL' })
  assert.equal(tally([]).text, '0 PASS, 0 WARN, 0 FAIL')
  assert.equal(shortRef(`${'ab'.repeat(32)}#3`), 'ababababab…#3')
})
