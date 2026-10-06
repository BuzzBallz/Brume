import { isDeepStrictEqual } from 'node:util'
import { STATE, type Address, type Credential, type Datum, type State } from '../../shared/types.ts'

// V1 escrow datum <-> Plutus Data CBOR, written by hand: the continuation datum must copy the input's bytes, and no
// library here exposes byte spans. Only the subset the V1 datum uses is read: constr tags 121..127, lists, bytes, uints.

export class DatumError extends Error {}

export type Span = { start: number; end: number }
export type DatumPatch = { resultHash?: string; sellerCooldownTime?: number; buyerCooldownTime?: number; state?: State }

export const DATUM_FIELDS = [
  'buyer', 'seller', 'referenceKey', 'referenceSignature', 'sellerNonce', 'buyerNonce', 'collateralReturnLovelace',
  'inputHash', 'resultHash', 'payByTime', 'submitResultTime', 'unlockTime', 'externalDisputeUnlockTime',
  'sellerCooldownTime', 'buyerCooldownTime', 'state',
] as const satisfies readonly (keyof Datum)[]

// The fields a continuation output may change; every other field must come back byte for byte.
const PATCHABLE: Record<keyof DatumPatch, number> = { resultHash: 8, sellerCooldownTime: 13, buyerCooldownTime: 14, state: 15 }

// The ledger refuses definite bytestrings over 64 bytes inside Plutus data: longer ones go out in 64-byte chunks.
const CHUNK = 64
const HASH28 = 28
const MAX_DEPTH = 16 // the V1 datum nests 5 deep; the cap only keeps a hostile input off the stack

// ---------- decoding ----------

type Node =
  | { kind: 'constr'; index: number; fields: Node[]; start: number; end: number }
  | { kind: 'int'; value: bigint; start: number; end: number }
  | { kind: 'bytes'; hex: string; start: number; end: number }

function toBytes(cborHex: string): Uint8Array {
  // Buffer.from(…, 'hex') stops silently at the first bad pair: check first, or a typo decodes as a truncation.
  if (typeof cborHex !== 'string' || !/^(?:[0-9a-fA-F]{2})*$/.test(cborHex)) throw new DatumError('datum is not an even-length hex string')
  return Uint8Array.from(Buffer.from(cborHex, 'hex'))
}

function parse(buf: Uint8Array): Node {
  let pos = 0

  const need = (n: number): void => {
    if (pos + n > buf.length) throw new DatumError(`truncated CBOR: ${n} more byte(s) needed at byte ${pos}, ${buf.length} in total`)
  }

  // Returns the major type and its argument; null argument = indefinite length.
  const head = (): { major: number; arg: bigint | null; at: number } => {
    const at = pos
    need(1)
    const ib = buf[pos++]!
    const major = ib >> 5
    const info = ib & 0x1f
    if (info < 24) return { major, arg: BigInt(info), at }
    if (info === 31) {
      if (major !== 2 && major !== 4) throw new DatumError(`indefinite length on major type ${major} at byte ${at}`)
      return { major, arg: null, at }
    }
    if (info > 27) throw new DatumError(`reserved additional info ${info} at byte ${at}`)
    const size = 1 << (info - 24)
    need(size)
    let arg = 0n
    for (let i = 0; i < size; i++) arg = (arg << 8n) | BigInt(buf[pos++]!)
    return { major, arg, at }
  }

  // A length can never exceed what is left: checked here, before Number() can lose precision.
  const length = (arg: bigint, at: number): number => {
    if (arg > BigInt(buf.length - pos)) throw new DatumError(`truncated CBOR: length ${arg} at byte ${at} exceeds the ${buf.length - pos} byte(s) left`)
    return Number(arg)
  }

  const isBreak = (): boolean => {
    need(1)
    return buf[pos] === 0xff
  }

  const bytesBody = (arg: bigint | null, at: number): string => {
    if (arg !== null) {
      const n = length(arg, at)
      const hex = Buffer.from(buf.subarray(pos, pos + n)).toString('hex')
      pos += n
      return hex
    }
    let hex = ''
    while (!isBreak()) {
      const chunk = head()
      if (chunk.major !== 2 || chunk.arg === null) throw new DatumError(`chunk of an indefinite bytestring at byte ${chunk.at} is not a definite bytestring`)
      hex += bytesBody(chunk.arg, chunk.at)
    }
    pos++
    return hex
  }

  const item = (depth: number): Node => {
    if (depth > MAX_DEPTH) throw new DatumError(`nesting deeper than ${MAX_DEPTH}`)
    const start = pos
    const h = head()
    switch (h.major) {
      case 0:
        return { kind: 'int', value: h.arg!, start, end: pos }
      case 1:
        return { kind: 'int', value: -1n - h.arg!, start, end: pos }
      case 2: {
        const hex = bytesBody(h.arg, h.at)
        return { kind: 'bytes', hex, start, end: pos }
      }
      case 6: {
        const tag = h.arg!
        if (tag < 121n || tag > 127n) throw new DatumError(`tag ${tag} at byte ${h.at} is not a Plutus constructor 0..6 (121..127)`)
        const list = head()
        if (list.major !== 4) throw new DatumError(`constructor at byte ${h.at} is not followed by a field list`)
        const fields: Node[] = []
        if (list.arg === null) {
          while (!isBreak()) fields.push(item(depth + 1))
          pos++
        } else {
          const n = length(list.arg, list.at) // every field takes at least one byte
          for (let i = 0; i < n; i++) fields.push(item(depth + 1))
        }
        return { kind: 'constr', index: Number(tag - 121n), fields, start, end: pos }
      }
      default:
        throw new DatumError(`major type ${h.major} at byte ${h.at} has no place in a V1 datum`)
    }
  }

  const root = item(0)
  if (pos !== buf.length) throw new DatumError(`${buf.length - pos} trailing byte(s) after the datum`)
  return root
}

