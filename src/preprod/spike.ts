// A2 spike, seller-first path (B): AuthorizeRefund (leg 1) then WithdrawRefund (leg 2), leg 2 signed by the buyer
// against leg 1's output before leg 1 exists. Staged so each step can be run and inspected:
//   node src/preprod/spike.ts lock                       buyer locks a fixture in ResultSubmitted (result hash set, submit deadline past)
//   node src/preprod/spike.ts dispute <ref>              buyer SetRefundRequested → Disputed
//   node src/preprod/spike.ts settle <ref> [--share 0.4] build leg 1, build leg 2 against leg1#0, buyer signs leg 2,
//                                                         then submit: seller signs leg 1 only now, both legs out back to back,
//                                                         then leg 2 replayed byte for byte (must be refused)
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import type { Asset, UTxO } from '@meshsdk/core'
import type { Address, Datum, TxLogEntry } from '../../shared/types.ts'
import { SCRIPT_HASH, V1_ADDRESS } from '../../shared/constants.ts'
import { liveUtxos, preprodChain, preprodSubmitter } from './chain.ts'
import { patchDatum, encodeDatum, readDatum } from './datum.ts'
import { buildEscrowSpend } from './escrow.ts'
import { ROOT } from './env.ts'
import { cst, mesh } from './mesh.ts'
import { addWitness, appendTxLog, buildPlain, confirmTx, cooldownFrom, hasValidWitness, submitAndConfirm, submitOnly, TxRuleError, txWindow, type Built } from './tx.ts'
import { party, type Party } from './wallet.ts'

const { positionals, values } = parseArgs({ allowPositionals: true, options: { share: { type: 'string', default: '0.4' } } })
const [cmd, refArg] = positionals

const MIN = 60_000
const lovelace = (u: UTxO): bigint => BigInt(u.output.amount.find((a) => a.unit === 'lovelace')?.quantity ?? '0')
// Funding may carry tokens (they go back in the change); collateral must be pure ADA.
const byLovelace = (us: UTxO[]): UTxO[] => [...us].sort((a, b) => (lovelace(b) > lovelace(a) ? 1 : -1))
const pureAda = (us: UTxO[]): UTxO[] => us.filter((u) => u.output.amount.every((a) => a.unit === 'lovelace')).sort((a, b) => (lovelace(b) > lovelace(a) ? 1 : -1))
const refOf = (u: UTxO): string => `${u.input.txHash}#${u.input.outputIndex}`
const plutusAddress = (bech32: string): Address => {
  const a = mesh.deserializeAddress(bech32)
  return { payment: { type: 'key', hash: a.pubKeyHash }, stake: a.stakeCredentialHash ? { type: 'key', hash: a.stakeCredentialHash } : null }
}
const log = (ref: string, e: TxLogEntry): void => {
  appendTxLog(`spike-${ref}`, e)
  console.log(`  ${e.step}: ${e.status} at ${e.stage}${e.block ? `, block ${e.block.height}` : ''}${e.refusal ? `, phase ${e.refusal.phase}: ${e.refusal.ledgerError.slice(0, 160)}` : ''}${e.error && !e.refusal ? `: ${e.error}` : ''}`)
}

async function escrowAt(ref: string): Promise<UTxO> {
  const [hash, idx] = ref.split('#')
  const u = (await preprodChain().fetchUTxOs(hash, Number(idx))).find((x) => x.input.outputIndex === Number(idx))
  if (!u) throw new Error(`escrow ${ref} not found (spent, or not indexed yet)`)
  if (u.output.address !== V1_ADDRESS.preprod || !u.output.plutusData) throw new Error(`${ref} is not a V1 escrow with an inline datum`)
  return u
}

async function lock(): Promise<void> {
  const [buyer, seller] = [await party('buyer'), await party('seller')]
  const now = Date.now()
  const datum: Datum = {
    buyer: plutusAddress(buyer.address),
    seller: plutusAddress(seller.address),
    referenceKey: Buffer.from('brume-bank').toString('hex'),
    referenceSignature: randomBytes(16).toString('hex'),
    sellerNonce: randomBytes(10).toString('hex'),
    buyerNonce: randomBytes(10).toString('hex'),
    collateralReturnLovelace: 2_000_000,
    inputHash: randomBytes(32).toString('hex'),
    resultHash: randomBytes(32).toString('hex'),
    payByTime: now - 20 * MIN,
    submitResultTime: now - 10 * MIN,
    unlockTime: now + 6 * 60 * MIN,
    externalDisputeUnlockTime: now + 12 * 60 * MIN,
    sellerCooldownTime: 0,
    buyerCooldownTime: 0,
    state: 'ResultSubmitted',
  }
  const funding = byLovelace(await liveUtxos(buyer.address))[0]
  const built = await buildPlain({
    network: 'preprod', window: txWindow(now), signers: [buyer], inputs: [funding], changeAddress: buyer.address, maxScriptOutputs: 1,
    outputs: [{ address: V1_ADDRESS.preprod, amount: [{ unit: 'lovelace', quantity: '20000000' }], datumCbor: encodeDatum(datum) }],
  })
  const entry = await submitAndConfirm(await addWitness(built, buyer), preprodSubmitter(), 'lock fixture (ResultSubmitted)', now)
  const ref = `${built.txHash}#0`
  log(ref, entry)
  console.log(`escrow ${ref}`)
}

