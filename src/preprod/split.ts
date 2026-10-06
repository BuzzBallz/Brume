// Splits one UTxO of a role into N equal pure-ADA outputs back to itself (tokens stay together in the change): the seller needs several independent UTxOs
// (leg 1 never spends leg 2's funding input) and the bank needs one funding input per escrow.
// Usage: node src/preprod/split.ts --role seller --outputs 5 --each 15 [--dry-run]
import { parseArgs } from 'node:util'
import type { Role } from '../../shared/types.ts'
import { preprodChain, preprodSubmitter } from './chain.ts'
import { addWitness, appendTxLog, buildPlain, submitAndConfirm, txWindow } from './tx.ts'
import { party } from './wallet.ts'

const { values } = parseArgs({
  options: {
    role: { type: 'string' },
    outputs: { type: 'string', default: '5' },
    each: { type: 'string', default: '15' },
    'dry-run': { type: 'boolean', default: false },
  },
})
const role = values.role as Role
if (role !== 'buyer' && role !== 'seller' && role !== 'admin') throw new Error('--role buyer|seller|admin')
const n = Number(values.outputs)
const each = BigInt(Math.round(Number(values.each) * 1e6))
if (!Number.isInteger(n) || n < 1 || n > 20 || each < 2_000_000n) throw new Error('--outputs 1..20, --each ≥ 2 (tADA)')

const p = await party(role)
const utxos = await preprodChain().fetchAddressUTxOs(p.address)
const lovelace = (u: (typeof utxos)[number]): bigint => BigInt(u.output.amount.find((a) => a.unit === 'lovelace')?.quantity ?? '0')
const byLovelace = [...utxos].sort((a, b) => (lovelace(b) > lovelace(a) ? 1 : -1))
const input = byLovelace.find((u) => lovelace(u) >= each * BigInt(n) + 3_000_000n)
if (!input) throw new Error(`no UTxO of ${role} covers ${n} × ${values.each} tADA + fee`)

const now = Date.now()
const window = txWindow(now)
const built = await buildPlain({
  network: 'preprod',
  window,
  signers: [p],
  inputs: [input],
  outputs: Array.from({ length: n }, () => ({ address: p.address, amount: [{ unit: 'lovelace', quantity: each.toString() }] })),
  changeAddress: p.address,
})
console.log(`${role} ${p.address}`)
const tokens = input.output.amount.filter((a) => a.unit !== 'lovelace').map((a) => `${a.quantity} ${a.unit.slice(0, 8)}…`)
console.log(`input   ${input.input.txHash}#${input.input.outputIndex} (${Number(lovelace(input)) / 1e6} tADA${tokens.length ? ` + ${tokens.join(", ")}, kept in change` : ""}), ${utxos.length} UTxOs before`)
console.log(`outputs ${n} × ${values.each} tADA + change, window slots ${window.fromSlot}..${window.toSlot}`)
console.log(`tx      ${built.txHash}`)
if (values['dry-run']) process.exit(0)

const signed = await addWitness(built, p)
const entry = await submitAndConfirm(signed, preprodSubmitter(), `split ${role} into ${n} × ${values.each} tADA`, now)
const file = appendTxLog(`wallet-${role}`, entry)
console.log(`${entry.status} at stage ${entry.stage}${entry.block ? `, block ${entry.block.height} (${entry.block.hash.slice(0, 16)}…)` : ''}${entry.error ? `: ${entry.error}` : ''}`)
console.log(`logged  ${file}`)
