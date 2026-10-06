// A5: the seller-first settlement (path B) as the product runs it.
//   prepare(escrowRef, sellerShare) → Proposal   seller's process builds leg 1 (frozen, unsigned) and leg 2 against leg1#0
//   sign('buyer', proposal) → Proposal            the buyer's witness on leg 2 (file drop); witness() merges a CIP-30 one
//   submit(proposal) → TxLogEntry[]               the first mover signs leg 1 ONLY here, after the buyer's leg-2 witness is
//                                                 verified in the CBOR; then leg 1, then leg 2 until it lands or expires
// Files: out/proposals/<hash>_<index>.json is the proposal the parties pass around (never a signed leg 1);
// out/seller/<hash>_<index>.json is the seller's own record (what it built), never shared;
// fixtures/preprod/txlog-<hash>_<index>.json is the run log, one entry per (step, tx), updated pending → confirmed.
import { randomBytes } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import type { Asset, UTxO } from '@meshsdk/core'
import type { Address, Proposal, Role, TxLogEntry, Value } from '../../shared/types.ts'
import { SCRIPT_HASH, V1_ADDRESS } from '../../shared/constants.ts'
import { AmbiguousSubmit, blockfrostGet, LedgerRejection, liveUtxos, msAt, preprodSubmitter, refusalPhase, seenByChain, SubmitTransportError, utxoInfo, type Submitter } from './chain.ts'
import { patchDatum, readDatum } from './datum.ts'
import { buildEscrowSpend } from './escrow.ts'
import { ROOT } from './env.ts'
import { escrowAt, lovelace, MIN, pureAda } from './fixture.ts'
import { cst, mesh } from './mesh.ts'
import { addWitness, confirmTx, cooldownFrom, hasValidWitness, submitOnly, TxRuleError, txWindow, type Built } from './tx.ts'
import { party } from './wallet.ts'

export const LEG1_WINDOW_MS = 20 * MIN // leg 1's upper bound: the buyer has this long to sign leg 2
export const LEG2_AFTER_LEG1_MS = 40 * MIN // leg 2 outlives leg 1 by this, so leg 1 can confirm and leg 2 still land
export const CONFIRM_MARGIN_MS = 10 * MIN

export class SettleError extends Error {} // one readable sentence, shown as-is by the UI

// Every file of a settlement is named from its escrow reference, which can come from the counterparty's proposal file:
// only <64 hex>#<index> is a reference, so no other string can name a path (out/seller/../proposals/... was one).
const REF = /^[0-9a-f]{64}#\d+$/
const slug = (ref: string): string => {
  if (typeof ref !== 'string' || !REF.test(ref)) throw new SettleError(`Not an escrow reference (<64 hex>#<index>): ${String(ref).slice(0, 80)}`)
  return ref.replace('#', '_')
}
export const txLogFile = (ref: string): string => join(ROOT, 'fixtures', 'preprod', `txlog-${slug(ref)}.json`)
export const proposalFile = (ref: string): string => join(ROOT, 'out', 'proposals', `${slug(ref)}.json`)
const sellerRecordFile = (ref: string): string => join(ROOT, 'out', 'seller', `${slug(ref)}.json`)
const writeJson = (file: string, v: unknown): void => {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify(v, null, 2) + '\n')
}
const sgt = (ms: number): string => new Date(ms + 8 * 3_600_000).toISOString().slice(11, 19) + ' SGT'

// One entry per (step, txHash): a pending entry is replaced by its confirmation, never duplicated. A tx in a block is
// final for its entry: nothing without a block (a resubmission refused for its spent inputs, a "sending" marker) replaces
// it. Anything else replaces what was there, so a pending acceptance gives way to every definite outcome: a front-run, an
// expiry alert, a phase-2 failure on chain. Written to a temp file then renamed, so a reader never sees half a log.
export function upsertTxLog(escrowRef: string, entry: TxLogEntry): TxLogEntry {
  const file = txLogFile(escrowRef)
  const log: TxLogEntry[] = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []
  const i = log.findIndex((e) => e.step === entry.step && e.txHash === entry.txHash)
  if (i >= 0 && log[i].block && !entry.block) return log[i]
  if (i >= 0) log[i] = entry
  else log.push(entry)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file + '.tmp', JSON.stringify(log, null, 2) + '\n')
  renameSync(file + '.tmp', file)
  return entry
}

// Settlements in flight (a concession sent, its exit not yet in a block) and the seller UTxOs every prepared proposal
// has reserved. A second prepare never takes a UTxO another proposal's leg 2 needs (D13 across proposals).
const sellerDir = (): string => join(ROOT, 'out', 'seller')
const pendingFile = (ref: string): string => join(sellerDir(), `${slug(ref)}.pending.json`)
export function reservedUtxos(exceptEscrowRef?: string): Set<string> {
  const out = new Set<string>()
  if (!existsSync(sellerDir())) return out
  for (const f of readdirSync(sellerDir())) {
    if (!f.endsWith('.json') || f.endsWith('.pending.json')) continue
    const r = JSON.parse(readFileSync(join(sellerDir(), f), 'utf8')) as SellerRecord
    if (r.escrowRef === exceptEscrowRef) continue
    for (const ref of [...(r.leg2Funding ?? []), ...(r.leg1Funding ?? [])]) out.add(ref)
  }
  return out
}

export const bech32Of = (a: Address): string => {
  if (a.payment.type !== 'key' || (a.stake && a.stake.type !== 'key')) throw new SettleError('Only key-controlled parties can settle.')
  return mesh.serializeAddressObj(mesh.pubKeyAddress(a.payment.hash, a.stake?.hash), 0)
}

