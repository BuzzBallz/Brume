// tryAnyway: the engine says a party cannot take a branch; build that tx anyway, send it, and record what the chain says.
// Allowed only on a cell the engine predicts refused, on an escrow whose party key we hold. No evaluation: the node runs
// the script itself, so a refusal at submission is the validator's (phase 2) and costs nothing (rejected from the mempool).
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Redeemer, Role, TxLogEntry, Value } from '../../shared/types.ts'
import { PARAMS, SCRIPT_HASH } from '../../shared/constants.ts'
import { AmbiguousSubmit, liveUtxos, preprodSubmitter, SubmitTransportError } from './chain.ts'
import { patchDatum, readDatum, type DatumPatch } from './datum.ts'
import { buildEscrowSpend } from './escrow.ts'
import { ROOT } from './env.ts'
import { escrowAt, lovelace, pureAda, refOf } from './fixture.ts'
import { upsertTxLog, SettleError } from './settle.ts'
import { addWitness, confirmTx, cooldownFrom, submitAndConfirm, submitOnly, txWindow, type TxWindow } from './tx.ts'
import { party } from './wallet.ts'
import { reach } from '../engine/reach.ts'

// Enough for the V1 script to run to its failure; the fee is paid on it, and nothing is charged if the node refuses.
const TRY_BUDGET = { mem: 6_000_000, steps: 2_500_000_000 }

// The continuation each branch documents, so the predicted guard is the one that decides (SPEC-VALIDATOR §2).
function continuationFor(r: Redeemer, raw: string, w: TxWindow): DatumPatch | null {
  const d = readDatum(raw)
  switch (r) {
    case 'SetRefundRequested':
      return { sellerCooldownTime: 0, buyerCooldownTime: cooldownFrom(w), state: d.resultHash ? 'Disputed' : 'RefundRequested' }
    case 'UnSetRefundRequested':
      return { sellerCooldownTime: 0, buyerCooldownTime: cooldownFrom(w), state: d.resultHash ? 'ResultSubmitted' : 'FundsLocked' }
    case 'SubmitResult':
      return { resultHash: d.resultHash || randomBytes(32).toString('hex'), sellerCooldownTime: cooldownFrom(w), buyerCooldownTime: 0, state: d.state === 'FundsLocked' || d.state === 'ResultSubmitted' ? 'ResultSubmitted' : 'Disputed' }
    case 'AuthorizeRefund':
      return { resultHash: '', sellerCooldownTime: cooldownFrom(w), buyerCooldownTime: 0, state: 'RefundRequested' }
    default:
      return null // an exit: Withdraw, WithdrawRefund, WithdrawDisputed
  }
}

// Only escrows we locked (fixtures/preprod/bank.json): a control never touches anyone else's escrow.
function inBank(ref: string): boolean {
  const file = join(ROOT, 'fixtures', 'preprod', 'bank.json')
  if (!existsSync(file)) return false
  const bank = JSON.parse(readFileSync(file, 'utf8')) as { ref: string; disputedFrom?: string }[]
  return bank.some((e) => e.ref === ref || e.disputedFrom === ref)
}

export async function tryAnyway(escrowRef: string, redeemer: Redeemer, role: Role, logAs: string = escrowRef): Promise<TxLogEntry> {
  if (role === 'admin') throw new SettleError('The admin keys of the shared escrow are not ours: the admin control runs on our own deployment.')
  // Withdraw has two mandatory datum-tagged outputs; without them the script refuses for that reason, not the predicted one.
  if (redeemer === 'Withdraw') throw new SettleError('Try anyway is not offered for Withdraw: its mandatory outputs, not the predicted guard, would decide.')
  if (!inBank(escrowRef)) throw new SettleError('Try anyway runs only on our own bank escrows (fixtures/preprod/bank.json).')
  const escrow = await escrowAt(escrowRef)
  const raw = escrow.output.plutusData as string
  const d = readDatum(raw)
  const value: Value = Object.fromEntries(escrow.output.amount.map((a) => [a.unit, a.quantity]))
  const now = Date.now()
  const cell = reach(d, value, now, PARAMS, escrowRef).verdicts.find((v) => v.redeemer === redeemer && v.role === role)
  if (!cell) throw new SettleError('Unknown redeemer or role.')
  if (cell.allowed) throw new SettleError(`The engine says the ${role} CAN take ${redeemer} now: "try anyway" is only for a move it predicts refused.`)
  const p = await party(role)
  if (d[role].payment.hash !== p.pkh) throw new SettleError(`This ${role} key is not the escrow's ${role}.`)

  const utxos = await liveUtxos(p.address)
  const collateral = pureAda(utxos).find((u) => lovelace(u) >= 5_000_000n)
  const funding = pureAda(utxos).find((u) => collateral && refOf(u) !== refOf(collateral) && lovelace(u) >= 5_000_000n)
  if (!collateral || !funding) throw new SettleError(`The ${role} needs two pure-ADA UTxOs of at least 5 tADA.`)
  const window = txWindow(now)
  const patch = continuationFor(redeemer, raw, window)
  const built = await buildEscrowSpend({
    network: 'preprod', window, escrow, redeemer, signers: [p], funding: [funding], collateral, unevaluated: TRY_BUDGET,
    continuation: patch ? { datumCbor: patchDatum(raw, patch), amount: escrow.output.amount } : undefined,
    outputs: patch ? [] : [{ address: p.address, amount: escrow.output.amount }], // an exit pays the whole pot to the party trying it
    changeAddress: p.address,
  })
  const signed = await addWitness(built, p)
  const s = preprodSubmitter()
  const base = {
    step: `try anyway: ${redeemer} by the ${role} (engine: ${cell.failed.join('; ')})`, network: 'preprod' as const, scriptHash: SCRIPT_HASH,
    txHash: built.txHash, atMs: Date.now(), via: s.via, redeemer, role, expected: 'refuse' as const,
  }
  let refused: TxLogEntry | null
  try {
    refused = await submitOnly(signed, s, base)
  } catch (error: unknown) {
    // A hole is logged as one, never as the control's outcome; an ambiguous submit may still land (the engine wrong).
    if (error instanceof SubmitTransportError) return upsertTxLog(logAs, { ...base, status: 'refused', stage: 'submit', error: `not sent: ${error.message.slice(0, 200)}` })
    if (!(error instanceof AmbiguousSubmit)) throw error
    upsertTxLog(logAs, { ...base, status: 'accepted', stage: 'submit', error: 'possibly live, not seen yet: confirming' })
    refused = null
  }
  // Accepted would mean the engine was wrong: logged as such (the UI shows it red), never hidden.
  if (refused) return upsertTxLog(logAs, refused)
  const c = await confirmTx(base)
  return upsertTxLog(logAs, c.block ? { ...c, error: 'ACCEPTED although the engine predicted a refusal' } : c)
}

