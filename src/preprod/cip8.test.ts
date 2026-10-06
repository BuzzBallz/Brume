// Offline: cip8.ts on throwaway keys made in memory (never printed, never written). fetch is replaced by a thrower for the
// whole file, so a test that reached the network would fail; checkSignature is Mesh's own, wrapped to count its calls.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { canonical, nextOffer, offerHash, payloadHex, readTranscript, signOffer, verifyMessage, verifyTranscript, writeTranscript, type CheckSignature, type Expected, type Message, type Offer } from './cip8.ts'
import { cst, mesh } from './mesh.ts'
import { SettleError } from './settle.ts'
import { parse } from './sign.ts'
import type { Party } from './wallet.ts'

// The core-cst copy cst names loads libsodium lazily, and only checkSignature awaits it: the tests below that derive keys
// with cst.Ed25519PrivateKey (toPublic, signData) would otherwise race its init and fail now and then.
await cst.Crypto.ready()

globalThis.fetch = (async (input: string | URL | Request) => {
  throw new Error(`unexpected fetch in an offline test: ${String(input)}`)
}) as typeof fetch

const REF = randomBytes(32).toString('hex') + '#0'
const T0 = 1_791_000_000_000
const TTL = 30 * 60_000

async function throwaway(role: 'buyer' | 'seller'): Promise<Party> {
  const wallet = new mesh.MeshWallet({ networkId: 0, key: { type: 'root', bech32: mesh.resolvePrivateKey(mesh.MeshWallet.brew() as string[]) } })
  await wallet.init()
  const address = await wallet.getChangeAddress()
  return { role, wallet, address, pkh: mesh.deserializeAddress(address).pubKeyHash }
}
const buyer = await throwaway('buyer')
const seller = await throwaway('seller')
const stranger = await throwaway('buyer') // a third key, holding no role on the escrow
const expected: Expected = { buyerPkh: buyer.pkh, sellerPkh: seller.pkh }

const nonce = (): string => randomBytes(16).toString('hex')
const offer = (o: Partial<Offer> & Pick<Offer, 'kind' | 'by' | 'sellerShare' | 'prev'>): Offer =>
  ({ escrowRef: REF, network: 'preprod', path: 'B', atMs: T0, expiresMs: T0 + TTL, nonce: nonce(), ...o })

// The positive control every refusal below departs from: seller proposes 0.4, buyer counters 0.3, seller accepts 0.3.
async function valid(): Promise<Message[]> {
  const m1 = await signOffer(seller, offer({ kind: 'propose', by: 'seller', sellerShare: 0.4, prev: null }))
  const m2 = await signOffer(buyer, offer({ kind: 'counter', by: 'buyer', sellerShare: 0.3, prev: offerHash(m1.offer) }))
  const m3 = await signOffer(seller, offer({ kind: 'accept', by: 'seller', sellerShare: 0.3, prev: offerHash(m2.offer) }))
  return [m1, m2, m3]
}
const refused = (p: Promise<unknown>, text: string): Promise<void> =>
  assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof SettleError, `not a SettleError: ${String(e)}`)
    assert.ok(e.message.includes(text), `"${e.message}" does not include "${text}"`)
    return true
  })
const counted = (): { check: CheckSignature; calls: { data: string; address?: string }[] } => {
  const calls: { data: string; address?: string }[] = []
  return { calls, check: async (data, sig, address) => (calls.push({ data, address }), mesh.checkSignature(data, sig, address)) }
}

test('the canonical payload: keys sorted at every level, no whitespace, UTF-8; the hash is blake2b-256 of those bytes', () => {
  const o = offer({ kind: 'propose', by: 'seller', sellerShare: 0.4, prev: null, nonce: 'ab'.repeat(16) })
  const text = `{"atMs":${T0},"by":"seller","escrowRef":"${REF}","expiresMs":${T0 + TTL},"kind":"propose","network":"preprod","nonce":"${'ab'.repeat(16)}","path":"B","prev":null,"sellerShare":0.4}`
  assert.equal(canonical(o), text)
  assert.equal(canonical({ sellerShare: 0.4, by: 'seller', z: { b: 1, a: [2, { d: 1, c: 0 }] } }), '{"by":"seller","sellerShare":0.4,"z":{"a":[2,{"c":0,"d":1}],"b":1}}')
  const reordered = Object.fromEntries(Object.entries(o).reverse()) as Offer
  assert.equal(payloadHex(reordered), Buffer.from(text, 'utf8').toString('hex'))
  assert.equal(offerHash(reordered), cst.blake2b(32).update(Buffer.from(text, 'utf8')).digest('hex'))
  assert.throws(() => canonical({ s: Number.NaN }), SettleError)
})

