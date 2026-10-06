import './env.ts'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { PARAMS } from '../../shared/constants.ts'
import { REDEEMER } from '../../shared/types.ts'
import type { Census, Proposal, Redeemer, Role, TxLogEntry } from '../../shared/types.ts'
import { runCensus } from '../census/census.ts'
import { reach } from '../engine/reach.ts'
import { tryAnyway } from '../preprod/controls.ts'
import { prepare, proposalFile, SettleError, submit, txLogFile, witness } from '../preprod/settle.ts'
import { solve, solverInputFor } from '../solver/solve.ts'
import { body, escrowFor, HttpError, parseNet, parseRef, readDatum, ROOT } from './escrow.ts'
import { getBank } from './bank.ts'
import { mip003 } from './mip003.ts'

const PORT = Number(process.env.PORT ?? 8787)
const CENSUS_TTL_MS = 60_000

let census: { at: number; read: Promise<Census> } | null = null
function getCensus() {
  if (!census || Date.now() - census.at > CENSUS_TTL_MS) {
    const read = runCensus('mainnet').then((r) => r.census)
    read.catch(() => (census = null))
    census = { at: Date.now(), read }
  }
  return census.read
}

type Handler = (url: URL, req: IncomingMessage) => Promise<{ body: unknown; status?: number }> | { body: unknown; status?: number }

const refOfPath = (url: URL) => {
  try {
    return parseRef(decodeURIComponent(url.pathname.split('/')[3] ?? ''))
  } catch {
    throw new HttpError(400, 'bad path')
  }
}
const readJson = (file: string, missing: string) => {
  if (!existsSync(file)) throw new HttpError(404, missing)
  return JSON.parse(readFileSync(file, 'utf8'))
}
const saveProposal = (p: Proposal) => {
  mkdirSync(join(proposalFile(p.escrowRef), '..'), { recursive: true })
  writeFileSync(proposalFile(p.escrowRef), JSON.stringify(p, null, 2) + '\n')
}
// Settlement writes only ever touch preprod escrows: a ref that is not one answers 400 before anything is built.
async function preprodOnly(ref: string) {
  await readDatum('preprod', ref).catch((e) => {
    throw e instanceof HttpError && e.status === 404 ? new HttpError(400, 'Settling and Try anyway run on preprod escrows only.') : e
  })
}

// submit() waits for both blocks (1-2 min): answer 202 once it has started, the UI follows GET /api/txlog.
// A refusal it raises at once (a check before the concession) still comes back as the answer.
const sending = new Map<string, Promise<TxLogEntry[]>>()
async function startSubmit(proposal: Proposal) {
  const ref = proposal.escrowRef
  if (sending.has(ref)) throw new HttpError(409, 'Both legs are already being sent for this escrow.')
  const run = submit(proposal).finally(() => sending.delete(ref))
  sending.set(ref, run)
  const early = await Promise.race([run.then(() => null, (e: unknown) => e), new Promise((r) => setTimeout(() => r(null), 2000))])
  if (early) throw early
  run.catch((e) => console.error(e))
  return { body: { escrowRef: ref, status: 'sending' }, status: 202 }
}

