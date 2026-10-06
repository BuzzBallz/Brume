import { readFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { V1_ADDRESS } from '../../shared/constants.ts'
import type { Datum, Grid, Network, SolverOutput, State, Value } from '../../shared/types.ts'
import { decodeDatum } from '../census/decode.ts'
import { utxo } from '../read/koios.ts'

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

// A flood of /api/datum must not become a flood of provider calls: one read per net and ref every 30 s.
const DATUM_TTL_MS = 30_000
const datumCache = new Map<string, { at: number; read: Promise<DatumRead> }>()

export function readDatum(net: Network, ref: string): Promise<DatumRead> {
  const key = `${net}|${ref}`
  const hit = datumCache.get(key)
  if (hit && Date.now() - hit.at < DATUM_TTL_MS) return hit.read
  if (datumCache.size >= 500) datumCache.clear()
  const read = fetchDatum(net, ref)
  datumCache.set(key, { at: Date.now(), read })
  read.catch(() => datumCache.delete(key))
  return read
}

async function fetchDatum(net: Network, ref: string): Promise<DatumRead> {
  const read = await utxo(net, ref)
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
  return readDatum('mainnet', ref).catch((e) => {
    if (e instanceof HttpError && e.status === 404) return readDatum('preprod', ref)
    throw e
  })
}
