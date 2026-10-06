// A3: the bank of preprod escrows the demo, the takes and the controls run on. Registry: fixtures/preprod/bank.json.
//   node src/preprod/bank.ts token --amount 90     seller → buyer, preprod USDM, so the pots carry a token as on mainnet
//   node src/preprod/bank.ts build                 one lock tx for the whole bank, then a real dispute for each path-B escrow
//   node src/preprod/bank.ts list                  live state of every bank escrow, read on chain
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import type { Asset } from '@meshsdk/core'
import type { State } from '../../shared/types.ts'
import { liveUtxos, preprodSubmitter, utxoStatus } from './chain.ts'
import { readDatum } from './datum.ts'
import { ROOT } from './env.ts'
import { escrowAt, tokenQty, TUSDM } from './fixture.ts'
import { lockEscrows, raiseDispute, type LockRequest } from './bankops.ts'
import { addWitness, appendTxLog, buildPlain, submitAndConfirm, txWindow } from './tx.ts'
import { party } from './wallet.ts'

// Stream B's demo wallets (DEMO.md on b/ui): only their keys can move the two escrows locked for them.
const B_BUYER = 'addr_test1qqlg6r6ww0kd0qxsw2zh6fd78qyk2f7k2rfgp3696sngcms6y3crsh87un2wt9rkk5g7m0t3z0rturaca94vdzjhzymsfct97t'
const B_SELLER = 'addr_test1qrvk6sgjjk7nsv9tg3jltr35g65nnsr98f7pw5c5p258geulnltrju4208p9ej3y5tc2nsw7cftqqnssjflvurd4we9stphwwa'

type Entry = {
  ref: string
  purpose: string
  path: 'A' | 'B'
  owners: 'A' | 'B' // which stream's wallets are buyer and seller
  value: Asset[]
  lockedIn: string // tx hash
  lockedInBlock?: number
  disputedFrom?: string // the ResultSubmitted ref this one came from
  disputedInBlock?: number
  targetStateMs?: number // lock submit → Disputed confirmed
  state: State | 'spent'
}
const FILE = join(ROOT, 'fixtures', 'preprod', 'bank.json')
const load = (): Entry[] => (existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : [])
const save = (e: Entry[]): void => {
  mkdirSync(join(ROOT, 'fixtures', 'preprod'), { recursive: true })
  writeFileSync(FILE, JSON.stringify(e, null, 2) + '\n')
}
const pot = (ada: number, usdm: number): Asset[] => [{ unit: 'lovelace', quantity: String(ada * 1e6) }, ...(usdm > 0 ? [{ unit: TUSDM, quantity: String(usdm * 1e6) }] : [])]

const { positionals, values } = parseArgs({ allowPositionals: true, options: { amount: { type: 'string', default: '90' }, usdm: { type: 'string', default: '10' }, follow: { type: 'string' }, owners: { type: 'string', default: 'A' }, count: { type: 'string', default: '2' }, ada: { type: 'string', default: '20' } } })

async function token(amount: number): Promise<void> {
  const [buyer, seller] = [await party('buyer'), await party('seller')]
  const q = BigInt(Math.round(amount * 1e6))
  const source = (await liveUtxos(seller.address)).find((u) => tokenQty(u, TUSDM) >= q)
  if (!source) throw new Error(`the seller has no UTxO with ${amount} tUSDM`)
  const now = Date.now()
  const built = await buildPlain({
    network: 'preprod', window: txWindow(now), signers: [seller], inputs: [source], changeAddress: seller.address,
    outputs: [{ address: buyer.address, amount: [{ unit: 'lovelace', quantity: '2000000' }, { unit: TUSDM, quantity: q.toString() }] }],
  })
  const entry = await submitAndConfirm(await addWitness(built, seller), preprodSubmitter(), `seller → buyer ${amount} tUSDM`, now)
  appendTxLog('wallet-seller', entry)
  console.log(`${entry.status} at ${entry.stage}${entry.block ? `, block ${entry.block.height}` : ''}  ${built.txHash}`)
}

