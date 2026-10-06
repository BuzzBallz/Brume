import { BLOCKFROST } from '../../shared/constants.ts'
import type { Network, RawUtxo, Read, Tip, Value } from '../../shared/types.ts'
import { request, type Cfg } from './http.ts'

type Row = {
  tx_hash: string
  output_index: number
  address?: string
  amount: { unit: string; quantity: string }[]
  inline_datum: string | null
}

const PAGE = 100
const KEY: Record<Network, string> = { mainnet: 'BLOCKFROST_MAINNET_PROJECT_ID', preprod: 'BLOCKFROST_PREPROD_PROJECT_ID' }

export const available = (net: Network) => Boolean(process.env[KEY[net]])

const get = (net: Network): RequestInit => ({ headers: { project_id: process.env[KEY[net]] ?? '', accept: 'application/json' } })

function toUtxo(r: Row, address: string): RawUtxo {
  const value: Value = {}
  for (const a of r.amount) value[a.unit] = a.quantity
  return { ref: `${r.tx_hash}#${r.output_index}`, address: r.address ?? address, value, inlineDatumCbor: r.inline_datum }
}

// 404 on an address list means "never seen on chain" = zero rows, not a hole.
export async function utxosAt(net: Network, address: string, cfg: Cfg = {}): Promise<Read<RawUtxo[]>> {
  const base = cfg.base ?? BLOCKFROST[net]
  const data: RawUtxo[] = []
  let holes = 0
  for (let page = 1; ; page++) {
    const res = await request(`${base}/addresses/${address}/utxos?count=${PAGE}&page=${page}`, get(net), cfg.backoffMs)
    if (res?.status === 404) break
    if (!res || res.status !== 200) {
      holes++
      break
    }
    const rows = res.body as Row[]
    data.push(...rows.map((r) => toUtxo(r, address)))
    if (rows.length < PAGE) break
  }
  return { data, holes, provider: 'blockfrost' }
}

// Blockfrost has no spent/unspent lookup by ref; resolve the tx outputs and match the index. A spent output is still returned, so callers needing "unspent" use utxosAt.
export async function utxo(net: Network, ref: string, cfg: Cfg = {}): Promise<Read<RawUtxo | null>> {
  const base = cfg.base ?? BLOCKFROST[net]
  const [hash, idx] = ref.split('#')
  const res = await request(`${base}/txs/${hash}/utxos`, get(net), cfg.backoffMs)
  if (res?.status === 404) return { data: null, holes: 0, provider: 'blockfrost' }
  if (!res || res.status !== 200) return { data: null, holes: 1, provider: 'blockfrost' }
  const row = (res.body as { outputs: Row[] }).outputs.find((o) => o.output_index === Number(idx))
  return { data: row ? toUtxo({ ...row, tx_hash: hash }, row.address ?? '') : null, holes: 0, provider: 'blockfrost' }
}

export async function tip(net: Network, cfg: Cfg = {}): Promise<Read<Tip | null>> {
  const base = cfg.base ?? BLOCKFROST[net]
  const res = await request(`${base}/blocks/latest`, get(net), cfg.backoffMs)
  const b = res?.status === 200 ? (res.body as { height: number; hash: string; time: number }) : null
  if (!b) return { data: null, holes: 1, provider: 'blockfrost' }
  return { data: { height: b.height, hash: b.hash, timeMs: b.time * 1000 }, holes: 0, provider: 'blockfrost' }
}
