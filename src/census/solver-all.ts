import { readFileSync, writeFileSync } from 'node:fs'
import { solve, solverInputFor } from '../solver/solve.ts'
import type { Snapshot } from './census.ts'
import { decodeAll } from './census.ts'

// S-5: the solver over every Disputed escrow of the pinned mainnet census, priced at the census tip, path B.
// Reads fixtures/mainnet/utxos-koios.json only (no network); writes fixtures/mainnet/solver-disputed.json.
const FIXTURES = new URL('../../fixtures/mainnet/', import.meta.url)
const snap = JSON.parse(readFileSync(new URL('utxos-koios.json', FIXTURES), 'utf8')) as Snapshot
const disputed = decodeAll(snap.utxos).filter((d) => d.datum?.state === 'Disputed')

const rows = disputed.map((d) => {
  const s = solve(solverInputFor(d.utxo.ref, d.datum!, d.utxo.value, snap.tip.timeMs), 'B')
  return { ref: d.utxo.ref, value: d.utxo.value, bands: s.bands, pathA: s.pathA, pathB: s.pathB, frontRunP: s.frontRunP }
})
rows.sort((a, b) => a.ref.localeCompare(b.ref))

writeFileSync(
  new URL('solver-disputed.json', FIXTURES),
  JSON.stringify({ network: 'mainnet', tip: snap.tip, provider: snap.provider, path: 'B', count: rows.length, rows }, null, 1),
)
const max30 = rows.map((r) => r.bands.find((b) => b.horizonDays === 30)?.sellerShareMax ?? 0)
console.log(`${rows.length} Disputed escrows solved at tip ${snap.tip.height} (path B); seller share max at 30 days ranges ${Math.min(...max30).toFixed(3)} to ${Math.max(...max30).toFixed(3)}`)
