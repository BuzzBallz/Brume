import './env.ts'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, normalize } from 'node:path'
import type { Census } from '../../shared/types.ts'
import { runCensus } from '../census/census.ts'
import { body, HttpError, mockFile, parseNet, parseRef, readDatum, ROOT } from './escrow.ts'
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

// ponytail: grid, solver, try and the settle flow stay on shared/mock until stream A's engine, solver and preprod land; each is one line to swap.
const MOCK_ROUTES = ['GET /api/grid', 'GET /api/solver', 'POST /api/try', 'POST /api/proposal', 'GET /api/proposal/:id', 'POST /api/proposal/:id/witness', 'POST /api/proposal/:id/submit']

type Handler = (url: URL, req: IncomingMessage) => Promise<{ body: unknown; mock?: boolean }> | { body: unknown; mock?: boolean }
const mock = (body: unknown) => ({ body, mock: true })

// First-mover rule (PLAN §4): a leg-2 witness is stored; a leg-1 witness is never stored, it goes out as an immediate submit.
const witnessed = new Map<string, Set<string>>()
const proposalFor = (ref: string) => {
  const m = mockFile('proposal')
  return { ...m, proposal: { ...m.proposal, signedBy: [...(witnessed.get(ref) ?? [])] } }
}
const refOfPath = (url: URL) => {
  try {
    return decodeURIComponent(url.pathname.split('/')[3] ?? '').slice(0, 200)
  } catch {
    throw new HttpError(400, 'bad path')
  }
}
const routes: Record<string, Handler> = {
  ...mip003,
  'GET /api/census': async () => ({ body: { census: await getCensus() } }),
  'GET /api/datum': async (url) => ({ body: await readDatum(parseNet(url.searchParams.get('net') ?? 'mainnet'), parseRef(url.searchParams.get('ref'))) }),
  'GET /api/grid': () => mock(mockFile('grid')),
  'GET /api/solver': () => mock(mockFile('solver')),
  'POST /api/try': () => mock(mockFile('txlog').txlog.find((e: { status: string }) => e.status === 'refused')),
  'POST /api/proposal': () => mock(mockFile('proposal')),
  'GET /api/proposal/:id': (url) => mock(proposalFor(refOfPath(url))),
  'POST /api/proposal/:id/witness': async (url, req) => {
    const { role, leg } = (await body(req)) ?? {}
    if (role !== 'buyer' && role !== 'seller') throw new HttpError(400, 'role must be buyer or seller')
    if (leg !== 1 && leg !== 2) throw new HttpError(400, 'leg must be 1 or 2')
    if (leg === 1) return mock(mockFile('txlog'))
    const ref = refOfPath(url)
    if (!witnessed.has(ref) && witnessed.size >= 100) throw new HttpError(429, 'too many proposals')
    witnessed.set(ref, (witnessed.get(ref) ?? new Set()).add(role))
    return mock(proposalFor(ref))
  },
  'POST /api/proposal/:id/submit': () => mock(mockFile('txlog')),
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
  const { body, mock: isMock } = await handler(url, req)
  const out = JSON.stringify(body)
  res.writeHead(200, { 'content-type': 'application/json', 'x-brume-source': isMock ? 'mock' : 'live', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }).end(out)
}

createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (!(e instanceof HttpError)) console.error(e)
    if (res.headersSent) return res.destroy()
    res.writeHead(e instanceof HttpError ? e.status : 500, { 'content-type': 'application/json', 'x-content-type-options': 'nosniff' }).end(JSON.stringify({ error: e instanceof HttpError ? e.message : 'internal error' }))
  })
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Brume agent on http://127.0.0.1:${PORT}  (census: ${process.env.READ_SOURCE === 'fixture' ? 'FIXTURE' : 'live'})`)
  console.log(`MOCK routes, served from shared/mock with x-brume-source: mock:\n  ${MOCK_ROUTES.join('\n  ')}`)
})
