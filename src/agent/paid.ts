// A paid Sokosumi Task, after the TOKEN2049 reference worker (demo-agent-token2049, live-demo-name-finder, paid-task.mjs):
// signed terms from our payment service, a masumiPayment event on the Task (Core charges Workspace credits and funds the
// escrow), the job once FundsLocked is confirmed, the result hash to the payment service, then the Task's completion.
// After unlock the payment service collects on its own; the seller receipt comes from `sokosumi runtime receipt`.
// Every stage is saved before its external write; a stage ending in -pending was interrupted mid-write and is never
// retried blindly (the reference does the same).
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { call, sha256 } from './payment.ts'

export const TUSDM = '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d'
const PRICE = '1000000' // 1 test USDM, the event's default quote
const MIN = 60_000

type Funds = { amount: string; unit: string }
type Tx = { status?: string; newOnChainState?: string; txHash?: string }
export type MpsPayment = {
  blockchainIdentifier: string
  agentIdentifier: string
  inputHash: string
  payByTime: string
  submitResultTime: string
  unlockTime: string
  externalDisputeUnlockTime: string
  onChainState: string | null
  resultHash?: string | null
  sellerReturnAddress?: string | null
  forceLayer?: string | null
  RequestedFunds: Funds[]
  PaymentSource?: { network: string; paymentSourceType: string; smartContractAddress: string; policyId: string }
  SmartContractWallet?: { walletVkey: string; walletAddress?: string }
  CurrentTransaction?: Tx | null
  TransactionHistory?: Tx[]
}
export type Paid = {
  stage: string
  nonce?: string
  payment?: MpsPayment
  eventId?: string
  observed?: { onChainState: string | null; resultHash?: string | null }
  resultHash?: string
  receipt?: unknown
}
type Core = { post(path: string, body: unknown): Promise<{ data: { id: string } }> }

export const confirmed = (p: MpsPayment, state: string) =>
  [p.CurrentTransaction, ...(p.TransactionHistory ?? [])].some((t) => t?.status === 'Confirmed' && t.newOnChainState === state)

// The Task event the reference posts, from the signed terms unchanged. Core cannot carry non-null signed overrides.
export function purchasePayload(p: MpsPayment, nonce: string) {
  if (p.sellerReturnAddress != null || p.forceLayer != null) throw new Error('signed terms carry a seller override Core cannot preserve')
  if (p.PaymentSource?.network !== 'Preprod' || p.PaymentSource.paymentSourceType !== 'Web3CardanoV2') throw new Error('payment source is not Preprod Web3CardanoV2')
  if (p.RequestedFunds.length !== 1 || p.RequestedFunds[0].unit !== TUSDM || p.RequestedFunds[0].amount !== PRICE) throw new Error('signed quote differs from 1 test USDM')
  if (!p.SmartContractWallet?.walletVkey) throw new Error('signed terms name no seller key')
  return {
    blockchainIdentifier: p.blockchainIdentifier, agentIdentifier: p.agentIdentifier, sellerVkey: p.SmartContractWallet.walletVkey,
    submitResultTime: p.submitResultTime, payByTime: p.payByTime, unlockTime: p.unlockTime, externalDisputeUnlockTime: p.externalDisputeUnlockTime,
    inputHash: p.inputHash, identifierFromPurchaser: nonce, paymentSourceType: 'Web3CardanoV2', supportedPaymentSourceIndex: 0,
    Amounts: p.RequestedFunds.map(({ amount, unit }) => ({ amount, unit })),
    PaymentSource: { network: 'Preprod', smartContractAddress: p.PaymentSource.smartContractAddress, policyId: p.PaymentSource.policyId },
  }
}

// The Coworker HTTP client of the installed Sokosumi CLI, with the runtime key from its vault (as the reference loads it).
async function coreClient(coworkerId: string, contextUserId?: string): Promise<Core> {
  const root = join(dirname(execFileSync('sokosumi', ['skills', 'path'], { encoding: 'utf8' }).trim()), 'dist', 'src')
  const creds = await import(pathToFileURL(join(root, 'coworker', 'runtime-credentials.js')).href)
  const http = await import(pathToFileURL(join(root, 'api', 'http-client.js')).href)
  return http.createCoworkerHttpClient({ apiKey: creds.readRuntimeCredential(coworkerId), contextUserId })
}

