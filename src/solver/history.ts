// D14 and C3 reproduced in the repo, read-only on mainnet: the V1 script's lifetime arbitration record. Every
// WithdrawDisputed ever submitted, the escrows it spent, and what each escrow's buyer and seller received, net, per asset.
// r_s = 0 means the seller received nothing in any asset in every valid one; π per asset is Σ buyer / Σ pot over the valid
// ones; the rest reached neither party (the tx fee, the fee address, admin-controlled addresses) and is kept as one
// remainder: those wallets' own change makes their gross flows meaningless. Also the arbiter's last action (C3, which T
// counts from) and the arbitration clock of the Disputed escrows: days since external_dispute_unlock_time, the moment
// arbitration opens (K50), which is the census's "median of 333 days" at block 14031954.
// Route (Koios keyless): script_redeemers lists every redeemer of the script in one call; each WithdrawDisputed tx is then
// read with tx_info, whose own decoding must say WithdrawDisputed on the same inputs; each escrow datum's CBOR comes from
// datum_info, its blake2b-256 checked against its hash, then the 16-field decoder. When BLOCKFROST_MAINNET_PROJECT_ID is
// set, Blockfrost's lifetime redeemer list is a second method, and the two sets of WithdrawDisputed txs must be equal.
// A hole is never a data point: with any one nothing is pinned (exit 1). Writes fixtures/arbitrations-<tip>.json, never
// overwrites one.
//   node src/solver/history.ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Datum, Value } from '../../shared/types.ts'
import { REDEEMER } from '../../shared/types.ts'
import { ARBITER_LAST_ACTION_MS, BLOCKFROST, BUYER_ARB_SHARE, KOIOS, SCRIPT_HASH, SELLER_ARB_SHARE, USDM } from '../../shared/constants.ts'
import { readDatum } from '../preprod/datum.ts'
import { cst } from '../preprod/mesh.ts'
import * as blockfrost from '../read/blockfrost.ts'
import { request } from '../read/http.ts'
import { CONTROL_HEIGHT, CONTROL_TX } from './dormancy.ts'

export class HistoryError extends Error {}

const WITHDRAW_DISPUTED = REDEEMER.indexOf('WithdrawDisputed')
const DAY_MS = 86_400_000

// ---------- Koios shapes (the fields read, nothing else) ----------

export type KAsset = { policy_id: string; asset_name: string | null; quantity: string }
export type KIo = { tx_hash: string; tx_index: number; value: string; asset_list: KAsset[] | null; payment_addr: { cred: string | null } | null; datum_hash: string | null }
export type KContract = {
  script_hash: string
  valid_contract: boolean
  spends_input?: { tx_hash: string; tx_index: number } | null
  input?: { redeemer?: { purpose?: string; datum?: { value?: { constructor?: unknown } } } }
}
export type KTx = { tx_hash: string; block_height: number; tx_timestamp: number; inputs: KIo[] | null; outputs: KIo[] | null; plutus_contracts: KContract[] | null }

// ---------- values: integer strings per unit, zeros dropped ----------

export function valueOf(io: Pick<KIo, 'value' | 'asset_list'>): Value {
  const v: Value = { lovelace: io.value }
  for (const a of io.asset_list ?? []) {
    const unit = a.policy_id + (a.asset_name ?? '')
    v[unit] = (BigInt(v[unit] ?? '0') + BigInt(a.quantity)).toString()
  }
  return clean(v)
}
const clean = (v: Value): Value => Object.fromEntries(Object.entries(v).filter(([, q]) => q !== '0'))
const combine = (a: Value, b: Value, sign: 1n | -1n): Value => {
  const out: Value = { ...a }
  for (const [u, q] of Object.entries(b)) out[u] = (BigInt(out[u] ?? '0') + sign * BigInt(q)).toString()
  return clean(out)
}
export const plus = (a: Value, b: Value): Value => combine(a, b, 1n)
export const minus = (a: Value, b: Value): Value => combine(a, b, -1n)
const anyPositive = (v: Value): boolean => Object.values(v).some((q) => BigInt(q) > 0n)
const ref = (x: { tx_hash: string; tx_index: number }): string => `${x.tx_hash}#${x.tx_index}`

