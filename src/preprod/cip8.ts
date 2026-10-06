// S-6 (SPEC part 6): the path-B split negotiated as CIP-8 signed messages. The signature is the product; the file drop
// under out/negotiation/ is only the transport, and a reader trusts nothing in it that a signature does not cover.
//   signOffer(party, offer) → Message                 the role's wallet signs the canonical payload (COSE_Sign1, CIP-8)
//   verifyMessage(msg, expected)                      payload, key, address and signature, against the escrow's pkhs
//   verifyTranscript(messages, expected, nowMs)       propose → counter* → accept: chain, turns, shares, expiries, nonces
//   negotiate(ref, kind, role, share?) → Step         the CLI's step: read, check, sign, re-verify, write atomically
// The expected pkhs come from the escrow datum on chain (expectedFor), never from the transcript.
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readDatum } from './datum.ts'
import { ROOT } from './env.ts'
import { escrowAt, MIN } from './fixture.ts'
import { cst, mesh } from './mesh.ts'
import { SettleError } from './settle.ts'
import { party, type Party } from './wallet.ts'

export const OFFER_TTL_MS = 30 * MIN // an offer nobody answers is dead after this
export const CLOCK_SKEW_MS = 5 * MIN // a message signed later than the verifier's now plus this is refused

export type Side = 'buyer' | 'seller'
export type OfferKind = 'propose' | 'counter' | 'accept'
// atMs: when the message was signed, by the signer's clock, and signed with it: the turns are checked against signed times,
// so an accepted negotiation stays verifiable as a record after its offers expire.
export type Offer = { kind: OfferKind; escrowRef: string; network: 'preprod'; path: 'B'; sellerShare: number; by: Side; atMs: number; expiresMs: number; prev: string | null; nonce: string }
export type Message = { offer: Offer; signature: string; key: string } // signature: COSE_Sign1 hex; key: COSE_Key hex
export type Expected = { buyerPkh: string; sellerPkh: string }
// accepted: sellerShare is the agreed share and `by` the party that accepted; `fresh` says whether the accept is still
// within its own expiry at the verifier's now (what --prepare requires). Open: no share is agreed; `last` is the offer on
// the table and `expired` says whether it can still be answered at the verifier's now.
export type Outcome = { accepted: boolean; sellerShare?: number; by: Side; last: Offer; head: string; expired: boolean; fresh: boolean; messages: number }
// mesh.checkSignature's shape. It needs no network (Ed25519 over the Sig_structure); injectable so a test can count calls.
export type CheckSignature = (data: string, signature: { key: string; signature: string }, address?: string) => Promise<boolean>

const OFFER_KEYS = ['atMs', 'by', 'escrowRef', 'expiresMs', 'kind', 'network', 'nonce', 'path', 'prev', 'sellerShare'] as const
const HEX = /^[0-9a-f]+$/
const HASH = /^[0-9a-f]{64}$/
const REF = /^[0-9a-f]{64}#\d+$/
const NONCE = /^[0-9a-f]{32}$/

const slug = (ref: string): string => ref.replace('#', '_')
export const negotiationFile = (ref: string): string => {
  if (!REF.test(ref)) throw new SettleError('An escrow is named <tx hash>#<index>.') // the ref becomes a file name
  return join(ROOT, 'out', 'negotiation', `${slug(ref)}.json`)
}
const iso = (ms: number): string => new Date(ms).toISOString()

