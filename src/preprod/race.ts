// S-1 (part 5b): the race, CONTENDED. Pre-signing removes a refusal, not a front-run: once the concession is visible, the
// buyer can send its own WithdrawRefund taking everything. Here the buyer gets a real chance: it knows leg 1's hash from the
// leg 2 it signed, pre-builds its exit (evaluated against leg 1's pending output: the positive control that it is valid if
// leg1#0 is still free), watches the mempool the seller submits to, and fires through ANOTHER provider the moment leg 1
// shows, possibly before leg 2 is even sent. The seller does what the product does: leg 1, then leg 2 at once.
// Our own bank escrows and keys. Each run is a data point; several runs are several data points, not a probability.
//   node src/preprod/race.ts <disputed bank ref> [--share 0.4] [--run k]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import type { UTxO } from '@meshsdk/core'
import type { TxLogEntry } from '../../shared/types.ts'
import { SCRIPT_HASH, V1_ADDRESS } from '../../shared/constants.ts'
import { blockfrostGet, liveUtxos, preprodSubmitter, refusalPhase } from './chain.ts'
import { KOIOS } from '../../shared/constants.ts'
import { buildEscrowSpend } from './escrow.ts'
import { ROOT } from './env.ts'
import { lovelace, pureAda } from './fixture.ts'
import { cst } from './mesh.ts'
import { prepare, sign, upsertTxLog } from './settle.ts'
import { addWitness, confirmTx, submitOnly, txWindow } from './tx.ts'
import { party } from './wallet.ts'

const { positionals, values } = parseArgs({ allowPositionals: true, options: { share: { type: 'string', default: '0.4' }, run: { type: 'string', default: '1' } } })
const ref = positionals[0]
if (!ref) throw new Error('usage: race.ts <disputed bank ref> [--share 0.4] [--run k]')
const bank = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'preprod', 'bank.json'), 'utf8')) as { ref: string; owners: string; state: string }[]
if (!bank.some((e) => e.ref === ref && e.owners === 'A' && e.state === 'Disputed')) throw new Error('the race runs only on one of our own Disputed bank escrows')
const logAs = `race-${ref}`
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const [buyer, seller] = [await party('buyer'), await party('seller')]
const proposal = await sign('buyer', await prepare(ref, Number(values.share)))
const leg1 = proposal.leg1!, leg2 = proposal.leg2!
const leg1Signed = await addWitness({ cborHex: leg1.cborHex, txHash: leg1.txHash }, seller)
const leg2Signed = await addWitness({ cborHex: leg2.cborHex, txHash: leg2.txHash }, seller)

// The rival, from what the buyer already knows: leg 1's hash and its escrow output (in the leg 1 body it was shown).
const out0 = cst.deserializeTx(leg1.cborHex).body().outputs()[0]
const coreValue = out0.amount().toCore()
const pot = [{ unit: 'lovelace', quantity: coreValue.coins.toString() }, ...[...(coreValue.assets ?? new Map()).entries()].map(([id, q]) => ({ unit: String(id), quantity: q.toString() }))]
const leg1Out: UTxO = { input: { txHash: leg1.txHash, outputIndex: 0 }, output: { address: V1_ADDRESS.preprod, amount: pot, plutusData: out0.datum()?.asInlineData()?.toCbor() as string } }
const bu = pureAda(await liveUtxos(buyer.address)).filter((u) => lovelace(u) >= 5_000_000n)
if (bu.length < 2) throw new Error('the buyer needs two pure-ADA UTxOs for the rival')
// buildEscrowSpend with `pending` evaluates the rival twice against leg 1's pending output: it is a valid exit if leg1#0 is free.
const rival = await addWitness(await buildEscrowSpend({
  network: 'preprod', window: txWindow(Date.now(), 150_000, 60 * 60_000), escrow: leg1Out, redeemer: 'WithdrawRefund', signers: [buyer],
  funding: [bu[0]], collateral: bu[1], outputs: [{ address: buyer.address, amount: pot }], changeAddress: buyer.address, pending: [leg1Out],
}), buyer)
mkdirSync(join(ROOT, 'out'), { recursive: true })
writeFileSync(join(ROOT, 'out', `race-${ref.replace('#', '_')}.json`), JSON.stringify({ leg2: leg2Signed, rival }, null, 2)) // recovery, before leg 1 goes out
console.log(`run ${values.run}\nleg 1 ${leg1.txHash}\nleg 2 ${leg2.txHash} (pays the seller its share)\nrival ${rival.txHash} (the buyer's own exit, the whole pot; evaluated OK against leg 1's pending output)`)