test('a valid propose → counter → accept verifies, with checkSignature called offline on each message and its address', async () => {
  const msgs = await valid()
  const { check, calls } = counted()
  const out = await verifyTranscript(msgs, expected, T0, check)
  assert.deepEqual({ accepted: out.accepted, sellerShare: out.sellerShare, by: out.by, messages: out.messages, expired: out.expired }, { accepted: true, sellerShare: 0.3, by: 'seller', messages: 3, expired: false })
  assert.equal(out.head, offerHash(msgs[2].offer))
  assert.deepEqual(calls.map((c) => c.address), [seller.address, buyer.address, seller.address])
  assert.deepEqual(calls.map((c) => c.data), msgs.map((m) => payloadHex(m.offer)))
  // An open negotiation: no agreed share; the offer on the table expires.
  const open = await verifyTranscript(msgs.slice(0, 2), expected, T0)
  assert.deepEqual({ accepted: open.accepted, sellerShare: open.sellerShare, by: open.by, expired: open.expired }, { accepted: false, sellerShare: undefined, by: 'buyer', expired: false })
  assert.equal((await verifyTranscript(msgs.slice(0, 2), expected, T0 + TTL + 1)).expired, true)
})

test('a share changed after signing is refused; the same message untouched verifies', async () => {
  const [m1] = await valid()
  await verifyMessage(m1, expected)
  await refused(verifyMessage({ ...m1, offer: { ...m1.offer, sellerShare: 0.9 } }, expected), 'signed payload is not the propose by the seller')
  await refused(verifyTranscript([{ ...m1, offer: { ...m1.offer, sellerShare: 0.9 } }], expected, T0), 'signed payload is not')
})

test('a message signed by the other party\'s key is refused; the right party\'s key verifies', async () => {
  const o = offer({ kind: 'propose', by: 'buyer', sellerShare: 0.4, prev: null })
  await verifyMessage(await signOffer(buyer, o), expected)
  const s = await seller.wallet.signData(payloadHex(o), seller.address) // the seller signs an offer that says "by the buyer"
  await refused(verifyMessage({ offer: o, signature: s.signature, key: s.key }, expected), 'signed by a key that is not the buyer\'s')
  await refused(signOffer(seller, o), 'This seller key cannot sign an offer made by the buyer')
})

test('a key that does not hash to the expected pkh is refused, whether it signed or was swapped in', async () => {
  const o = offer({ kind: 'propose', by: 'buyer', sellerShare: 0.4, prev: null })
  const good = await signOffer(buyer, o)
  await verifyMessage(good, expected)
  await refused(verifyMessage(await signOffer(stranger, o), expected), 'signed by a key that is not the buyer\'s')
  const theirs = await signOffer(stranger, o)
  await refused(verifyMessage({ ...good, key: theirs.key }, expected), 'signed by a key that is not the buyer\'s')
  // The same stranger's message is accepted only when the expected pkh is the stranger's: the check is against `expected`.
  await verifyMessage(theirs, { ...expected, buyerPkh: stranger.pkh })
})

test('the signing address must be a preprod key address of that pkh; the signature bytes must verify', async () => {
  const k = cst.Ed25519PrivateKey.fromNormalBytes(randomBytes(32))
  const pkh = k.toPublic().hash().hex()
  const o = offer({ kind: 'propose', by: 'buyer', sellerShare: 0.4, prev: null })
  const at = (address: InstanceType<typeof cst.Address>): Message => ({ offer: o, ...cst.signData(payloadHex(o), { address, key: k }) })
  const e = { ...expected, buyerPkh: pkh }
  assert.equal(await verifyMessage(at(cst.buildEnterpriseAddress(0, cst.Hash28ByteBase16(pkh)).toAddress()), e), cst.buildEnterpriseAddress(0, cst.Hash28ByteBase16(pkh)).toAddress().toBech32())
  await refused(verifyMessage(at(cst.buildEnterpriseAddress(1, cst.Hash28ByteBase16(pkh)).toAddress()), e), 'non-preprod address')
  await refused(verifyMessage(at(cst.buildEnterpriseAddress(0, cst.Hash28ByteBase16(seller.pkh)).toAddress()), e), 'payment key is not the buyer\'s')
  // Flip one byte of the Ed25519 signature (the COSE_Sign1's last 64 bytes): payload, key and address still pass.
  const good = await signOffer(buyer, o)
  const bad = good.signature.slice(0, -2) + (good.signature.slice(-2) === '00' ? '01' : '00')
  const { check, calls } = counted()
  await refused(verifyMessage({ ...good, signature: bad }, expected, check), 'does not verify')
  assert.equal(calls.length, 1)
  await refused(verifyMessage(good, expected, async () => false), 'does not verify') // the injected check decides
})

