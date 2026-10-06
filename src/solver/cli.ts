// pnpm solver <txHash#index> [--net mainnet|preprod] [--path A|B] [--at <ISO time>]
// Keyless and read-only: the individually rational band per horizon, per unit of the escrow value (never dollars).
import { parseArgs } from 'node:util'
import type { Network } from '../../shared/types.ts'
import { readEscrow } from '../engine/escrow-read.ts'
import { solve, solverInputFor } from './solve.ts'

const { positionals, values } = parseArgs({ allowPositionals: true, options: { net: { type: 'string', default: 'mainnet' }, path: { type: 'string', default: 'B' }, at: { type: 'string' } } })
const ref = positionals[0]
const net = values.net as Network
const path = values.path === 'A' ? 'A' : 'B'
if (!ref || (net !== 'mainnet' && net !== 'preprod')) throw new Error('usage: pnpm solver <txHash#index> [--net mainnet|preprod] [--path A|B] [--at ISO]')
const { datum, value } = await readEscrow(net, ref)
const at = values.at ? Date.parse(values.at) : Date.now()
const input = solverInputFor(ref, datum, value, at)
const out = solve(input, path)
const pct = (x: number): string => `${(x * 100).toFixed(1)} %`

console.log(`${ref} on ${net}, path ${path}, arbiter silent for ${input.dormancyDays.toFixed(1)} days, front-run p = ${out.frontRunP.used} (${out.frontRunP.measured ? 'measured' : 'worst case, not measured'})`)
for (const b of out.bands) {
  const units = Object.entries(b.perUnit).map(([u, t]) => `${u === 'lovelace' ? 'ADA' : u.slice(0, 8) + '…'} ${pct(t.sellerShareMin)}–${pct(t.sellerShareMax)} (buyer's arbitration value by H: ${pct(t.rBuyer)})`).join('; ')
  console.log(`H = ${String(b.horizonDays).padStart(3)} d: seller share ${b.feasible ? `${pct(b.sellerShareMin)} to ${pct(b.sellerShareMax)}` : 'NO feasible split'}  [${units}]`)
}
const t = path === 'A' ? out.pathA : out.pathB
console.log(`leg-2 defector keeps ${JSON.stringify(t.defectorKeeps)}; ${t.exposedParty} exposed, floor ${JSON.stringify(t.exposedFloor)}; fee ${JSON.stringify(t.fee)}${Object.keys(t.topUp).length ? `; top-up ${JSON.stringify(t.topUp)}` : ''}`)
