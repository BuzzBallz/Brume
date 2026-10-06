// pnpm demo:preprod — the seller-first settlement from nothing, on preprod, with your own two keys (PLAN D11).
//   pnpm demo:preprod --keygen                  writes two fresh preprod root keys into .env if they are absent (prints
//                                               the addresses only, never a key)
//   pnpm demo:preprod [--ada 10] [--share 0.4]  the run; --prep forces step 1 even when the wallets are ready
// Before the run: fund the BUYER address with ≥ 80 tADA from the preprod faucet
// (https://docs.cardano.org/cardano-testnets/tools/faucet) and set BLOCKFROST_PREPROD_PROJECT_ID (a free preprod project
// at blockfrost.io) in .env. The seller needs nothing: step 1 pays it from the buyer.
// Each step is confirmed on chain before the next:
//   1 wallets: separate UTxOs, only if missing (the seller funds leg 1 and leg 2 from two different ones, D13)
//   2 lock one escrow in ResultSubmitted, result hash set, ADA only
//   3 the buyer disputes it (SetRefundRequested → Disputed, the state of the 61 mainnet escrows)
//   4 the engine's grid on it
//   5 try anyway: the buyer's WithdrawRefund, which the engine predicts refused → the validator must refuse it (phase 2)
//   6 settle: the seller concedes (leg 1), the buyer's exit signed beforehand pays the split (leg 2), leg 2 replayed
//     byte for byte (the ledger must refuse it, phase 1), the balances read back on the second indexer
// One log: fixtures/preprod/txlog-<escrow>.json. Exit code 0 only if every step did what the engine predicted.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import type { TxLogEntry, Value } from '../../shared/types.ts'
import { PARAMS } from '../../shared/constants.ts'
import { allowedCells, reach } from '../engine/reach.ts'
import { lockEscrows, raiseDispute } from './bankops.ts'
import { liveUtxos, preprodSubmitter } from './chain.ts'
import { tryAnyway } from './controls.ts'
import { readDatum } from './datum.ts'
import { loadEnv, ROOT } from './env.ts'
import { byLovelace, escrowAt, lovelace, pureAda } from './fixture.ts'
import { mesh } from './mesh.ts'
import { prepare, reservedUtxos, sign, submit, txLogFile, upsertTxLog } from './settle.ts'
import { addWitness, buildPlain, submitAndConfirm, txWindow } from './tx.ts'
import { party, type Party } from './wallet.ts'

const { values } = parseArgs({ options: { keygen: { type: 'boolean', default: false }, prep: { type: 'boolean', default: false }, ada: { type: 'string', default: '10' }, share: { type: 'string', default: '0.4' } } })
const ADA = Number(values.ada)
const SHARE = Number(values.share)
if (!(ADA >= 5 && ADA <= 100)) throw new Error('--ada 5..100 (tADA in the escrow)')
if (!(SHARE > 0 && SHARE < 1)) throw new Error('--share strictly between 0 and 1 (the seller\'s part)')

const EACH = 10_000_000n // one prepared UTxO
const link = (h: string): string => `https://preprod.cardanoscan.io/transaction/${h}`
const tada = (l: bigint): string => `${Number(l) / 1e6} tADA`
const sameValue = (a: Value, b: Value): boolean => {
  const k = (v: Value): string => JSON.stringify(Object.entries(v).filter(([, q]) => q !== '0').sort())
  return k(a) === k(b)
}

// Fresh keys go straight into .env; only the addresses are printed. An existing key is never replaced.
async function keygen(): Promise<void> {
  const file = join(ROOT, '.env')
  const add: string[] = []
  for (const role of ['BUYER', 'SELLER'] as const) {
    const name = `PREPROD_${role}_SKEY`
    if (process.env[name]?.trim()) console.log(`${name} is already set: kept`)
    else {
      const key = mesh.resolvePrivateKey(mesh.MeshWallet.brew() as string[])
      add.push(`${name}=${key}`)
      process.env[name] = key // set here too: loadEnvFile never overrides an existing empty `NAME=` line
    }
  }
  if (add.length) {
    const lead = existsSync(file) && !readFileSync(file, 'utf8').endsWith('\n') ? '\n' : ''
    appendFileSync(file, `${lead}${add.join('\n')}\n`)
  }
  const [buyer, seller] = [await party('buyer'), await party('seller')]
  console.log(`buyer  ${buyer.address}   ← fund this one (≥ 80 tADA) from the preprod faucet`)
  console.log(`seller ${seller.address}`)
}