const kindOf = (n: Node): string => (n.kind === 'constr' ? `constructor ${n.index} with ${n.fields.length} field(s)` : n.kind)

function asBytes(n: Node, what: string): string {
  if (n.kind !== 'bytes') throw new DatumError(`${what}: expected bytes, got ${kindOf(n)}`)
  return n.hex
}

function asInt(n: Node, what: string): number {
  if (n.kind !== 'int') throw new DatumError(`${what}: expected an integer, got ${kindOf(n)}`)
  if (n.value < 0n) throw new DatumError(`${what}: negative integer ${n.value}`)
  if (n.value > BigInt(Number.MAX_SAFE_INTEGER)) throw new DatumError(`${what}: ${n.value} exceeds Number.MAX_SAFE_INTEGER`)
  return Number(n.value)
}

function asConstr(n: Node, what: string, arity: number): Extract<Node, { kind: 'constr' }> {
  if (n.kind !== 'constr' || n.fields.length !== arity) throw new DatumError(`${what}: expected a constructor with ${arity} field(s), got ${kindOf(n)}`)
  return n
}

// Plutus Credential: Constr 0 [keyhash] | Constr 1 [scripthash]. Ledger credentials are 28-byte hashes.
function asCredential(n: Node, what: string): Credential {
  const c = asConstr(n, what, 1)
  if (c.index > 1) throw new DatumError(`${what}: constructor ${c.index} is not a credential (0 key, 1 script)`)
  const hash = asBytes(c.fields[0]!, what)
  if (hash.length !== HASH28 * 2) throw new DatumError(`${what}: a credential hash is ${HASH28} bytes, got ${hash.length / 2}`)
  return { type: c.index === 0 ? 'key' : 'script', hash }
}

// Plutus Address: Constr 0 [payment, Option<Referenced<Credential>>]. None = Constr 1 [], Some(Inline c) = Constr 0 [Constr 0 [c]].
function asAddress(n: Node, what: string): Address {
  const a = asConstr(n, what, 2)
  if (a.index !== 0) throw new DatumError(`${what}: an address is constructor 0, got ${a.index}`)
  const payment = asCredential(a.fields[0]!, `${what} payment credential`)
  const opt = a.fields[1]!
  if (opt.kind !== 'constr') throw new DatumError(`${what} stake: expected an option, got ${kindOf(opt)}`)
  if (opt.index === 1) {
    asConstr(opt, `${what} stake (None)`, 0)
    return { payment, stake: null }
  }
  if (opt.index !== 0) throw new DatumError(`${what} stake: constructor ${opt.index} is not an option (0 Some, 1 None)`)
  const ref = asConstr(opt, `${what} stake (Some)`, 1).fields[0]!
  if (ref.kind === 'constr' && ref.index === 1) throw new DatumError(`${what} stake: pointer stake credentials are not supported`)
  const inline = asConstr(ref, `${what} stake (Inline)`, 1)
  if (inline.index !== 0) throw new DatumError(`${what} stake: constructor ${inline.index} is not a referenced credential (0 inline, 1 pointer)`)
  return { payment, stake: asCredential(inline.fields[0]!, `${what} stake credential`) }
}