const refs = (cborHex: string, part: 'inputs' | 'collateral' | 'referenceInputs'): string[] => {
  const body = cst.deserializeTx(cborHex).body()
  const set = part === 'inputs' ? body.inputs() : part === 'collateral' ? body.collateral() : body.referenceInputs()
  return (set?.toCore() ?? []).map((i) => `${i.txId}#${i.index}`)
}
const ttlMs = (cborHex: string): number => {
  const t = cst.deserializeTx(cborHex).body().ttl()
  if (t === undefined) throw new SettleError('A leg has no upper validity bound.')
  return msAt(Number(t))
}

// The split per asset: the seller gets floor(q × share), the buyer the rest. WithdrawRefund has no fee and no output rule.
export function splitPot(amount: Asset[], share: number): { buyer: Asset[]; seller: Asset[] } {
  if (!(share >= 0 && share <= 1)) throw new SettleError('The seller share must be between 0 and 1.')
  const ppm = BigInt(Math.round(share * 1_000_000))
  const buyer: Asset[] = [], seller: Asset[] = []
  for (const a of amount) {
    const s = (BigInt(a.quantity) * ppm) / 1_000_000n
    if (s > 0n) seller.push({ unit: a.unit, quantity: s.toString() })
    if (BigInt(a.quantity) - s > 0n) buyer.push({ unit: a.unit, quantity: (BigInt(a.quantity) - s).toString() })
  }
  return { buyer, seller }
}
const toValue = (assets: Asset[]): Value => Object.fromEntries(assets.map((a) => [a.unit, a.quantity]))

type SellerRecord = { escrowRef: string; leg1Hash: string; leg2Hash: string; leg2Funding: string[]; leg1Funding?: string[]; buyerPkh?: string /* read from the chain datum at prepare() */; pot?: Asset[] /* the escrow's value on chain at prepare() */; leg1Seller?: string /* CIP-30 witness set, kept here only */ }

export async function prepare(escrowRef: string, sellerShare: number): Promise<Proposal> {
  const release = lock(escrowRef) // never rewrites the seller record while a send of this escrow reads it
  try {
    return await prepareLocked(escrowRef, sellerShare)
  } finally {
    release()
  }
}
async function prepareLocked(escrowRef: string, sellerShare: number): Promise<Proposal> {
  const seller = await party('seller')
  const escrow = await escrowAt(escrowRef)
  const raw = escrow.output.plutusData as string
  const d = readDatum(raw)
  if (d.state !== 'Disputed' || !d.resultHash) throw new SettleError(`This escrow is ${d.state}: the seller-first exit starts from Disputed with a result.`)
  if (d.seller.payment.hash !== seller.pkh) throw new SettleError('This seller key is not the escrow\'s seller.')
  if (existsSync(pendingFile(escrowRef))) {
    const pending = JSON.parse(readFileSync(pendingFile(escrowRef), 'utf8')) as { leg1: string; leg2ValidToMs: number }
    if (Date.now() <= pending.leg2ValidToMs) throw new SettleError(`A concession for this escrow is already in flight: pnpm sign --resend ${escrowRef}`)
    // Both legs have expired. A leg 1 that never reached a block exposed nothing: the record is cleared and the escrow,
    // still Disputed, can be prepared again. One in a block is a concession whose exit did not land: never cleared.
    if (await blockfrostGet(`/txs/${pending.leg1}`)) throw new SettleError('An earlier concession of this escrow is on chain and its exit expired unlanded: see its log.')
    rmSync(pendingFile(escrowRef), { force: true })
  }
  const reserved = reservedUtxos(escrowRef)
  const sellerUtxos = pureAda(await liveUtxos(seller.address)).filter((u) => lovelace(u) >= 5_000_000n && !reserved.has(`${u.input.txHash}#${u.input.outputIndex}`))
  if (sellerUtxos.length < 2) throw new SettleError('The seller needs two separate pure-ADA UTxOs of at least 5 tADA: leg 1 never spends leg 2\'s.')
  const [s1, s2] = sellerUtxos

  const now = Date.now()
  const w1 = txWindow(now, 150_000, LEG1_WINDOW_MS)
  const leg1Datum = patchDatum(raw, { resultHash: '', sellerCooldownTime: cooldownFrom(w1), buyerCooldownTime: 0, state: 'RefundRequested' })
  const leg1 = await buildEscrowSpend({
    network: 'preprod', window: w1, escrow, redeemer: 'AuthorizeRefund', signers: [seller], funding: [s1], collateral: s1,
    continuation: { datumCbor: leg1Datum, amount: escrow.output.amount }, outputs: [], changeAddress: seller.address,
  })
  const leg1Out: UTxO = { input: { txHash: leg1.txHash, outputIndex: 0 }, output: { address: V1_ADDRESS.preprod, amount: escrow.output.amount, plutusData: leg1Datum } }
  const w2 = txWindow(now, 150_000, LEG1_WINDOW_MS + LEG2_AFTER_LEG1_MS)
  const payout = splitPot(escrow.output.amount, sellerShare)
  const buyerAddress = bech32Of(d.buyer)
  let leg2: Built
  try {
    leg2 = await buildEscrowSpend({
      network: 'preprod', window: w2, escrow: leg1Out, redeemer: 'WithdrawRefund', signers: [{ pkh: d.buyer.payment.hash }], funding: [s2], collateral: s2,
      outputs: [...(payout.buyer.length ? [{ address: buyerAddress, amount: payout.buyer }] : []), ...(payout.seller.length ? [{ address: seller.address, amount: payout.seller }] : [])],
      changeAddress: seller.address, pending: [leg1Out],
    })
  } catch (error: unknown) {
    if (error instanceof TxRuleError && /under its .* minimum/.test(error.message)) throw new SettleError('This split leaves one side under the ledger\'s minimum output: choose a share further from 0 or 1.')
    throw error
  }
  const proposal: Proposal = {
    escrowRef, network: 'preprod', path: 'B', sellerShare,
    payout: { buyer: toValue(payout.buyer), seller: toValue(payout.seller), fee: {} },
    leg1: { redeemer: 'AuthorizeRefund', cborHex: leg1.cborHex, txHash: leg1.txHash, validFromMs: w1.fromMs, validToMs: w1.toMs, inputs: refs(leg1.cborHex, 'inputs') },
    leg2: { redeemer: 'WithdrawRefund', cborHex: leg2.cborHex, txHash: leg2.txHash, validFromMs: w2.fromMs, validToMs: w2.toMs, inputs: refs(leg2.cborHex, 'inputs') },
    signedBy: [],
  }
  // A new prepare replaces the previous proposal for this escrow (new hashes, signatures reset).
  writeJson(sellerRecordFile(escrowRef), { escrowRef, leg1Hash: leg1.txHash, leg2Hash: leg2.txHash, leg2Funding: [`${s2.input.txHash}#${s2.input.outputIndex}`], leg1Funding: [`${s1.input.txHash}#${s1.input.outputIndex}`], buyerPkh: d.buyer.payment.hash, pot: escrow.output.amount } satisfies SellerRecord)
  writeJson(proposalFile(escrowRef), proposal)
  return proposal
}

