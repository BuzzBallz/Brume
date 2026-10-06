// pnpm engine <txHash#index> [--net mainnet|preprod] [--at <ISO time>]
// Keyless and read-only on both networks: one Koios read of the escrow UTxO, then the 7 × 3 grid at that time.
import { parseArgs } from 'node:util'
import type { Network, Value } from '../../shared/types.ts'
import { KOIOS, PARAMS, V1_ADDRESS } from '../../shared/constants.ts'
import { readDatum } from '../preprod/datum.ts'
import { reach } from './reach.ts'

const { positionals, values } = parseArgs({ allowPositionals: true, options: { net: { type: 'string', default: 'mainnet' }, at: { type: 'string' } } })
const ref = positionals[0]
const net = values.net as Network
if (!ref || !/^[0-9a-f]{64}#\d+$/.test(ref) || (net !== 'mainnet' && net !== 'preprod')) throw new Error('usage: pnpm engine <txHash#index> [--net mainnet|preprod] [--at ISO]')

type Row = { tx_hash: string; tx_index: number; address: string; value: string; is_spent: boolean; inline_datum: { bytes: string } | null; asset_list: { policy_id: string; asset_name: string; quantity: string }[] | null }
const res = await fetch(`${KOIOS[net]}/utxo_info`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ _utxo_refs: [ref], _extended: true }), signal: AbortSignal.timeout(30_000),
})
if (!res.ok) throw new Error(`Koios ${net} utxo_info HTTP ${res.status}: no grid (a failed read is a hole, not an answer)`)
const row = ((await res.json()) as Row[])[0]
if (!row) throw new Error(`${ref} is not known to Koios ${net}`)
if (row.address !== V1_ADDRESS[net]) throw new Error(`${ref} is not at the V1 escrow address`)
if (!row.inline_datum) throw new Error(`${ref} has no inline datum`)
const value: Value = { lovelace: row.value }
for (const a of row.asset_list ?? []) value[a.policy_id + a.asset_name] = a.quantity
const at = values.at ? Date.parse(values.at) : Date.now()
const grid = reach(readDatum(row.inline_datum.bytes), value, at, PARAMS, ref)

console.log(`${ref} on ${net}${row.is_spent ? ' (SPENT: the grid describes its last state)' : ''}, ${grid.state}, at ${new Date(at).toISOString()}`)
const cell = (redeemer: string, role: string): string => {
  const v = grid.verdicts.find((x) => x.redeemer === redeemer && x.role === role)
  return v?.allowed ? 'CAN' : `- ${v?.failed[0] ?? ''}`
}
for (const r of [...new Set(grid.verdicts.map((v) => v.redeemer))]) {
  console.log(`${r.padEnd(21)} buyer: ${cell(r, 'buyer').padEnd(44).slice(0, 44)} seller: ${cell(r, 'seller').padEnd(44).slice(0, 44)} admin: ${cell(r, 'admin')}`)
}