function asState(n: Node, what: string): State {
  const s = asConstr(n, what, 0)
  const state = STATE[s.index]
  if (state === undefined) throw new DatumError(`${what}: constructor ${s.index} is not a V1 state (0..${STATE.length - 1})`)
  return state
}

function toDatum(root: Node): Datum {
  const top = asConstr(root, 'datum', DATUM_FIELDS.length)
  if (top.index !== 0) throw new DatumError(`datum: expected constructor 0, got ${top.index}`)
  const f = top.fields
  const at = (i: number): [Node, string] => [f[i]!, `field ${i} (${DATUM_FIELDS[i]})`]
  return {
    buyer: asAddress(...at(0)),
    seller: asAddress(...at(1)),
    referenceKey: asBytes(...at(2)),
    referenceSignature: asBytes(...at(3)),
    sellerNonce: asBytes(...at(4)),
    buyerNonce: asBytes(...at(5)),
    collateralReturnLovelace: asInt(...at(6)),
    inputHash: asBytes(...at(7)),
    resultHash: asBytes(...at(8)),
    payByTime: asInt(...at(9)),
    submitResultTime: asInt(...at(10)),
    unlockTime: asInt(...at(11)),
    externalDisputeUnlockTime: asInt(...at(12)),
    sellerCooldownTime: asInt(...at(13)),
    buyerCooldownTime: asInt(...at(14)),
    state: asState(...at(15)),
  }
}

// Strict: definite or indefinite lists, definite or chunked bytes, nothing after the datum. Bytes come back lowercase,
// chunks concatenated. A definite bytestring over 64 bytes is read (it cannot be on chain, but it is unambiguous).
export function readDatum(cborHex: string): Datum {
  return toDatum(parse(toBytes(cborHex)))
}

// Offsets are HEX-CHARACTER offsets into cborHex (= 2 × byte offset), so cborHex.slice(start, end) is that field's CBOR.
// The datum is fully validated first: no span is returned for a datum readDatum would refuse.
export function fieldSpans(cborHex: string): Span[] {
  const root = parse(toBytes(cborHex))
  toDatum(root)
  return (root as Extract<Node, { kind: 'constr' }>).fields.map((n) => ({ start: n.start * 2, end: n.end * 2 }))
}

// ---------- encoding (on-chain style: indefinite non-empty lists, 80 for an empty one, minimal heads) ----------

function uintHead(major: number, n: number | bigint): string {
  const v = BigInt(n)
  const ib = (extra: number): string => ((major << 5) | extra).toString(16).padStart(2, '0')
  if (v < 24n) return ib(Number(v))
  if (v < 0x100n) return ib(24) + v.toString(16).padStart(2, '0')
  if (v < 0x10000n) return ib(25) + v.toString(16).padStart(4, '0')
  if (v < 0x100000000n) return ib(26) + v.toString(16).padStart(8, '0')
  return ib(27) + v.toString(16).padStart(16, '0')
}

function hexOf(value: string, what: string): string {
  if (typeof value !== 'string' || !/^(?:[0-9a-fA-F]{2})*$/.test(value)) throw new DatumError(`${what}: not an even-length hex string`)
  return value.toLowerCase()
}

function encBytes(value: string, what: string): string {
  const hex = hexOf(value, what)
  const n = hex.length / 2
  if (n <= CHUNK) return uintHead(2, n) + hex
  let out = '5f'
  for (let i = 0; i < hex.length; i += CHUNK * 2) {
    const chunk = hex.slice(i, i + CHUNK * 2)
    out += uintHead(2, chunk.length / 2) + chunk
  }
  return out + 'ff'
}

function encInt(n: number, what: string): string {
  if (!Number.isSafeInteger(n) || n < 0) throw new DatumError(`${what}: ${n} is not a non-negative safe integer`)
  return uintHead(0, n)
}

function encConstr(index: number, fields: string[]): string {
  if (!Number.isInteger(index) || index < 0 || index > 6) throw new DatumError(`constructor ${index} is outside 0..6`)
  return uintHead(6, 121 + index) + (fields.length === 0 ? '80' : '9f' + fields.join('') + 'ff')
}