// C11 on the shared script: after a concession alone, every branch the engine says is gone is sent anyway and must be
// refused by the validator; then the buyer, the only party left, exits. Our own bank escrow, our own keys, one log.
//   node src/preprod/controls.ts c11 <disputed bank ref>
async function concedeAlone(ref: string, logAs: string): Promise<string> {
  const seller = await party('seller')
  const escrow = await escrowAt(ref)
  const raw = escrow.output.plutusData as string
  const utxos = pureAda(await liveUtxos(seller.address)).filter((u) => lovelace(u) >= 5_000_000n)
  if (utxos.length < 2) throw new SettleError('The seller needs two pure-ADA UTxOs of at least 5 tADA.')
  const window = txWindow(Date.now())
  const built = await buildEscrowSpend({
    network: 'preprod', window, escrow, redeemer: 'AuthorizeRefund', signers: [seller], funding: [utxos[0]], collateral: utxos[1],
    continuation: { datumCbor: patchDatum(raw, { resultHash: '', sellerCooldownTime: cooldownFrom(window), buyerCooldownTime: 0, state: 'RefundRequested' }), amount: escrow.output.amount },
    outputs: [], changeAddress: seller.address,
  })
  const e = await submitAndConfirm(await addWitness(built, seller), preprodSubmitter(), 'AuthorizeRefund alone (C11: the concession, no exit signed)', Date.now(), SCRIPT_HASH)
  upsertTxLog(logAs, { ...e, redeemer: 'AuthorizeRefund', role: 'seller', expected: 'accept' })
  if (e.status !== 'accepted' || !e.block) throw new SettleError(`the concession was ${e.status} at ${e.stage}`)
  // The bank entry follows the escrow to its new output, so the controls below run on a registered ref.
  const file = join(ROOT, 'fixtures', 'preprod', 'bank.json')
  const bank = JSON.parse(readFileSync(file, 'utf8')) as { ref: string; disputedFrom?: string; state: string; concededFrom?: string }[]
  const entry = bank.find((x) => x.ref === ref)
  if (entry) Object.assign(entry, { concededFrom: ref, ref: `${built.txHash}#0`, state: 'RefundRequested' })
  writeFileSync(file, JSON.stringify(bank, null, 2) + '\n')
  return `${built.txHash}#0`
}

async function buyerExit(ref: string, logAs: string): Promise<TxLogEntry> {
  const buyer = await party('buyer')
  const escrow = await escrowAt(ref)
  const utxos = pureAda(await liveUtxos(buyer.address)).filter((u) => lovelace(u) >= 5_000_000n)
  if (utxos.length < 2) throw new SettleError('The buyer needs two pure-ADA UTxOs of at least 5 tADA.')
  const built = await buildEscrowSpend({
    network: 'preprod', window: txWindow(Date.now()), escrow, redeemer: 'WithdrawRefund', signers: [buyer], funding: [utxos[0]], collateral: utxos[1],
    outputs: [{ address: buyer.address, amount: escrow.output.amount }], changeAddress: buyer.address,
  })
  const e = await submitAndConfirm(await addWitness(built, buyer), preprodSubmitter(), 'WithdrawRefund by the buyer (C11: the only party left)', Date.now(), SCRIPT_HASH)
  return upsertTxLog(logAs, { ...e, redeemer: 'WithdrawRefund', role: 'buyer', expected: 'accept' })
}

if (process.argv[1]?.endsWith('controls.ts') && process.argv[2] === 'c11' && process.argv[3]) {
  const start = process.argv[3]
  const logAs = `c11-${start}`
  const after = await concedeAlone(start, logAs)
  console.log(`conceded: ${after}`)
  for (const [redeemer, role] of [['SubmitResult', 'seller'], ['AuthorizeRefund', 'seller'], ['SetRefundRequested', 'buyer']] as const) {
    const e = await tryAnyway(after, redeemer, role, logAs)
    console.log(`  ${e.step}: ${e.status} at ${e.stage}${e.refusal ? `, phase ${e.refusal.phase}` : ''}`)
  }
  const exit = await buyerExit(after, logAs)
  console.log(`  ${exit.step}: ${exit.status} at ${exit.stage}${exit.block ? `, block ${exit.block.height}` : ''}`)
}
