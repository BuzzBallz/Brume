// S-2: OUR OWN DEPLOYMENT of the V1 escrow, for the one control the shared script cannot host (its admin keys are
// Masumi's). Same compiled code as the deployed script (the vendored blueprint), same fee address, fee permille and
// cooldown; only the admin set differs: our admin key listed three times, threshold 2 — the validator counts a key listed
// n times as n votes (SPEC-VALIDATOR §2), so one signature is three votes. Labelled as our own deployment everywhere.
//   node src/preprod/own.ts info              params, script hash, address → fixtures/preprod/own-deployment.json
//   node src/preprod/own.ts fund-admin        buyer → admin, 2 × 15 tADA (fee and collateral for the admin's tx)
//   node src/preprod/own.ts lock              buyer locks escrow X and escrow Y, both Disputed, arbitration window open
//   node src/preprod/own.ts concede <ref>     the seller's AuthorizeRefund on Y (leg 1 alone)
//   node src/preprod/own.ts arbitrate <ref>   the admin's WithdrawDisputed: X before the concession, Y after it
//   node src/preprod/own.ts exit <ref>        the buyer's WithdrawRefund on Y, so our funds come back
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Params, Redeemer, Role, TxLogEntry, Value } from '../../shared/types.ts'
import { PARAMS, SCRIPT_HASH } from '../../shared/constants.ts'
import { reach } from '../engine/reach.ts'
import { liveUtxos, preprodSubmitter } from './chain.ts'
import { patchDatum, readDatum } from './datum.ts'
import { buildEscrowSpend } from './escrow.ts'
import { ROOT } from './env.ts'
import { escrowAt, lovelace, pureAda, refOf } from './fixture.ts'
import { lockEscrows } from './bankops.ts'
import { reservedUtxos, SettleError, upsertTxLog } from './settle.ts'
import { applyV1, BLUEPRINT_UNAPPLIED_HASH, type Script } from './script.ts'
import { addWitness, buildPlain, confirmTx, cooldownFrom, submitAndConfirm, submitOnly, txWindow } from './tx.ts'
import { party, type Party } from './wallet.ts'

const LABEL = 'OUR OWN DEPLOYMENT of the V1 escrow (same compiled code, our admin key ×3, threshold 2) — not the shared Masumi escrow'
const LOG = 'own-deployment' // fixtures/preprod/txlog-own-deployment.json
const FILE = join(ROOT, 'fixtures', 'preprod', 'own-deployment.json')
const TRY_BUDGET = { mem: 6_000_000, steps: 2_500_000_000 }

export async function ownParams(): Promise<Params> {
  const admin = await party('admin')
  return { ...PARAMS, adminKeyHashes: [admin.pkh, admin.pkh, admin.pkh] }
}

export async function ownScript(): Promise<Script> {
  const s = applyV1(await ownParams())
  if (s.hash === SCRIPT_HASH) throw new SettleError('Our own deployment must not be the shared script.')
  return s
}

type Registry = { label: string; blueprint: string; params: Params; scriptHash: string; address: string; escrows: { ref: string; purpose: string }[] }
const load = (): Registry | null => (existsSync(FILE) ? (JSON.parse(readFileSync(FILE, 'utf8')) as Registry) : null)
const save = async (r: Registry): Promise<void> => {
  const { writeFileSync, mkdirSync } = await import('node:fs')
  mkdirSync(join(ROOT, 'fixtures', 'preprod'), { recursive: true })
  writeFileSync(FILE, JSON.stringify(r, null, 2) + '\n')
}
const value = (amount: { unit: string; quantity: string }[]): Value => Object.fromEntries(amount.map((a) => [a.unit, a.quantity]))

async function twoPureAda(p: Party): Promise<[ReturnType<typeof pureAda>[number], ReturnType<typeof pureAda>[number]]> {
  const reserved = reservedUtxos()
  const us = pureAda(await liveUtxos(p.address)).filter((u) => lovelace(u) >= 5_000_000n && !reserved.has(refOf(u)))
  if (us.length < 2) throw new SettleError(`The ${p.role} needs two pure-ADA UTxOs of at least 5 tADA.`)
  return [us[0], us[1]]
}

async function info(): Promise<Registry> {
  const s = await ownScript()
  const r: Registry = { label: LABEL, blueprint: BLUEPRINT_UNAPPLIED_HASH, params: await ownParams(), scriptHash: s.hash, address: s.address.preprod, escrows: load()?.escrows ?? [] }
  await save(r)
  console.log(`${LABEL}\n  script hash ${s.hash} (shared: ${SCRIPT_HASH})\n  address     ${s.address.preprod}\n  admins      ${r.params.adminKeyHashes.map((h) => h.slice(0, 8) + '…').join(', ')} threshold ${r.params.requiredAdmins}`)
  return r
}