// File-drop signature. Only the buyer signs here; the seller's signature is part of submit(). The seller share is the
// seller's own field: with expectShare (the share the buyer agreed to), a proposal at any other share is refused.
export async function sign(role: Role, proposal: Proposal, expectShare?: number): Promise<Proposal> {
  if (role !== 'buyer') throw new SettleError('The seller signs leg 1 only inside submit, after checking the buyer\'s signature on leg 2.')
  if (!proposal.leg2) throw new SettleError('This proposal has no exit leg to sign.')
  if (expectShare !== undefined && proposal.sellerShare !== expectShare) throw new SettleError(`This proposal gives the seller ${proposal.sellerShare}, not the agreed ${expectShare}: not signing it.`)
  if (Date.now() > (proposal.leg1?.validToMs ?? 0)) throw new SettleError(`Leg 1 expired at ${sgt(proposal.leg1?.validToMs ?? 0)}: prepare again.`)
  const buyer = await party('buyer')
  if (buyer.pkh !== proposalPkh(proposal, 'buyer')) throw new SettleError('This key is not the buyer\'s for leg 2.')
  await checkForBuyer(proposal)
  const signed = await addWitness({ cborHex: proposal.leg2.cborHex, txHash: proposal.leg2.txHash }, buyer)
  return { ...proposal, leg2: { ...proposal.leg2, cborHex: signed.cborHex }, signedBy: [...new Set<Role>([...proposal.signedBy, 'buyer'])] }
}

// CIP-30 path: merges a raw witness set (api.signTx(cbor, true)) into a leg. Idempotent; never stores a signed leg 1 in
// the returned proposal (a seller leg-1 witness is kept in the seller's own record and used by submit()).
export function witness(proposal: Proposal, role: Role, leg: 1 | 2, witnessSetCbor: string): Proposal {
  const target = leg === 1 ? proposal.leg1 : proposal.leg2
  if (!target) throw new SettleError(`This proposal has no leg ${leg}.`)
  if (Date.now() > (proposal.leg1?.validToMs ?? 0)) throw new SettleError(`Leg 1 expired at ${sgt(proposal.leg1?.validToMs ?? 0)}: prepare again.`)
  const ws = cst.Serialization.TransactionWitnessSet.fromCbor(cst.HexBlob(witnessSetCbor))
  const tx = cst.deserializeTx(target.cborHex)
  const expected = proposalPkh(proposal, role)
  const all = [...(ws.vkeys()?.values() ?? [])]
  if (all.length === 0) throw new SettleError('The wallet returned no signature.')
  // A wallet may add witnesses for other keys it holds (a stake key): only the expected party's are kept.
  const added = all.filter((w) => cst.blake2b(28).update(Buffer.from(w.vkey(), 'hex')).digest('hex') === expected)
  if (added.length === 0) throw new SettleError(`This key is not the ${role}'s for leg ${leg}.`)
  const merged = cst.Serialization.TransactionWitnessSet.fromCbor(tx.witnessSet().toCbor())
  const have = new Map([...(merged.vkeys()?.values() ?? [])].map((w) => [w.vkey(), w]))
  for (const w of added) have.set(w.vkey(), w) // the same witness twice is a no-op
  merged.setVkeys(cst.Serialization.CborSet.fromCore([...have.values()].map((w) => w.toCore()), cst.Serialization.VkeyWitness.fromCore))
  const cborHex = new cst.Transaction(tx.body(), merged, tx.auxiliaryData()).toCbor()
  if (mesh.resolveTxHash(cborHex) !== target.txHash) throw new SettleError('Signature does not match this leg\'s body.')
  if (!hasValidWitness(cborHex, expected)) throw new SettleError('Signature does not match this leg\'s body.')
  if (leg === 1) {
    if (role !== 'seller') throw new SettleError('Only the seller signs leg 1.')
    if (!proposal.leg2 || !hasValidWitness(proposal.leg2.cborHex, proposalPkh(proposal, 'buyer'))) throw new SettleError('Leg 2 must be signed by the buyer before the seller signs leg 1.')
    const record = readRecord(proposal.escrowRef)
    writeJson(sellerRecordFile(proposal.escrowRef), { ...record, leg1Seller: witnessSetCbor })
    return { ...proposal, signedBy: [...new Set<Role>([...proposal.signedBy, 'seller'])] }
  }
  return { ...proposal, leg2: { ...target, cborHex }, signedBy: [...new Set<Role>([...proposal.signedBy, role])] }
}