// JSON with keys sorted at every level and no whitespace: the same offer always gives the same bytes.
export function canonical(v: unknown): string {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v)
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new SettleError('An offer holds a number JSON cannot carry.')
    return JSON.stringify(v)
  }
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`
  }
  throw new SettleError(`An offer holds a ${typeof v}, which JSON cannot carry.`)
}
const payloadBytes = (offer: Offer): Buffer => Buffer.from(canonical(offer), 'utf8')
export const payloadHex = (offer: Offer): string => payloadBytes(offer).toString('hex')
// blake2b-256 of the canonical payload bytes: what the next message's `prev` names.
export const offerHash = (offer: Offer): string => cst.blake2b(32).update(payloadBytes(offer)).digest('hex')

// A message read from a file is untrusted: exactly the fields of an Offer, each of its type, or a refusal.
export function parseOffer(x: unknown): Offer {
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw new SettleError('A message carries no offer.')
  const o = x as Record<string, unknown>
  const keys = Object.keys(o).sort()
  if (keys.length !== OFFER_KEYS.length || keys.some((k, i) => k !== OFFER_KEYS[i])) throw new SettleError(`An offer has the fields ${keys.join(', ')}; it must have exactly ${OFFER_KEYS.join(', ')}.`)
  if (o.kind !== 'propose' && o.kind !== 'counter' && o.kind !== 'accept') throw new SettleError('An offer\'s kind is propose, counter or accept.')
  if (typeof o.escrowRef !== 'string' || !REF.test(o.escrowRef)) throw new SettleError('An offer names its escrow as <tx hash>#<index>.')
  if (o.network !== 'preprod') throw new SettleError('An offer is for preprod only.')
  if (o.path !== 'B') throw new SettleError('An offer is for the seller-first exit (path B) only.')
  if (typeof o.sellerShare !== 'number' || !(o.sellerShare > 0 && o.sellerShare < 1)) throw new SettleError('An offer\'s seller share is strictly between 0 and 1.')
  if (o.by !== 'buyer' && o.by !== 'seller') throw new SettleError('An offer is made by the buyer or the seller.')
  if (typeof o.atMs !== 'number' || !Number.isSafeInteger(o.atMs) || o.atMs <= 0) throw new SettleError('An offer\'s signing time is a time in milliseconds.')
  if (typeof o.expiresMs !== 'number' || !Number.isSafeInteger(o.expiresMs) || o.expiresMs <= o.atMs) throw new SettleError('An offer\'s expiry is a time in milliseconds, after it was signed.')
  if (o.prev !== null && (typeof o.prev !== 'string' || !HASH.test(o.prev))) throw new SettleError('An offer\'s prev is null or a 32-byte hash in hex.')
  if (typeof o.nonce !== 'string' || !NONCE.test(o.nonce)) throw new SettleError('An offer\'s nonce is 16 bytes in hex.')
  return o as Offer
}

export function parseMessage(x: unknown): Message {
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw new SettleError('A negotiation message is an object { offer, signature, key }.')
  const m = x as Record<string, unknown>
  const keys = Object.keys(m).sort().join(',')
  if (keys !== 'key,offer,signature') throw new SettleError(`A negotiation message has the fields ${keys}; it must have exactly offer, signature, key.`)
  if (typeof m.signature !== 'string' || !HEX.test(m.signature) || typeof m.key !== 'string' || !HEX.test(m.key)) throw new SettleError('A message\'s signature and key are hex.')
  return { offer: parseOffer(m.offer), signature: m.signature, key: m.key }
}

const pkhOf = (vkey: Buffer): string => cst.blake2b(28).update(vkey).digest('hex')

// The role's wallet signs the canonical payload, from the address party() derived (a preprod key address of that pkh).
export async function signOffer(p: Party, offer: Offer): Promise<Message> {
  const o = parseOffer(offer)
  if (p.role !== o.by) throw new SettleError(`This ${p.role} key cannot sign an offer made by the ${o.by}.`)
  const s = await p.wallet.signData(payloadHex(o), p.address)
  return { offer: o, signature: s.signature, key: s.key }
}

// One message on its own: the signed payload is this offer's canonical bytes (not detached, not another offer), the key
// hashes to the pkh the escrow datum gives the role in offer.by, the address in the protected header is a preprod key
// address whose payment key is that pkh, and the COSE_Sign1 verifies. Returns the signing address.
export async function verifyMessage(msg: Message, expected: Expected, check: CheckSignature = mesh.checkSignature): Promise<string> {
  const { offer, signature, key } = parseMessage(msg)
  const what = `the ${offer.kind} by the ${offer.by}`
  const pkh = offer.by === 'buyer' ? expected.buyerPkh : expected.sellerPkh
  let cose: InstanceType<typeof cst.CoseSign1>
  try {
    cose = cst.CoseSign1.fromCbor(signature)
  } catch (error: unknown) {
    throw new SettleError(`The signature of ${what} is not a COSE_Sign1.`, { cause: error })
  }
  let signed: Buffer | null
  try {
    signed = cose.getPayload()
  } catch (error: unknown) {
    throw new SettleError(`The signature of ${what} carries no payload (detached).`, { cause: error })
  }
  if (!signed || !signed.equals(payloadBytes(offer))) throw new SettleError(`The signed payload is not ${what} as written: it was changed after signing, or signed detached.`)
  // Mesh's parser ignores bytes after the COSE_Sign1 and accepts other CBOR spellings of it. Re-encoded, it must give back
  // the hex as written, so a signature has one spelling (Mesh's signData writes exactly this encoding).
  const sig = cose.getSignature()
  if (!sig || cose.buildMessage(sig).toString('hex') !== signature) throw new SettleError(`The signature of ${what} is not a canonical COSE_Sign1 (trailing or re-encoded bytes).`)
  let vkey: Buffer
  try {
    vkey = cst.getPublicKeyFromCoseKey(key)
  } catch (error: unknown) {
    throw new SettleError(`The key of ${what} is not a COSE_Key.`, { cause: error })
  }
  if (vkey.length !== 32 || pkhOf(vkey) !== pkh) throw new SettleError(`${cap(what)} is signed by a key that is not the ${offer.by}'s on this escrow.`)
  // CIP-8 headers: the key id (label 4) is optional; when present it must be the COSE_Key's key. The address is required.
  let kid: Buffer | null = null
  try {
    kid = cose.getPublicKey()
  } catch (error: unknown) {
    // Mesh throws exactly this when the header is absent, which CIP-8 allows; a header present but unreadable is refused.
    if (!(error instanceof Error && error.message === 'Public key not found')) throw new SettleError(`The key id of ${what} is unreadable.`, { cause: error })
  }
  if (kid && !kid.equals(vkey)) throw new SettleError(`The signature of ${what} names another key than its COSE_Key.`)
  let address: string
  let props: ReturnType<InstanceType<typeof cst.Address>['getProps']>
  try {
    const a = cst.Address.fromBytes(cst.HexBlob(cose.getAddress().toString('hex')))
    address = a.toBech32()
    props = a.getProps()
  } catch (error: unknown) {
    throw new SettleError(`The signature of ${what} carries no readable address.`, { cause: error })
  }
  if (props.networkId !== 0 || !address.startsWith('addr_test1')) throw new SettleError(`${cap(what)} is signed from a non-preprod address.`)
  if (props.paymentPart?.type !== cst.CredentialType.KeyHash || props.paymentPart.hash !== pkh) throw new SettleError(`${cap(what)} is signed from an address whose payment key is not the ${offer.by}'s.`)
  if (!(await check(payloadHex(offer), { key, signature }, address))) throw new SettleError(`The signature of ${what} does not verify.`)
  return address
}
const cap = (s: string): string => s[0].toUpperCase() + s.slice(1)