test('a COSE key id that is not the COSE_Key is refused; a matching key id verifies', async () => {
  const o = offer({ kind: 'propose', by: 'buyer', sellerShare: 0.4, prev: null })
  const good = await signOffer(buyer, o)
  await verifyMessage(good, expected)
  // A stranger signs from the buyer's address, then the buyer's COSE_Key is swapped in: key, pkh and address all pass,
  // and only the key id in the protected header (the stranger's key) gives it away.
  const k = cst.Ed25519PrivateKey.fromNormalBytes(randomBytes(32))
  const forged = { offer: o, ...cst.signData(payloadHex(o), { address: cst.Address.fromBech32(buyer.address), key: k }), key: good.key }
  assert.equal(cst.CoseSign1.fromCbor(forged.signature).getPublicKey().toString('hex'), k.toPublic().hex()) // the header is there
  await refused(verifyMessage(forged, expected), 'names another key than its COSE_Key')
})

test('a signature with bytes after its COSE_Sign1 is refused; the same signature as written verifies', async () => {
  const good = await signOffer(buyer, offer({ kind: 'propose', by: 'buyer', sellerShare: 0.4, prev: null }))
  await verifyMessage(good, expected)
  const { check, calls } = counted()
  await refused(verifyMessage({ ...good, signature: good.signature + '00' }, expected, check), 'not a canonical COSE_Sign1')
  assert.equal(calls.length, 0)
})

test('a propose in the middle of a negotiation is refused; a counter in its place verifies', async () => {
  const [m1] = await valid()
  const reopen = await signOffer(buyer, offer({ kind: 'propose', by: 'buyer', sellerShare: 0.35, prev: offerHash(m1.offer) }))
  await refused(verifyTranscript([m1, reopen], expected, T0), 'a propose only opens a negotiation')
  const counter = await signOffer(buyer, { ...reopen.offer, kind: 'counter' })
  await verifyTranscript([m1, counter], expected, T0)
})

test('a broken prev chain is refused; the intact chain verifies', async () => {
  const [m1, m2] = await valid()
  await verifyTranscript([m1, m2], expected, T0)
  const bad = await signOffer(buyer, { ...m2.offer, prev: randomBytes(32).toString('hex') })
  await refused(verifyTranscript([m1, bad], expected, T0), 'does not follow the message before it')
  const first = await signOffer(seller, { ...m1.offer, prev: randomBytes(32).toString('hex') })
  await refused(verifyTranscript([first], expected, T0), 'does not follow')
})

test('two messages in a row by the same party are refused', async () => {
  const [m1] = await valid()
  const again = await signOffer(seller, offer({ kind: 'counter', by: 'seller', sellerShare: 0.35, prev: offerHash(m1.offer) }))
  await refused(verifyTranscript([m1, again], expected, T0), 'answers the seller\'s own propose: turns alternate')
  const reply = await signOffer(buyer, offer({ kind: 'counter', by: 'buyer', sellerShare: 0.35, prev: offerHash(m1.offer) }))
  await verifyTranscript([m1, reply], expected, T0)
})

test('an accept with another share than the one on the table is refused', async () => {
  const [m1, m2, m3] = await valid()
  await verifyTranscript([m1, m2, m3], expected, T0)
  const off = await signOffer(seller, { ...m3.offer, sellerShare: 0.31 })
  await refused(verifyTranscript([m1, m2, off], expected, T0), 'accepts 0.31, not the 0.3 on the table')
})

test('a counter that keeps the share is refused, and a negotiation starts with a propose', async () => {
  const [m1, m2] = await valid()
  const same = await signOffer(buyer, { ...m2.offer, sellerShare: m1.offer.sellerShare })
  await refused(verifyTranscript([m1, same], expected, T0), 'a counter changes it')
  await refused(verifyTranscript([m2], expected, T0), 'starts with a propose')
  await refused(verifyTranscript([], expected, T0), 'has no message')
})

