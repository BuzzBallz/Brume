// One keyless Koios read of a V1 escrow UTxO, either network (read-only), for the engine and solver CLIs.
import type { Datum, Network, Value } from '../../shared/types.ts'
import { KOIOS, V1_ADDRESS } from '../../shared/constants.ts'
import { readDatum } from '../preprod/datum.ts'

type Row = { address: string; value: string; is_spent: boolean; inline_datum: { bytes: string } | null; asset_list: { policy_id: string; asset_name: string; quantity: string }[] | null }

export async function readEscrow(net: Network, ref: string): Promise<{ datum: Datum; value: Value; spent: boolean }> {
  if (!/^[0-9a-f]{64}#\d+$/.test(ref)) throw new Error('an escrow reference is <txHash>#<index>')
  const res = await fetch(`${KOIOS[net]}/utxo_info`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ _utxo_refs: [ref], _extended: true }), signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`Koios ${net} utxo_info HTTP ${res.status}: no answer (a failed read is a hole, not an answer)`)
  const row = ((await res.json()) as Row[])[0]
  if (!row) throw new Error(`${ref} is not known to Koios ${net}`)
  if (row.address !== V1_ADDRESS[net]) throw new Error(`${ref} is not at the V1 escrow address`)
  if (!row.inline_datum) throw new Error(`${ref} has no inline datum`)
  const value: Value = { lovelace: row.value }
  for (const a of row.asset_list ?? []) value[a.policy_id + a.asset_name] = a.quantity
  return { datum: readDatum(row.inline_datum.bytes), value, spent: row.is_spent }
}
