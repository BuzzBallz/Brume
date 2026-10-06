import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Datum, Value } from '../../shared/types.ts'
import { REDEEMER } from '../../shared/types.ts'
import { PARAMS, USDM } from '../../shared/constants.ts'
import { readDatum } from '../preprod/datum.ts'
import { allowedCells, reach, WINDOW_AFTER_MS, WINDOW_BEFORE_MS } from './reach.ts'

// The real mainnet Disputed escrow pinned in shared/mock (a7084c50…#0), read at the kickoff tip time (block 14031823).
const raw = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'shared', 'mock', 'utxo-disputed.mock.json'), 'utf8')).utxo.inline_datum.bytes as string
const HERO = readDatum(raw)
const HERO_VALUE: Value = { lovelace: '4029850', [USDM]: '2000000' }
const KICKOFF = 1_791_262_108_000
const sorted = (xs: string[]): string[] => [...xs].sort()

test('hero mainnet escrow at the kickoff tip: exactly the three moves the 61 have', () => {
  const g = reach(HERO, HERO_VALUE, KICKOFF, PARAMS, 'a7084c50…#0')
  assert.equal(g.verdicts.length, 21)
  assert.deepEqual(g.verdicts.map((v) => v.redeemer), REDEEMER.flatMap((r) => [r, r, r]))
  assert.deepEqual(sorted(allowedCells(g)), sorted(['UnSetRefundRequested/buyer', 'AuthorizeRefund/seller', 'WithdrawDisputed/admin']))
  const set = g.verdicts.find((v) => v.redeemer === 'SetRefundRequested' && v.role === 'buyer')
  assert.match(set?.failed[0] ?? '', /only before unlock_time/)
  const wd = g.verdicts.find((v) => v.redeemer === 'Withdraw' && v.role === 'seller')
  assert.match(wd?.failed[0] ?? '', /needs ResultSubmitted \(is Disputed\)/)
})

test('after the seller concedes (C11): only the buyer can move the value, and the admin set is out', () => {
  const after: Datum = { ...HERO, state: 'RefundRequested', resultHash: '', sellerCooldownTime: KICKOFF + 3_600_000, buyerCooldownTime: 0 }
  const g = reach(after, HERO_VALUE, KICKOFF, PARAMS)
  assert.deepEqual(sorted(allowedCells(g)), sorted(['WithdrawRefund/buyer', 'UnSetRefundRequested/buyer']))
  const admin = g.verdicts.find((v) => v.redeemer === 'WithdrawDisputed' && v.role === 'admin')
  assert.deepEqual(admin?.failed, ['needs Disputed (is RefundRequested)', 'needs a result hash'])
  const resubmit = g.verdicts.find((v) => v.redeemer === 'SubmitResult' && v.role === 'seller')
  assert.equal(resubmit?.allowed, false)
  assert.deepEqual(g.verdicts.find((v) => v.redeemer === 'WithdrawRefund' && v.role === 'buyer')?.outputRules, ['none: no fee output, no collateral output, the outputs are the buyer\'s to choose'])
})

// Our bank fixtures (src/preprod/fixture.ts): result set, submit deadline past, unlock in 6 h, dispute window in 12 h.
const fixture = (over: Partial<Datum>): Datum => ({
  ...HERO, state: 'ResultSubmitted', submitResultTime: KICKOFF - 20 * 60_000, unlockTime: KICKOFF + 6 * 3_600_000,
  externalDisputeUnlockTime: KICKOFF + 12 * 3_600_000, sellerCooldownTime: 0, buyerCooldownTime: 0, ...over,
})

test('fixture in ResultSubmitted: the buyer can dispute, the seller can resubmit, nobody can exit yet', () => {
  assert.deepEqual(sorted(allowedCells(reach(fixture({}), HERO_VALUE, KICKOFF, PARAMS))), sorted(['SetRefundRequested/buyer', 'SubmitResult/seller']))
})