function encCredential(c: Credential, what: string): string {
  if (c.type !== 'key' && c.type !== 'script') throw new DatumError(`${what}: credential type ${String(c.type)}`)
  const hash = hexOf(c.hash, what)
  if (hash.length !== HASH28 * 2) throw new DatumError(`${what}: a credential hash is ${HASH28} bytes, got ${hash.length / 2}`)
  return encConstr(c.type === 'key' ? 0 : 1, [encBytes(hash, what)])
}

function encAddress(a: Address, what: string): string {
  const stake = a.stake === null ? encConstr(1, []) : encConstr(0, [encConstr(0, [encCredential(a.stake, `${what} stake`)])])
  return encConstr(0, [encCredential(a.payment, `${what} payment`), stake])
}

function encState(s: State): string {
  const index = STATE.indexOf(s)
  if (index < 0) throw new DatumError(`state ${String(s)} is not a V1 state`)
  return encConstr(index, [])
}

// Used to lock our own preprod fixture escrows. Reproduces the mainnet encoding byte for byte (see datum.test.ts).
export function encodeDatum(d: Datum): string {
  return encConstr(0, [
    encAddress(d.buyer, 'buyer'),
    encAddress(d.seller, 'seller'),
    encBytes(d.referenceKey, 'referenceKey'),
    encBytes(d.referenceSignature, 'referenceSignature'),
    encBytes(d.sellerNonce, 'sellerNonce'),
    encBytes(d.buyerNonce, 'buyerNonce'),
    encInt(d.collateralReturnLovelace, 'collateralReturnLovelace'),
    encBytes(d.inputHash, 'inputHash'),
    encBytes(d.resultHash, 'resultHash'),
    encInt(d.payByTime, 'payByTime'),
    encInt(d.submitResultTime, 'submitResultTime'),
    encInt(d.unlockTime, 'unlockTime'),
    encInt(d.externalDisputeUnlockTime, 'externalDisputeUnlockTime'),
    encInt(d.sellerCooldownTime, 'sellerCooldownTime'),
    encInt(d.buyerCooldownTime, 'buyerCooldownTime'),
    encState(d.state),
  ])
}

// ---------- continuation datum ----------

// Re-encodes only the patched top-level fields; every other byte (outer header, other fields, break) is the input's.
// Never rebuilt from the decoded type: a field encoded differently from the input would fail the validator's datum check.
// The result is read back and must equal the input's decoded datum with exactly the patch applied.
export function patchDatum(cborHex: string, patch: DatumPatch): string {
  for (const k of Object.keys(patch)) if (!(k in PATCHABLE)) throw new DatumError(`${k} is not a patchable datum field`)
  const hex = hexOf(cborHex, 'datum')
  const spans = fieldSpans(hex)
  const before = readDatum(hex)
  const encoded = new Map<number, string>()
  if (patch.resultHash !== undefined) encoded.set(PATCHABLE.resultHash, encBytes(patch.resultHash, 'resultHash'))
  if (patch.sellerCooldownTime !== undefined) encoded.set(PATCHABLE.sellerCooldownTime, encInt(patch.sellerCooldownTime, 'sellerCooldownTime'))
  if (patch.buyerCooldownTime !== undefined) encoded.set(PATCHABLE.buyerCooldownTime, encInt(patch.buyerCooldownTime, 'buyerCooldownTime'))
  if (patch.state !== undefined) encoded.set(PATCHABLE.state, encState(patch.state))
  let out = ''
  let cursor = 0
  for (const [i, s] of spans.entries()) {
    const replacement = encoded.get(i)
    if (replacement === undefined) continue
    out += hex.slice(cursor, s.start) + replacement
    cursor = s.end
  }
  out += hex.slice(cursor)
  const want: Datum = { ...before }
  if (patch.resultHash !== undefined) want.resultHash = patch.resultHash.toLowerCase()
  if (patch.sellerCooldownTime !== undefined) want.sellerCooldownTime = patch.sellerCooldownTime
  if (patch.buyerCooldownTime !== undefined) want.buyerCooldownTime = patch.buyerCooldownTime
  if (patch.state !== undefined) want.state = patch.state
  if (!isDeepStrictEqual(readDatum(out), want)) throw new DatumError('patched datum does not read back as the input plus the patch')
  return out
}