// ---------- one arbitration ----------

export type Arbitration = {
  txHash: string
  height: number
  time: string
  validContract: boolean // false: a phase-2-failed attempt, its escrows were not spent and it moved nothing but collateral
  escrows: { ref: string; buyer: string; seller: string }[] // each escrow's parties, as payment key hashes from its datum
  pot: Value // the escrows' value
  buyer: Value // net received by the escrows' buyers (outputs to their payment key, less their own inputs)
  seller: Value // the same for the sellers
  neither: Value // pot − buyer − seller: reached neither party
}

// Pure: a tx_info row and the decoded escrow datums → what each party received. Throws on anything that would make the
// reading ambiguous: no WithdrawDisputed in the tx's own decoding, script inputs and V1 redeemers that do not pair up, an
// escrow spent by another redeemer in the same tx, a datum missing, or one party on both sides.
export function flows(tx: KTx, datumOf: (hash: string) => Datum): Arbitration {
  const h = tx.tx_hash
  const v1 = (tx.plutus_contracts ?? []).filter((c) => c.script_hash === SCRIPT_HASH)
  const constructors = v1.map((c) => (c.input?.redeemer?.purpose === 'spend' ? c.input.redeemer.datum?.value?.constructor : undefined))
  if (!constructors.includes(WITHDRAW_DISPUTED)) throw new HistoryError(`${h}: tx_info shows no WithdrawDisputed among its V1 redeemers`)
  if (constructors.some((k) => k !== WITHDRAW_DISPUTED)) throw new HistoryError(`${h}: spends V1 escrows with another redeemer too (${constructors.join(', ')})`)
  const inputs = tx.inputs ?? []
  const atScript = inputs.filter((i) => i.payment_addr?.cred === SCRIPT_HASH)
  const spent = new Set(v1.map((c) => (c.spends_input ? ref(c.spends_input) : '')))
  if (atScript.length !== v1.length || atScript.some((i) => !spent.has(ref(i)))) {
    throw new HistoryError(`${h}: ${atScript.length} script inputs against ${v1.length} V1 redeemers, not paired one to one`)
  }
  const escrows = atScript.map((i) => {
    if (!i.datum_hash) throw new HistoryError(`${h}: escrow ${ref(i)} has no datum`)
    const d = datumOf(i.datum_hash)
    return { ref: ref(i), buyer: d.buyer.payment.hash, seller: d.seller.payment.hash }
  })
  const buyers = new Set(escrows.map((e) => e.buyer))
  const sellers = new Set(escrows.map((e) => e.seller))
  for (const b of buyers) if (sellers.has(b)) throw new HistoryError(`${h}: one key is a buyer and a seller in the same tx`)
  const pot = atScript.reduce((v, i) => plus(v, valueOf(i)), {} as Value)
  const base = { txHash: h, height: tx.block_height, time: new Date(tx.tx_timestamp * 1000).toISOString(), escrows, pot }
  if (!v1.every((c) => c.valid_contract)) return { ...base, validContract: false, buyer: {}, seller: {}, neither: {} }
  const net = (creds: Set<string>): Value => {
    let v: Value = {}
    for (const o of tx.outputs ?? []) if (creds.has(o.payment_addr?.cred ?? '')) v = plus(v, valueOf(o))
    for (const i of inputs) if (i.payment_addr?.cred !== SCRIPT_HASH && creds.has(i.payment_addr?.cred ?? '')) v = minus(v, valueOf(i))
    return v
  }
  const buyer = net(buyers)
  const seller = net(sellers)
  return { ...base, validContract: true, buyer, seller, neither: minus(minus(pot, buyer), seller) }
}

// ---------- the record ----------

const ratio = (part: string | undefined, whole: string): number => Number((Number(BigInt(part ?? '0')) / Number(BigInt(whole))).toFixed(4))
const at = (a: Arbitration): { txHash: string; height: number; time: string } => ({ txHash: a.txHash, height: a.height, time: a.time })

