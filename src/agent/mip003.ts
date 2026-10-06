import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { JobResult } from '../../shared/types.ts'
import { HttpError, mockFile, parseNet, parseRef, readDatum } from './escrow.ts'

type Job = { status: 'running' | 'completed' | 'failed'; result?: string }
const jobs = new Map<string, Job>()

const INPUT_SCHEMA = {
  input_data: [
    { id: 'escrowRef', type: 'string', name: 'Escrow UTxO reference', data: { description: '<tx hash>#<index> of a V1 escrow output' } },
    { id: 'network', type: 'option', name: 'Network', data: { description: 'mainnet is read-only', values: ['mainnet', 'preprod'] } },
  ],
}

async function body(req: IncomingMessage) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > 65_536) throw new HttpError(413, 'body too large')
    chunks.push(c)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'body is not JSON')
  }
}

// ponytail: grid and solver come from shared/mock until stream A's engine and solver land, and the result says so. No payment leg yet: start_job answers without the Masumi payment fields.
const ORIGIN = process.env.PUBLIC_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8787}`

async function run(net: 'mainnet' | 'preprod', ref: string) {
  const { datum } = await readDatum(net, ref)
  const result: JobResult & { mock: string[] } = {
    escrowRef: ref,
    grid: { ...mockFile('grid').grid, ref, state: datum.state },
    solver: { ...mockFile('solver').solver, ref },
    uiUrl: `${ORIGIN}/?escrow=${ref}`,
    mock: ['grid', 'solver'],
  }
  return JSON.stringify(result)
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
    const id = randomUUID()
    const job: Job = { status: 'running' }
    jobs.set(id, job)
    run(net, ref).then(
      (result) => Object.assign(job, { status: 'completed', result }),
      (e) => Object.assign(job, { status: 'failed', result: (e as Error).message }),
    )
    return { body: { id, identifierFromPurchaser: input.identifier_from_purchaser } }
  },
  'GET /status': (url: URL) => {
    const job = jobs.get(url.searchParams.get('job_id') ?? '')
    if (!job) throw new HttpError(404, 'unknown job_id')
    return { body: job }
  },
}
