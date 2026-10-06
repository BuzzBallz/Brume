import type { Asset, UTxO } from '@meshsdk/core'
import type { Network, Redeemer } from '../../shared/types.ts'
import { REDEEMER } from '../../shared/types.ts'
import { assertPreprod, assertPreprodAddress, blockfrostGet, evaluateWithUtxos, preprodChain, type ExUnits } from './chain.ts'
import { builderCst, cst, mesh } from './mesh.ts'
import { deployedV1, type Script } from './script.ts'
import { checkTx, protocol, TxRuleError, type Built, type TxOut, type TxWindow } from './tx.ts'
import type { Party } from './wallet.ts'

// One spend of one escrow UTxO (SPEC-VALIDATOR P4/P5): exactly one escrow input, at most one escrow output, which is
// always output 0 so a pre-signed next leg can name `<hash>#0` before this tx exists.
export type EscrowSpend = {
  network: Network
  window: TxWindow
  escrow: UTxO
  redeemer: Redeemer
  signers: Pick<Party, 'pkh'>[] // declared as required signers (SPEC-VALIDATOR §1: a witness alone does not satisfy the check)
  funding: UTxO[] // key inputs that pay the fee, chosen by the caller (the two-UTxO rule depends on it)
  collateral: UTxO // key-owned, pure ADA
  continuation?: { datumCbor: string; amount: Asset[] } // the escrow output, for continuation branches
  outputs: TxOut[] // everything else, e.g. the negotiated split on an exit branch
  changeAddress: string
  pending?: UTxO[] // outputs of unsubmitted txs this one spends, inline datum included (leg 1's escrow output, for leg 2)
  unevaluated?: ExUnits // try-anyway only: a fixed budget and NO evaluation, so the node itself runs the script and decides
  script?: Script // defaults to the shared deployed V1; our own deployment (S-2) passes its own
}

// Mesh 1.9.0-beta.96 hashes the script data with its built-in PlutusV3 cost model (297 entries); preprod's has 350
// (6 Oct, epoch 317), so every script tx it builds fails ScriptIntegrityHashMismatch (phase 1). The hash is recomputed
// with the chain's cost model before anyone signs: blake2b-256(redeemers || datums || language views), as Mesh does.
let chainV3: Promise<number[]> | null = null
const chainCostModelV3 = (): Promise<number[]> =>
  (chainV3 ??= blockfrostGet<{ cost_models_raw: { PlutusV3: number[] } }>('/epochs/latest/parameters')
    .then((p) => {
      if (!p?.cost_models_raw?.PlutusV3?.length) throw new TxRuleError('no PlutusV3 cost model in the preprod protocol parameters')
      return p.cost_models_raw.PlutusV3
    })
    .catch((error: unknown) => {
      chainV3 = null // a failed read is a hole, never a cached value
      throw error
    }))

export async function withChainScriptDataHash(cborHex: string): Promise<string> {
  const c = builderCst
  const tx = c.deserializeTx(cborHex)
  const ws = tx.witnessSet()
  const redeemers = ws.redeemers()
  if (!redeemers || redeemers.size() === 0) return cborHex
  const costmdls = new c.Serialization.Costmdls()
  costmdls.insert(c.Serialization.CostModel.newPlutusV3(await chainCostModelV3()))
  const datums = ws.plutusData()
  const parts = [redeemers.toCbor(), ...(datums && datums.size() > 0 ? [datums.toCbor()] : []), costmdls.languageViewsEncoding()]
  const hash: string = cst.blake2b(32).update(Buffer.from(parts.join(''), 'hex')).digest('hex') // bytes in, hex out
  const body = tx.body()
  body.setScriptDataHash(c.Hash32ByteBase16(hash))
  const fixed = new c.Transaction(body, ws, tx.auxiliaryData()).toCbor()
  if (fixed.length !== cborHex.length) throw new TxRuleError('re-encoding the body changed its size: the fee would no longer cover it')
  return fixed
}

const ref = (u: UTxO): string => `${u.input.txHash}#${u.input.outputIndex}`
// scriptSize 0 marks the input as fully described, so the builder never fetches it (leg 1's output does not exist yet).
const known = (u: UTxO): [string, number, Asset[], string, number] => [u.input.txHash, u.input.outputIndex, u.output.amount, u.output.address, 0]