// The whole negotiation. Turns are judged on signed times: each message is signed no earlier than the one it answers and
// no later than that one's expiry, and none later than the verifier's now (plus clock skew). So an accepted negotiation
// stays verifiable as a record; whether it can still be acted on is `fresh` (now within the accept's own expiry), and
// whether an open offer can still be answered is `expired`. Both use the verifier's now.
export async function verifyTranscript(messages: unknown, expected: Expected, nowMs: number, check: CheckSignature = mesh.checkSignature): Promise<Outcome> {
  if (!Array.isArray(messages) || messages.length === 0) throw new SettleError('The negotiation has no message.')
  const nonces = new Set<string>()
  let prev: Offer | null = null, prevHash: string | null = null
  for (const [i, raw] of messages.entries()) {
    const msg = parseMessage(raw)
    const o = msg.offer
    const at = `Message ${i + 1} (${o.kind} by the ${o.by})`
    await verifyMessage(msg, expected, check)
    if (prev?.kind === 'accept') throw new SettleError(`${at} comes after an accept: an accept ends the negotiation.`)
    if (!prev && o.kind !== 'propose') throw new SettleError(`${at}: a negotiation starts with a propose.`)
    if (prev && o.kind === 'propose') throw new SettleError(`${at}: a propose only opens a negotiation.`)
    if (o.prev !== prevHash) throw new SettleError(`${at} does not follow the message before it (its prev is not that message's hash).`)
    if (prev && (o.escrowRef !== prev.escrowRef || o.network !== prev.network || o.path !== prev.path)) throw new SettleError(`${at} is about another escrow, network or path than the negotiation.`)
    if (prev && o.by === prev.by) throw new SettleError(`${at} answers the ${prev.by}'s own ${prev.kind}: turns alternate.`)
    if (prev && o.kind === 'counter' && o.sellerShare === prev.sellerShare) throw new SettleError(`${at} repeats the share ${o.sellerShare}: a counter changes it, an accept repeats it.`)
    if (prev && o.kind === 'accept' && o.sellerShare !== prev.sellerShare) throw new SettleError(`${at} accepts ${o.sellerShare}, not the ${prev.sellerShare} on the table.`)
    if (nonces.has(o.nonce)) throw new SettleError(`${at} replays a nonce already used in this negotiation.`)
    nonces.add(o.nonce)
    if (o.atMs > nowMs + CLOCK_SKEW_MS) throw new SettleError(`${at} is signed in the future (${iso(o.atMs)}): refused.`)
    if (prev && o.atMs < prev.atMs) throw new SettleError(`${at} is signed before the message it answers: refused.`)
    if (prev && o.atMs > prev.expiresMs) throw new SettleError(`${at} answers the ${prev.kind} by the ${prev.by} after it expired at ${iso(prev.expiresMs)}: refused.`)
    prev = o
    prevHash = offerHash(o)
  }
  const last = prev as Offer
  const accepted = last.kind === 'accept'
  return { accepted, ...(accepted ? { sellerShare: last.sellerShare } : {}), by: last.by, last, head: prevHash as string, expired: !accepted && nowMs > last.expiresMs, fresh: accepted && nowMs <= last.expiresMs, messages: messages.length }
}