// The parties named in THIS proposal's leg-1 continuation datum, read on every call: never cached, since a proposal is
// untrusted input and a cache keyed by escrow would let one forged proposal decide whose witness a real one accepts.
// The seller side does not rely on it for the buyer: submit() checks against the buyer read from the chain at prepare().
function proposalPkh(proposal: Proposal, role: Role): string {
  if (role === 'admin') throw new SettleError('The admin set has no part in a settlement.')
  const leg1 = proposal.leg1
  if (!leg1) throw new SettleError('This proposal has no leg 1.')
  const datum = cst.deserializeTx(leg1.cborHex).body().outputs()[0]?.datum()?.asInlineData()?.toCbor()
  if (!datum) throw new SettleError('Leg 1 carries no escrow datum.')
  const d = readDatum(datum)
  return role === 'buyer' ? d.buyer.payment.hash : d.seller.payment.hash
}

function readRecord(escrowRef: string): SellerRecord {
  const file = sellerRecordFile(escrowRef)
  if (!existsSync(file)) throw new SettleError('This proposal was not prepared by this seller: prepare it here first.')
  return JSON.parse(readFileSync(file, 'utf8')) as SellerRecord
}

// Every check that must hold before the concession goes out, read from the two bodies and the chain.
export async function checkBeforeConcession(proposal: Proposal, record: SellerRecord, sellerAddress: string, nowMs = Date.now()): Promise<void> {
  const { leg1, leg2 } = proposal
  if (!leg1 || !leg2) throw new SettleError('This proposal is missing a leg.')
  if (leg1.txHash !== record.leg1Hash || leg2.txHash !== record.leg2Hash) throw new SettleError('These legs are not the ones this seller prepared: prepare again.')
  if (mesh.resolveTxHash(leg1.cborHex) !== record.leg1Hash || mesh.resolveTxHash(leg2.cborHex) !== record.leg2Hash) throw new SettleError('A leg\'s body was changed after it was prepared.')
  if (!hasValidWitness(leg2.cborHex, record.buyerPkh ?? proposalPkh(proposal, 'buyer'))) throw new SettleError('Leg 2 must be signed by the buyer before the seller signs leg 1.')
  if (!refs(leg2.cborHex, 'inputs').includes(`${leg1.txHash}#0`)) throw new SettleError('Leg 2 does not spend leg 1\'s escrow output.')
  // Leg 2 was evaluated against an assumed leg-1 output: leg 1's real output 0 must be that, the whole pot (read from the
  // chain at prepare) kept at the script.
  const out0 = cst.deserializeTx(leg1.cborHex).body().outputs()[0]
  if (out0?.address().toBech32() !== V1_ADDRESS.preprod || (record.pot && !sameAssets(valueOf(out0), record.pot))) throw new SettleError('Leg 1 does not keep the whole pot at the escrow: prepare again.')
  const t1 = ttlMs(leg1.cborHex), t2 = ttlMs(leg2.cborHex)
  if (t1 - nowMs < MIN) throw new SettleError(`Leg 1 expired at ${sgt(t1)}: prepare again.`)
  if (t2 - t1 < CONFIRM_MARGIN_MS) throw new SettleError('Leg 2 must stay valid well after leg 1: prepare again.')
  const leg1In = new Set(refs(leg1.cborHex, 'inputs'))
  const leg2Own = [...refs(leg2.cborHex, 'inputs'), ...refs(leg2.cborHex, 'collateral'), ...refs(leg2.cborHex, 'referenceInputs')].filter((r) => r !== `${leg1.txHash}#0`)
  if (leg2Own.some((r) => leg1In.has(r))) throw new SettleError('Leg 1 spends an input leg 2 needs: prepare again.')
  const info = await utxoInfo([...new Set([...leg2Own, ...leg1In])])
  for (const r of leg2Own) {
    const i = info.get(r)
    if (!i || i.spent) throw new SettleError('An input of leg 2 is already spent: prepare again.')
    if (i.address !== sellerAddress) throw new SettleError('Leg 2 must be funded by the seller alone.')
  }
  for (const r of leg1In) if (!info.get(r) || info.get(r)?.spent) throw new SettleError('An input of leg 1 is already spent: prepare again.')
}

// A body output's value as assets, and two asset lists compared unit by unit.
function valueOf(o: ReturnType<ReturnType<ReturnType<typeof cst.deserializeTx>['body']>['outputs']>[number]): Asset[] {
  const v = o.amount().toCore()
  const out: Asset[] = [{ unit: 'lovelace', quantity: v.coins.toString() }]
  for (const [unit, q] of v.assets ?? new Map()) out.push({ unit: String(unit), quantity: q.toString() })
  return out
}
const assetMap = (a: Asset[]): Map<string, bigint> => {
  const m = new Map<string, bigint>()
  for (const x of a) m.set(x.unit, (m.get(x.unit) ?? 0n) + BigInt(x.quantity))
  return m
}
function sameAssets(a: Asset[], b: Asset[]): boolean {
  const [x, y] = [assetMap(a), assetMap(b)]
  return [...new Set([...x.keys(), ...y.keys()])].every((u) => (x.get(u) ?? 0n) === (y.get(u) ?? 0n))
}