const bf = preprodSubmitter('blockfrost'), koios = preprodSubmitter('koios')
const t: Record<string, number> = {}
let sighting: 'mempool' | 'txs' | null = null
let rivalAttempts = 0
const attempts: { atMs: number; kind: string; reason: string }[] = []

// One raw submit to Koios with a short timeout: the rival's own transport, so a slow answer never stalls its loop.
async function fireOnce(cborHex: string): Promise<{ kind: 'accepted' | 'refused' | 'timeout' | 'http'; text: string; reason: string }> {
  try {
    const res = await fetch(`${KOIOS.preprod}/submittx`, { method: 'POST', headers: { 'content-type': 'application/cbor' }, body: Buffer.from(cborHex, 'hex'), signal: AbortSignal.timeout(2_500) })
    const text = (await res.text()).replace(/[A-Za-z0-9+/]{200,}={0,2}/g, '<script bytes>')
    const reason = /BadInputsUTxO/.test(text) ? 'BadInputsUTxO' : /All inputs are spent/.test(text) ? 'All inputs are spent' : text.slice(0, 80)
    if (res.ok) return { kind: 'accepted', text, reason: 'accepted' }
    return res.status === 400 ? { kind: 'refused', text, reason } : { kind: 'http', text, reason: `HTTP ${res.status}` }
  } catch (error: unknown) {
    return { kind: 'timeout', text: '', reason: error instanceof Error ? error.name : 'error' }
  }
}
const entry = (step: string, txHash: string, via: TxLogEntry['via'], role: 'buyer' | 'seller', expected: 'accept' | 'refuse'): Omit<TxLogEntry, 'status' | 'stage'> =>
  ({ step, network: 'preprod', scriptHash: SCRIPT_HASH, txHash, atMs: Date.now(), via, redeemer: step.startsWith('Authorize') ? 'AuthorizeRefund' : 'WithdrawRefund', role, expected })
const RIVAL_STEP = `rival (run ${values.run}): the buyer's own WithdrawRefund, fired through Koios on first sight of leg 1 in Blockfrost's mempool, retried until leg1#0 is spent`

// The adversary watches the mempool the seller submits to (Blockfrost) every 200 ms.
let go = false
const adversary = (async (): Promise<TxLogEntry | null> => {
  while (!go) await sleep(5)
  const until = Date.now() + 120_000
  while (Date.now() < until) {
    if (await blockfrostGet(`/mempool/${leg1.txHash}`).catch(() => null)) sighting = 'mempool'
    else if (await blockfrostGet(`/txs/${leg1.txHash}`).catch(() => null)) sighting = 'txs'
    if (sighting) {
      t.rivalSeesLeg1 = Date.now()
      // A real attacker keeps firing while leg 1 propagates to its node: one raw POST per attempt with a 2.5 s timeout
      // (no internal retries, no settling wait), every 200 ms, until the rival is accepted, or leg1#0 is spent on chain,
      // or 60 s pass. Every attempt is recorded; a timeout is a hole, an answer is an observation.
      const b = entry(RIVAL_STEP, rival.txHash, 'koios', 'buyer', 'refuse')
      let last: TxLogEntry | null = null
      for (const stop = Date.now() + 60_000; Date.now() < stop; ) {
        rivalAttempts++
        const at = Date.now() - t.leg1Sent
        const a = await fireOnce(rival.cborHex)
        attempts.push({ atMs: at, kind: a.kind, reason: a.reason })
        if (a.kind === 'accepted') {
          t.rivalAnswered = Date.now()
          return { ...b, status: 'accepted', stage: 'submit', error: `Koios accepted the rival into its mempool (attempt ${rivalAttempts}, +${at} ms)` }
        }
        if (a.kind === 'refused') {
          last = { ...b, status: 'refused', stage: 'submit', refusal: { phase: refusalPhase(a.text), ledgerError: a.text.slice(0, 600) } }
          if (/All inputs are spent/i.test(a.text)) break
        }
        if (rivalAttempts % 5 === 0 && (await blockfrostGet(`/txs/${leg2.txHash}`).catch(() => null))) break // leg 2 in a block: leg1#0 is gone
        await sleep(200)
      }
      t.rivalAnswered = Date.now()
      return last
    }
    await sleep(200)
  }
  return null
})()