export type ArbitrationRecord = {
  arbitrations: number
  valid: number
  failedPhase2: number
  escrows: number // escrows spent by the valid ones
  sellerReceivedIn: number // valid ones where a seller's net is positive in any asset
  buyerWholePotIn: number // valid ones where the buyers got at least the whole pot in every unit
  buyerShare: Record<string, number> // Σ buyer / Σ pot per unit, valid ones
  neitherShare: Record<string, number> // Σ neither / Σ pot per unit
  totals: { pot: Value; buyer: Value; seller: Value; neither: Value }
  first: { txHash: string; height: number; time: string } | null
  last: { txHash: string; height: number; time: string } | null // the arbiter's last action: C3, T counts from it
}

export function summarize(arbs: Arbitration[]): ArbitrationRecord {
  const valid = [...arbs].filter((a) => a.validContract).sort((x, y) => x.height - y.height || x.txHash.localeCompare(y.txHash))
  const sum = (k: 'pot' | 'buyer' | 'seller' | 'neither'): Value => valid.reduce((v, a) => plus(v, a[k]), {} as Value)
  const totals = { pot: sum('pot'), buyer: sum('buyer'), seller: sum('seller'), neither: sum('neither') }
  const share = (part: Value): Record<string, number> => Object.fromEntries(Object.keys(totals.pot).sort().map((u) => [u, ratio(part[u], totals.pot[u])]))
  return {
    arbitrations: arbs.length,
    valid: valid.length,
    failedPhase2: arbs.length - valid.length,
    escrows: valid.reduce((n, a) => n + a.escrows.length, 0),
    sellerReceivedIn: valid.filter((a) => anyPositive(a.seller)).length,
    buyerWholePotIn: valid.filter((a) => Object.entries(a.pot).every(([u, q]) => BigInt(a.buyer[u] ?? '0') >= BigInt(q))).length,
    buyerShare: share(totals.buyer),
    neitherShare: share(totals.neither),
    totals,
    first: valid[0] ? at(valid[0]) : null,
    last: valid.length ? at(valid[valid.length - 1]) : null,
  }
}

// The arbitration clock of a set of escrows at a time: days since each one's external_dispute_unlock_time.
export function arbitrationClock(ds: Datum[], atMs: number): { n: number; pastOpen: number; medianDays: number; minDays: number; maxDays: number } | null {
  if (!ds.length) return null
  const days = ds.map((d) => (atMs - d.externalDisputeUnlockTime) / DAY_MS).sort((a, b) => a - b)
  const mid = days.length >> 1
  const median = days.length % 2 ? days[mid] : (days[mid - 1] + days[mid]) / 2
  const r2 = (x: number): number => Number(x.toFixed(2))
  return { n: days.length, pastOpen: days.filter((x) => x > 0).length, medianDays: r2(median), minDays: r2(days[0]), maxDays: r2(days[days.length - 1]) }
}

// What shared/constants.ts carries (D14, C3) against what this walk measured. Shares to 3 decimals, the date to the minute.
export function againstConstants(r: ArbitrationRecord): { buyerAda: boolean; buyerToken: boolean; sellerNothing: boolean; lastAction: boolean } {
  return {
    buyerAda: r.buyerShare.lovelace !== undefined && Math.abs(r.buyerShare.lovelace - BUYER_ARB_SHARE.lovelace) < 0.0005,
    buyerToken: r.buyerShare[USDM] !== undefined && Math.abs(r.buyerShare[USDM] - BUYER_ARB_SHARE[USDM]) < 0.0005,
    sellerNothing: r.sellerReceivedIn === 0 && Object.values(SELLER_ARB_SHARE).every((x) => x === 0),
    lastAction: !!r.last && Math.abs(Date.parse(r.last.time) - ARBITER_LAST_ACTION_MS) < 60_000,
  }
}

// ---------- network (Koios keyless; Blockfrost only as the optional second method) ----------

const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) })
const BATCH = 20
type Holes = { holes: number; errors: string[] }
const hole = (h: Holes, e: string): void => {
  h.holes++
  h.errors.push(e)
}