// What the buyer signs (file drop: sign(); the agent calls it before offering a CIP-30 signature). A proposal is the
// seller's file: only the two bodies count, read against the chain. Leg 1 must be the concession of THIS escrow as the
// chain holds it (state RefundRequested, the whole pot kept at the script); leg 2 must spend leg 1's output 0 and nothing
// under the buyer's payment key, and pay the buyer's key at least the agreed part of every asset, the part the share
// gives on the pot read from the chain. Leg 2's other inputs, collateral and reference inputs are the seller's own key
// UTxOs (a second script input could be another escrow the buyer's signature unlocks), and it mints, withdraws and
// certifies nothing.
export async function checkForBuyer(proposal: Proposal): Promise<void> {
  const { leg1, leg2 } = proposal
  if (!leg1 || !leg2) throw new SettleError('This proposal is missing a leg.')
  const leg1Hash = mesh.resolveTxHash(leg1.cborHex)
  if (leg1Hash !== leg1.txHash || mesh.resolveTxHash(leg2.cborHex) !== leg2.txHash) throw new SettleError('A leg\'s hash does not match its body.')
  const escrow = await escrowAt(proposal.escrowRef)
  const d = readDatum(escrow.output.plutusData as string)
  if (d.state !== 'Disputed') throw new SettleError(`This escrow is ${d.state}, not Disputed: nothing to sign.`)
  const buyerKey = d.buyer.payment.hash
  const body1 = cst.deserializeTx(leg1.cborHex).body()
  if (!refs(leg1.cborHex, 'inputs').includes(proposal.escrowRef)) throw new SettleError('Leg 1 does not spend this escrow.')
  const out0 = body1.outputs()[0]
  const cont = out0?.datum()?.asInlineData()?.toCbor()
  if (!out0 || !cont || out0.address().toBech32() !== V1_ADDRESS.preprod || !sameAssets(valueOf(out0), escrow.output.amount)) throw new SettleError('Leg 1 does not keep the whole pot at the escrow.')
  const c = readDatum(cont)
  if (c.state !== 'RefundRequested' || c.resultHash !== '' || c.buyer.payment.hash !== buyerKey || c.seller.payment.hash !== d.seller.payment.hash) throw new SettleError('Leg 1 is not this escrow\'s concession.')
  if (!refs(leg2.cborHex, 'inputs').includes(`${leg1Hash}#0`)) throw new SettleError('Leg 2 does not spend leg 1\'s escrow output.')
  const body2 = cst.deserializeTx(leg2.cborHex).body()
  if ((body2.mint()?.size ?? 0) > 0 || (body2.withdrawals()?.size ?? 0) > 0 || (body2.certs()?.size() ?? 0) > 0) throw new SettleError('Leg 2 mints, withdraws or carries a certificate: not signing it.')
  const own = [...refs(leg2.cborHex, 'inputs'), ...refs(leg2.cborHex, 'collateral'), ...refs(leg2.cborHex, 'referenceInputs')].filter((r) => r !== `${leg1Hash}#0`)
  const sellerKey = d.seller.payment.hash
  const info = await utxoInfo(own)
  for (const r of own) {
    const i = info.get(r)
    if (!i) throw new SettleError('An input of leg 2 cannot be read on chain: not signing it.')
    let key: string | undefined
    try {
      key = mesh.deserializeAddress(i.address).pubKeyHash
    } catch {
      key = undefined
    }
    if (key === buyerKey) throw new SettleError('Leg 2 spends one of the buyer\'s own UTxOs: not signing it.')
    if (!key || key !== sellerKey) throw new SettleError('Leg 2 spends an input that is not the seller\'s own: not signing it.')
  }
  const want = assetMap(splitPot(escrow.output.amount, proposal.sellerShare).buyer)
  const stated = assetMap(Object.entries(proposal.payout.buyer).map(([unit, quantity]) => ({ unit, quantity })))
  if (![...new Set([...want.keys(), ...stated.keys()])].every((u) => (want.get(u) ?? 0n) === (stated.get(u) ?? 0n))) throw new SettleError('The stated payout is not the share applied to the pot.')
  const paid = new Map<string, bigint>()
  for (const o of cst.deserializeTx(leg2.cborHex).body().outputs()) {
    let key: string | undefined
    try {
      key = mesh.deserializeAddress(o.address().toBech32()).pubKeyHash
    } catch {
      key = undefined
    }
    if (key === buyerKey) for (const a of valueOf(o)) paid.set(a.unit, (paid.get(a.unit) ?? 0n) + BigInt(a.quantity))
  }
  for (const [unit, q] of want) if ((paid.get(unit) ?? 0n) < q) throw new SettleError(`Leg 2 pays the buyer less than the agreed ${q} of ${unit === 'lovelace' ? 'lovelace' : unit.slice(0, 12) + '…'}: not signing it.`)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const submitters = (): Submitter[] => {
  const primary = preprodSubmitter()
  return [primary, preprodSubmitter(primary.via === 'koios' ? 'blockfrost' : 'koios')]
}
const LEG2_STEP = 'WithdrawRefund (leg 2, pre-signed)'
const leg2Base = (leg2Hash: string, via?: TxLogEntry['via']): Omit<TxLogEntry, 'status' | 'stage'> => ({
  step: LEG2_STEP, network: 'preprod', scriptHash: SCRIPT_HASH, txHash: leg2Hash, atMs: Date.now(), via, redeemer: 'WithdrawRefund', role: 'buyer', expected: 'accept',
})

// Who spent leg1#0, if anyone yet: leg 2 itself (success), another tx (a front-run), or nobody known so far.
async function leg1Spender(leg1Hash: string): Promise<'unspent' | 'unknown' | string> {
  const out0 = (await utxoInfo([`${leg1Hash}#0`])).get(`${leg1Hash}#0`)
  if (!out0) return 'unknown'
  if (!out0.spent) return 'unspent'
  const utxos = await blockfrostGet<{ outputs: { output_index: number; consumed_by_tx?: string | null }[] }>(`/txs/${leg1Hash}/utxos`)
  return utxos?.outputs.find((o) => o.output_index === 0)?.consumed_by_tx ?? 'unknown'
}

// One pass of sending leg 2 until an endpoint takes it. Every read here can fail: a failure is a hole, retried, never
// a reason to stop driving the exit once the concession may be live. carriedBy: the endpoint that took the bytes (not
// one that later refused a resubmission), so the read-back runs on the other one.
async function driveLeg2(escrowRef: string, leg1Hash: string, leg2: Built, validToMs: number): Promise<{ entry: TxLogEntry; carriedBy?: Submitter['via'] }> {
  const subs = submitters()
  let last = ''
  for (let attempt = 0; Date.now() < validToMs - MIN; attempt++) {
    const s = subs[attempt % subs.length]
    const base = { ...leg2Base(leg2.txHash, s.via), atMs: Date.now() }
    try {
      const r = await submitOnly(leg2, s, base)
      if (!r) return { entry: { ...base, status: 'accepted', stage: 'submit', error: 'submitted, not in a block yet: pending' }, carriedBy: s.via }
      const text = r.refusal?.ledgerError ?? ''
      if (await blockfrostGet(`/txs/${leg2.txHash}`)) return { entry: { ...base, status: 'accepted', stage: 'submit', error: 'already in a block' } }
      const spender = await leg1Spender(leg1Hash)
      if (spender === leg2.txHash) return { entry: { ...base, status: 'accepted', stage: 'submit', error: 'leg 1 output spent by leg 2: pending its block' } }
      if (spender !== 'unspent' && spender !== 'unknown') {
        const frontRun: TxLogEntry = { ...r, error: `FRONT-RUN: leg 1's escrow output was spent by ${spender}, not by leg 2.` }
        upsertTxLog(escrowRef, frontRun)
        return { entry: frontRun }
      }
      if (/BadInputsUTxO|All inputs are spent|UnknownInput/i.test(text)) {
        last = 'leg 1 output not visible on that node yet'
      } else {
        // A refusal of a leg that evaluated clean twice, while leg 1 may be live: an alert, logged; still retried until expiry.
        last = text.slice(0, 300)
        upsertTxLog(escrowRef, { ...base, status: 'accepted', stage: 'submit', error: `retrying; ALERT: leg 2 refused once: ${last}` })
      }
    } catch (error: unknown) {
      // Every failure here is a hole, including an endpoint answering 200 with another hash (TxRuleError from
      // submitOnly): the bytes may be live, so leg 2 keeps being driven.
      last = error instanceof Error ? error.message.slice(0, 200) : String(error)
    }
    await sleep(5_000)
  }
  return { entry: upsertTxLog(escrowRef, { ...leg2Base(leg2.txHash), status: 'refused', stage: 'submit', error: `ALERT: leg 2 not accepted before it expired (${sgt(validToMs)}); last: ${last}` }) }
}

// Leg 2 is resent until it is in a block or expires: a mempool acceptance can still be dropped.
async function landLeg2(escrowRef: string, leg1Hash: string, leg2: Built, validToMs: number): Promise<TxLogEntry> {
  upsertTxLog(escrowRef, { ...leg2Base(leg2.txHash), status: 'accepted', stage: 'submit', error: 'sending; retried until it lands or expires' })
  let carrier: Submitter['via'] | undefined
  while (Date.now() < validToMs - MIN) {
    const { entry: r, carriedBy } = await driveLeg2(escrowRef, leg1Hash, leg2, validToMs)
    if (r.status !== 'accepted') return r
    carrier ??= carriedBy
    upsertTxLog(escrowRef, { ...r, via: carrier ?? r.via })
    const c = await confirmTx({ ...leg2Base(leg2.txHash, carrier ?? r.via), atMs: r.atMs }, 120_000)
    if (c.block) return upsertTxLog(escrowRef, { ...c, redeemer: 'WithdrawRefund', role: 'buyer', expected: 'accept' })
  }
  return upsertTxLog(escrowRef, { ...leg2Base(leg2.txHash), status: 'refused', stage: 'submit', error: `ALERT: leg 2 not in a block before it expired (${sgt(validToMs)})` })
}

// The replay control: the same leg-2 bytes once more, after leg 2 is in a block. Only a first-hand ledger answer counts.
async function replayControl(escrowRef: string, leg2: Built): Promise<TxLogEntry | null> {
  const s = preprodSubmitter()
  const base = { step: 'replay leg 2 (same bytes)', network: 'preprod' as const, scriptHash: SCRIPT_HASH, txHash: leg2.txHash, atMs: Date.now(), via: s.via, redeemer: 'WithdrawRefund' as const, role: 'seller' as const, expected: 'refuse' as const }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await s.submitTx(leg2.cborHex)
      return upsertTxLog(escrowRef, { ...base, status: 'accepted', stage: 'submit', error: 'the endpoint accepted the replay: control FAILED' })
    } catch (error: unknown) {
      if (error instanceof LedgerRejection) {
        return upsertTxLog(escrowRef, { ...base, status: 'refused', stage: 'submit', refusal: { phase: refusalPhase(error.message), ledgerError: error.message }, error: error.message.slice(0, 600) })
      }
      await sleep(3_000) // a transport hole: retried, never logged as the control's outcome
    }
  }
  return null
}

