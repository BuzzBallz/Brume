import { KOIOS } from '../../shared/constants.ts'
import type { Network, RawUtxo, Read, Tip, Value } from '../../shared/types.ts'
import { request, type Cfg } from './http.ts'

type Row = {
  tx_hash: string
  tx_index: number
  address: string
  value: string
  asset_list: { policy_id: string; asset_name: string; quantity: string }[] | null
  inline_datum: { bytes: string } | null
}

const PAGE = 1000
const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json' },
  body: JSON.stringify(body),
})

function toUtxo(r: Row): RawUtxo {
  const value: Value = { lovelace: r.value }
  for (const a of r.asset_list ?? []) value[a.policy_id + a.asset_name] = a.quantity
  return { ref: `${r.tx_hash}#${r.tx_index}`, address: r.address, value, inlineDatumCbor: r.inline_datum?.bytes ?? null }
}

export async function utxosAt(net: Network, address: string, cfg: Cfg = {}): Promise<Read<RawUtxo[]>> {
  const base = cfg.base ?? KOIOS[net]
  const data: RawUtxo[] = []
  let holes = 0
  for (let offset = 0; ; offset += PAGE) {
    const res = await request(`${base}/address_utxos?limit=${PAGE}&offset=${offset}`, post({ _addresses: [address], _extended: true }), cfg.backoffMs)
    if (!res || res.status !== 200) {
      holes++
      break
    }
    const rows = res.body as Row[]
    data.push(...rows.map(toUtxo))
    if (rows.length < PAGE) break
  }
  return { data, holes, provider: 'koios' }
}

export async function utxo(net: Network, ref: string, cfg: Cfg = {}): Promise<Read<RawUtxo | null>> {
  const base = cfg.base ?? KOIOS[net]
  const res = await request(`${base}/utxo_info`, post({ _utxo_refs: [ref], _extended: true }), cfg.backoffMs)
  if (!res || res.status !== 200) return { data: null, holes: 1, provider: 'koios' }
  const rows = (res.body as Row[]).filter((r) => !('is_spent' in r) || !(r as Row & { is_spent: boolean }).is_spent)
  return { data: rows[0] ? toUtxo(rows[0]) : null, holes: 0, provider: 'koios' }
}

export async function tip(net: Network, cfg: Cfg = {}): Promise<Read<Tip | null>> {
  const base = cfg.base ?? KOIOS[net]
  const res = await request(`${base}/tip`, { headers: { accept: 'application/json' } }, cfg.backoffMs)
  const t = res?.status === 200 ? (res.body as { block_no: number; hash: string; block_time: number }[])[0] : undefined
  if (!t) return { data: null, holes: 1, provider: 'koios' }
  return { data: { height: t.block_no, hash: t.hash, timeMs: t.block_time * 1000 }, holes: 0, provider: 'koios' }
}