async function dispute(ref: string): Promise<void> {
  const buyer = await party('buyer')
  const escrow = await escrowAt(ref)
  const raw = escrow.output.plutusData as string
  const d = readDatum(raw)
  const now = Date.now()
  const window = txWindow(now)
  if (window.toMs >= d.unlockTime) throw new TxRuleError('too late: SetRefundRequested needs its upper bound strictly before unlock_time')
  const utxos = await liveUtxos(buyer.address)
  const funding = byLovelace(utxos)[0]
  const collateral = pureAda(utxos).find((u) => refOf(u) !== refOf(funding) && lovelace(u) >= 3_000_000n)
  if (!collateral) throw new TxRuleError('the buyer needs a pure-ADA UTxO (>= 3 tADA) besides the funding input, for collateral')
  const built = await buildEscrowSpend({
    network: 'preprod', window, escrow, redeemer: 'SetRefundRequested', signers: [buyer], funding: [funding], collateral,
    continuation: { datumCbor: patchDatum(raw, { sellerCooldownTime: 0, buyerCooldownTime: cooldownFrom(window), state: d.resultHash ? 'Disputed' : 'RefundRequested' }), amount: escrow.output.amount },
    outputs: [], changeAddress: buyer.address,
  })
  const entry = await submitAndConfirm(await addWitness(built, buyer), preprodSubmitter(), 'SetRefundRequested (buyer raises)', now, SCRIPT_HASH)
  log(ref, { ...entry, redeemer: 'SetRefundRequested', role: 'buyer', expected: 'accept' })
  if (entry.status === 'accepted') console.log(`disputed escrow ${built.txHash}#0`)
}

// The split, per asset: the seller gets floor(q × share), the buyer the rest. WithdrawRefund has no fee and no output rule.
function split(amount: Asset[], share: number): { buyer: Asset[]; seller: Asset[] } {
  const permille = BigInt(Math.round(share * 1_000_000))
  const buyer: Asset[] = [], seller: Asset[] = []
  for (const a of amount) {
    const s = (BigInt(a.quantity) * permille) / 1_000_000n
    if (s > 0n) seller.push({ unit: a.unit, quantity: s.toString() })
    if (BigInt(a.quantity) - s > 0n) buyer.push({ unit: a.unit, quantity: (BigInt(a.quantity) - s).toString() })
  }
  return { buyer, seller }
}

// submit(): the first mover (seller) signs leg 1 only here, and only after checking the buyer's leg-2 witness in the CBOR.
async function submitBoth(ref: string, seller: Party, buyerPkh: string, leg1: Built, leg2: Built, leg2ValidToMs: number): Promise<void> {
  if (!hasValidWitness(leg2.cborHex, buyerPkh)) throw new TxRuleError('leg 2 has no valid buyer witness: leg 1 is not signed')
  if (!cstSpends(leg2.cborHex, `${leg1.txHash}#0`)) throw new TxRuleError('leg 2 does not spend leg 1 output 0')
  if (leg2ValidToMs - Date.now() < 10 * MIN) throw new TxRuleError('leg 2 expires in less than 10 minutes: prepare again')
  // Two-UTxO rule, read from both bodies: leg 1 must not spend any of leg 2's funding or collateral inputs.
  const leg1Inputs = new Set(cst.deserializeTx(leg1.cborHex).body().inputs().toCore().map((i) => `${i.txId}#${i.index}`))
  const b2 = cst.deserializeTx(leg2.cborHex).body()
  const leg2Own = [...b2.inputs().toCore(), ...(b2.collateral()?.toCore() ?? [])].map((i) => `${i.txId}#${i.index}`).filter((r) => r !== `${leg1.txHash}#0`)
  const clash = leg2Own.find((r) => leg1Inputs.has(r))
  if (clash) throw new TxRuleError(`leg 1 spends ${clash}, which leg 2 needs: leg 2 would be dead on arrival`)
  const leg1s = await addWitness(leg1, seller)
  const leg2s = await addWitness(leg2, seller)
  // The fully signed exit is written to out/ (gitignored) before the concession goes out: if leg 1's submit turns out
  // ambiguous, the only pre-signed exit is never lost and can be sent as soon as leg 1 is seen on chain.
  mkdirSync(join(ROOT, 'out'), { recursive: true })
  writeFileSync(join(ROOT, 'out', `leg2-${leg2s.txHash}.cbor.hex`), leg2s.cborHex)
  const submitter = preprodSubmitter()
  const at = Date.now()
  const base1 = { step: 'AuthorizeRefund (leg 1)', network: 'preprod' as const, scriptHash: SCRIPT_HASH, txHash: leg1s.txHash, atMs: at, via: submitter.via }
  const base2 = { step: 'WithdrawRefund (leg 2, pre-signed)', network: 'preprod' as const, scriptHash: SCRIPT_HASH, txHash: leg2s.txHash, atMs: at, via: submitter.via }
  const r1 = await submitOnly(leg1s, submitter, base1)
  if (r1) return log(ref, { ...r1, redeemer: 'AuthorizeRefund', role: 'seller', expected: 'accept' })
  const r2 = await submitOnly(leg2s, submitter, base2) // back to back, same node, before leg 1 is in a block
  console.log(`  both legs handed to ${submitter.via} ${Date.now() - at} ms apart`)
  log(ref, { ...(await confirmTx(base1)), redeemer: 'AuthorizeRefund', role: 'seller', expected: 'accept' })
  log(ref, { ...(r2 ?? (await confirmTx(base2))), redeemer: 'WithdrawRefund', role: 'buyer', expected: 'accept' })
  if (r2) return
  // Negative control: the same leg-2 bytes again. Its input is spent, so the ledger must refuse it (phase 1, not the validator).
  const replay = await submitOnly(leg2s, submitter, { ...base2, step: 'replay leg 2 (same bytes)', atMs: Date.now() })
  log(ref, replay ? { ...replay, redeemer: 'WithdrawRefund', role: 'seller', expected: 'refuse' } : { ...base2, step: 'replay leg 2 (same bytes)', status: 'accepted', stage: 'submit', expected: 'refuse', error: 'replay was ACCEPTED: control failed' })
}

