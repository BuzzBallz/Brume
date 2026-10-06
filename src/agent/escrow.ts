import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { V1_ADDRESS } from '../../shared/constants.ts'
import type { Datum, Network, Value } from '../../shared/types.ts'
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

export const mockFile = (name: string) => JSON.parse(readFileSync(join(ROOT, 'shared/mock', `${name}.mock.json`), 'utf8'))

export async function readDatum(net: Network, ref: string): Promise<{ ref: string; datum: Datum; value: Value }> {
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
