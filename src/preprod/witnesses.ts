// "Name the redeemer, then walk me to the UTxO": each leg of a settled escrow, read from the chain alone (the tx CBOR on
// Blockfrost and the spent escrow's datum), never from our own logs' claims. Per leg: the redeemer and the escrow UTxO it
// spends, the escrow's state before and after, the outputs and what each party received, the required signers, every
// vkey witness hashed to its key hash and named against the escrow's datum, and the explicit check against the three
// admin key hashes of the deployed parameters (PARAMS). Expected on the seller-first path: no admin key anywhere.
//   node src/preprod/witnesses.ts <escrowRef> [...]   writes fixtures/preprod/witnesses-<hash>_<index>.json
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TxLogEntry } from '../../shared/types.ts'
import { REDEEMER } from '../../shared/types.ts'
import { PARAMS, V1_ADDRESS } from '../../shared/constants.ts'
import { blockfrostGet } from './chain.ts'
import { readDatum } from './datum.ts'
import { ROOT } from './env.ts'
import { cst, mesh } from './mesh.ts'
import { txLogFile } from './settle.ts'

type Who = 'buyer' | 'seller' | 'admin' | 'other'
type Value = Record<string, string>
export type LegWalk = {
  leg: 1 | 2
  txHash: string
  block: { height: number; slot: number } | null
  redeemer: { name: string; constructor: number; spends: string }
  escrowBefore: { ref: string; state: string }
  escrowAfter: { ref: string; state: string } | null // null: the escrow left the script
  outputs: { address: string; party: Who | 'script'; value: Value }[]
  requiredSigners: { keyHash: string; party: Who }[]
  witnesses: { keyHash: string; party: Who }[]
  adminKeysSigned: string[] // of PARAMS.adminKeyHashes: expected []
  collateral: string[]
}

const keyHash = (vkeyHex: string): string => cst.blake2b(28).update(Buffer.from(vkeyHex, 'hex')).digest('hex')
const refOf = (i: { txId: string; index: number }): string => `${i.txId}#${i.index}`

function valueOf(o: ReturnType<ReturnType<ReturnType<typeof cst.deserializeTx>['body']>['outputs']>[number]): Value {
  const v = o.amount().toCore()
  const out: Value = { lovelace: v.coins.toString() }
  for (const [unit, q] of v.assets ?? new Map()) out[String(unit)] = q.toString()
  return out
}

async function cborOf(txHash: string): Promise<string> {
  const r = await blockfrostGet<{ cbor: string }>(`/txs/${txHash}/cbor`)
  if (!r?.cbor) throw new Error(`no CBOR on Blockfrost for ${txHash}`)
  return r.cbor
}
async function blockOf(txHash: string): Promise<{ height: number; slot: number } | null> {
  const t = await blockfrostGet<{ block_height: number; slot: number }>(`/txs/${txHash}`)
  return t ? { height: t.block_height, slot: t.slot } : null
}
// The datum of a UTxO as the chain holds it (Blockfrost gives inline datums as CBOR).
async function datumAt(ref: string): Promise<string> {
  const [h, i] = ref.split('#')
  const u = await blockfrostGet<{ outputs: { output_index: number; inline_datum: string | null }[] }>(`/txs/${h}/utxos`)
  const d = u?.outputs.find((o) => o.output_index === Number(i))?.inline_datum
  if (!d) throw new Error(`no inline datum at ${ref}`)
  return d
}

