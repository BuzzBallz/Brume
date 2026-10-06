// pnpm engine <txHash#index> [--net mainnet|preprod] [--at <ISO time>]
// Keyless and read-only on both networks: one Koios read of the escrow UTxO, then the 7 × 3 grid at that time.
import { parseArgs } from 'node:util'
import type { Network } from '../../shared/types.ts'
import { PARAMS } from '../../shared/constants.ts'
import { readEscrow } from './escrow-read.ts'
import { reach } from './reach.ts'

const { positionals, values } = parseArgs({ allowPositionals: true, options: { net: { type: 'string', default: 'mainnet' }, at: { type: 'string' } } })
const ref = positionals[0]
const net = values.net as Network
if (!ref || (net !== 'mainnet' && net !== 'preprod')) throw new Error('usage: pnpm engine <txHash#index> [--net mainnet|preprod] [--at ISO]')
const { datum, value, spent } = await readEscrow(net, ref)
const at = values.at ? Date.parse(values.at) : Date.now()
const grid = reach(datum, value, at, PARAMS, ref)

console.log(`${ref} on ${net}${spent ? ' (SPENT: the grid describes its last state)' : ''}, ${grid.state}, at ${new Date(at).toISOString()}`)
const cell = (redeemer: string, role: string): string => {
  const v = grid.verdicts.find((x) => x.redeemer === redeemer && x.role === role)
  return v?.allowed ? 'CAN' : `- ${v?.failed[0] ?? ''}`
}
for (const r of [...new Set(grid.verdicts.map((v) => v.redeemer))]) {
  console.log(`${r.padEnd(21)} buyer: ${cell(r, 'buyer').padEnd(44).slice(0, 44)} seller: ${cell(r, 'seller').padEnd(44).slice(0, 44)} admin: ${cell(r, 'admin')}`)
}