test('anything after an accept is refused', async () => {
  const msgs = await valid()
  await verifyTranscript(msgs, expected, T0)
  const after = await signOffer(buyer, offer({ kind: 'counter', by: 'buyer', sellerShare: 0.2, prev: offerHash(msgs[2].offer) }))
  await refused(verifyTranscript([...msgs, after], expected, T0), 'comes after an accept')
  const reaccept = await signOffer(buyer, offer({ kind: 'accept', by: 'buyer', sellerShare: 0.3, prev: offerHash(msgs[2].offer) }))
  await refused(verifyTranscript([...msgs, reaccept], expected, T0), 'comes after an accept')
})

test('an accept signed after the offer it accepts expired is refused; an accepted negotiation stays verifiable as a record', async () => {
  const msgs = await valid() // all signed at T0; the buyer's counter expires at T0 + TTL
  const now = await verifyTranscript(msgs, expected, T0)
  const later = await verifyTranscript(msgs, expected, T0 + 10 * TTL) // long after: still a valid record, no longer fresh
  assert.deepEqual([now.accepted, now.fresh, later.accepted, later.fresh, later.sellerShare], [true, true, true, false, 0.3])
  const late = await signOffer(seller, { ...msgs[2].offer, atMs: T0 + TTL + 1, expiresMs: T0 + 2 * TTL })
  await refused(verifyTranscript([msgs[0], msgs[1], late], expected, T0 + TTL + 2), 'after it expired')
  const onTime = await signOffer(seller, { ...msgs[2].offer, atMs: T0 + TTL, expiresMs: T0 + 2 * TTL }) // up to the expiry it holds
  assert.equal((await verifyTranscript([msgs[0], msgs[1], onTime], expected, T0 + TTL)).accepted, true)
  const future = await signOffer(seller, { ...msgs[2].offer, atMs: T0 + 10 * 60_000 })
  await refused(verifyTranscript([msgs[0], msgs[1], future], expected, T0), 'signed in the future')
  const backwards = await signOffer(seller, { ...msgs[2].offer, atMs: T0 - 1 })
  await refused(verifyTranscript([msgs[0], msgs[1], backwards], expected, T0), 'signed before the message it answers')
  await refused(verifyTranscript([{ ...msgs[0], offer: { ...msgs[0].offer, expiresMs: T0 } }], expected, T0), 'after it was signed')
})

test('a replayed nonce is refused; fresh nonces verify', async () => {
  const [m1] = await valid()
  const replay = await signOffer(buyer, offer({ kind: 'counter', by: 'buyer', sellerShare: 0.3, prev: offerHash(m1.offer), nonce: m1.offer.nonce }))
  await refused(verifyTranscript([m1, replay], expected, T0), 'replays a nonce')
})

test('a message with an extra or missing field, or another escrow, network or path, is refused', async () => {
  const [m1, m2] = await valid()
  await refused(verifyTranscript([{ ...m1, extra: 1 }], expected, T0), 'must have exactly offer, signature, key')
  await refused(verifyTranscript([{ ...m1, offer: { ...m1.offer, note: 'x' } }], expected, T0), 'it must have exactly')
  await refused(verifyTranscript([{ ...m1, offer: { ...m1.offer, network: 'mainnet' } }], expected, T0), 'preprod only')
  await refused(verifyTranscript([{ ...m1, offer: { ...m1.offer, path: 'A' } }], expected, T0), 'path B')
  await refused(verifyTranscript([{ ...m1, offer: { ...m1.offer, sellerShare: 1 } }], expected, T0), 'strictly between 0 and 1')
  const elsewhere = await signOffer(buyer, { ...m2.offer, escrowRef: randomBytes(32).toString('hex') + '#1' })
  await refused(verifyTranscript([m1, elsewhere], expected, T0), 'another escrow, network or path')
})

test('nextOffer: chains, alternates and repeats the share, and refuses what verifyTranscript would refuse', async () => {
  const p = await nextOffer([], expected, { escrowRef: REF, kind: 'propose', by: 'buyer', sellerShare: 0.25 }, T0)
  assert.deepEqual({ prev: p.prev, expiresMs: p.expiresMs, by: p.by }, { prev: null, expiresMs: T0 + TTL, by: 'buyer' })
  const m1 = await signOffer(buyer, p)
  await refused(nextOffer([m1], expected, { escrowRef: REF, kind: 'propose', by: 'seller', sellerShare: 0.3 }, T0), 'already on file')
  await refused(nextOffer([m1], expected, { escrowRef: REF, kind: 'counter', by: 'buyer', sellerShare: 0.3 }, T0), 'the seller answers it')
  await refused(nextOffer([m1], expected, { escrowRef: REF, kind: 'counter', by: 'seller', sellerShare: 0.25 }, T0), 'is the share on the table')
  await refused(nextOffer([m1], expected, { escrowRef: REF, kind: 'accept', by: 'seller' }, T0 + TTL + 1), 'expired at')
  const a = await nextOffer([m1], expected, { escrowRef: REF, kind: 'accept', by: 'seller' }, T0 + 60_000)
  assert.deepEqual({ kind: a.kind, sellerShare: a.sellerShare, prev: a.prev }, { kind: 'accept', sellerShare: 0.25, prev: offerHash(m1.offer) })
  const done = [m1, await signOffer(seller, a)]
  assert.equal((await verifyTranscript(done, expected, T0 + 60_000)).sellerShare, 0.25)
  await refused(nextOffer(done, expected, { escrowRef: REF, kind: 'counter', by: 'buyer', sellerShare: 0.2 }, T0 + 60_000), 'nothing follows an accept')
})