async function build(): Promise<void> {
  const [buyer, seller] = [await party('buyer'), await party('seller')]
  const ours = (purpose: string, path: 'A' | 'B', state: 'ResultSubmitted' | 'Disputed', unlock: 'future' | 'past'): { req: LockRequest; meta: Omit<Entry, 'ref' | 'lockedIn' | 'state'> } => ({
    req: { buyer: buyer.address, seller: seller.address, amount: pot(20, 10), options: { state, unlock, collateralReturnLovelace: 2_000_000 } },
    meta: { purpose, path, owners: 'A', value: pot(20, 10) },
  })
  const plan = [
    ours('demo take 1 (path B)', 'B', 'ResultSubmitted', 'future'),
    ours('demo take 2 (path B)', 'B', 'ResultSubmitted', 'future'),
    ours('demo take 3 (path B)', 'B', 'ResultSubmitted', 'future'),
    ours('race measurement 5b (path B)', 'B', 'ResultSubmitted', 'future'),
    ours('controls: refusals after the concession (path B)', 'B', 'ResultSubmitted', 'future'),
    ours('fallback path A (locked directly in Disputed, unlock_time past)', 'A', 'Disputed', 'past'),
    {
      req: { buyer: B_BUYER, seller: B_SELLER, amount: pot(20, 10), options: { state: 'Disputed', unlock: 'future', collateralReturnLovelace: 2_000_000 } },
      meta: { purpose: 'stream B demo 1 (locked directly in Disputed for B\'s wallets)', path: 'B', owners: 'B', value: pot(20, 10) },
    },
    {
      req: { buyer: B_BUYER, seller: B_SELLER, amount: pot(20, 10), options: { state: 'Disputed', unlock: 'future', collateralReturnLovelace: 2_000_000 } },
      meta: { purpose: 'stream B demo 2 (locked directly in Disputed for B\'s wallets)', path: 'B', owners: 'B', value: pot(20, 10) },
    },
  ] as const
  const t0 = Date.now()
  const { entry, refs } = await lockEscrows(buyer, plan.map((p) => p.req))
  appendTxLog('bank', entry)
  console.log(`lock: ${entry.status} at ${entry.stage}${entry.block ? `, block ${entry.block.height}` : ''}`)
  if (entry.status !== 'accepted' || !entry.block) throw new Error('lock not confirmed: nothing registered')
  const bank = load()
  const fresh: Entry[] = plan.map((p, i) => ({ ...p.meta, ref: refs[i], lockedIn: entry.txHash, lockedInBlock: entry.block?.height, state: p.req.options.state }))
  bank.push(...fresh)
  save(bank)
  await disputeAll(bank, buyer, t0)
}

// A real buyer-signed SetRefundRequested for each of our escrows still in ResultSubmitted, as the 61 got there.
// Sequential: each needs its own funding input, and the change of one is the funding of the next.
async function disputeAll(bank: Entry[], buyer: Awaited<ReturnType<typeof party>>, t0?: number): Promise<void> {
  for (const e of bank.filter((x) => x.owners === 'A' && x.state === 'ResultSubmitted')) {
    const { entry: d, next } = await raiseDispute(e.ref, buyer)
    appendTxLog('bank', d)
    if (d.status === 'accepted' && d.block) {
      Object.assign(e, { disputedFrom: e.ref, ref: next, disputedInBlock: d.block.height, state: 'Disputed', ...(t0 ? { targetStateMs: Date.now() - t0 } : {}) })
      console.log(`  ${e.purpose}: Disputed in block ${d.block.height}${t0 ? `, ${Math.round((Date.now() - t0) / 1000)} s after the lock was sent` : ''} → ${next}`)
    } else console.log(`  ${e.purpose}: dispute ${d.status} at ${d.stage}${d.error ? `: ${d.error.slice(0, 200)}` : ''}`)
    // The whole registry is re-read and only this entry replaced: `bank` may be a subset (a top-up's fresh entries).
    const all = load()
    const i = all.findIndex((x) => x.lockedIn === e.lockedIn && (x.ref === (e.disputedFrom ?? e.ref) || x.ref === e.ref))
    if (i >= 0) all[i] = e
    else all.push(e)
    save(all)
  }
}

