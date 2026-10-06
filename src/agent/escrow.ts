import { readFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { V1_ADDRESS } from '../../shared/constants.ts'
import type { Datum, Grid, Network, SolverOutput, State, Value } from '../../shared/types.ts'
import { decodeDatum } from '../census/decode.ts'
import * as blockfrost from '../read/blockfrost.ts'
import * as koios from '../read/koios.ts'

export const ROOT = fileURLToPath(new URL('../../', import.meta.url))

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const REF = /^[0-9a-f]{64}#\d{1,4}$/i
export const parseRef = (ref: unknown) => {
  if (typeof ref !== 'string' || !REF.test(ref)) throw new HttpError(400, 'ref must be <64 hex tx hash>#<index>')
  return ref
}
export const parseNet = (net: unknown): Network => {
  if (net !== 'mainnet' && net !== 'preprod') throw new HttpError(400, 'net must be mainnet or preprod')
  return net
}

export async function body(req: IncomingMessage) {
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

type DatumRead = { ref: string; datum: Datum; value: Value }

// Every read goes through this cache, so repeated calls for one ref cost one provider call per TTL. Mainnet escrows
// are read-only and slow-moving (30 s). Preprod escrows are the ones we settle, so theirs is short (3 s): a just-spent
// bank escrow stops showing as live within seconds. Calls for many distinct refs are bounded by the per-IP rate limit
// in server.ts; when the cache is full, the oldest entry goes, never the whole cache.
const DATUM_TTL_MS: Record<Network, number> = { mainnet: 30_000, preprod: 3_000 }
const MAX_CACHED = 500
const datumCache = new Map<string, { at: number; read: Promise<DatumRead> }>()

export function readDatum(net: Network, ref: string): Promise<DatumRead> {
  const key = `${net}|${ref}`
  const hit = datumCache.get(key)
  if (hit && Date.now() - hit.at < DATUM_TTL_MS[net]) return hit.read
  datumCache.delete(key)
  while (datumCache.size >= MAX_CACHED) datumCache.delete(datumCache.keys().next().value!)
  const read = fetchDatum(net, ref)
  datumCache.set(key, { at: Date.now(), read })
  read.catch(() => datumCache.delete(key))
  return read
}

// Two providers when a key is set, so one in trouble (Koios preprod rate-limits us) is not a hole: preprod reads
// Blockfrost first, mainnet keeps keyless Koios first. The second provider is asked only when the first has a hole.
const readers = (net: Network) =>
  !blockfrost.available(net) ? [koios.utxo] : net === 'preprod' ? [blockfrost.utxo, koios.utxo] : [koios.utxo, blockfrost.utxo]

async function fetchDatum(net: Network, ref: string): Promise<DatumRead> {
  let read = { data: null, holes: 1 } as Awaited<ReturnType<typeof koios.utxo>>
  for (const r of readers(net)) {
    read = await r(net, ref)
    if (!read.holes) break
  }
  if (read.holes) throw new HttpError(502, 'the provider did not answer: a hole, not proof the escrow is gone')
  if (!read.data) throw new HttpError(404, 'no unspent output at this ref')
  if (read.data.address !== V1_ADDRESS[net]) throw new HttpError(422, 'this output is not at the V1 escrow address')
  if (read.data.inlineDatumCbor === null) throw new HttpError(422, 'this output has no inline datum')
  try {
    return { ref, datum: decodeDatum(read.data.inlineDatumCbor), value: read.data.value }
  } catch (e) {
    throw new HttpError(422, (e as Error).message)
  }
}

// The escrow a grid or solver call is about: ?net= when the caller knows it, else mainnet first, then preprod
// (a tx hash lives on one network only).
export async function escrowFor(url: URL): Promise<DatumRead> {
  const ref = parseRef(url.searchParams.get('ref'))
  const net = url.searchParams.get('net')
  if (net) return readDatum(parseNet(net), ref)
  // A mainnet failure of any kind still tries preprod; if both fail, the mainnet error is the one reported unless it was a 404.
  return readDatum('mainnet', ref).catch((mainnetError) =>
    readDatum('preprod', ref).catch((preprodError) => {
      throw mainnetError instanceof HttpError && mainnetError.status === 404 ? preprodError : mainnetError
    }),
  )
}
