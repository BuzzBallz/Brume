import assert from 'node:assert/strict'
import { test } from 'node:test'
import { confirmed, purchasePayload, TUSDM, type MpsPayment } from './paid.ts'

const terms = (over: Partial<MpsPayment> = {}): MpsPayment => ({
  blockchainIdentifier: 'bc', agentIdentifier: 'agent', inputHash: 'ih', payByTime: '1', submitResultTime: '2', unlockTime: '3', externalDisputeUnlockTime: '4',
  onChainState: null, sellerReturnAddress: null, forceLayer: null, RequestedFunds: [{ amount: '1000000', unit: TUSDM }],
  PaymentSource: { network: 'Preprod', paymentSourceType: 'Web3CardanoV2', smartContractAddress: 'addr', policyId: 'pol' },
  SmartContractWallet: { walletVkey: 'vkey' }, ...over,
})

test('the Task payment carries the signed terms unchanged, and refuses anything but 1 test USDM on Preprod V2', () => {
  const p = purchasePayload(terms(), 'nonce')
  assert.deepEqual([p.blockchainIdentifier, p.sellerVkey, p.identifierFromPurchaser, p.inputHash, p.payByTime], ['bc', 'vkey', 'nonce', 'ih', '1'])
  assert.deepEqual(p.Amounts, [{ amount: '1000000', unit: TUSDM }])
  assert.throws(() => purchasePayload(terms({ RequestedFunds: [{ amount: '2000000', unit: TUSDM }] }), 'n'))
  assert.throws(() => purchasePayload(terms({ RequestedFunds: [{ amount: '1000000', unit: '' }] }), 'n'))
  assert.throws(() => purchasePayload(terms({ sellerReturnAddress: 'addr_x' }), 'n'))
  assert.throws(() => purchasePayload(terms({ PaymentSource: { network: 'Mainnet', paymentSourceType: 'Web3CardanoV2', smartContractAddress: 'a', policyId: 'p' } }), 'n'))
})

test('a state counts only once a transaction reaching it is confirmed', () => {
  assert.equal(confirmed(terms({ CurrentTransaction: { status: 'Pending', newOnChainState: 'FundsLocked' } }), 'FundsLocked'), false)
  assert.equal(confirmed(terms({ TransactionHistory: [{ status: 'Confirmed', newOnChainState: 'FundsLocked' }] }), 'FundsLocked'), true)
  assert.equal(confirmed(terms({ CurrentTransaction: { status: 'Confirmed', newOnChainState: 'ResultSubmitted' } }), 'FundsLocked'), false)
})
