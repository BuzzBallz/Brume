import { STATE } from '../../shared/types.ts'
import type { Address, Credential, Datum } from '../../shared/types.ts'

export type Plutus = { constr: number; fields: Plutus[] } | { bytes: string } | { int: bigint } | { list: Plutus[] }

// Plutus data is CBOR: constructors are tags 121-127 (then 1280-1400) around an array, so a constructor is never a bare integer.
export function parsePlutus(hex: string): Plutus {
  if (hex.length % 2 || /[^0-9a-f]/i.test(hex)) throw new Error('cbor: not hex')
  const buf = Buffer.from(hex, 'hex')
  let at = 0
  const take = (n: number) => {
    if (at + n > buf.length) throw new Error('cbor: truncated')
    at += n
    return buf.subarray(at - n, at)
  }
  const head = () => {
    const b = take(1)[0]
    const major = b >> 5
    const info = b & 31
    if (info < 24) return { major, arg: BigInt(info), indef: false }
    if (info === 31 && (major === 2 || major === 4)) return { major, arg: 0n, indef: true }
    if (info > 27) throw new Error('cbor: unsupported head')
    return { major, arg: BigInt('0x' + take(1 << (info - 24)).toString('hex')), indef: false }
  }
  const atBreak = () => {
    if (buf[at] !== 0xff) return false
    at++
    return true
  }
  const items = (arg: bigint, indef: boolean) => {
    const out: Plutus[] = []
    if (indef) while (!atBreak()) out.push(item())
    else for (let i = 0n; i < arg; i++) out.push(item())
    return out
  }
  const bytesOf = (arg: bigint, indef: boolean) => {
    if (!indef) return take(Number(arg)).toString('hex')
    let out = ''
    while (!atBreak()) {
      const h = head()
      if (h.major !== 2 || h.indef) throw new Error('cbor: bad byte chunk')
      out += take(Number(h.arg)).toString('hex')
    }
    return out
  }
  const item = (): Plutus => {
    const { major, arg, indef } = head()
    if (major === 0) return { int: arg }
    if (major === 1) return { int: -1n - arg }
    if (major === 2) return { bytes: bytesOf(arg, indef) }
    if (major === 4) return { list: items(arg, indef) }
    if (major === 6) {
      const inner = item()
      if (arg === 2n || arg === 3n) {
        if (!('bytes' in inner)) throw new Error('cbor: bignum without bytes')
        const n = BigInt('0x' + (inner.bytes || '0'))
        return { int: arg === 2n ? n : -1n - n }
      }
      const index = arg >= 121n && arg <= 127n ? arg - 121n : arg >= 1280n && arg <= 1400n ? arg - 1273n : null
      if (index === null || !('list' in inner)) throw new Error(`cbor: unsupported tag ${arg}`)
      return { constr: Number(index), fields: inner.list }
    }
    throw new Error(`cbor: unsupported major type ${major}`)
  }
  const root = item()
  if (at !== buf.length) throw new Error('cbor: trailing bytes')
  return root
}

const bad = (what: string, why: string): never => {
  throw new Error(`datum: ${what} ${why}`)
}

function con(p: Plutus, what: string) {
  return 'constr' in p ? p : bad(what, 'is not a constructor')
}

function bytes(p: Plutus, what: string) {
  return 'bytes' in p ? p.bytes : bad(what, 'is not bytes')
}

function nat(p: Plutus, what: string) {
  if (!('int' in p) || p.int < 0n || p.int > BigInt(Number.MAX_SAFE_INTEGER)) return bad(what, 'is not a safe natural')
  return Number(p.int)
}

function credential(p: Plutus, what: string): Credential {
  const c = con(p, what)
  if (c.constr > 1 || c.fields.length !== 1) bad(what, 'is not a credential')
  const hash = bytes(c.fields[0], what)
  if (hash.length !== 56) bad(what, 'hash is not 28 bytes')
  return { type: c.constr === 0 ? 'key' : 'script', hash }
}

function address(p: Plutus, what: string): Address {
  const a = con(p, what)
  if (a.constr !== 0 || a.fields.length !== 2) bad(what, 'is not an address')
  const opt = con(a.fields[1], what)
  let stake: Credential | null = null
  if (opt.constr === 0 && opt.fields.length === 1) {
    const sc = con(opt.fields[0], what)
    if (sc.constr !== 0 || sc.fields.length !== 1) bad(what, 'has a pointer stake credential')
    stake = credential(sc.fields[0], what)
  } else if (opt.constr !== 1 || opt.fields.length !== 0) bad(what, 'has a malformed stake part')
  return { payment: credential(a.fields[0], what), stake }
}

export function decodeDatum(cborHex: string): Datum {
  const top = con(parsePlutus(cborHex), 'root')
  if (top.constr !== 0 || top.fields.length !== 16) bad('root', `has ${top.fields.length} fields, expected 16`)
  const f = top.fields
  const state = con(f[15], 'state')
  if (state.fields.length !== 0 || state.constr >= STATE.length) bad('state', 'is not a known constructor')
  return {
    buyer: address(f[0], 'buyer'),
    seller: address(f[1], 'seller'),
    referenceKey: bytes(f[2], 'referenceKey'),
    referenceSignature: bytes(f[3], 'referenceSignature'),
    sellerNonce: bytes(f[4], 'sellerNonce'),
    buyerNonce: bytes(f[5], 'buyerNonce'),
    collateralReturnLovelace: nat(f[6], 'collateralReturnLovelace'),
    inputHash: bytes(f[7], 'inputHash'),
    resultHash: bytes(f[8], 'resultHash'),
    payByTime: nat(f[9], 'payByTime'),
    submitResultTime: nat(f[10], 'submitResultTime'),
    unlockTime: nat(f[11], 'unlockTime'),
    externalDisputeUnlockTime: nat(f[12], 'externalDisputeUnlockTime'),
    sellerCooldownTime: nat(f[13], 'sellerCooldownTime'),
    buyerCooldownTime: nat(f[14], 'buyerCooldownTime'),
    state: STATE[state.constr],
  }
}
