// S-1 (part 5b): the race, measured once. Pre-signing removes a REFUSAL, not a FRONT-RUN: once the concession is visible,
// the buyer can send its own WithdrawRefund taking everything. This run gives the buyer its best honest shot — it knows
// leg 1's hash from the leg 2 it signed, so it pre-builds its competing exit and fires it the moment leg 1 appears in a
// mempool — while the seller does what the product does: leg 1, then leg 2 at once. Our own bank escrow, our own keys.
// One run is a data point, not a probability.
//   node src/preprod/race.ts <disputed bank ref> [--share 0.4]
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import type { UTxO } from '@meshsdk/core'
import type { TxLogEntry } from '../../shared/types.ts'
import { SCRIPT_HASH, V1_ADDRESS } from '../../shared/constants.ts'
import { blockfrostGet, liveUtxos, preprodSubmitter } from './chain.ts'
import { buildEscrowSpend } from './escrow.ts'
import { ROOT } from './env.ts'
import { lovelace, pureAda } from './fixture.ts'
import { prepare, sign, upsertTxLog } from './settle.ts'
import { addWitness, confirmTx, submitOnly, txWindow } from './tx.ts'
import { party } from './wallet.ts'

const { positionals, values } = parseArgs({ allowPositionals: true, options: { share: { type: 'string', default: '0.4' } } })
const ref = positionals[0]
if (!ref) throw new Error('usage: race.ts <disputed bank ref> [--share 0.4]')
const logAs = `race-${ref}`
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const [buyer, seller] = [await party('buyer'), await party('seller')]
const proposal = await sign('buyer', await prepare(ref, Number(values.share)))
const leg1 = proposal.leg1!, leg2 = proposal.leg2!
const leg1Signed = await addWitness({ cborHex: leg1.cborHex, txHash: leg1.txHash }, seller)
const leg2Signed = await addWitness({ cborHex: leg2.cborHex, txHash: leg2.txHash }, seller)

// The buyer's competing exit, built before the race from what it already knows: leg 1's hash and its escrow output.
const leg1Datum = (await import('./mesh.ts')).cst.deserializeTx(leg1.cborHex).body().outputs()[0].datum()?.asInlineData()?.toCbor() as string
const amount = (await import('./mesh.ts')).cst.deserializeTx(leg1.cborHex).body().outputs()[0].amount().toCore()
const pot = [{ unit: 'lovelace', quantity: amount.coins.toString() }, ...[...(amount.assets ?? new Map()).entries()].map(([id, q]) => ({ unit: String(id), quantity: q.toString() }))]
const leg1Out: UTxO = { input: { txHash: leg1.txHash, outputIndex: 0 }, output: { address: V1_ADDRESS.preprod, amount: pot, plutusData: leg1Datum } }
const bu = pureAda(await liveUtxos(buyer.address)).filter((u) => lovelace(u) >= 5_000_000n)
if (bu.length < 2) throw new Error('the buyer needs two pure-ADA UTxOs for the competing exit')
const rival = await addWitness(await buildEscrowSpend({
  network: 'preprod', window: txWindow(Date.now(), 150_000, 60 * 60_000), escrow: leg1Out, redeemer: 'WithdrawRefund', signers: [buyer],
  funding: [bu[0]], collateral: bu[1], outputs: [{ address: buyer.address, amount: pot }], changeAddress: buyer.address, pending: [leg1Out],
}), buyer)
console.log(`leg 1 ${leg1.txHash}\nleg 2 ${leg2.txHash} (pays the seller its share)\nrival ${rival.txHash} (the buyer's own exit, takes the whole pot; built in advance)`)

const koios = preprodSubmitter('koios'), bf = preprodSubmitter('blockfrost')
const t: Record<string, number> = {}
const base = (step: string, txHash: string, via: TxLogEntry['via'], role: 'buyer' | 'seller', expected: 'accept' | 'refuse'): Omit<TxLogEntry, 'status' | 'stage'> =>
  ({ step, network: 'preprod', scriptHash: SCRIPT_HASH, txHash, atMs: Date.now(), via, redeemer: step.startsWith('Authorize') ? 'AuthorizeRefund' : 'WithdrawRefund', role, expected })

