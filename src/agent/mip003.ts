import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { JobResult } from '../../shared/types.ts'
import { body, HttpError, mockGrid, mockSolver, parseNet, parseRef, readDatum } from './escrow.ts'
import { assertConfigured, createPayment, inputHash, resolvePayment, resultHash, submitResult } from './payment.ts'
import type { Payment } from './payment.ts'

type Job = { status: 'awaiting_payment' | 'running' | 'completed' | 'failed'; result?: string; createdAt: number }
const jobs = new Map<string, Job>()

// start_job is public behind the tunnel: each call can open a payment at the Masumi service, so open jobs are capped and old ones dropped.
const MAX_OPEN_JOBS = 10
const KEEP_JOBS_MS = 24 * 3600_000
function admit() {
  const now = Date.now()
  let open = 0
  for (const [id, j] of jobs) {
    if (now - j.createdAt > KEEP_JOBS_MS) jobs.delete(id)
    else if (j.status === 'awaiting_payment' || j.status === 'running') open++
  }
  if (open >= MAX_OPEN_JOBS) throw new HttpError(429, 'too many open jobs, try again later')
}

const INPUT_SCHEMA = {
  input_data: [
    { id: 'escrowRef', type: 'string', name: 'Escrow UTxO reference', data: { description: '<tx hash>#<index> of a V1 escrow output' } },
    { id: 'network', type: 'option', name: 'Network', data: { description: 'mainnet is read-only', values: ['mainnet', 'preprod'] } },
  ],
}

// HIRE_VIA=sokosumi: start_job opens a payment at the Masumi payment service and the job runs once the funds are locked. direct (default): no payment, for scripted calls.
const HIRE_VIA = process.env.HIRE_VIA ?? 'direct'
if (HIRE_VIA !== 'direct' && HIRE_VIA !== 'sokosumi') throw new Error('HIRE_VIA must be sokosumi or direct')
if (HIRE_VIA === 'sokosumi') assertConfigured()

const POLL_MS = 10_000
const MAX_POLL_ERRORS = 5
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ponytail: grid and solver come from shared/mock until stream A's engine and solver land, and the result says so.
const ORIGIN = process.env.PUBLIC_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8787}`

async function run(net: 'mainnet' | 'preprod', ref: string) {
  const { datum } = await readDatum(net, ref)
  const result: JobResult & { mock: string[] } = {
    escrowRef: ref,
    grid: mockGrid(ref, datum.state),
    solver: mockSolver(ref),
    uiUrl: `${ORIGIN}/?escrow=${ref}`,
    mock: ['grid', 'solver'],
  }
  return JSON.stringify(result)
}

// Wait for the buyer's funds, run the job, hand the result hash to the payment service. A job that cannot run after payment is left failed and unsubmitted, so the buyer can ask for a refund.
async function settle(job: Job, payment: Payment, identifier: string, net: 'mainnet' | 'preprod', ref: string) {
  const deadline = Number(payment.payByTime) + 60_000
  let errors = 0
  while (job.status === 'awaiting_payment') {
    try {
      const now = await resolvePayment(payment.blockchainIdentifier)
      errors = 0
      if (now.onChainState === 'FundsLocked') job.status = 'running'
      else if (Date.now() > deadline) throw new Error('not paid before payByTime')
    } catch (e) {
      if (++errors >= MAX_POLL_ERRORS || Date.now() > deadline) throw e
    }
    if (job.status === 'awaiting_payment') await sleep(POLL_MS)
  }
  const result = await run(net, ref)
  await submitResult(payment.blockchainIdentifier, resultHash(identifier, result))
  Object.assign(job, { status: 'completed', result })
}

export const mip003 = {
  'GET /availability': () => ({ body: { status: 'available', type: 'masumi-agent' } }),
  'GET /input_schema': () => ({ body: INPUT_SCHEMA }),
  'POST /start_job': async (_url: URL, req: IncomingMessage) => {
    const input = await body(req)
    if (typeof input?.identifier_from_purchaser !== 'string') throw new HttpError(400, 'identifier_from_purchaser is required')
    const data = input.input_data ?? {}
    const ref = parseRef(data.escrowRef)
    const net = parseNet(data.network ?? 'mainnet')
    const identifier: string = input.identifier_from_purchaser
    admit()
    const id = randomUUID()
    if (HIRE_VIA === 'direct') {
      const job: Job = { status: 'running', createdAt: Date.now() }
      jobs.set(id, job)
      run(net, ref).then(
        (result) => Object.assign(job, { status: 'completed', result }),
        (e) => Object.assign(job, { status: 'failed', result: (e as Error).message }),
      )
      return { body: { id, identifierFromPurchaser: identifier } }
    }
    if (!/^[0-9a-f]{14,26}$/i.test(identifier)) throw new HttpError(400, 'identifier_from_purchaser must be 14 to 26 hex characters')
    const hash = inputHash(identifier, data)
    const payment = await createPayment(identifier, hash).catch((e) => {
      throw new HttpError(500, (e as Error).message)
    })
    const job: Job = { status: 'awaiting_payment', createdAt: Date.now() }
    jobs.set(id, job)
    settle(job, payment, identifier, net, ref).catch((e) => Object.assign(job, { status: 'failed', result: (e as Error).message }))
    return {
      body: {
        id,
        blockchainIdentifier: payment.blockchainIdentifier,
        // as the payment service returns them (unix ms, strings): the reference agent passes them through, and buyers repeat them to POST /purchase
        payByTime: payment.payByTime,
        submitResultTime: payment.submitResultTime,
        unlockTime: payment.unlockTime,
        externalDisputeUnlockTime: payment.externalDisputeUnlockTime,
        amounts: payment.RequestedFunds,
        agentIdentifier: process.env.AGENT_IDENTIFIER,
        sellerVKey: payment.SmartContractWallet?.walletVkey,
        identifierFromPurchaser: identifier,
        input_hash: hash,
      },
    }
  },
  'GET /status': (url: URL) => {
    const job = jobs.get(url.searchParams.get('job_id') ?? '')
    if (!job) throw new HttpError(404, 'unknown job_id')
    return { body: { status: job.status, result: job.result } }
  },
}