// The fast fixture (PLAN M-4): one escrow from nothing to Disputed, timed from the lock being sent to the dispute's block.
async function fast(usdm: number): Promise<void> {
  const [buyer, seller] = [await party('buyer'), await party('seller')]
  const t0 = Date.now()
  const req: LockRequest = { buyer: buyer.address, seller: seller.address, amount: pot(20, usdm), options: { state: 'ResultSubmitted', unlock: 'future', collateralReturnLovelace: 2_000_000 } }
  const { entry, refs } = await lockEscrows(buyer, [req])
  appendTxLog('bank', entry)
  if (entry.status !== 'accepted' || !entry.block) throw new Error(`lock ${entry.status} at ${entry.stage}`)
  const bank = load()
  const e: Entry = { purpose: 'fast fixture run (spare, path B)', path: 'B', owners: 'A', value: pot(20, usdm), ref: refs[0], lockedIn: entry.txHash, lockedInBlock: entry.block.height, state: 'ResultSubmitted' }
  bank.push(e)
  save(bank)
  await disputeAll([e], buyer, t0)
  save(bank.map((x) => (x.lockedIn === e.lockedIn ? e : x)))
  console.log(`fast fixture: lock block ${entry.block.height} → Disputed block ${e.disputedInBlock ?? '-'} in ${Math.round((Date.now() - t0) / 1000)} s`)
}

// More escrows for the takes: N in one lock tx. Stream B's (its keys are not ours) are locked directly in Disputed;
// ours reach Disputed through a real buyer-signed dispute, as the first bank did.
async function topup(owners: 'A' | 'B', count: number, ada: number, usdm: number): Promise<void> {
  const [buyer, seller] = [await party('buyer'), await party('seller')]
  const [b, s] = owners === 'B' ? [B_BUYER, B_SELLER] : [buyer.address, seller.address]
  const state = owners === 'B' ? ('Disputed' as const) : ('ResultSubmitted' as const)
  const req: LockRequest = { buyer: b, seller: s, amount: pot(ada, usdm), options: { state, unlock: 'future', collateralReturnLovelace: 2_000_000 } }
  const t0 = Date.now()
  const { entry, refs } = await lockEscrows(buyer, Array.from({ length: count }, () => req))
  appendTxLog('bank', entry)
  if (entry.status !== 'accepted' || !entry.block) throw new Error(`lock ${entry.status} at ${entry.stage}`)
  const bank = load()
  const purpose = owners === 'B' ? 'stream B take (locked directly in Disputed for the wallets of stream B)' : 'demo take (path B)'
  const fresh: Entry[] = refs.map((ref) => ({ purpose, path: 'B', owners, value: pot(ada, usdm), ref, lockedIn: entry.txHash, lockedInBlock: entry.block?.height, state }))
  bank.push(...fresh)
  save(bank)
  console.log(`lock block ${entry.block.height}: ${refs.length} escrows for stream ${owners}`)
  if (owners === 'A') await disputeAll(fresh, buyer, t0)
  for (const e of fresh) console.log(`  ${e.ref} ${e.state}`)
}

// The registry against the chain: an entry whose ref is spent is marked spent (with nothing re-pointed silently), and a
// known successor (e.g. a dispute whose registry write was lost) can be attached with --follow <old>=<new>.
async function reconcile(follow: string | undefined): Promise<void> {
  const bank = load()
  if (follow) {
    const [from, to] = follow.split('=')
    const e = bank.find((x) => x.ref === from)
    if (!e) throw new Error(`no entry ${from}`)
    Object.assign(e, { disputedFrom: from, ref: to, state: 'Disputed' })
  }
  const status = await utxoStatus(bank.map((e) => e.ref))
  for (const e of bank) if (status.get(e.ref) === 'spent') e.state = 'spent'
  save(bank)
  console.log(bank.map((e) => `${e.ref.slice(0, 16)}… ${e.state}`).join(' | '))
}

async function list(): Promise<void> {
  const bank = load()
  for (const e of bank) {
    let state: string
    try {
      state = readDatum((await escrowAt(e.ref)).output.plutusData as string).state
    } catch {
      state = 'spent or not found'
    }
    console.log(`${e.ref.slice(0, 16)}…#${e.ref.split('#')[1]}  ${state.padEnd(16)} path ${e.path} owners ${e.owners}  ${e.purpose}`)
  }
}

const [cmd] = positionals
if (cmd === 'token') await token(Number(values.amount))
else if (cmd === 'build') await build()
else if (cmd === 'fast') await fast(Number(values.usdm))
else if (cmd === 'dispute') await disputeAll(load(), await party('buyer'))
else if (cmd === 'topup') await topup(values.owners === 'B' ? 'B' : 'A', Number(values.count), Number(values.ada), Number(values.usdm))
else if (cmd === 'reconcile') await reconcile(values.follow)
else if (cmd === 'list') await list()
else throw new Error('usage: bank.ts token --amount 90 | build | dispute | list')
