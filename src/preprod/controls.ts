// tryAnyway: the engine says a party cannot take a branch; build that tx anyway, send it, and record what the chain says.
// Allowed only on a cell the engine predicts refused, on an escrow whose party key we hold. No evaluation: the node runs
// the script itself, so a refusal at submission is the validator's (phase 2) and costs nothing (rejected from the mempool).
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Redeemer, Role, TxLogEntry, Value } from '../../shared/types.ts'
import { FEE_ADDRESS, PARAMS, SCRIPT_HASH, TUSDM as TUSDM_UNIT } from '../../shared/constants.ts'
import { AmbiguousSubmit, liveUtxos, preprodSubmitter, SubmitTransportError } from './chain.ts'
import { patchDatum, readDatum, type DatumPatch } from './datum.ts'
import { buildEscrowSpend } from './escrow.ts'
import { lockEscrows } from './bankops.ts'
import { ROOT } from './env.ts'
import { escrowAt, lovelace, pureAda, refOf } from './fixture.ts'
import { bech32Of, upsertTxLog, SettleError } from './settle.ts'
import { addWitness, confirmTx, cooldownFrom, submitAndConfirm, submitOnly, txWindow, type TxWindow } from './tx.ts'
import { party } from './wallet.ts'
import { reach } from '../engine/reach.ts'

// Enough for the V1 script to run to its failure; the fee is paid on it, and nothing is charged if the node refuses.
const TRY_BUDGET = { mem: 6_000_000, steps: 2_500_000_000 }

// own_ref as Plutus data: OutputReference { transaction_id: ByteArray, output_index: Int } = Constr 0 [bytes, int].
function ownRefDatum(u: { input: { txHash: string; outputIndex: number } }): string {
  if (u.input.outputIndex > 23) throw new SettleError('output index above 23 is not encoded here')
  return `d8799f5820${u.input.txHash}${u.input.outputIndex.toString(16).padStart(2, '0')}ff`
}

// Withdraw's output rules (SPEC-VALIDATOR §2): to the fee address, tagged own_ref, at least floor(q × φ / 1000) of every
// asset (lovelace raised to its min-UTxO); to the buyer, tagged own_ref, at least c lovelace; the rest to the seller.
function withdrawOutputs(escrow: Awaited<ReturnType<typeof escrowAt>>, d: ReturnType<typeof readDatum>, seller: string): { address: string; amount: { unit: string; quantity: string }[]; datumCbor?: string }[] {
  const tag = ownRefDatum(escrow)
  const fee = escrow.output.amount.map((a) => ({ unit: a.unit, quantity: ((BigInt(a.quantity) * BigInt(PARAMS.feePermille)) / 1000n).toString() })).filter((a) => a.quantity !== '0')
  const feeLovelace = BigInt(fee.find((a) => a.unit === 'lovelace')?.quantity ?? '0')
  const feeOut = [{ unit: 'lovelace', quantity: (feeLovelace > 1_500_000n ? feeLovelace : 1_500_000n).toString() }, ...fee.filter((a) => a.unit !== 'lovelace')]
  const buyerOut = [{ unit: 'lovelace', quantity: String(d.collateralReturnLovelace) }]
  const rest = escrow.output.amount.map((a) => {
    const used = BigInt(feeOut.find((x) => x.unit === a.unit)?.quantity ?? '0') + BigInt(buyerOut.find((x) => x.unit === a.unit)?.quantity ?? '0')
    return { unit: a.unit, quantity: (BigInt(a.quantity) - used).toString() }
  }).filter((a) => BigInt(a.quantity) > 0n)
  return [
    { address: FEE_ADDRESS.preprod, amount: feeOut, datumCbor: tag },
    { address: bech32Of(d.buyer), amount: buyerOut, datumCbor: tag },
    { address: seller, amount: rest },
  ]
}

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

// Only escrows we locked: the bank (fixtures/preprod/bank.json) or a `pnpm demo:preprod` run (out/demo/escrows.json).
// A control never touches anyone else's escrow.
function inBank(ref: string): boolean {
  return [join(ROOT, 'fixtures', 'preprod', 'bank.json'), join(ROOT, 'out', 'demo', 'escrows.json')].some((file) => {
    if (!existsSync(file)) return false
    const list = JSON.parse(readFileSync(file, 'utf8')) as { ref: string; disputedFrom?: string }[]
    return list.some((e) => e.ref === ref || e.disputedFrom === ref)
  })
}