// The parties, from the continuation datum of the leg 1 we built (its output 0, the one leg 2 spends).
function partiesOf(leg1Cbor: string): { buyer: string; seller: string } {
  const datum = cst.deserializeTx(leg1Cbor).body().outputs()[0]?.datum()?.asInlineData()?.toCbor()
  if (!datum) throw new SettleError('leg 1 output 0 carries no inline datum')
  const d = readDatum(datum)
  return { buyer: bech32Of(d.buyer), seller: bech32Of(d.seller) }
}

// The confirmed leg 2 gets its balances read back from the second indexer, retried every 5 s for 60 s while that indexer
// catches up. A failed read is a hole: counted and printed, never a balance. With no read-back the entry stays as it
// was (confirmed, no readback): the settlement stands, and `node src/preprod/readback.ts <ref>` backfills it later.
async function withReadback(escrowRef: string, confirmed: TxLogEntry, parties: () => Promise<{ buyer: string; seller: string }>): Promise<TxLogEntry> {
  const { readBack } = await import('./readback.ts')
  let holes = 0
  let last = ''
  for (let i = 0; i < 12; i++) {
    try {
      const { buyer, seller } = await parties()
      const rb = await readBack(confirmed.txHash, confirmed.via, buyer, seller)
      if (rb) return upsertTxLog(escrowRef, { ...confirmed, readback: rb })
    } catch (error: unknown) {
      holes++
      last = error instanceof Error ? error.message.slice(0, 160) : String(error)
    }
    await sleep(5_000)
  }
  console.error(`read-back of leg 2 ${confirmed.txHash.slice(0, 12)}… not available after 60 s (${holes} holes${last ? `, last: ${last}` : ''}); backfill: node src/preprod/readback.ts ${escrowRef}`)
  return confirmed
}

