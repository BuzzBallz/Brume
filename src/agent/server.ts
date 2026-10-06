import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { V1_ADDRESS } from '../../shared/constants.ts'
import type { Census, Network } from '../../shared/types.ts'
import { decodeDatum } from '../census/decode.ts'
import { runCensus } from '../census/census.ts'
import { utxo } from '../read/koios.ts'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const PORT = Number(process.env.PORT ?? 8787)
const CENSUS_TTL_MS = 60_000

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const REF = /^[0-9a-f]{64}#\d{1,4}$/i
const refOf = (url: URL) => {
  const ref = url.searchParams.get('ref') ?? ''
  if (!REF.test(ref)) throw new HttpError(400, 'ref must be <64 hex tx hash>#<index>')
  return ref
}
const netOf = (url: URL): Network => {
  const net = url.searchParams.get('net') ?? 'mainnet'
  if (net !== 'mainnet' && net !== 'preprod') throw new HttpError(400, 'net must be mainnet or preprod')
  return net
}

const mockFile = (name: string) => JSON.parse(readFileSync(join(ROOT, 'shared/mock', `${name}.mock.json`), 'utf8'))

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
const MOCK_ROUTES = ['GET /api/grid', 'GET /api/solver', 'POST /api/try', 'POST /api/proposal', 'GET /api/proposal/:id', 'POST /api/proposal/:id/submit']

type Handler = (url: URL) => Promise<{ body: unknown; mock?: boolean }> | { body: unknown; mock?: boolean }
const mock = (body: unknown) => ({ body, mock: true })
const routes: Record<string, Handler> = {
  'GET /api/census': async () => ({ body: { census: await getCensus() } }),
  'GET /api/datum': async (url) => {
    const net = netOf(url)
    const ref = refOf(url)
    const read = await utxo(net, ref)
    if (read.holes) throw new HttpError(502, 'the provider did not answer: a hole, not proof the escrow is gone')
    if (!read.data) throw new HttpError(404, 'no unspent output at this ref')
    if (read.data.address !== V1_ADDRESS[net]) throw new HttpError(422, 'this output is not at the V1 escrow address')
    if (read.data.inlineDatumCbor === null) throw new HttpError(422, 'this output has no inline datum')
    try {
      return { body: { ref, datum: decodeDatum(read.data.inlineDatumCbor), value: read.data.value } }
    } catch (e) {
      throw new HttpError(422, (e as Error).message)
    }
  },
  'GET /api/grid': () => mock(mockFile('grid')),
  'GET /api/solver': () => mock(mockFile('solver')),
  'POST /api/try': () => mock(mockFile('txlog').txlog.find((e: { status: string }) => e.status === 'refused')),
  'POST /api/proposal': () => mock(mockFile('proposal')),
  'GET /api/proposal/:id': () => mock(mockFile('proposal')),
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
  const rel = normalize(decodeURIComponent(path === '/' ? '/index.html' : path)).replace(/^[/\\]+/, '')
  const base = rel.startsWith('shared/mock/') ? ROOT : join(ROOT, 'docs')
  const file = join(base, rel)
  if (!file.startsWith(base) || !TYPES[extname(file)]) throw new HttpError(404, 'not found')
  try {
    res.writeHead(200, { 'content-type': TYPES[extname(file)], 'cache-control': 'no-store' }).end(readFileSync(file))
  } catch {
    throw new HttpError(404, 'not found')
  }
}

const routeKey = (method: string, pathname: string) =>
  `${method} ${pathname.replace(/^(\/api\/proposal\/)[^/]+/, '$1:id')}`

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET') throw new HttpError(405, 'method not allowed')
    return staticFile(url.pathname, res)
  }
  const handler = routes[routeKey(req.method ?? 'GET', url.pathname)]
  if (!handler) throw new HttpError(404, 'unknown route')
  const { body, mock: isMock } = await handler(url)
  res.writeHead(200, { 'content-type': 'application/json', 'x-brume-source': isMock ? 'mock' : 'live', 'cache-control': 'no-store' }).end(JSON.stringify(body))
}

createServer((req, res) => {
  handle(req, res).catch((e) => {
    const status = e instanceof HttpError ? e.status : 502
    if (!(e instanceof HttpError)) console.error(e)
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: (e as Error).message }))
  })
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Brume agent on http://127.0.0.1:${PORT}  (census: ${process.env.READ_SOURCE === 'fixture' ? 'FIXTURE' : 'live'})`)
  console.log(`MOCK routes, served from shared/mock with x-brume-source: mock:\n  ${MOCK_ROUTES.join('\n  ')}`)
})