test('fixture after the dispute: the seller can concede (or resubmit); the buyer waits out its cooldown', () => {
  const disputed = fixture({ state: 'Disputed', buyerCooldownTime: KICKOFF + 37 * 60_000 })
  const g = reach(disputed, HERO_VALUE, KICKOFF, PARAMS)
  assert.deepEqual(sorted(allowedCells(g)), sorted(['AuthorizeRefund/seller', 'SubmitResult/seller']))
  assert.match(g.verdicts.find((v) => v.redeemer === 'UnSetRefundRequested' && v.role === 'buyer')?.failed[0] ?? '', /buyer cooldown until/)
})

test('FundsLocked with no result: the buyer can take the refund exit', () => {
  const locked = fixture({ state: 'FundsLocked', resultHash: '' })
  assert.ok(allowedCells(reach(locked, HERO_VALUE, KICKOFF, PARAMS)).includes('WithdrawRefund/buyer'))
})

test('time bounds: must_end_before is strict, must_start_after is inclusive, at the widest window', () => {
  const atUpper = fixture({ unlockTime: KICKOFF + WINDOW_AFTER_MS })
  assert.equal(reach(atUpper, HERO_VALUE, KICKOFF, PARAMS).verdicts.find((v) => v.redeemer === 'SetRefundRequested' && v.role === 'buyer')?.allowed, false)
  const justAfter = fixture({ unlockTime: KICKOFF + WINDOW_AFTER_MS + 1 })
  assert.equal(reach(justAfter, HERO_VALUE, KICKOFF, PARAMS).verdicts.find((v) => v.redeemer === 'SetRefundRequested' && v.role === 'buyer')?.allowed, true)
  const atLower = { ...HERO, sellerCooldownTime: KICKOFF - WINDOW_BEFORE_MS }
  assert.equal(reach(atLower, HERO_VALUE, KICKOFF, PARAMS).verdicts.find((v) => v.redeemer === 'AuthorizeRefund' && v.role === 'seller')?.allowed, true)
  const insideLower = { ...HERO, sellerCooldownTime: KICKOFF - WINDOW_BEFORE_MS + 1 }
  assert.equal(reach(insideLower, HERO_VALUE, KICKOFF, PARAMS).verdicts.find((v) => v.redeemer === 'AuthorizeRefund' && v.role === 'seller')?.allowed, false)
})

test('the wrong role is refused first, with the reason the UI shows', () => {
  const g = reach(HERO, HERO_VALUE, KICKOFF, PARAMS)
  assert.equal(g.verdicts.find((v) => v.redeemer === 'AuthorizeRefund' && v.role === 'buyer')?.failed[0], 'only the seller signs this')
  assert.equal(g.verdicts.find((v) => v.redeemer === 'WithdrawDisputed' && v.role === 'seller')?.failed[0], 'only the admin set signs this')
})

test('a script-controlled party can never sign', () => {
  const scripted: Datum = { ...HERO, seller: { payment: { type: 'script', hash: 'ab'.repeat(28) }, stake: null } }
  const v = reach(scripted, HERO_VALUE, KICKOFF, PARAMS).verdicts.find((x) => x.redeemer === 'AuthorizeRefund' && x.role === 'seller')
  assert.equal(v?.allowed, false)
  assert.match(v?.failed[0] ?? '', /script address/)
})

test('Withdraw output rules carry this escrow\'s numbers, and the top-up when the collateral floor is all the ADA', () => {
  const rs = fixture({ unlockTime: KICKOFF - 10 * 60_000 }) // past even for the widest lower bound (now − 152 s)
  const v = reach(rs, HERO_VALUE, KICKOFF, PARAMS).verdicts.find((x) => x.redeemer === 'Withdraw' && x.role === 'seller')
  assert.equal(v?.allowed, true)
  assert.match(v?.outputRules[0] ?? '', /201492 lovelace \+ 100000 of c48cbb3d/)
  assert.match(v?.outputRules[1] ?? '', /at least 4029850 lovelace \(no token floor\)/)
  assert.match(v?.outputRules[2] ?? '', /the seller adds 201492 lovelace/)
})
