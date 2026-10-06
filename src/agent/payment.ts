import { createHash } from 'node:crypto'

const NETWORK = 'Preprod'
// The payment service wants payByTime at least 5 min before submitResultTime, and submitResultTime at least 15 min ahead.
const PAY_WITHIN_MS = 30 * 60_000
const SUBMIT_WITHIN_MS = 60 * 60_000

export const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

// RFC 8785 for the value kinds an input can hold: sorted keys, no whitespace.
export const canonical = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(canonical).join(',')}]`
    : v && typeof v === 'object'
      ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`
      : JSON.stringify(v)

// MIP-004: the purchaser's identifier is part of both hashes.
export const inputHash = (identifier: string, input: unknown) => sha256(`${identifier};${canonical(input)}`)
export const resultHash = (identifier: string, result: string) => sha256(`${identifier};${result}`)

export function assertConfigured() {
  for (const v of ['PAYMENT_SERVICE_URL', 'PAYMENT_API_KEY', 'AGENT_IDENTIFIER']) {
    if (!process.env[v]) throw new Error(`HIRE_VIA=sokosumi needs ${v} in .env`)
  }
}

async function call(path: string, method: 'GET' | 'POST', body?: unknown) {
  const res = await fetch(`${process.env.PAYMENT_SERVICE_URL}${path}`, {
    method,
    headers: { token: process.env.PAYMENT_API_KEY ?? '', 'content-type': 'application/json', accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`payment service ${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`)
  return JSON.parse(text).data
}

export type Payment = {
  blockchainIdentifier: string
  payByTime: string
  submitResultTime: string
  unlockTime: string
  externalDisputeUnlockTime: string
  onChainState: string | null
  RequestedFunds: { amount: string; unit: string }[]
  SmartContractWallet: { walletVkey: string } | null
}

export const createPayment = (identifierFromPurchaser: string, hash: string): Promise<Payment> =>
  call('/payment/', 'POST', {
    payByTime: new Date(Date.now() + PAY_WITHIN_MS).toISOString(),
    submitResultTime: new Date(Date.now() + SUBMIT_WITHIN_MS).toISOString(),
    network: NETWORK,
    agentIdentifier: process.env.AGENT_IDENTIFIER,
    paymentSourceType: 'Web3CardanoV2',
    supportedPaymentSourceIndex: 0,
    inputHash: hash,
    identifierFromPurchaser,
  })

export const resolvePayment = (blockchainIdentifier: string): Promise<Payment> =>
  call('/payment/resolve-blockchain-identifier', 'POST', { blockchainIdentifier, network: NETWORK })

export const submitResult = (blockchainIdentifier: string, submitResultHash: string) =>
  call('/payment/submit-result', 'POST', { network: NETWORK, blockchainIdentifier, submitResultHash })
