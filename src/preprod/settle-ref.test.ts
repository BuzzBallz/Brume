// Offline: an escrow reference names every file of a settlement, and a proposal's reference comes from the
// counterparty's file. Only <64 hex>#<index> is accepted, so a forged reference can never name another path.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Proposal } from '../../shared/types.ts'
import { lock, proposalFile, SettleError, submit, txLogFile } from './settle.ts'

const REF = `${'ab'.repeat(32)}#0`
const FORGED = ['../proposals/x', `${'ab'.repeat(32)}#0/../../x`, `${'AB'.repeat(32)}#0`, `${'ab'.repeat(31)}#0`, `${'ab'.repeat(32)}`, '']

test('a real escrow reference names its files as <hash>_<index>', () => {
  assert.match(proposalFile(REF), /out[\\/]proposals[\\/]a{0}(ab){32}_0\.json$/)
  assert.match(txLogFile(REF), /txlog-(ab){32}_0\.json$/)
})

test('anything else is refused before it names a file', () => {
  for (const ref of FORGED) {
    assert.throws(() => proposalFile(ref), SettleError, ref)
    assert.throws(() => txLogFile(ref), SettleError, ref)
    assert.throws(() => lock(ref), SettleError, ref)
  }
})

test('submit refuses a proposal whose escrowRef is a path, before any record or key is read', async () => {
  const forged: Proposal = { escrowRef: '../proposals/x', network: 'preprod', path: 'B', sellerShare: 0.4, payout: { buyer: {}, seller: {}, fee: {} }, signedBy: [] }
  await assert.rejects(submit(forged), (e: unknown) => e instanceof SettleError && /Not an escrow reference/.test(e.message))
})
