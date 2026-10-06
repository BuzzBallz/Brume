// Offline: the seller share is the seller's own field in the proposal file. The buyer can require the share it agreed
// to (pnpm sign --role buyer <file> --share <s>, or an accepted negotiation on file), and a proposal at any other share
// is refused before any key is loaded or any chain read is made.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Proposal } from '../../shared/types.ts'
import { SettleError, sign } from './settle.ts'
import { parse } from './sign.ts'

const proposal = (sellerShare: number): Proposal => ({
  escrowRef: `${'cd'.repeat(32)}#0`, network: 'preprod', path: 'B', sellerShare,
  payout: { buyer: {}, seller: {}, fee: {} },
  leg2: { redeemer: 'WithdrawRefund', txHash: '00'.repeat(32), cborHex: '', validFromMs: 0, validToMs: 0, inputs: [] },
  signedBy: [],
})

test('the buyer refuses a proposal whose seller share is not the agreed one', async () => {
  await assert.rejects(sign('buyer', proposal(0.75), 0.4), (e: unknown) => e instanceof SettleError && /gives the seller 0\.75, not the agreed 0\.4/.test(e.message))
})

test('pnpm sign --role buyer <file> --share <s> names the share the buyer requires', () => {
  assert.deepEqual(parse(['--role', 'buyer', 'p.json', '--share', '0.4']), { mode: 'file', target: 'p.json', role: 'buyer', share: 0.4, replay: true })
  assert.throws(() => parse(['--role', 'seller', 'p.json', '--share', '0.4']), (e: unknown) => e instanceof SettleError && /--share is for --prepare, --offer and --counter/.test(e.message))
})