type KRedeemer = { tx_hash: string; purpose: string; datum_value: { constructor?: unknown } | null }
async function koiosRedeemers(h: Holes): Promise<KRedeemer[] | null> {
  const res = await request(`${KOIOS.mainnet}/script_redeemers?_script_hash=${SCRIPT_HASH}`, { headers: { accept: 'application/json' } })
  const rows = res?.status === 200 && Array.isArray(res.body) ? (res.body as { script_hash: string; redeemers: KRedeemer[] }[]) : null
  if (!rows || rows.length !== 1 || rows[0].script_hash !== SCRIPT_HASH || !Array.isArray(rows[0].redeemers)) {
    hole(h, 'koios script_redeemers: no answer, or not one row for the V1 script')
    return null
  }
  return rows[0].redeemers
}

async function koiosTxs(hashes: string[], h: Holes): Promise<Map<string, KTx>> {
  const out = new Map<string, KTx>()
  for (let i = 0; i < hashes.length; i += BATCH) {
    const chunk = hashes.slice(i, i + BATCH)
    const res = await request(`${KOIOS.mainnet}/tx_info`, post({ _tx_hashes: chunk, _inputs: true, _metadata: false, _assets: true, _withdrawals: false, _certs: false, _scripts: true, _bytecode: false }))
    if (res?.status !== 200 || !Array.isArray(res.body)) {
      hole(h, `koios tx_info: no answer for ${chunk.length} txs`)
      continue
    }
    for (const r of res.body as KTx[]) out.set(r.tx_hash, r)
    for (const x of chunk) if (!out.has(x)) hole(h, `koios tx_info: ${x} missing`)
  }
  return out
}