async function walkLeg(leg: 1 | 2, txHash: string, parties: { buyer: string; seller: string }): Promise<LegWalk> {
  const tx = cst.deserializeTx(await cborOf(txHash))
  if (mesh.resolveTxHash(tx.toCbor()) !== txHash) throw new Error(`the CBOR read for ${txHash} does not hash to it`)
  const body = tx.body()
  const name = (k: string): Who => (k === parties.buyer ? 'buyer' : k === parties.seller ? 'seller' : PARAMS.adminKeyHashes.includes(k) ? 'admin' : 'other')
  const inputs = body.inputs().toCore().map((i) => ({ txId: String(i.txId), index: Number(i.index) }))
  // A spend redeemer's index points into the inputs in ledger order: sorted by tx id, then output index.
  const sorted = [...inputs].sort((a, b) => (a.txId === b.txId ? a.index - b.index : a.txId < b.txId ? -1 : 1))
  const spends = [...(tx.witnessSet().redeemers()?.values() ?? [])].map((r) => r.toCore()).filter((r) => r.purpose === 'spend')
  if (spends.length !== 1) throw new Error(`${txHash}: ${spends.length} spend redeemers, expected exactly one escrow spend`)
  const data = spends[0].data as { constructor?: bigint }
  const constructor = Number(data.constructor)
  const spent = refOf(sorted[Number(spends[0].index)])
  const before = readDatum(await datumAt(spent)).state
  const outs = body.outputs()
  const out0 = outs[0]
  const cont = out0?.address().toBech32() === V1_ADDRESS.preprod ? out0.datum()?.asInlineData()?.toCbor() : undefined
  const keyOfAddr = (a: string): string | undefined => {
    try {
      return mesh.deserializeAddress(a).pubKeyHash || undefined
    } catch {
      return undefined
    }
  }
  const witnesses = [...(tx.witnessSet().vkeys()?.values() ?? [])].map((w) => keyHash(w.vkey()))
  const required = [...(body.requiredSigners()?.values() ?? [])].map((s) => String(s.toCore()))
  return {
    leg,
    txHash,
    block: await blockOf(txHash),
    redeemer: { name: REDEEMER[constructor] ?? `constructor ${constructor}`, constructor, spends: spent },
    escrowBefore: { ref: spent, state: before },
    escrowAfter: cont ? { ref: `${txHash}#0`, state: readDatum(cont).state } : null,
    outputs: outs.map((o) => {
      const address = o.address().toBech32()
      const k = keyOfAddr(address)
      return { address, party: address === V1_ADDRESS.preprod ? ('script' as const) : k ? name(k) : 'other', value: valueOf(o) }
    }),
    requiredSigners: required.map((k) => ({ keyHash: k, party: name(k) })),
    witnesses: witnesses.map((k) => ({ keyHash: k, party: name(k) })),
    adminKeysSigned: [...new Set([...witnesses, ...required])].filter((k) => PARAMS.adminKeyHashes.includes(k)),
    collateral: (body.collateral()?.toCore() ?? []).map((i) => refOf({ txId: String(i.txId), index: Number(i.index) })),
  }
}

export async function walkSettlement(escrowRef: string): Promise<{ escrowRef: string; parties: { buyer: string; seller: string }; legs: LegWalk[] }> {
  const log = JSON.parse(readFileSync(txLogFile(escrowRef), 'utf8')) as TxLogEntry[]
  const leg1 = log.find((e) => e.step.startsWith('AuthorizeRefund (leg 1)') && e.block)
  const leg2 = log.find((e) => e.step.startsWith('WithdrawRefund (leg 2') && e.block)
  if (!leg1 || !leg2) throw new Error(`${escrowRef}: no confirmed leg 1 and leg 2 in its log`)
  // The parties as the escrow's own datum names them, read on chain at the escrow UTxO.
  const d = readDatum(await datumAt(escrowRef))
  const parties = { buyer: d.buyer.payment.hash, seller: d.seller.payment.hash }
  return { escrowRef, parties, legs: [await walkLeg(1, leg1.txHash, parties), await walkLeg(2, leg2.txHash, parties)] }
}

if (process.argv[1]?.endsWith('witnesses.ts')) {
  const refs = process.argv.slice(2)
  if (!refs.length) throw new Error('usage: node src/preprod/witnesses.ts <escrowRef> [...]')
  const tada = (v: Value): string => Object.entries(v).map(([u, q]) => (u === 'lovelace' ? `${Number(q) / 1e6} tADA` : `${Number(q) / 1e6} ${u.slice(-10) === '745553444d' ? 'tUSDM' : u.slice(0, 8) + '…'}`)).join(' + ')
  for (const ref of refs) {
    const w = await walkSettlement(ref)
    const file = join(ROOT, 'fixtures', 'preprod', `witnesses-${ref.replace('#', '_')}.json`)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, JSON.stringify({ label: 'the seller-first settlement, read from the chain: redeemers, spent UTxOs, outputs, required signers and witnesses, against the deployed admin key hashes', ...w }, null, 2) + '\n')
    console.log(`${ref}  buyer ${w.parties.buyer.slice(0, 8)}…  seller ${w.parties.seller.slice(0, 8)}…`)
    for (const l of w.legs) {
      console.log(`  leg ${l.leg} ${l.txHash} block ${l.block?.height}: ${l.redeemer.name} (redeemer ${l.redeemer.constructor}) spends ${l.redeemer.spends} (${l.escrowBefore.state}) → ${l.escrowAfter ? `${l.escrowAfter.ref} (${l.escrowAfter.state})` : 'the escrow leaves the script'}`)
      for (const o of l.outputs) console.log(`    out ${o.party.padEnd(6)} ${tada(o.value)}`)
      console.log(`    required signers: ${l.requiredSigners.map((s) => s.party).join(', ') || 'none'}; witnesses: ${l.witnesses.map((s) => s.party).join(', ')}; admin keys: ${l.adminKeysSigned.length ? l.adminKeysSigned.join(', ') : 'none of the 3'}`)
    }
    console.log(`  → ${file}`)
  }
}
