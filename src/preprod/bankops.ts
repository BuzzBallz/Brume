import type { Asset } from '@meshsdk/core'
import type { TxLogEntry } from '../../shared/types.ts'
import { SCRIPT_HASH, V1_ADDRESS } from '../../shared/constants.ts'
import { liveUtxos, preprodSubmitter } from './chain.ts'
import { encodeDatum, patchDatum, readDatum } from './datum.ts'
import { buildEscrowSpend } from './escrow.ts'
import { byLovelace, escrowAt, fixtureDatum, lovelace, pureAda, refOf, type LockOptions } from './fixture.ts'
import { addWitness, buildPlain, cooldownFrom, submitAndConfirm, TxRuleError, txWindow } from './tx.ts'
import type { Party } from './wallet.ts'

export type LockRequest = { buyer: string; seller: string; amount: Asset[]; options: LockOptions }

// One lock tx can create several escrows: locking runs no validator (only spending does), so P4/P5 do not apply here.
// The funder pays; the datum names the parties, who alone can move each escrow afterwards.
export async function lockEscrows(funder: Party, requests: LockRequest[], scriptAddress: string = V1_ADDRESS.preprod): Promise<{ entry: TxLogEntry; refs: string[] }> {
  const now = Date.now()
  const funding = byLovelace(await liveUtxos(funder.address))
  const need = requests.reduce((s, r) => s + BigInt(r.amount.find((a) => a.unit === 'lovelace')?.quantity ?? '0'), 0n) + 3_000_000n
  const tokensNeeded = new Map<string, bigint>()
  for (const r of requests) for (const a of r.amount) if (a.unit !== 'lovelace') tokensNeeded.set(a.unit, (tokensNeeded.get(a.unit) ?? 0n) + BigInt(a.quantity))
  // Token-carrying UTxOs first (only those the lock needs), then the largest by lovelace, until everything is covered;
  // pure-ADA UTxOs are left for collateral whenever possible.
  const needsToken = (u: (typeof funding)[number]): boolean => u.output.amount.some((x) => tokensNeeded.has(x.unit))
  const ordered = [...funding.filter(needsToken), ...funding.filter((u) => !needsToken(u))]
  const inputs = []
  const have = new Map<string, bigint>()
  for (const u of ordered) {
    const covered = (have.get('lovelace') ?? 0n) >= need && [...tokensNeeded].every(([unit, q]) => (have.get(unit) ?? 0n) >= q)
    if (covered) break
    inputs.push(u)
    for (const a of u.output.amount) have.set(a.unit, (have.get(a.unit) ?? 0n) + BigInt(a.quantity))
  }
  for (const [unit, q] of tokensNeeded) if ((have.get(unit) ?? 0n) < q) throw new TxRuleError(`the funder holds less than ${q} of ${unit.slice(0, 12)}…`)
  const built = await buildPlain({
    network: 'preprod', window: txWindow(now), signers: [funder], inputs, changeAddress: funder.address, maxScriptOutputs: requests.length, scriptAddress,
    outputs: requests.map((r) => ({ address: scriptAddress, amount: r.amount, datumCbor: encodeDatum(fixtureDatum(r.buyer, r.seller, now, r.options)) })),
  })
  const entry = await submitAndConfirm(await addWitness(built, funder), preprodSubmitter(), `lock ${requests.length} fixture escrow(s)`, now)
  return { entry, refs: requests.map((_, i) => `${built.txHash}#${i}`) }
}

// SetRefundRequested by the escrow's own buyer: ResultSubmitted (result hash set) → Disputed, the state of the 61.
export async function raiseDispute(ref: string, buyer: Party): Promise<{ entry: TxLogEntry; next: string }> {
  const escrow = await escrowAt(ref)
  const raw = escrow.output.plutusData as string
  const d = readDatum(raw)
  if (d.buyer.payment.hash !== buyer.pkh) throw new TxRuleError(`${ref}: this buyer key is not the escrow's buyer`)
  const now = Date.now()
  const window = txWindow(now)
  if (window.toMs >= d.unlockTime) throw new TxRuleError('too late: SetRefundRequested needs its upper bound strictly before unlock_time')
  if (window.fromMs < d.buyerCooldownTime) throw new TxRuleError('the buyer cooldown has not passed')
  const utxos = await liveUtxos(buyer.address)
  const funding = byLovelace(utxos)[0]
  const collateral = pureAda(utxos).find((u) => refOf(u) !== refOf(funding) && lovelace(u) >= 3_000_000n)
  if (!funding || !collateral) throw new TxRuleError('the buyer needs a funding UTxO and a separate pure-ADA UTxO (>= 3 tADA) for collateral')
  const built = await buildEscrowSpend({
    network: 'preprod', window, escrow, redeemer: 'SetRefundRequested', signers: [buyer], funding: [funding], collateral,
    continuation: { datumCbor: patchDatum(raw, { sellerCooldownTime: 0, buyerCooldownTime: cooldownFrom(window), state: d.resultHash ? 'Disputed' : 'RefundRequested' }), amount: escrow.output.amount },
    outputs: [], changeAddress: buyer.address,
  })
  const entry = await submitAndConfirm(await addWitness(built, buyer), preprodSubmitter(), 'SetRefundRequested (buyer raises)', now, SCRIPT_HASH)
  return { entry: { ...entry, redeemer: 'SetRefundRequested', role: 'buyer', expected: 'accept' }, next: `${built.txHash}#0` }
}