// The next offer of a negotiation, after verifying what is on file. A propose opens an empty one; a counter or an accept
// answers the open offer, by the other party, before it expires. The accept repeats the share on the table.
export async function nextOffer(messages: unknown[], expected: Expected, step: { escrowRef: string; kind: OfferKind; by: Side; sellerShare?: number }, nowMs: number, ttlMs = OFFER_TTL_MS, check: CheckSignature = mesh.checkSignature): Promise<Offer> {
  const base = { escrowRef: step.escrowRef, network: 'preprod' as const, path: 'B' as const, by: step.by, atMs: nowMs, expiresMs: nowMs + ttlMs, nonce: randomBytes(16).toString('hex') }
  if (step.kind === 'propose') {
    if (messages.length) throw new SettleError('A negotiation is already on file: counter or accept it.')
    if (step.sellerShare === undefined) throw new SettleError('A propose names a seller share.')
    return parseOffer({ ...base, kind: 'propose', sellerShare: step.sellerShare, prev: null })
  }
  const now = await verifyTranscript(messages, expected, nowMs, check)
  if (now.last.escrowRef !== step.escrowRef) throw new SettleError('The negotiation on file is about another escrow.')
  if (now.accepted) throw new SettleError(`This negotiation is accepted at ${now.sellerShare}: nothing follows an accept.`)
  if (now.expired) throw new SettleError(`The ${now.last.kind} by the ${now.last.by} expired at ${iso(now.last.expiresMs)}: propose again.`)
  if (now.by === step.by) throw new SettleError(`The ${step.by} made the offer on the table: the ${step.by === 'buyer' ? 'seller' : 'buyer'} answers it.`)
  if (step.kind === 'accept') {
    if (step.sellerShare !== undefined && step.sellerShare !== now.last.sellerShare) throw new SettleError(`An accept repeats the share on the table (${now.last.sellerShare}).`)
    return parseOffer({ ...base, kind: 'accept', sellerShare: now.last.sellerShare, prev: now.head })
  }
  if (step.sellerShare === undefined) throw new SettleError('A counter names a seller share.')
  if (step.sellerShare === now.last.sellerShare) throw new SettleError(`${step.sellerShare} is the share on the table: accept it, or counter with another.`)
  return parseOffer({ ...base, kind: 'counter', sellerShare: step.sellerShare, prev: now.head })
}