export async function tryAnyway(escrowRef: string, redeemer: Redeemer, role: Role, logAs: string = escrowRef): Promise<TxLogEntry> {
  if (role === 'admin') throw new SettleError('The admin keys of the shared escrow are not ours: the admin control runs on our own deployment.')
  // Withdraw has two mandatory datum-tagged outputs; without them the script refuses for that reason, not the predicted one.
  if (!inBank(escrowRef)) throw new SettleError('Try anyway runs only on escrows we locked (the bank, or a demo:preprod run).')
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
    // An exit pays the pot to the party trying it; Withdraw also gets its two mandatory datum-tagged outputs, so that the
    // predicted guard, not a missing output, is what decides.
    outputs: patch ? [] : redeemer === 'Withdraw' ? withdrawOutputs(escrow, d, p.address) : [{ address: p.address, amount: escrow.output.amount }],
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
// minimalCooldown: the concession writes seller_cooldown = upper bound + the V1 period (7 min, R5) + 1 min, the smallest
// safe value, so the seller controls can be sent once it has passed and the cooldown cannot be what refuses them.
async function concedeAlone(ref: string, logAs: string, minimalCooldown = false): Promise<string> {
  const seller = await party('seller')
  const escrow = await escrowAt(ref)
  const raw = escrow.output.plutusData as string
  const utxos = pureAda(await liveUtxos(seller.address)).filter((u) => lovelace(u) >= 5_000_000n)
  if (utxos.length < 2) throw new SettleError('The seller needs two pure-ADA UTxOs of at least 5 tADA.')
  const window = txWindow(Date.now())
  const built = await buildEscrowSpend({
    network: 'preprod', window, escrow, redeemer: 'AuthorizeRefund', signers: [seller], funding: [utxos[0]], collateral: utxos[1],
    continuation: { datumCbor: patchDatum(raw, { resultHash: '', sellerCooldownTime: minimalCooldown ? window.toMs + PARAMS.cooldownMs + 60_000 : cooldownFrom(window), buyerCooldownTime: 0, state: 'RefundRequested' }), amount: escrow.output.amount },
    outputs: [], changeAddress: seller.address,
  })
  const e = await submitAndConfirm(await addWitness(built, seller), preprodSubmitter(), `AuthorizeRefund alone (C11: the concession, no exit signed${minimalCooldown ? '; minimal seller cooldown' : ''})`, Date.now(), SCRIPT_HASH)
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

// C11's last branch, Withdraw, with its mandatory outputs and on an escrow whose unlock_time has passed, so that only the
// concession's effects (state RefundRequested, result hash emptied) can refuse it.
if (process.argv[1]?.endsWith('controls.ts') && process.argv[2] === 'c11-withdraw' && process.argv[3]) {
  const start = process.argv[3]
  const logAs = `c11-withdraw-${start}`
  const after = await concedeAlone(start, logAs)
  console.log(`conceded: ${after}`)
  const e = await tryAnyway(after, 'Withdraw', 'seller', logAs)
  console.log(`  ${e.step}: ${e.status} at ${e.stage}${e.refusal ? `, phase ${e.refusal.phase}` : ''}`)
  const exit = await buyerExit(after, logAs)
  console.log(`  ${exit.step}: ${exit.status} at ${exit.stage}${exit.block ? `, block ${exit.block.height}` : ''}`)
}

// C11 with the guard isolated: concession with the minimal cooldown, then each seller control only once the engine's
// reasons for it no longer include any cooldown, so the state or the emptied result hash is what decides.
if (process.argv[1]?.endsWith('controls.ts') && process.argv[2] === 'c11-isolated' && process.argv[3]) {
  const start = process.argv[3]
  const logAs = `c11-isolated-${start}`
  const after = await concedeAlone(start, logAs, true)
  console.log(`conceded: ${after}; waiting for the seller cooldown to pass`)
  const seller = [['SubmitResult', 'seller'], ['AuthorizeRefund', 'seller']] as const
  for (;;) {
    const escrow = await escrowAt(after)
    const d = readDatum(escrow.output.plutusData as string)
    const v: Value = Object.fromEntries(escrow.output.amount.map((a) => [a.unit, a.quantity]))
    const g = reach(d, v, Date.now(), PARAMS, after)
    const cells = seller.map(([r, role]) => g.verdicts.find((x) => x.redeemer === r && x.role === role))
    if (cells.every((c) => c && !c.failed.some((f) => /cooldown/.test(f)))) break
    await new Promise((r) => setTimeout(r, 20_000))
  }
  for (const [redeemer, role] of seller) {
    const e = await tryAnyway(after, redeemer, role, logAs)
    console.log(`  ${e.step}: ${e.status} at ${e.stage}${e.refusal ? `, phase ${e.refusal.phase}` : ''}`)
  }
  const exit = await buyerExit(after, logAs)
  console.log(`  ${exit.step}: ${exit.status} at ${exit.stage}${exit.block ? `, block ${exit.block.height}` : ''}`)
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

// Positive control for the Withdraw refusal: the SAME output construction (fee and buyer outputs tagged own_ref) on an
// escrow where Withdraw is open (ResultSubmitted, result set, unlock_time past) must be accepted. It is also the first
// execution of the fee rule (fee_permille of every asset to the fee address) on the deployed bytes.
async function withdrawOpen(logAs: string): Promise<TxLogEntry> {
  const [buyer, seller] = [await party('buyer'), await party('seller')]
  const amount = [{ unit: 'lovelace', quantity: '20000000' }, ...((await liveUtxos(buyer.address)).some((u) => u.output.amount.some((a) => a.unit === TUSDM_UNIT)) ? [{ unit: TUSDM_UNIT, quantity: '2000000' }] : [])]
  const { entry, refs } = await lockEscrows(buyer, [{ buyer: buyer.address, seller: seller.address, amount, options: { state: 'ResultSubmitted', unlock: 'past', collateralReturnLovelace: 2_000_000 } }])
  upsertTxLog(logAs, { ...entry, step: 'lock for the positive control (ResultSubmitted, unlock_time past)' })
  if (entry.status !== 'accepted' || !entry.block) throw new SettleError(`lock ${entry.status}`)
  const escrow = await escrowAt(refs[0])
  const d = readDatum(escrow.output.plutusData as string)
  const cell = reach(d, Object.fromEntries(escrow.output.amount.map((a) => [a.unit, a.quantity])), Date.now(), PARAMS, refs[0]).verdicts.find((v) => v.redeemer === 'Withdraw' && v.role === 'seller')
  if (!cell?.allowed) throw new SettleError(`the engine does not predict Withdraw open here: ${cell?.failed.join('; ')}`)
  const utxos = pureAda(await liveUtxos(seller.address)).filter((u) => lovelace(u) >= 5_000_000n)
  const built = await buildEscrowSpend({
    network: 'preprod', window: txWindow(Date.now()), escrow, redeemer: 'Withdraw', signers: [seller], funding: [utxos[0]], collateral: utxos[1],
    outputs: withdrawOutputs(escrow, d, seller.address), changeAddress: seller.address,
  })
  const e = await submitAndConfirm(await addWitness(built, seller), preprodSubmitter(), 'Withdraw by the seller, same tagged outputs (positive control: must be accepted)', Date.now(), SCRIPT_HASH)
  return upsertTxLog(logAs, { ...e, redeemer: 'Withdraw', role: 'seller', expected: 'accept' })
}

if (process.argv[1]?.endsWith('controls.ts') && process.argv[2] === 'withdraw-open' && process.argv[3]) {
  const e = await withdrawOpen(`c11-withdraw-${process.argv[3]}`)
  console.log(`  ${e.step}: ${e.status} at ${e.stage}${e.block ? `, block ${e.block.height}` : ''}${e.refusal ? `, phase ${e.refusal.phase}: ${e.refusal.ledgerError.slice(0, 200)}` : ''}`)
}
