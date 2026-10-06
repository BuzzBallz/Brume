// Offline: an offer's signing time is the signer's own claim, so its expiry is bounded by the offer lifetime both sides
// use (30 min) plus the clock skew allowed (5 min). A counterparty cannot sign an accept that stays fresh for days.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CLOCK_SKEW_MS, OFFER_TTL_MS, parseOffer } from './cip8.ts'
import { SettleError } from './settle.ts'

const T0 = 1_791_262_222_000
const offer = (expiresMs: number): Record<string, unknown> => ({
  kind: 'accept', escrowRef: `${'12'.repeat(32)}#0`, network: 'preprod', path: 'B', sellerShare: 0.4, by: 'buyer',
  atMs: T0, expiresMs, prev: '34'.repeat(32), nonce: '56'.repeat(16),
})

test('an offer expiring within the offer lifetime is read (positive control)', () => {
  assert.equal(parseOffer(offer(T0 + OFFER_TTL_MS)).expiresMs, T0 + OFFER_TTL_MS)
})

test('an offer expiring later than the offer lifetime after it was signed is refused', () => {
  assert.throws(() => parseOffer(offer(T0 + OFFER_TTL_MS + CLOCK_SKEW_MS + 1)), (e: unknown) => e instanceof SettleError && /at most 35 min after it was signed/.test(e.message))
  assert.throws(() => parseOffer(offer(T0 + 365 * 86_400_000)), SettleError)
})
