// tryAnyway: the engine says a party cannot take a branch; build that tx anyway, send it, and record what the chain says.
// Allowed only on a cell the engine predicts refused, on an escrow whose party key we hold. No evaluation: the node runs
// the script itself, so a refusal at submission is the validator's (phase 2) and costs nothing (rejected from the mempool).
import { randomBytes } from 'node:crypto'
import type { Redeemer, Role, TxLogEntry, Value } from '../../shared/types.ts'
import { PARAMS, SCRIPT_HASH } from '../../shared/constants.ts'
import { liveUtxos, preprodSubmitter } from './chain.ts'
import { patchDatum, readDatum, type DatumPatch } from './datum.ts'
import { buildEscrowSpend } from './escrow.ts'
import { escrowAt, lovelace, pureAda, refOf } from './fixture.ts'
import { upsertTxLog, SettleError } from './settle.ts'
import { addWitness, confirmTx, cooldownFrom, submitOnly, txWindow, type TxWindow } from './tx.ts'
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

export async function tryAnyway(escrowRef: string, redeemer: Redeemer, role: Role): Promise<TxLogEntry> {
  if (role === 'admin') throw new SettleError('The admin keys of the shared escrow are not ours: the admin control runs on our own deployment.')
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
    step: `try anyway: ${redeemer} by the ${role} (engine: ${cell.failed[0]})`, network: 'preprod' as const, scriptHash: SCRIPT_HASH,
    txHash: built.txHash, atMs: Date.now(), via: s.via, redeemer, role, expected: 'refuse' as const,
  }
  const refused = await submitOnly(signed, s, base)
  // Accepted would mean the engine was wrong: logged as such (the UI shows it red), never hidden.
  const entry = refused ?? { ...(await confirmTx(base)), error: 'ACCEPTED although the engine predicted a refusal' }
  upsertTxLog(escrowRef, entry)
  return entry
}