export async function buildEscrowSpend(spec: EscrowSpend): Promise<Built> {
  assertPreprod(spec.network)
  const script = spec.script ?? deployedV1()
  if (spec.escrow.output.address !== script.address.preprod) throw new TxRuleError(`escrow input ${ref(spec.escrow)} is not at the script address`)
  if (spec.signers.length === 0) throw new TxRuleError('an escrow spend needs at least one declared signer')
  if (spec.collateral.output.amount.some((a) => a.unit !== 'lovelace')) throw new TxRuleError('collateral must be pure ADA')
  for (const u of [...spec.funding, spec.collateral]) assertPreprodAddress(u.output.address)
  if (spec.funding.some((u) => u.output.address === script.address.preprod)) throw new TxRuleError('a funding input sits at the script address: one escrow input per tx')

  let cborHex: string
  if (spec.unevaluated) {
    cborHex = await assemble(spec, script, spec.unevaluated)
  } else if (!spec.pending?.length) {
    cborHex = await assemble(spec, script) // escrow on chain: Mesh's evaluator resolves it
  } else {
    // Escrow not on chain yet: evaluate against the pending outputs ourselves, then build with those units plus 10 %,
    // then evaluate the final body again. A leg that fails here never lets the leg before it go out.
    const provisional = await assemble(spec, script, PROVISIONAL)
    const [used] = await evaluateWithUtxos(provisional, spec.pending)
    if (!used) throw new TxRuleError('evaluation returned no redeemer budget')
    const units = { mem: Math.ceil(used.mem * 1.1), steps: Math.ceil(used.steps * 1.1) }
    cborHex = await assemble(spec, script, units)
    const [check] = await evaluateWithUtxos(cborHex, spec.pending)
    if (!check || check.mem > units.mem || check.steps > units.steps) throw new TxRuleError('the final body needs more than the declared execution units')
  }

  const pp = await protocol()
  checkTx(cborHex, {
    signers: spec.signers.map((s) => s.pkh),
    inputs: [ref(spec.escrow), ...spec.funding.map(ref)],
    window: spec.window,
    maxScriptOutputs: spec.continuation ? 1 : 0,
    scriptAddress: script.address.preprod,
    coinsPerUtxoByte: Number(pp.coinsPerUtxoSize),
  })
  // Collateral covers collateral% of the fee once the collateral return is taken off (a phase-1 rule evaluation skips).
  const body = cst.deserializeTx(cborHex).body()
  const fee = body.fee()
  const back = body.collateralReturn()?.amount().coin() ?? 0n
  const posted = BigInt(spec.collateral.output.amount.find((a) => a.unit === 'lovelace')?.quantity ?? '0') - back
  const needed = (fee * BigInt(pp.collateralPercent) + 99n) / 100n
  if (posted < needed) throw new TxRuleError(`collateral ${posted} lovelace is under ${pp.collateralPercent}% of the fee (${needed})`)
  if (spec.continuation && cst.deserializeTx(cborHex).body().outputs()[0]?.address().toBech32() !== script.address.preprod) {
    throw new TxRuleError('the escrow continuation is not output 0: a pre-signed next leg would name the wrong output')
  }
  return { cborHex, txHash: mesh.resolveTxHash(cborHex) }
}

// Below the per-tx ceiling, only a placeholder for the first pass; never submitted.
const PROVISIONAL: ExUnits = { mem: 7_000_000, steps: 3_000_000_000 }

async function assemble(spec: EscrowSpend, script: Script, units?: ExUnits): Promise<string> {
  const chain = preprodChain()
  const b = new mesh.MeshTxBuilder({ fetcher: chain, evaluator: units ? undefined : chain, params: await protocol() }).setNetwork('preprod')
  b.spendingPlutusScriptV3()
    .txIn(...known(spec.escrow))
    .txInInlineDatumPresent()
    .txInRedeemerValue({ alternative: REDEEMER.indexOf(spec.redeemer), fields: [] }, 'Mesh', units)
    .txInScript(script.cbor)
  for (const u of spec.funding) b.txIn(...known(u))
  const [ch, ci, ca, caddr] = known(spec.collateral)
  b.txInCollateral(ch, ci, ca, caddr)
  if (spec.continuation) b.txOut(script.address.preprod, spec.continuation.amount).txOutInlineDatumValue(spec.continuation.datumCbor, 'CBOR')
  for (const o of spec.outputs) {
    if (o.address === script.address.preprod) throw new TxRuleError('extra output to the script address')
    b.txOut(o.address, o.amount)
    if (o.datumCbor) b.txOutInlineDatumValue(o.datumCbor, 'CBOR') // Withdraw's fee and collateral outputs carry own_ref
  }
  for (const s of spec.signers) b.requiredSignerHash(s.pkh)
  b.invalidBefore(spec.window.fromSlot).invalidHereafter(spec.window.toSlot).changeAddress(spec.changeAddress)
  return withChainScriptDataHash(await b.complete())
}