// Step 1: the separate UTxOs the later steps need, in one tx paid by the buyer. The buyer: one large UTxO for the lock
// plus two of its own for the dispute's and try anyway's collateral; the seller: two (leg 1 and leg 2 never share one).
async function wallets(buyer: Party, seller: Party, force: boolean): Promise<TxLogEntry | null> {
  const reserved = reservedUtxos() // a UTxO another proposal's legs need does not count as ready (D13)
  const ready = async (p: Party): Promise<number> => pureAda(await liveUtxos(p.address)).filter((u) => lovelace(u) >= 5_000_000n && !reserved.has(`${u.input.txHash}#${u.input.outputIndex}`)).length
  const buyerNeeds = force ? 2 : Math.max(0, 3 - (await ready(buyer)))
  const sellerNeeds = force ? 2 : Math.max(0, 2 - (await ready(seller)))
  if (!buyerNeeds && !sellerNeeds) {
    console.log('  wallets already hold the separate UTxOs the run needs: nothing sent')
    return null
  }
  const outputs = [...Array<string>(buyerNeeds).fill(buyer.address), ...Array<string>(sellerNeeds).fill(seller.address)].map((address) => ({ address, amount: [{ unit: 'lovelace', quantity: EACH.toString() }] }))
  const need = EACH * BigInt(outputs.length) + BigInt(ADA * 1e6) + 10_000_000n
  const input = byLovelace(await liveUtxos(buyer.address))[0]
  if (!input || lovelace(input) < need) throw new Error(`the buyer needs one UTxO of at least ${tada(need)}: fund ${buyer.address} from the preprod faucet`)
  const now = Date.now()
  const built = await buildPlain({ network: 'preprod', window: txWindow(now), signers: [buyer], inputs: [input], outputs, changeAddress: buyer.address })
  return submitAndConfirm(await addWitness(built, buyer), preprodSubmitter(), `demo wallets: ${buyerNeeds} × 10 tADA to the buyer, ${sellerNeeds} × 10 tADA to the seller`, now)
}

// A UTxO confirmed a moment ago may not be indexed yet: retried on that error only, every 5 s for 60 s.
async function indexed<T>(what: string, f: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await f()
    } catch (error: unknown) {
      if (i >= 11 || !(error instanceof Error) || !/not found|not indexed/i.test(error.message)) throw error
      console.log(`  ${what}: not indexed yet, retrying in 5 s`)
      await new Promise((r) => setTimeout(r, 5_000))
    }
  }
}

// try anyway runs only on escrows we locked: a demo run records its own here (out/ is never committed).
function register(ref: string, disputedFrom: string): void {
  const file = join(ROOT, 'out', 'demo', 'escrows.json')
  const list = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { ref: string; disputedFrom: string; atMs: number }[]) : []
  list.push({ ref, disputedFrom, atMs: Date.now() })
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify(list, null, 2) + '\n')
}

const line = (e: TxLogEntry): string =>
  `${e.status}${e.refusal ? `, phase ${e.refusal.phase}` : ''}${e.block ? `, block ${e.block.height}` : ''}${e.error && !e.refusal ? ` (${e.error.slice(0, 160)})` : ''}`