// One settlement per escrow at a time: an exclusive lock file, released on every exit path, taken by prepare() and by
// every send. The lock names its owner (pid, host, a random id) and the owner refreshes its time every 20 s while it
// holds it. A lock is stale when its process is gone (same host) or when it has not been refreshed for 2 min (any
// host; a pid can be reused on Windows, so the refresh, not the pid, decides): an agent that died mid-send blocks its
// escrow for 2 min at most, well inside leg 2's window, and --resend can then take over.
export const LOCK_HEARTBEAT_MS = 20_000
export const LOCK_STALE_MS = 2 * MIN
type LockOwner = { pid: number; host: string; atMs: number; id?: string }
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0) // signal 0: existence check only
    return true
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'EPERM' // exists, not ours to signal
  }
}
export function isStale(owner: LockOwner | null, nowMs = Date.now(), host = hostname()): boolean {
  if (!owner || typeof owner.pid !== 'number' || typeof owner.atMs !== 'number') return true // unreadable: no owner to wait for
  if (nowMs - owner.atMs > LOCK_STALE_MS) return true
  return owner.host === host && !alive(owner.pid)
}
const readOwner = (file: string): LockOwner | null => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as LockOwner
  } catch {
    return null
  }
}
export function lock(escrowRef: string): () => void {
  mkdirSync(sellerDir(), { recursive: true })
  const file = join(sellerDir(), `${slug(escrowRef)}.lock`)
  const me: LockOwner = { pid: process.pid, host: hostname(), atMs: Date.now(), id: randomBytes(8).toString('hex') }
  const mine = (o: LockOwner | null): boolean => !!o && o.id === me.id
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx')
      writeFileSync(fd, JSON.stringify(me))
      closeSync(fd)
      // The refresh: rewritten whole (temp file, then rename) and only while the lock is still ours.
      const beat = setInterval(() => {
        if (!mine(readOwner(file))) return clearInterval(beat)
        writeFileSync(`${file}.${me.id}`, JSON.stringify({ ...me, atMs: Date.now() }))
        renameSync(`${file}.${me.id}`, file)
      }, LOCK_HEARTBEAT_MS)
      beat.unref()
      // Released only by its owner: never removes a lock another process has since taken over.
      return () => {
        clearInterval(beat)
        if (mine(readOwner(file))) rmSync(file, { force: true })
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const owner = readOwner(file)
      if (attempt === 0 && isStale(owner)) {
        // Taken over by moving it aside: of two processes racing, one rename finds no file and that process retries the
        // create, which then meets the winner's fresh lock. What was moved must be the stale lock seen above; a fresh lock
        // created in between is put back.
        const aside = `${file}.${me.id}.stale`
        try {
          renameSync(file, aside)
        } catch {
          continue
        }
        const moved = readOwner(aside)
        if (owner && moved && moved.id !== owner.id && !isStale(moved)) {
          renameSync(aside, file)
          throw new SettleError(`A settlement of this escrow is already running (process ${moved.pid} on ${moved.host}, since ${sgt(moved.atMs)}): wait for it to finish.`)
        }
        rmSync(aside, { force: true })
        continue
      }
      throw new SettleError(`A settlement of this escrow is already running${owner ? ` (process ${owner.pid} on ${owner.host}, since ${sgt(owner.atMs)})` : ''}: wait for it to finish.`)
    }
  }
  throw new SettleError('A settlement of this escrow is already running: wait for it to finish.')
}