test('a transcript round-trips through its file and still verifies; no temp file is left behind', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'brume-cip8-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'negotiation', `${REF.replace('#', '_')}.json`)
  assert.equal(readTranscript(file), null)
  const msgs = await valid()
  writeTranscript(file, msgs)
  const back = readTranscript(file)
  assert.deepEqual(back, msgs)
  assert.equal((await verifyTranscript(back, expected, T0)).sellerShare, 0.3)
  assert.equal(readTranscript(file + '.tmp'), null)
  // Nothing in the file is secret: the COSE_Key holds the public key only, and no root key prefix appears.
  assert.ok(!JSON.stringify(back).includes('xprv'))
})

// pnpm sign's argv: parse() reads, signs and fetches nothing, so these stay offline.
test('pnpm sign runs one mode at a time and refuses a flag its mode would ignore; each mode alone parses', () => {
  const ref = REF
  assert.deepEqual(parse(['--prepare', ref]), { mode: 'prepare', target: ref, replay: true })
  assert.deepEqual(parse(['--prepare', ref, '--share', '0.3']), { mode: 'prepare', target: ref, share: 0.3, replay: true })
  assert.deepEqual(parse(['--offer', ref, '--share', '0.4', '--role', 'seller']), { mode: 'offer', target: ref, role: 'seller', share: 0.4, replay: true })
  assert.deepEqual(parse(['--counter', ref, '--share', '0.3', '--role', 'buyer']), { mode: 'counter', target: ref, role: 'buyer', share: 0.3, replay: true })
  assert.deepEqual(parse(['--accept', ref, '--role', 'seller']), { mode: 'accept', target: ref, role: 'seller', replay: true })
  assert.deepEqual(parse(['--negotiation', ref]), { mode: 'negotiation', target: ref, replay: true })
  assert.deepEqual(parse(['--resend', ref]), { mode: 'resend', target: ref, replay: true })
  assert.deepEqual(parse(['--role', 'seller', '--no-replay', 'p.json']), { mode: 'file', target: 'p.json', role: 'seller', replay: false })
  const no = (argv: string[], text: string): void =>
    assert.throws(() => parse(argv), (e: unknown) => e instanceof SettleError && e.message.includes(text))
  no(['--prepare', ref, '--accept', ref, '--role', 'seller'], 'One mode at a time: --prepare and --accept')
  no(['--offer', ref, '--counter', ref, '--share', '0.3', '--role', 'buyer'], '--offer and --counter')
  no(['--negotiation', ref, '--resend', ref], '--resend and --negotiation')
  no(['--accept', ref, '--role', 'seller', 'p.json'], '--accept and a proposal file')
  no(['--role', 'buyer', 'a.json', 'b.json'], 'One proposal file at a time')
  no([], 'usage: pnpm sign')
  no(['--negotiation', ref, '--share', '0.3'], '--share is for --prepare, --offer and --counter')
  no(['--accept', ref, '--share', '0.3', '--role', 'seller'], 'no --share')
  no(['--prepare', ref, '--role', 'buyer'], '--role is for a signing step')
  no(['--offer', ref, '--share', '0.4'], 'needs --role buyer|seller')
  no(['--offer', ref, '--role', 'admin', '--share', '0.4'], 'needs --role buyer|seller')
  no(['--counter', ref, '--role', 'buyer'], 'A counter names a seller share')
  no(['--prepare', ref, '--share', '1'], 'strictly between 0 and 1')
  no(['--prepare', ref, '--share', 'x'], 'strictly between 0 and 1')
  no(['--prepare', ref, '--no-replay'], '--no-replay is for')
  no(['--role', 'buyer', '--no-replay', 'p.json'], '--no-replay is for')
  no(['--prepare', ''], '--prepare names an escrow')
})