// Read from the CBOR the buyer signed, not from the spec that built it.
const cstSpends = (cborHex: string, ref: string): boolean =>
  cst.deserializeTx(cborHex).body().inputs().toCore().some((i) => `${i.txId}#${i.index}` === ref)

async function settle(ref: string, share: number): Promise<void> {
  const [buyer, seller] = [await party('buyer'), await party('seller')]
  const escrow = await escrowAt(ref)
  const raw = escrow.output.plutusData as string
  const d = readDatum(raw)
  if (d.state !== 'Disputed' || !d.resultHash) throw new TxRuleError(`escrow is ${d.state}: the seller-first path starts from Disputed with a result hash`)
  const sellerUtxos = pureAda(await liveUtxos(seller.address))
  if (sellerUtxos.length < 2) throw new TxRuleError('the seller needs two independent pure-ADA UTxOs (leg 1 never spends leg 2\'s)')
  const [s1, s2] = sellerUtxos

  const now = Date.now()
  const w1 = txWindow(now, 150_000, 20 * MIN)
  const leg1Datum = patchDatum(raw, { resultHash: '', sellerCooldownTime: cooldownFrom(w1), buyerCooldownTime: 0, state: 'RefundRequested' })
  const leg1 = await buildEscrowSpend({
    network: 'preprod', window: w1, escrow, redeemer: 'AuthorizeRefund', signers: [seller], funding: [s1], collateral: s1,
    continuation: { datumCbor: leg1Datum, amount: escrow.output.amount }, outputs: [], changeAddress: seller.address,
  })
  console.log(`leg 1 AuthorizeRefund  ${leg1.txHash}  (body frozen, unsigned, valid until ${new Date(w1.toMs).toISOString()})`)

  const leg1Out: UTxO = { input: { txHash: leg1.txHash, outputIndex: 0 }, output: { address: V1_ADDRESS.preprod, amount: escrow.output.amount, plutusData: leg1Datum } }
  const w2 = txWindow(now, 150_000, 60 * MIN)
  const payout = split(escrow.output.amount, share)
  const leg2 = await buildEscrowSpend({
    network: 'preprod', window: w2, escrow: leg1Out, redeemer: 'WithdrawRefund', signers: [buyer], funding: [s2], collateral: s2,
    outputs: [{ address: buyer.address, amount: payout.buyer }, { address: seller.address, amount: payout.seller }],
    changeAddress: seller.address, pending: [leg1Out],
  })
  console.log(`leg 2 WithdrawRefund   ${leg2.txHash}  (spends ${leg1.txHash.slice(0, 12)}…#0, which does not exist yet; valid until ${new Date(w2.toMs).toISOString()})`)
  console.log(`      split: seller ${JSON.stringify(payout.seller)} / buyer ${JSON.stringify(payout.buyer)}`)
  const onChain = await preprodChain().fetchUTxOs(leg1.txHash).catch(() => [])
  if (onChain.length) throw new TxRuleError('leg 1 is already on chain: this is not a pre-signature')

  const leg2b = await addWitness(leg2, buyer)
  console.log(`buyer signed leg 2, hash unchanged ${leg2b.txHash === leg2.txHash}`)
  await submitBoth(ref, seller, buyer.pkh, leg1, leg2b, w2.toMs)
}

if (cmd === 'lock') await lock()
else if (cmd === 'dispute' && refArg) await dispute(refArg)
else if (cmd === 'settle' && refArg) await settle(refArg, Number(values.share))
else throw new Error('usage: spike.ts lock | dispute <ref> | settle <ref> [--share 0.4]')
