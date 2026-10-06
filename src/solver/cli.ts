// pnpm solver <txHash#index> [--net mainnet|preprod] [--path A|B] [--pin]
// Keyless and read-only: the arbiter's dormancy checked live since the pinned block (D9; --pin skips the check and uses
// the pin), the deadline band per horizon and the S-4 break-evens, per unit of the escrow value (never dollars).
// Blockfrost joins as a second method when BLOCKFROST_MAINNET_PROJECT_ID is in .env; the key is never printed.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import type { Network } from '../../shared/types.ts'
import { readEscrow } from '../engine/escrow-read.ts'
import { checkDormancyReceipt, PIN, pinnedDormancy, spendsByRedeemer, type Receipt } from './dormancy.ts'
import { solve, solverInputFor } from './solve.ts'

const env = join(import.meta.dirname, '..', '..', '.env')
if (existsSync(env)) process.loadEnvFile(env)

const { positionals, values } = parseArgs({ allowPositionals: true, options: { net: { type: 'string', default: 'mainnet' }, path: { type: 'string', default: 'B' }, pin: { type: 'boolean', default: false } } })
const ref = positionals[0]
const net = values.net as Network
const path = values.path === 'A' ? 'A' : 'B'
if (!ref || (net !== 'mainnet' && net !== 'preprod')) throw new Error('usage: pnpm solver <txHash#index> [--net mainnet|preprod] [--path A|B] [--pin]')
const [{ datum, value }, receipt] = await Promise.all([readEscrow(net, ref), values.pin ? Promise.resolve<Receipt | null>(null) : checkDormancyReceipt()])
const d = receipt?.dormancy ?? pinnedDormancy()
const input = solverInputFor(ref, datum, value, Date.now(), null, d)
const out = solve(input, path)
const w = out.wait
const pct = (x: number): string => `${(x * 100).toFixed(1)} %`
const iso = (ms: number): string => new Date(ms).toISOString().replace('.000Z', 'Z')
const ok = (b: boolean): string => (b ? 'fired' : 'FAILED')

// The dormancy receipt first: every band and break-even below rests on T.
for (const a of d.acted) console.log(`ALERT: the arbiter acted at ${a.txHash} (${a.height}${a.validContract ? '' : ', phase-2-failed attempt'}): C3 and every dormancy sentence are withdrawn`)
for (const x of receipt?.walks ?? []) {
  const tip = x.tip ? `tip ${x.tip.height}` : 'no tip'
  console.log(`  ${x.provider}: ${tip}, ${x.txs} txs since block ${PIN.height}, V1 spends by redeemer ${JSON.stringify(spendsByRedeemer(x.spends))}, ${x.holes} holes, decode control ${ok(x.controls.decode)}, listing control ${ok(x.controls.listing)}${x.errors.length ? `; ${x.errors.slice(0, 3).join('; ')}` : ''}`)
}
for (const s of receipt?.skipped ?? []) console.log(`  ${s}`)
if (d.diff.length) console.log(`  providers disagree on ${d.diff.length} script spends: ${d.diff.join(', ')}`)
if (d.status === 'unverified') console.log(`arbiter: the live check since block ${PIN.height} is incomplete (${d.holes} holes, a control failed or the providers disagree): silence is counted through the pinned block only`)
const who = d.method === 'pin' || d.status === 'unverified' ? 'pinned' : d.providers.join(' + ')
const controls = d.method === 'pin' || d.status === 'unverified' ? 'controls fired at the kickoff read' : receipt?.walks.every((x) => x.controls.decode && x.controls.listing) ? 'controls fired' : 'a control FAILED'
console.log(`arbiter: no WithdrawDisputed on V1 since ${iso(d.lastActionMs)} through block ${d.through.height} (${who}, ${d.holes} holes, ${controls}) = ${w.silentDays.toFixed(2)} silent days; ${w.silentDays < 1 ? 'too short a silence to bound the rate' : `at 95 % the rate is at most one per ${w.meanGapDaysAtLeast.toFixed(1)} days`}`)

console.log(`${ref} on ${net}, path ${path}, front-run p = ${out.frontRunP.used} (${out.frontRunP.measured ? 'measured' : 'worst case, not measured'})`)
for (const b of out.bands) {
  const units = Object.entries(b.perUnit).map(([u, t]) => `${u === 'lovelace' ? 'ADA' : u.slice(0, 8) + '…'} ${pct(t.sellerShareMin)}–${pct(t.sellerShareMax)} (buyer's arbitration value within the deadline: at most ${pct(t.rBuyer)})`).join('; ')
  console.log(`deadline ${String(b.horizonDays).padStart(3)} d, for a buyer who would wait at most ${b.horizonDays} days: seller share ${b.feasible ? `${pct(b.sellerShareMin)} to ${pct(b.sellerShareMax)}` : 'NO feasible split'}  [${units}]`)
}
for (const s of [0.1, 0.25, 0.4, 0.5, 0.75]) {
  const p = w.curve.find((x) => Math.abs(x.sellerShare - s) < 1e-9)
  if (!p) continue
  if (!p.feasible) {
    console.log(`seller share ${pct(s)}: no feasible split on path ${path}`)
    continue
  }
  const by = p.deadlineDays === null ? 'beats waiting for a buyer with any deadline' : `beats waiting for a buyer who would wait at most ${p.deadlineDays.toFixed(1)} days`
  // Above 1000 %/yr the exact figure reads as noise on stage: the bound is stated, the JSON keeps the number.
  const rate = p.breakEvenDiscountAnnual === null ? ', and no discount rate makes it beat waiting forever'
    : !Number.isFinite(p.breakEvenDiscountAnnual) || p.breakEvenDiscountAnnual > 10 ? ', or only for a buyer who discounts at more than 1000 %/yr'
    : `, or who discounts at ≥ ${(p.breakEvenDiscountAnnual * 100).toFixed(1)} %/yr`
  console.log(`seller share ${pct(s)} ${by}${rate} (at the 95 % bound)`)
}
const t = path === 'A' ? out.pathA : out.pathB
console.log(`leg-2 defector keeps ${JSON.stringify(t.defectorKeeps)}; ${t.exposedParty} exposed, floor ${JSON.stringify(t.exposedFloor)}; fee ${JSON.stringify(t.fee)}${Object.keys(t.topUp).length ? `; top-up ${JSON.stringify(t.topUp)}` : ''}`)
