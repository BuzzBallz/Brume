import './env.ts'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { runCensus } from '../census/census.ts'
import { decodeDatum } from '../census/decode.ts'
import { getBank } from './bank.ts'
import { PARAMS } from '../../shared/constants.ts'
import { reach } from '../engine/reach.ts'
import { proposalFile, txLogFile } from '../preprod/settle.ts'
import { witnessSummary } from '../preprod/witnesses.ts'
import { solve, solverInputFor } from '../solver/solve.ts'
import { ROOT } from './escrow.ts'

const HERO_REF = process.env.HERO_REF ?? 'a7084c50029798fc0530b6c9abc2bf3e203b23e11102a3e8cdb90ede0c64970d#0'
// The settled bank escrow whose run Pages replays: the UI rehearsal of 6 Oct.
const RUN_REF = process.env.RUN_REF ?? '9054b1d81c9ce47db1e3ea993aa34f0f978eb95629d4319131f149619c68de9d#6'
const OUT = new URL('docs/data/', `file://${ROOT}`)
const readOr = (file: string, none: unknown) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : none)

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
const now = Date.now()
write('grid', { grid: reach(datum, hero.value, now, PARAMS, HERO_REF) })
write('solver', { solver: solve(solverInputFor(HERO_REF, datum, hero.value, now), 'B') })
const bank = await getBank()
write('bank', { bank })
// The proposal lives in out/ (not committed): run site:data on the machine that prepared it, or the run has no proposal.
const proposal = readOr(proposalFile(RUN_REF), null)
write('settle', { proposal })
write('txlog', { txlog: readOr(txLogFile(RUN_REF), []) })
if (existsSync(txLogFile(RUN_REF))) write('witnesses', { witnesses: await witnessSummary(RUN_REF) })

console.log(`docs/data written · hero ${HERO_REF} · tip ${census.tip.height} · ${census.open} open · ${census.holes} holes`)
console.log(`preprod bank: ${bank.length} escrows · settled run ${RUN_REF}: ${proposal ? 'proposal and log written' : 'NO proposal file here, settle.json is empty'}`)
if (!census.secondProvider) console.log('second provider: skipped (no key)')
