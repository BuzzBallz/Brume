import './env.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { runCensus } from '../census/census.ts'
import { decodeDatum } from '../census/decode.ts'
import { getBank } from './bank.ts'
import { mockGrid, mockSolver, ROOT } from './escrow.ts'

const HERO_REF = process.env.HERO_REF ?? 'a7084c50029798fc0530b6c9abc2bf3e203b23e11102a3e8cdb90ede0c64970d#0'
const OUT = new URL('docs/data/', `file://${ROOT}`)

const { census, snaps } = await runCensus('mainnet')
const hero = snaps[0].utxos.find((u) => u.ref === HERO_REF)
if (!hero?.inlineDatumCbor) throw new Error(`${HERO_REF} is not in the census (spent, or not a V1 escrow)`)
const datum = decodeDatum(hero.inlineDatumCbor)

// The snapshot UI opens the first Disputed row, so the hero goes first.
census.rows.sort((a, b) => Number(b.ref === HERO_REF) - Number(a.ref === HERO_REF))

mkdirSync(OUT, { recursive: true })
const write = (name: string, body: unknown) => writeFileSync(new URL(`${name}.json`, OUT), JSON.stringify(body, null, 1))
write('census', { census })
write('datum', { ref: HERO_REF, datum, value: hero.value })
// ponytail: no producer for grid and solver yet (stream A), so the snapshot carries the mock shapes; swap for engine and solver output when they land.
const NOTE = 'MOCK, no producer yet'
write('grid', { _note: NOTE, grid: mockGrid(HERO_REF, datum.state) })
write('solver', { _note: NOTE, solver: mockSolver(HERO_REF) })
const bank = await getBank()
write('bank', { bank })

console.log(`docs/data written · hero ${HERO_REF} · tip ${census.tip.height} · ${census.open} open · ${census.holes} holes`)
console.log('MOCK, no producer yet: grid, solver')
console.log(`preprod bank: ${bank.length} escrows`)
if (!census.secondProvider) console.log('second provider: skipped (no key)')