async function fundAdmin(): Promise<void> {
  const [buyer, admin] = [await party('buyer'), await party('admin')]
  const funding = (await liveUtxos(buyer.address)).sort((a, b) => (lovelace(b) > lovelace(a) ? 1 : -1))[0]
  const now = Date.now()
  const built = await buildPlain({
    network: 'preprod', window: txWindow(now), signers: [buyer], inputs: [funding], changeAddress: buyer.address,
    outputs: [1, 2].map(() => ({ address: admin.address, amount: [{ unit: 'lovelace', quantity: '15000000' }] })),
  })
  const e = await submitAndConfirm(await addWitness(built, buyer), preprodSubmitter(), 'buyer → admin 2 × 15 tADA (fee and collateral for the admin control)', now)
  upsertTxLog(LOG, e)
  console.log(`${e.status} at ${e.stage}${e.block ? `, block ${e.block.height}` : ''}`)
}

async function lock(): Promise<void> {
  const r = await info()
  const [buyer, seller] = [await party('buyer'), await party('seller')]
  const amount = [{ unit: 'lovelace', quantity: '10000000' }]
  const req = { buyer: buyer.address, seller: seller.address, amount, options: { state: 'Disputed' as const, unlock: 'past' as const, collateralReturnLovelace: 2_000_000, arbitration: 'open' as const } }
  const { entry, refs } = await lockEscrows(buyer, [req, req], r.address)
  upsertTxLog(LOG, { ...entry, step: `${entry.step} at our own deployment (a lock runs no validator)` }) // scriptHash stays '': nothing ran
  if (entry.status !== 'accepted' || !entry.block) throw new SettleError(`lock ${entry.status} at ${entry.stage}`)
  r.escrows.push({ ref: refs[0], purpose: 'X: the admin arbitrates BEFORE any concession (expected: accepted)' }, { ref: refs[1], purpose: 'Y: the seller concedes, then the admin tries to arbitrate (expected: refused)' })
  await save(r)
  console.log(`lock block ${entry.block.height}\n  X ${refs[0]}\n  Y ${refs[1]}`)
}

// One spend of an escrow at our own deployment, by `by`, with the engine's prediction recorded next to the outcome.
async function spend(ref: string, redeemer: Redeemer, by: Party, outputsTo: string | null): Promise<TxLogEntry> {
  const script = await ownScript()
  const params = await ownParams()
  const escrow = await escrowAt(ref, script.address.preprod)
  const raw = escrow.output.plutusData as string
  const d = readDatum(raw)
  const role: Role = by.role
  const now = Date.now()
  const cell = reach(d, value(escrow.output.amount), now, params, ref).verdicts.find((v) => v.redeemer === redeemer && v.role === role)
  if (!cell) throw new SettleError('Unknown cell.')
  const [funding, collateral] = await twoPureAda(by)
  const window = txWindow(now)
  const continuation = redeemer === 'AuthorizeRefund'
    ? { datumCbor: patchDatum(raw, { resultHash: '', sellerCooldownTime: cooldownFrom(window), buyerCooldownTime: 0, state: 'RefundRequested' }), amount: escrow.output.amount }
    : undefined
  const built = await buildEscrowSpend({
    network: 'preprod', window, escrow, redeemer, signers: [by], funding: [funding], collateral, script,
    continuation, outputs: outputsTo ? [{ address: outputsTo, amount: escrow.output.amount }] : [], changeAddress: by.address,
    // A move the engine predicts refused is sent unevaluated, so the node runs the script and decides.
    ...(cell.allowed ? {} : { unevaluated: TRY_BUDGET }),
  })
  const signed = await addWitness(built, by)
  const s = preprodSubmitter()
  const base = {
    step: `${redeemer} by the ${role} at our own deployment (engine: ${cell.allowed ? 'CAN' : cell.failed.join('; ')})`, network: 'preprod' as const,
    scriptHash: script.hash, txHash: built.txHash, atMs: Date.now(), via: s.via, redeemer, role, expected: cell.allowed ? ('accept' as const) : ('refuse' as const),
  }
  const refused = await submitOnly(signed, s, base)
  const entry = refused ?? (await confirmTx(base))
  upsertTxLog(LOG, entry)
  console.log(`  ${entry.step}: ${entry.status} at ${entry.stage}${entry.block ? `, block ${entry.block.height}` : ''}${entry.refusal ? ` (phase ${entry.refusal.phase}: ${entry.refusal.ledgerError.slice(0, 200)})` : ''}`)
  if (entry.status === 'accepted' && continuation) console.log(`  now ${built.txHash}#0`)
  return entry
}

const [cmd, ref] = process.argv.slice(2)
if (cmd === 'info') await info()
else if (cmd === 'fund-admin') await fundAdmin()
else if (cmd === 'lock') await lock()
else if (cmd === 'concede' && ref) await spend(ref, 'AuthorizeRefund', await party('seller'), null)
else if (cmd === 'arbitrate' && ref) await spend(ref, 'WithdrawDisputed', await party('admin'), (await party('buyer')).address)
else if (cmd === 'exit' && ref) await spend(ref, 'WithdrawRefund', await party('buyer'), (await party('buyer')).address)
else throw new Error('usage: own.ts info | fund-admin | lock | concede <ref> | arbitrate <ref> | exit <ref>')