// --- the file drop ---

export function readTranscript(file: string): unknown[] | null {
  if (!existsSync(file)) return null
  const v: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (!Array.isArray(v)) throw new SettleError(`${file} is not a list of negotiation messages.`)
  return v
}

// Written to a temp file then renamed, so a reader never sees half a transcript.
export function writeTranscript(file: string, messages: Message[]): void {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file + '.tmp', JSON.stringify(messages, null, 2) + '\n')
  renameSync(file + '.tmp', file)
}

// The pkhs each side must sign with, from the escrow's datum on chain.
export async function expectedFor(escrowRef: string): Promise<Expected> {
  const d = readDatum((await escrowAt(escrowRef)).output.plutusData as string)
  if (d.buyer.payment.type !== 'key' || d.seller.payment.type !== 'key') throw new SettleError('Only key-controlled parties can sign a negotiation.')
  return { buyerPkh: d.buyer.payment.hash, sellerPkh: d.seller.payment.hash }
}

// The negotiation on file for this escrow, verified against the chain's pkhs at nowMs; null when there is none.
export async function negotiated(escrowRef: string, nowMs = Date.now(), expected?: Expected): Promise<Outcome | null> {
  const messages = readTranscript(negotiationFile(escrowRef))
  if (!messages) return null
  const outcome = await verifyTranscript(messages, expected ?? (await expectedFor(escrowRef)), nowMs)
  if (outcome.last.escrowRef !== escrowRef) throw new SettleError(`${negotiationFile(escrowRef)} is about another escrow.`)
  return outcome
}

export type Step = { message: Message; address: string; hash: string; outcome: Outcome; file: string; replaced?: string }

// One CLI step: the role's key must be the escrow's for that role; the new transcript is verified whole before it is written.
// A propose replaces a negotiation on file only if that one is refused or no longer live (its open offer expired, or its
// accept is no longer fresh).
export async function negotiate(escrowRef: string, kind: OfferKind, role: Side, sellerShare: number | undefined, nowMs = Date.now()): Promise<Step> {
  const expected = await expectedFor(escrowRef)
  const p = await party(role)
  if (p.pkh !== (role === 'buyer' ? expected.buyerPkh : expected.sellerPkh)) throw new SettleError(`This ${role} key is not the escrow's ${role}.`)
  const file = negotiationFile(escrowRef)
  let messages: unknown[] = readTranscript(file) ?? []
  let replaced: string | undefined
  if (kind === 'propose' && messages.length) {
    let live: Outcome | null = null
    try {
      const o = await verifyTranscript(messages, expected, nowMs)
      if (o.accepted ? o.fresh : !o.expired) live = o
      else replaced = `its ${o.last.kind} by the ${o.last.by} expired at ${iso(o.last.expiresMs)}`
    } catch (error: unknown) {
      if (!(error instanceof SettleError)) throw error
      replaced = error.message
    }
    if (live) throw new SettleError(live.accepted ? `This negotiation is accepted at ${live.sellerShare}: pnpm sign --prepare ${escrowRef}` : `A ${live.last.kind} by the ${live.last.by} is open until ${iso(live.last.expiresMs)}: counter or accept it.`)
    messages = []
  }
  const offer = await nextOffer(messages, expected, { escrowRef, kind, by: role, sellerShare }, nowMs)
  const message = await signOffer(p, offer)
  const next = [...messages.map(parseMessage), message]
  const outcome = await verifyTranscript(next, expected, nowMs)
  const address = await verifyMessage(message, expected)
  writeTranscript(file, next)
  return { message, address, hash: offerHash(offer), outcome, file, ...(replaced ? { replaced } : {}) }
}