go = true
t.leg1Sent = Date.now()
const r1 = await submitOnly(leg1Signed, bf, entry('AuthorizeRefund (leg 1)', leg1.txHash, 'blockfrost', 'seller', 'accept'))
t.leg1Answered = Date.now()
const r2 = await submitOnly(leg2Signed, bf, entry('WithdrawRefund (leg 2, pre-signed)', leg2.txHash, 'blockfrost', 'buyer', 'accept')).catch((e: unknown) => ({ ...entry('WithdrawRefund (leg 2, pre-signed)', leg2.txHash, 'blockfrost', 'buyer', 'accept'), status: 'refused' as const, stage: 'submit' as const, error: `hole: ${e instanceof Error ? e.message.slice(0, 160) : ''}` }))
t.leg2Answered = Date.now()
const adv = await adversary

// The chain decides: who spent leg1#0.
let spender: string | null = null
for (let i = 0; i < 60 && !spender; i++) {
  await sleep(5_000)
  const utxos = await blockfrostGet<{ outputs: { output_index: number; consumed_by_tx?: string | null }[] }>(`/txs/${leg1.txHash}/utxos`).catch(() => null)
  spender = utxos?.outputs.find((o) => o.output_index === 0)?.consumed_by_tx ?? null
}
const winner = spender === leg2.txHash ? 'leg 2 (the settlement)' : spender === rival.txHash ? 'RIVAL: front-run, the buyer took the whole pot' : spender ? `another tx ${spender}` : 'unknown (not indexed in 5 min)'
const c1 = await confirmTx(entry('AuthorizeRefund (leg 1)', leg1.txHash, 'blockfrost', 'seller', 'accept'))
const c2 = spender === leg2.txHash ? await confirmTx(entry('WithdrawRefund (leg 2, pre-signed)', leg2.txHash, 'blockfrost', 'buyer', 'accept')) : (r2 ?? null)
const cr = spender === rival.txHash ? { ...(await confirmTx(entry(RIVAL_STEP, rival.txHash, 'koios', 'buyer', 'refuse'))), error: 'FRONT-RUN: the rival landed' } : adv
for (const e of [r1 ?? c1, c2, cr]) if (e) upsertTxLog(logAs, e)
const blockTime = async (h: string | undefined): Promise<number | null> => (h ? ((await blockfrostGet<{ block_time: number }>(`/txs/${h}`).catch(() => null))?.block_time ?? null) : null)

const summary = {
  label: `S-1 race, contended run ${values.run}: our own bank escrow, our own keys; a data point, not a probability`,
  escrow: ref, leg1: leg1.txHash, leg2: leg2.txHash, rival: rival.txHash,
  rivalPositiveControl: 'evaluated OK twice against leg 1\'s pending output (a valid exit had leg1#0 been free)',
  setup: 'legs to Blockfrost (seller); the rival polls Blockfrost\'s mempool every 200 ms, then fires raw POSTs at Koios (2.5 s timeout each) every 200 ms until leg1#0 is spent or 60 s pass',
  absoluteMs: t,
  relativeMs: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v - t.leg1Sent])),
  rivalSighting: sighting,
  rivalAttempts,
  rivalAttemptKinds: attempts.reduce<Record<string, number>>((m, a) => ({ ...m, [a.reason]: (m[a.reason] ?? 0) + 1 }), {}),
  rivalAttemptsTimeline: attempts.length > 40 ? [...attempts.slice(0, 20), { atMs: -1, kind: '…', reason: `${attempts.length - 40} more` }, ...attempts.slice(-20)] : attempts,
  rivalAnswer: adv ? { status: adv.status, detail: (adv.refusal?.ledgerError ?? adv.error ?? '').slice(0, 300) } : 'never saw leg 1 within 120 s',
  leg2Answer: r2 ? { status: r2.status, detail: (r2.refusal?.ledgerError ?? r2.error ?? '').slice(0, 300) } : 'accepted by Blockfrost',
  winner,
  blocks: { leg1: c1.block?.height ?? null, leg1TimeS: await blockTime(leg1.txHash), leg2: c2?.block?.height ?? null, rival: spender === rival.txHash ? cr?.block?.height ?? null : null },
}
const file = join(ROOT, 'fixtures', 'preprod', `race-${ref.replace('#', '_')}.json`)
if (existsSync(file)) throw new Error(`${file} exists: one summary per escrow`)
writeFileSync(file, JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify(summary, null, 2))
