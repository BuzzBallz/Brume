import { KOIOS, V1_ADDRESS } from '../../shared/constants.ts'
import { STATE } from '../../shared/types.ts'
import type { Network, RawUtxo, Read, Tip, Value } from '../../shared/types.ts'
import { request, type Cfg } from './http.ts'
import type { TxInfo } from './txinfo.ts'

type Row = {
  tx_hash: string
  tx_index: number
  address: string
  value: string
  asset_list: { policy_id: string; asset_name: string; quantity: string }[] | null
  inline_datum: { bytes: string } | null
}

const PAGE = 1000
// KOIOS_PREPROD_API_TOKEN (optional) lifts the keyless daily cap on preprod; header only, never in a URL or a log.
const auth = (net: Network): Record<string, string> => {
  const token = net === 'preprod' ? process.env.KOIOS_PREPROD_API_TOKEN?.trim() : undefined
  return token ? { authorization: `Bearer ${token}` } : {}
}
const post = (net: Network, body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json', ...auth(net) },
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
    // Offsets are only stable under an explicit order: without one, pages past the first can skip or repeat rows.
    const res = await request(`${base}/address_utxos?order=tx_hash.asc,tx_index.asc&limit=${PAGE}&offset=${offset}`, post(net, { _addresses: [address], _extended: true }), cfg.backoffMs)
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
  const res = await request(`${base}/utxo_info`, post(net, { _utxo_refs: [ref], _extended: true }), cfg.backoffMs)
  if (!res || res.status !== 200) return { data: null, holes: 1, provider: 'koios' }
  const rows = (res.body as Row[]).filter((r) => !('is_spent' in r) || !(r as Row & { is_spent: boolean }).is_spent)
  return { data: rows[0] ? toUtxo(rows[0]) : null, holes: 0, provider: 'koios' }
}

export async function tip(net: Network, cfg: Cfg = {}): Promise<Read<Tip | null>> {
  const base = cfg.base ?? KOIOS[net]
  const res = await request(`${base}/tip`, { headers: { accept: 'application/json', ...auth(net) } }, cfg.backoffMs)
  const t = res?.status === 200 ? (res.body as { block_no: number; hash: string; block_time: number }[])[0] : undefined
  if (!t) return { data: null, holes: 1, provider: 'koios' }
  return { data: { height: t.block_no, hash: t.hash, timeMs: t.block_time * 1000 }, holes: 0, provider: 'koios' }
}

type TxRow = {
  tx_hash: string
  block_hash: string
  block_height: number
  absolute_slot: number
  outputs: { payment_addr: { bech32: string }; inline_datum: { value?: { fields?: { constructor?: number }[] } } | null }[]
  plutus_contracts: { script_hash: string; valid_contract: boolean; input: { redeemer?: { purpose: string; datum: { value: { constructor?: number } } } } }[] | null
}

export async function tx(net: Network, hash: string, cfg: Cfg = {}): Promise<Read<TxInfo | null>> {
  const base = cfg.base ?? KOIOS[net]
  const res = await request(`${base}/tx_info`, post(net, { _tx_hashes: [hash], _inputs: false, _metadata: false, _assets: false, _withdrawals: false, _certs: false, _scripts: true, _bytecode: false }), cfg.backoffMs)
  if (!res || res.status !== 200) return { data: null, holes: 1, provider: 'koios' }
  const r = (res.body as TxRow[])[0]
  if (!r) return { data: null, holes: 0, provider: 'koios' }
  const contracts = (r.plutus_contracts ?? []).map((c) => ({ scriptHash: c.script_hash, purpose: c.input.redeemer?.purpose ?? 'unknown', redeemer: c.input.redeemer?.datum.value.constructor ?? null, valid: c.valid_contract }))
  const v1OutputStates = r.outputs
    .filter((o) => o.payment_addr.bech32 === V1_ADDRESS[net])
    .map((o) => STATE[o.inline_datum?.value?.fields?.[15]?.constructor ?? -1] ?? null)
  const validContract = contracts.length ? contracts.every((c) => c.valid) : null
  return { data: { hash: r.tx_hash, blockHash: r.block_hash, blockHeight: r.block_height, slot: r.absolute_slot, contracts, validContract, v1OutputStates }, holes: 0, provider: 'koios' }
}