export type PaidContext = {
  taskId: string
  input: string
  coworkerId: string
  contextUserId?: string // the personal Workspace's owner, for a personal Task
  answer: (input: string) => Promise<string>
  saveResult: (result: string) => void // the exact bytes completion will send
  complete: () => void // runtime complete with the saved result file
  receipt: () => unknown // runtime receipt
  save: (p: Paid) => void
}

export async function advancePaid(p: Paid, c: PaidContext): Promise<Paid> {
  const next = (q: Paid) => (c.save(q), q)
  if (p.stage === 'new') {
    if (!process.env.AGENT_IDENTIFIER) throw new Error('AGENT_IDENTIFIER is not set')
    const nonce = randomBytes(10).toString('hex')
    const now = Date.now()
    next({ stage: 'terms-pending', nonce })
    const payment: MpsPayment = await call('/payment/', 'POST', {
      network: 'Preprod', agentIdentifier: process.env.AGENT_IDENTIFIER, paymentSourceType: 'Web3CardanoV2', supportedPaymentSourceIndex: 0,
      inputHash: sha256(c.input), identifierFromPurchaser: nonce, RequestedFunds: [{ amount: PRICE, unit: TUSDM }],
      payByTime: new Date(now + 5 * MIN).toISOString(), submitResultTime: new Date(now + 20 * MIN).toISOString(),
      unlockTime: new Date(now + 36 * MIN).toISOString(), externalDisputeUnlockTime: new Date(now + 52 * MIN).toISOString(),
      metadata: JSON.stringify({ taskId: c.taskId }),
    })
    return next({ stage: 'terms-saved', nonce, payment })
  }
  const pay = p.payment as MpsPayment
  if (p.stage === 'terms-saved') {
    const masumiPayment = purchasePayload(pay, p.nonce as string)
    if (Date.now() >= Number(pay.payByTime)) throw new Error('signed payment deadline expired')
    next({ ...p, stage: 'purchase-pending' })
    const core = await coreClient(c.coworkerId, c.contextUserId)
    const event = await core.post(`/v1/tasks/${encodeURIComponent(c.taskId)}/events`, { comment: 'Payment requested: 1 test USDM.', masumiPayment })
    return next({ ...p, stage: 'awaiting-escrow', eventId: event.data.id })
  }
  if (p.stage === 'awaiting-escrow' || p.stage === 'awaiting-result' || p.stage === 'awaiting-withdrawal') {
    const seen: MpsPayment = await call('/payment/resolve-blockchain-identifier', 'POST', { network: 'Preprod', blockchainIdentifier: pay.blockchainIdentifier, includeHistory: 'true' })
    const q = { ...p, observed: { onChainState: seen.onChainState, resultHash: seen.resultHash } }
    if (p.stage === 'awaiting-escrow') {
      if (seen.onChainState !== 'FundsLocked' || !confirmed(seen, 'FundsLocked')) return next(q)
      if (Date.now() >= Number(pay.submitResultTime)) throw new Error('result deadline passed before the job ran')
      const result = await c.answer(c.input)
      c.saveResult(result)
      return next({ ...q, stage: 'result-saved', resultHash: sha256(result) })
    }
    if (p.stage === 'awaiting-result') {
      if (seen.onChainState !== 'ResultSubmitted' || seen.resultHash !== p.resultHash || !confirmed(seen, 'ResultSubmitted')) return next(q)
      next({ ...q, stage: 'complete-pending' })
      c.complete()
      return next({ ...q, stage: 'awaiting-withdrawal' })
    }
    if (seen.onChainState !== 'Withdrawn' && seen.onChainState !== 'DisputedWithdrawn') return next(q)
    const receipt = c.receipt()
    const settled = (receipt as { settled?: boolean }).settled === true
    return next({ ...q, stage: settled ? 'settled' : 'awaiting-withdrawal', receipt })
  }
  if (p.stage === 'result-saved') {
    if (Date.now() >= Number(pay.submitResultTime)) throw new Error('result deadline passed before submit')
    next({ ...p, stage: 'submit-pending' })
    await call('/payment/submit-result', 'POST', { network: 'Preprod', blockchainIdentifier: pay.blockchainIdentifier, submitResultHash: p.resultHash })
    return next({ ...p, stage: 'awaiting-result' })
  }
  if (p.stage.endsWith('-pending')) throw new Error(`interrupted at ${p.stage}: inspect the payment and the Task before any retry`)
  return p
}