const routes: Record<string, Handler> = {
  ...mip003,
  'GET /api/census': async () => ({ body: { census: await getCensus() } }),
  'GET /api/datum': async (url) => ({ body: await readDatum(parseNet(url.searchParams.get('net') ?? 'mainnet'), parseRef(url.searchParams.get('ref'))) }),
  'GET /api/bank': async () => ({ body: { bank: await getBank() } }),
  'GET /api/txlog': (url) => ({ body: { txlog: readJson(txLogFile(parseRef(url.searchParams.get('ref'))), 'no run recorded for this escrow') } }),
  'GET /api/grid': async (url) => {
    const e = await escrowFor(url)
    return { body: { grid: reach(e.datum, e.value, Date.now(), PARAMS, e.ref) } }
  },
  'GET /api/solver': async (url) => {
    const e = await escrowFor(url)
    return { body: { solver: solve(solverInputFor(e.ref, e.datum, e.value, Date.now()), 'B') } }
  },
  'POST /api/try': async (_url, req) => {
    const { escrowRef, redeemer, role } = (await body(req)) ?? {}
    const ref = parseRef(escrowRef)
    if (!REDEEMER.includes(redeemer)) throw new HttpError(400, 'unknown redeemer')
    if (role !== 'buyer' && role !== 'seller' && role !== 'admin') throw new HttpError(400, 'role must be buyer, seller or admin')
    await preprodOnly(ref)
    return { body: await tryAnyway(ref, redeemer as Redeemer, role as Role) }
  },
  'POST /api/proposal': async (_url, req) => {
    const { escrowRef, sellerShare } = (await body(req)) ?? {}
    const ref = parseRef(escrowRef)
    if (typeof sellerShare !== 'number' || !(sellerShare >= 0 && sellerShare <= 1)) throw new HttpError(400, 'sellerShare must be a number from 0 to 1')
    await preprodOnly(ref)
    return { body: { proposal: await prepare(ref, sellerShare) } }
  },
  'GET /api/proposal/:id': (url) => ({ body: { proposal: readJson(proposalFile(refOfPath(url)), 'no proposal for this escrow yet') } }),
  // witness() keeps a seller's leg-1 signature in the seller's own record, never in the proposal, and that signature
  // starts the send at once (first-mover rule, PLAN §4).
  'POST /api/proposal/:id/witness': async (url, req) => {
    const ref = refOfPath(url)
    const { role, leg, witnessSet } = (await body(req)) ?? {}
    if (role !== 'buyer' && role !== 'seller') throw new HttpError(400, 'role must be buyer or seller')
    if (leg !== 1 && leg !== 2) throw new HttpError(400, 'leg must be 1 or 2')
    if (typeof witnessSet !== 'string' || !/^[0-9a-f]+$/i.test(witnessSet)) throw new HttpError(400, 'witnessSet must be hex CBOR')
    const updated = witness(readJson(proposalFile(ref), 'no proposal for this escrow yet'), role, leg, witnessSet)
    saveProposal(updated)
    if (leg === 1) return startSubmit(updated)
    return { body: { proposal: updated } }
  },
  'POST /api/proposal/:id/submit': (url) => startSubmit(readJson(proposalFile(refOfPath(url)), 'no proposal for this escrow yet')),
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

// docs/ at the root, plus shared/mock/ so the UI's ?source=mock works locally.
function staticFile(path: string, res: ServerResponse) {
  let decoded: string
  try {
    decoded = decodeURIComponent(path === '/' ? '/index.html' : path)
  } catch {
    throw new HttpError(400, 'bad path')
  }
  const rel = normalize(decoded).replace(/^[/\\]+/, '')
  const base = rel.startsWith('shared/mock/') ? ROOT : join(ROOT, 'docs')
  const file = join(base, rel)
  if (!file.startsWith(base) || !TYPES[extname(file)]) throw new HttpError(404, 'not found')
  let content: Buffer
  try {
    content = readFileSync(file)
  } catch {
    throw new HttpError(404, 'not found')
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)], 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }).end(content)
}

const routeKey = (method: string, pathname: string) =>
  `${method} ${pathname.replace(/^(\/api\/proposal\/)[^/]+/, '$1:id')}`

// Tunnel traffic carries cf-connecting-ip; direct local use does not and is never limited, so the UI's polling is safe.
const hits = new Map<string, number[]>()
function limit(req: IncomingMessage, name: string, max: number) {
  const ip = req.headers['cf-connecting-ip']
  if (!ip) return
  const key = `${name}|${ip}`
  const now = Date.now()
  const recent = (hits.get(key) ?? []).filter((t) => now - t < 60_000)
  if (recent.length >= max) throw new HttpError(429, 'rate limit, try again in a minute')
  hits.set(key, [...recent, now])
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v[v.length - 1] > 60_000) hits.delete(k)
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const handler = routes[routeKey(req.method ?? 'GET', url.pathname)]
  if (!handler) {
    if (url.pathname.startsWith('/api/')) throw new HttpError(404, 'unknown route')
    if (req.method !== 'GET') throw new HttpError(405, 'method not allowed')
    return staticFile(url.pathname, res)
  }
  limit(req, 'api', 300)
  if (req.method === 'POST' && url.pathname === '/start_job') limit(req, 'start_job', 10)
  const { body, status } = await handler(url, req)
  const out = JSON.stringify(body)
  res.writeHead(status ?? 200, { 'content-type': 'application/json', 'x-brume-source': 'live', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }).end(out)
}

createServer((req, res) => {
  handle(req, res).catch((caught) => {
    // A settlement refusal is one readable sentence from stream A, shown as-is.
    const e = caught instanceof SettleError ? new HttpError(400, caught.message) : caught
    if (!(e instanceof HttpError)) console.error(e)
    if (res.headersSent) return res.destroy()
    res.writeHead(e instanceof HttpError ? e.status : 500, { 'content-type': 'application/json', 'x-content-type-options': 'nosniff' }).end(JSON.stringify({ error: e instanceof HttpError ? e.message : 'internal error' }))
  })
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Brume agent on http://127.0.0.1:${PORT}  (census: ${process.env.READ_SOURCE === 'fixture' ? 'FIXTURE' : 'live'})`)
})