// Each datum's CBOR, kept only when its blake2b-256 is the hash it was asked for.
async function koiosDatums(hashes: string[], h: Holes): Promise<Map<string, Datum>> {
  const out = new Map<string, Datum>()
  for (let i = 0; i < hashes.length; i += 50) {
    const chunk = hashes.slice(i, i + 50)
    const res = await request(`${KOIOS.mainnet}/datum_info`, post({ _datum_hashes: chunk }))
    if (res?.status !== 200 || !Array.isArray(res.body)) {
      hole(h, `koios datum_info: no answer for ${chunk.length} datums`)
      continue
    }
    const rows = new Map((res.body as { datum_hash: string; bytes: string | null }[]).map((r) => [r.datum_hash, r.bytes]))
    for (const x of chunk) {
      const bytes = rows.get(x)
      if (!bytes) {
        hole(h, `koios datum_info: ${x} missing or without bytes`)
        continue
      }
      if (cst.blake2b(32).update(Buffer.from(bytes, 'hex')).digest('hex') !== x) {
        hole(h, `koios datum_info: ${x} answered bytes that do not hash to it`)
        continue
      }
      try {
        out.set(x, readDatum(bytes))
      } catch (e: unknown) {
        hole(h, `datum ${x}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }
  return out
}

// Blockfrost, the second method: every redeemer of the script, its constructor resolved from its redeemer data (one
// lookup per distinct data hash), never compared by hash. The key goes in a header, never in a URL or a log.
async function blockfrostFours(h: Holes): Promise<{ txs: Set<string>; redeemers: number }> {
  const init: RequestInit = { headers: { project_id: process.env.BLOCKFROST_MAINNET_PROJECT_ID ?? '', accept: 'application/json' } }
  const data = new Map<string, Promise<number | null>>()
  const constructorOf = (hash: string): Promise<number | null> => {
    if (!data.has(hash)) data.set(hash, request(`${BLOCKFROST.mainnet}/scripts/datum/${hash}`, init).then((r) => {
      const k = r?.status === 200 ? (r.body as { json_value?: { constructor?: unknown } }).json_value?.constructor : undefined
      return Number.isInteger(k) ? (k as number) : null
    }))
    return data.get(hash)!
  }
  const txs = new Set<string>()
  let redeemers = 0
  for (let page = 1; ; page++) {
    const res = await request(`${BLOCKFROST.mainnet}/scripts/${SCRIPT_HASH}/redeemers?order=asc&count=100&page=${page}`, init)
    if (res?.status !== 200 || !Array.isArray(res.body)) {
      hole(h, `blockfrost redeemers page ${page}: no answer`)
      break
    }
    const rows = res.body as { tx_hash: string; purpose: string; redeemer_data_hash: string }[]
    for (const r of rows) {
      redeemers++
      const k = r.purpose === 'spend' ? await constructorOf(r.redeemer_data_hash) : null
      if (k === null) hole(h, `blockfrost: ${r.tx_hash} has a V1 redeemer that does not decode`)
      else if (k === WITHDRAW_DISPUTED) txs.add(r.tx_hash)
    }
    if (rows.length < 100) break
  }
  return { txs, redeemers }
}

type Tip = { block_height: number; hash: string; block_time: number }
async function koiosTip(h: Holes): Promise<Tip | null> {
  const res = await request(`${KOIOS.mainnet}/tip`, { headers: { accept: 'application/json' } })
  const t = res?.status === 200 && Array.isArray(res.body) ? (res.body as Tip[])[0] : undefined
  if (!t || !Number.isInteger(t.block_height)) {
    hole(h, 'koios tip: no answer')
    return null
  }
  return t
}

// Today's Disputed escrows (credential_utxos, the census's route) for the live clock.
async function disputedNow(h: Holes): Promise<Datum[]> {
  const ds: Datum[] = []
  for (let offset = 0; ; offset += 1000) {
    const res = await request(`${KOIOS.mainnet}/credential_utxos?order=tx_hash.asc,tx_index.asc&offset=${offset}&limit=1000`, post({ _payment_credentials: [SCRIPT_HASH], _extended: true }))
    if (res?.status !== 200 || !Array.isArray(res.body)) {
      hole(h, `koios credential_utxos offset ${offset}: no answer`)
      return ds
    }
    const page = res.body as { inline_datum: { bytes: string | null } | null }[]
    for (const r of page) {
      try {
        const d = r.inline_datum?.bytes ? readDatum(r.inline_datum.bytes) : null
        if (d?.state === 'Disputed') ds.push(d)
      } catch {
        // an undecodable row is no Disputed escrow (the census counts it apart)
      }
    }
    if (page.length < 1000) return ds
  }
}

// The census pinned for the video (fixtures/mainnet/utxos-koios.json): its Disputed escrows at its own tip.
export function pinnedClock(root: string): { tip: { height: number; hash: string; time: string }; clock: ReturnType<typeof arbitrationClock> } | null {
  const file = join(root, 'fixtures', 'mainnet', 'utxos-koios.json')
  if (!existsSync(file)) return null
  const f = JSON.parse(readFileSync(file, 'utf8')) as { tip: { height: number; hash: string; timeMs: number }; utxos: { inlineDatumCbor: string | null }[] }
  const ds: Datum[] = []
  for (const u of f.utxos) {
    try {
      const d = u.inlineDatumCbor ? readDatum(u.inlineDatumCbor) : null
      if (d?.state === 'Disputed') ds.push(d)
    } catch {
      // as above
    }
  }
  return { tip: { height: f.tip.height, hash: f.tip.hash, time: new Date(f.tip.timeMs).toISOString() }, clock: arbitrationClock(ds, f.tip.timeMs) }
}

// ---------- the run ----------

if (process.argv[1]?.endsWith('history.ts')) {
  const root = join(import.meta.dirname, '..', '..')
  const env = join(root, '.env')
  if (existsSync(env)) process.loadEnvFile(env) // BLOCKFROST_MAINNET_PROJECT_ID, for the second method; never printed
  const h: Holes = { holes: 0, errors: [] }
  const before = await koiosTip(h)
  const redeemers = (await koiosRedeemers(h)) ?? []
  const byRedeemer: Record<string, number> = {}
  for (const r of redeemers) {
    const k = r.purpose === 'spend' ? r.datum_value?.constructor : undefined
    const name = Number.isInteger(k) && REDEEMER[k as number] ? REDEEMER[k as number] : `undecoded (${r.purpose})`
    byRedeemer[name] = (byRedeemer[name] ?? 0) + 1
    if (!name.startsWith('undecoded')) continue
    hole(h, `koios script_redeemers: ${r.tx_hash} has a redeemer that does not decode`)
  }
  const fours = [...new Set(redeemers.filter((r) => r.purpose === 'spend' && r.datum_value?.constructor === WITHDRAW_DISPUTED).map((r) => r.tx_hash))].sort()
  const txs = await koiosTxs(fours, h)
  const datumHashes = [...new Set([...txs.values()].flatMap((t) => (t.inputs ?? []).filter((i) => i.payment_addr?.cred === SCRIPT_HASH && i.datum_hash).map((i) => i.datum_hash as string)))]
  const datums = await koiosDatums(datumHashes, h)
  const arbs: Arbitration[] = []
  for (const x of fours) {
    const t = txs.get(x)
    if (!t) continue // already a hole
    try {
      arbs.push(flows(t, (hash) => {
        const d = datums.get(hash)
        if (!d) throw new HistoryError(`${x}: datum ${hash} not read`)
        return d
      }))
    } catch (e: unknown) {
      hole(h, e instanceof Error ? e.message : String(e))
    }
  }
  const record = summarize(arbs)
  const second = blockfrost.available('mainnet') ? await blockfrostFours(h) : null
  const sameAsBlockfrost = second ? second.txs.size === fours.length && fours.every((x) => second.txs.has(x)) : null
  if (second && !sameAsBlockfrost) hole(h, `blockfrost lists ${second.txs.size} WithdrawDisputed txs, Koios ${fours.length}: the two methods disagree`)
  const live = await disputedNow(h)
  const after = await koiosTip(h)
  const controlRow = arbs.find((a) => a.txHash === CONTROL_TX)
  const controls = {
    // the last arbitration on record (C3) is listed, decoded by tx_info as WithdrawDisputed, valid, at its block
    controlTx: !!controlRow && controlRow.validContract && controlRow.height === CONTROL_HEIGHT,
    everyFourRead: arbs.length === fours.length,
  }
  if (!controls.controlTx) hole(h, `control ${CONTROL_TX} (block ${CONTROL_HEIGHT}) not read as a valid WithdrawDisputed`)
  const constants = againstConstants(record)
  const out = {
    label: 'The V1 script\'s lifetime arbitration record on mainnet, read-only: every WithdrawDisputed, what each escrow\'s buyer and seller received, net, per asset. Shares are Σ buyer / Σ pot per unit over the valid ones; no dollar figure.',
    tip: { before: before && { height: before.block_height, hash: before.hash, time: new Date(before.block_time * 1000).toISOString() }, after: after && { height: after.block_height, hash: after.hash } },
    routes: ['koios script_redeemers (every redeemer of the script)', 'koios tx_info (each WithdrawDisputed, its own redeemer decoding)', 'koios datum_info (escrow datums, blake2b-256 checked)', ...(second ? ['blockfrost scripts/{hash}/redeemers (second method)'] : [])],
    skipped: second ? [] : ['blockfrost: BLOCKFROST_MAINNET_PROJECT_ID is not set, so the list of WithdrawDisputed txs rests on one provider'],
    lifetime: { redeemers: redeemers.length, txs: new Set(redeemers.map((r) => r.tx_hash)).size, byRedeemer, ...(second ? { blockfrostRedeemers: second.redeemers, sameWithdrawDisputedTxs: sameAsBlockfrost } : {}) },
    record,
    againstConstants: constants,
    controls,
    clock: { definition: 'days since external_dispute_unlock_time, the moment arbitration opens (K50)', pinned: pinnedClock(root), live: before && { tip: before.block_height, clock: arbitrationClock(live, before.block_time * 1000) } },
    holes: h.holes,
    errors: h.errors,
    arbitrations: arbs,
  }
  const brief = { ...out, arbitrations: `${arbs.length} rows` }
  console.log(JSON.stringify(brief, null, 2))
  if (h.holes || !before) {
    console.error(`\n${h.holes} hole(s): nothing pinned. A hole is never a data point; run again.`)
    process.exitCode = 1
  } else {
    const file = join(root, 'fixtures', `arbitrations-${before.block_height}.json`)
    if (existsSync(file)) throw new Error(`${file} exists: a pinned fixture is never overwritten; re-run at a later tip`)
    writeFileSync(file, JSON.stringify(out, null, 2) + '\n')
    console.log(`\npinned: ${file}`)
    const off = Object.entries(constants).filter(([, ok]) => !ok).map(([k]) => k)
    if (off.length) {
      console.error(`DIFFERS from shared/constants.ts: ${off.join(', ')}: the solver's inputs and every sentence citing them must change`)
      process.exitCode = 1
    }
  }
}