async function run(): Promise<boolean> {
  const [buyer, seller] = [await party('buyer'), await party('seller')]
  console.log(`buyer  ${buyer.address}\nseller ${seller.address}\nescrow ${ADA} tADA, seller's share ${SHARE}`)
  const t0 = Date.now()
  const failures: string[] = []
  const expect = (ok: boolean, what: string): void => {
    console.log(`  ${ok ? 'as predicted' : 'NOT as predicted'}: ${what}`)
    if (!ok) failures.push(what)
  }
  const sent: TxLogEntry[] = []

  console.log('\n1 wallets')
  const prep = await wallets(buyer, seller, values.prep)
  if (prep) {
    console.log(`  ${line(prep)}  ${prep.txHash}`)
    if (!prep.block) throw new Error('the wallet tx did not confirm: nothing else was sent')
    sent.push(prep)
  }

  console.log('\n2 lock')
  const { entry: locked, refs } = await lockEscrows(buyer, [{
    buyer: buyer.address, seller: seller.address, amount: [{ unit: 'lovelace', quantity: String(ADA * 1e6) }],
    options: { state: 'ResultSubmitted', unlock: 'future', collateralReturnLovelace: 2_000_000 },
  }])
  console.log(`  ${line(locked)}  ${refs[0]}`)
  if (!locked.block) throw new Error('the lock did not confirm: nothing else was sent')

  console.log('\n3 the buyer disputes')
  const { entry: disputed, next: ref } = await indexed('the escrow', () => raiseDispute(refs[0], buyer))
  console.log(`  ${line(disputed)}  → ${ref} is the escrow from here on`)
  if (!disputed.block) throw new Error('the dispute did not confirm: nothing else was sent')
  register(ref, refs[0])
  for (const e of [...sent, locked, disputed]) upsertTxLog(ref, e)

  console.log('\n4 the engine')
  const e = await indexed('the disputed escrow', () => escrowAt(ref))
  const d = readDatum(e.output.plutusData as string)
  const grid = reach(d, Object.fromEntries(e.output.amount.map((a) => [a.unit, a.quantity])), Date.now(), PARAMS, ref)
  console.log(`  ${d.state}; can move now: ${allowedCells(grid).join(', ')}`)
  const cell = grid.verdicts.find((v) => v.redeemer === 'WithdrawRefund' && v.role === 'buyer')
  expect(!!cell && !cell.allowed, `the buyer cannot take WithdrawRefund yet (${cell?.failed.join('; ')})`)
  expect(allowedCells(grid).includes('AuthorizeRefund/seller'), 'the seller can concede (AuthorizeRefund)')

  console.log('\n5 try anyway: the buyer takes everything while Disputed')
  const tried = await tryAnyway(ref, 'WithdrawRefund', 'buyer')
  console.log(`  ${line(tried)}  ${tried.txHash}`)
  expect(tried.status === 'refused' && tried.refusal?.phase === 2, 'refused by the validator (phase 2), nothing spent')

  console.log(`\n6 settle: seller ${SHARE}, buyer ${Math.round((1 - SHARE) * 1000) / 1000}`)
  const proposal = await sign('buyer', await indexed('the disputed escrow', () => prepare(ref, SHARE)))
  console.log(`  leg 2 signed by the buyer before leg 1 exists: leg 1 ${proposal.leg1?.txHash}, leg 2 ${proposal.leg2?.txHash}`)
  const [leg1, leg2, replay] = await submit(proposal)
  if (!leg2) {
    console.log(`  leg 1 (AuthorizeRefund, seller): ${line(leg1)}: leg 1 did not go out, so nothing was exposed and leg 2 was not sent`)
    return false
  }
  console.log(`  leg 1 (AuthorizeRefund, seller): ${line(leg1)}\n  leg 2 (WithdrawRefund, buyer's): ${line(leg2)}${replay ? `\n  leg 2 replayed: ${line(replay)}` : ''}`)
  expect(!!leg1.block && !!leg2.block, 'both legs confirmed')
  if (leg1.block && leg2.block) console.log(`  ${leg1.block.height === leg2.block.height ? 'same block' : `blocks ${leg1.block.height} and ${leg2.block.height}`}`)
  expect(replay?.status === 'refused' && replay.refusal?.phase === 1, 'the replay refused by the ledger (phase 1: its inputs are spent)')
  const rb = leg2.readback
  if (!rb?.balances) {
    failures.push('read-back')
    console.log(`  read-back not available yet (a hole, not a mismatch): node src/preprod/readback.ts ${ref}`)
  } else {
    console.log(`  read back on ${rb.provider}: buyer ${JSON.stringify(rb.balances.buyer)}, seller ${JSON.stringify(rb.balances.seller)}`)
    expect(rb.validContract && sameValue(rb.balances.buyer, proposal.payout.buyer) && sameValue(rb.balances.seller, proposal.payout.seller), 'what each party received equals the agreed split')
  }

  console.log(`\nlog   ${txLogFile(ref)}`)
  for (const t of [...sent, locked, disputed, tried, leg1, leg2]) console.log(`      ${t.txHash}  ${t.step.replace(/ \(engine: .*\)$/, '')}`)
  console.log(`check pnpm verify <tx hash> preprod   or   ${link(leg2.txHash)}`)
  console.log(`\n${Math.round((Date.now() - t0) / 1000)} s from the first step to the last, each confirmed on chain before the next`)
  if (failures.length) console.log(`${failures.length} step(s) not as predicted: ${failures.join(' · ')}`)
  return failures.length === 0
}

loadEnv()
if (values.keygen) await keygen()
else process.exitCode = (await run()) ? 0 : 1
