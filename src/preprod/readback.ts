// Balances read back from a SECOND indexer after leg 2 confirms — a real re-read of the chain, never a copy of the payout.
// What each party received from the escrow, from leg 2's own inputs, outputs and fee on that indexer:
//   buyer  = Σ outputs to the buyer − Σ the buyer's inputs (none on the seller-first path)
//   seller = Σ outputs to the seller − Σ the seller's inputs + the fee (the seller funds leg 2, so its change is not a payout)
// Collateral inputs and the collateral return are not part of a valid tx's effect and are excluded.
//   node src/preprod/readback.ts <escrowRef>   backfills readback into fixtures/preprod/txlog-<ref>.json
import type { Provider, TxLogEntry, Value } from '../../shared/types.ts'
import { KOIOS } from '../../shared/constants.ts'
import { blockfrostGet } from './chain.ts'
import { readDatum } from './datum.ts'

export type Readback = NonNullable<TxLogEntry['readback']>
type Flow = { address: string; amount: { unit: string; quantity: string }[] }

const add = (v: Map<string, bigint>, unit: string, q: bigint): void => { v.set(unit, (v.get(unit) ?? 0n) + q) }
const toValue = (m: Map<string, bigint>): Value => Object.fromEntries([...m].filter(([, q]) => q !== 0n).map(([u, q]) => [u, q.toString()]))

async function viaBlockfrost(txHash: string): Promise<{ fee: bigint; valid: boolean; inputs: Flow[]; outputs: Flow[] } | null> {
  const tx = await blockfrostGet<{ fees: string; valid_contract: boolean }>(`/txs/${txHash}`)
  const u = await blockfrostGet<{ inputs: (Flow & { collateral?: boolean; reference?: boolean })[]; outputs: (Flow & { collateral?: boolean })[] }>(`/txs/${txHash}/utxos`)
  if (!tx || !u) return null
  return { fee: BigInt(tx.fees), valid: tx.valid_contract, inputs: u.inputs.filter((i) => !i.collateral && !i.reference), outputs: u.outputs.filter((o) => !o.collateral) }
}

type KoiosIo = { payment_addr: { bech32: string }; value: string; asset_list: { policy_id: string; asset_name: string; quantity: string }[] | null }
async function koiosTx(txHash: string): Promise<{ fee: string; inputs: KoiosIo[]; outputs: KoiosIo[]; plutus_contracts: { valid_contract?: boolean }[] | null } | null> {
  const res = await fetch(`${KOIOS.preprod}/tx_info`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ _tx_hashes: [txHash], _inputs: true, _assets: true, _scripts: true }), signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`Koios tx_info HTTP ${res.status}: no read-back (a hole)`)
  return ((await res.json()) as never[])[0] ?? null
}
const flow = (io: KoiosIo): Flow => ({ address: io.payment_addr.bech32, amount: [{ unit: 'lovelace', quantity: io.value }, ...(io.asset_list ?? []).map((a) => ({ unit: a.policy_id + a.asset_name, quantity: a.quantity }))] })
async function viaKoios(txHash: string): Promise<{ fee: bigint; valid: boolean; inputs: Flow[]; outputs: Flow[] } | null> {
  const t = await koiosTx(txHash)
  if (!t) return null
  return { fee: BigInt(t.fee), valid: (t.plutus_contracts ?? []).every((c) => c.valid_contract !== false), inputs: t.inputs.map(flow), outputs: t.outputs.map(flow) }
}

// sentVia: the provider that accepted the send; the read-back uses the other one.
export async function readBack(txHash: string, sentVia: Provider | undefined, buyer: string, seller: string): Promise<Readback | undefined> {
  const provider: Provider = sentVia === 'blockfrost' ? 'koios' : 'blockfrost'
  const t = provider === 'blockfrost' ? await viaBlockfrost(txHash) : await viaKoios(txHash)
  if (!t) return undefined
  const b = new Map<string, bigint>(), s = new Map<string, bigint>()
  for (const o of t.outputs) for (const a of o.amount) {
    if (o.address === buyer) add(b, a.unit, BigInt(a.quantity))
    if (o.address === seller) add(s, a.unit, BigInt(a.quantity))
  }
  for (const i of t.inputs) for (const a of i.amount) {
    if (i.address === buyer) add(b, a.unit, -BigInt(a.quantity))
    if (i.address === seller) add(s, a.unit, -BigInt(a.quantity))
  }
  add(s, 'lovelace', t.fee) // the seller paid leg 2's fee from its own input
  return { provider, validContract: t.valid, balances: { buyer: toValue(b), seller: toValue(s) } }
}

// The escrow's parties, from leg 1's continuation datum as the chain holds it (Blockfrost gives it as CBOR; preprod
// Koios gives only the JSON form, bytes null).
export async function partiesFromLeg1(leg1Hash: string): Promise<{ buyer: string; seller: string }> {
  const u = await blockfrostGet<{ outputs: { inline_datum: string | null }[] }>(`/txs/${leg1Hash}/utxos`)
  const datum = u?.outputs.find((o) => o.inline_datum)?.inline_datum
  if (!datum) throw new Error(`leg 1 ${leg1Hash.slice(0, 12)}… carries no inline datum on Blockfrost`)
  const d = readDatum(datum)
  const { bech32Of } = await import('./settle.ts')
  return { buyer: bech32Of(d.buyer), seller: bech32Of(d.seller) }
}

if (process.argv[1]?.endsWith('readback.ts')) {
  const ref = process.argv[2]
  if (!ref) throw new Error('usage: readback.ts <escrowRef>')
  const { txLogFile, upsertTxLog } = await import('./settle.ts')
  const { readFileSync } = await import('node:fs')
  const log = JSON.parse(readFileSync(txLogFile(ref), 'utf8')) as TxLogEntry[]
  const leg1 = log.find((e) => e.step.startsWith('AuthorizeRefund (leg 1)') && e.block)
  const leg2 = log.find((e) => e.step.startsWith('WithdrawRefund (leg 2') && e.block)
  if (!leg1 || !leg2) throw new Error('no confirmed leg 1 and leg 2 in this log')
  const { buyer, seller } = await partiesFromLeg1(leg1.txHash)
  const readback = await readBack(leg2.txHash, leg2.via, buyer, seller)
  if (!readback) throw new Error('the second indexer does not know leg 2 yet')
  upsertTxLog(ref, { ...leg2, readback })
  console.log(JSON.stringify(readback, null, 2))
}