// The adversary: polls Blockfrost's mempool for leg 1 every 250 ms, fires the rival the moment it is seen.
const adversary = (async (): Promise<TxLogEntry | null> => {
  const until = Date.now() + 120_000
  while (Date.now() < until) {
    if ((await blockfrostGet(`/mempool/${leg1.txHash}`).catch(() => null)) || (await blockfrostGet(`/txs/${leg1.txHash}`).catch(() => null))) {
      t.rivalSeesLeg1 = Date.now()
      const b = base('rival: the buyer\'s own WithdrawRefund, fired on first sight of leg 1', rival.txHash, 'blockfrost', 'buyer', 'refuse')
      const r = await submitOnly(rival, bf, b).catch((e: unknown) => ({ ...b, status: 'refused' as const, stage: 'submit' as const, error: `hole: ${e instanceof Error ? e.message.slice(0, 160) : ''}` }))
      t.rivalSent = Date.now()
      return r ?? { ...b, status: 'accepted', stage: 'submit', error: 'the endpoint accepted the rival into its mempool' }
    }
    await sleep(250)
  }
  return null
})()

t.leg1Sent = Date.now()
const r1 = await submitOnly(leg1Signed, koios, base('AuthorizeRefund (leg 1)', leg1.txHash, 'koios', 'seller', 'accept'))
t.leg1Accepted = Date.now()
const r2 = await submitOnly(leg2Signed, koios, base('WithdrawRefund (leg 2, pre-signed)', leg2.txHash, 'koios', 'buyer', 'accept'))
t.leg2Accepted = Date.now()
const adv = await adversary

// Who spent leg1#0: the chain decides the race.
let spender: string | null = null
for (let i = 0; i < 60 && !spender; i++) {
  await sleep(5_000)
  const utxos = await blockfrostGet<{ outputs: { output_index: number; consumed_by_tx?: string | null }[] }>(`/txs/${leg1.txHash}/utxos`).catch(() => null)
  spender = utxos?.outputs.find((o) => o.output_index === 0)?.consumed_by_tx ?? null
}
const winner = spender === leg2.txHash ? 'leg 2 (the settlement)' : spender === rival.txHash ? 'RIVAL (front-run: the buyer took the pot)' : spender ? `another tx ${spender}` : 'unknown (not indexed in 5 min)'
const c1 = await confirmTx(base('AuthorizeRefund (leg 1)', leg1.txHash, 'koios', 'seller', 'accept'))
const c2 = spender === leg2.txHash ? await confirmTx(base('WithdrawRefund (leg 2, pre-signed)', leg2.txHash, 'koios', 'buyer', 'accept')) : r2
const cr = spender === rival.txHash ? await confirmTx(base('rival: the buyer\'s own WithdrawRefund, fired on first sight of leg 1', rival.txHash, 'blockfrost', 'buyer', 'refuse')) : adv
for (const e of [r1 ?? c1, c2 ?? undefined, cr ?? undefined].filter((x): x is TxLogEntry => !!x)) upsertTxLog(logAs, e)

const rel = (k: string): string => (t[k] ? `+${t[k] - t.leg1Sent} ms` : 'n/a')
const summary = {
  label: 'S-1 race measurement, ONE run on our own bank escrow with our own keys; a data point, not a probability',
  escrow: ref, leg1: leg1.txHash, leg2: leg2.txHash, rival: rival.txHash,
  timings: { leg1HandedToKoios: '+0 ms', leg1Accepted: rel('leg1Accepted'), leg2Accepted: rel('leg2Accepted'), rivalSeesLeg1: rel('rivalSeesLeg1'), rivalSent: rel('rivalSent') },
  rivalAnswer: adv ? { status: adv.status, error: adv.error ?? adv.refusal?.ledgerError?.slice(0, 300) } : 'the rival never saw leg 1 within 120 s',
  winner, leg1Block: c1.block?.height, leg2Block: c2?.block?.height ?? null,
}
mkdirSync(join(ROOT, 'fixtures', 'preprod'), { recursive: true })
writeFileSync(join(ROOT, 'fixtures', 'preprod', `race-${ref.replace('#', '_')}.json`), JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify(summary, null, 2))