export async function submit(proposal: Proposal, opts: { replay?: boolean } = {}): Promise<TxLogEntry[]> {
  const release = lock(proposal.escrowRef)
  try {
    if (existsSync(pendingFile(proposal.escrowRef))) throw new SettleError(`A concession for this escrow is already in flight: pnpm sign --resend ${proposal.escrowRef}`)
    const seller = await party('seller')
    const record = readRecord(proposal.escrowRef)
    await checkBeforeConcession(proposal, record, seller.address)
    const { leg1, leg2 } = proposal as Required<Proposal>
    // Leg 1 must not spend what another in-flight proposal's leg 2 needs (D13 across proposals).
    const reserved = reservedUtxos(proposal.escrowRef)
    if (refs(leg1.cborHex, 'inputs').some((r) => reserved.has(r))) throw new SettleError('Leg 1 would spend an input another proposal\'s exit needs: prepare again.')

    // The seller's leg-1 signature: a CIP-30 witness kept in the seller's record, or the seller key signing now.
    const leg1Built: Built = record.leg1Seller
      ? { txHash: leg1.txHash, cborHex: mergeSeller(leg1, record.leg1Seller) }
      : await addWitness({ cborHex: leg1.cborHex, txHash: leg1.txHash }, seller)
    if (!hasValidWitness(leg1Built.cborHex, seller.pkh)) throw new SettleError("This key is not the seller's for leg 1.")
    const leg2Built = hasValidWitness(leg2.cborHex, seller.pkh) ? { cborHex: leg2.cborHex, txHash: leg2.txHash } : await addWitness({ cborHex: leg2.cborHex, txHash: leg2.txHash }, seller)
    const leg2Ttl = ttlMs(leg2.cborHex)
    // The complete exit is on disk before the concession goes out: never lost, and `--resend` can send it later.
    mkdirSync(join(ROOT, 'out'), { recursive: true })
    writeFileSync(join(ROOT, 'out', `leg2-${leg2Built.txHash}.cbor.hex`), leg2Built.cborHex)
    writeJson(pendingFile(proposal.escrowRef), { escrowRef: proposal.escrowRef, leg1: leg1.txHash, leg2: leg2.txHash, leg2ValidToMs: leg2Ttl })

    const [primary, other] = submitters()
    const base1 = { step: 'AuthorizeRefund (leg 1)', network: 'preprod' as const, scriptHash: SCRIPT_HASH, txHash: leg1.txHash, atMs: Date.now(), via: primary.via, redeemer: 'AuthorizeRefund' as const, role: 'seller' as const, expected: 'accept' as const }
    let r1: TxLogEntry | null = null
    let possiblyLive = ''
    try {
      r1 = await submitOnly(leg1Built, primary, base1)
    } catch (error: unknown) {
      if (error instanceof SubmitTransportError) {
        // Certainly not delivered: one more try on the other provider, then a plain "not sent".
        try {
          r1 = await submitOnly(leg1Built, other, { ...base1, via: other.via })
        } catch (again: unknown) {
          if (again instanceof SubmitTransportError) {
            rmSync(pendingFile(proposal.escrowRef), { force: true })
            return [upsertTxLog(proposal.escrowRef, { ...base1, status: 'refused', stage: 'submit', error: `not sent: ${again.message.slice(0, 200)}` })]
          }
          // Anything but a certain non-delivery may have reached a node: from here the concession is treated as live.
          possiblyLive = again instanceof Error ? again.message : String(again)
        }
      } else {
        // An ambiguous submit, a read hole while checking it, or an endpoint answering 200 with another hash: the
        // bytes may be live, so leg 2 is driven; never a thrown error that leaves the exit unsent.
        possiblyLive = error instanceof Error ? error.message : String(error)
      }
    }
    if (r1) {
      // "Inputs spent" can mean our own leg 1 is already in a mempool (a retried request): ask the chain before calling it
      // a refusal. A read hole there is no answer: the concession is treated as possibly live.
      let ownInMempool = false
      if (/BadInputsUTxO|All inputs are spent/i.test(r1.refusal?.ledgerError ?? '')) {
        try {
          ownInMempool = await seenByChain(leg1.txHash, 30_000)
        } catch (error: unknown) {
          ownInMempool = true
          possiblyLive = `inputs spent and the chain could not be read: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`
        }
      }
      if (ownInMempool) {
        r1 = null
      } else {
        rmSync(pendingFile(proposal.escrowRef), { force: true })
        return [upsertTxLog(proposal.escrowRef, r1)] // a definite refusal: the escrow is untouched and nothing is exposed
      }
    }
    upsertTxLog(proposal.escrowRef, { ...base1, status: 'accepted', stage: 'submit', error: possiblyLive ? `possibly live, not seen yet: ${possiblyLive.slice(0, 160)}` : 'submitted, not in a block yet: pending' })

    // Leg 1's confirmation and leg 2's landing run side by side, so the UI sees leg 1 confirmed while leg 2 is still driven.
    const [c1, c2] = await Promise.all([
      confirmTx(base1, LEG2_AFTER_LEG1_MS).then((c) => upsertTxLog(proposal.escrowRef, c)),
      landLeg2(proposal.escrowRef, leg1.txHash, leg2Built, leg2Ttl),
    ])
    const out = [c1, c2]
    if (c2.status === 'accepted' && c2.block) {
      rmSync(pendingFile(proposal.escrowRef), { force: true }) // settled: its reserved UTxOs are free again
      out[1] = await withReadback(proposal.escrowRef, c2, async () => partiesOf(leg1.cborHex))
      if (opts.replay !== false) {
        const rc = await replayControl(proposal.escrowRef, leg2Built)
        if (rc) out.push(rc)
      }
    }
    return out
  } finally {
    release()
  }
}

// A seller leg-1 witness that came through CIP-30, merged into the unsigned leg 1 inside submit() only.
function mergeSeller(leg1: NonNullable<Proposal['leg1']>, witnessSetCbor: string): string {
  const tx = cst.deserializeTx(leg1.cborHex)
  const ws = cst.Serialization.TransactionWitnessSet.fromCbor(cst.HexBlob(witnessSetCbor))
  const merged = cst.Serialization.TransactionWitnessSet.fromCbor(tx.witnessSet().toCbor())
  merged.setVkeys(cst.Serialization.CborSet.fromCore([...(ws.vkeys()?.values() ?? [])].map((w) => w.toCore()), cst.Serialization.VkeyWitness.fromCore))
  const cborHex = new cst.Transaction(tx.body(), merged, tx.auxiliaryData()).toCbor()
  if (mesh.resolveTxHash(cborHex) !== leg1.txHash) throw new SettleError('Signature does not match this leg\'s body.')
  return cborHex
}

// Resends a saved, fully signed leg 2 (out/leg2-<hash>.cbor.hex) once leg 1 is visible, until it lands or expires.
export async function resend(escrowRef: string): Promise<TxLogEntry> {
  const release = lock(escrowRef)
  try {
    if (!existsSync(pendingFile(escrowRef))) throw new SettleError('No concession in flight for this escrow.')
    const pending = JSON.parse(readFileSync(pendingFile(escrowRef), 'utf8')) as { leg1: string; leg2: string; leg2ValidToMs: number }
    const cborHex = readFileSync(join(ROOT, 'out', `leg2-${pending.leg2}.cbor.hex`), 'utf8').trim()
    const r = await landLeg2(escrowRef, pending.leg1, { cborHex, txHash: pending.leg2 }, pending.leg2ValidToMs)
    if (r.status === 'accepted' && r.block) {
      rmSync(pendingFile(escrowRef), { force: true })
      const { partiesFromLeg1 } = await import('./readback.ts')
      return withReadback(escrowRef, r, () => partiesFromLeg1(pending.leg1)) // only leg 1's hash is kept here
    }
    return r
  } finally {
    release()
  }
}
