import { V1_ADDRESS } from '../../shared/constants.ts'
import type { State, Value } from '../../shared/types.ts'
import { decodeAll } from '../census/census.ts'
import { utxosAt } from '../read/koios.ts'
import type { RawUtxo } from '../../shared/types.ts'

// The two demo wallets of DEMO.md (public addresses): wallet 1 plays the buyer, wallet 2 the seller.
const BUYER = 'addr_test1qqlg6r6ww0kd0qxsw2zh6fd78qyk2f7k2rfgp3696sngcms6y3crsh87un2wt9rkk5g7m0t3z0rturaca94vdzjhzymsfct97t'
const SELLER = 'addr_test1qrvk6sgjjk7nsv9tg3jltr35g65nnsr98f7pw5c5p258geulnltrju4208p9ej3y5tc2nsw7cftqqnssjflvurd4we9stphwwa'

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'

// Payment key hash of a base address: header byte, then 28 bytes. The bech32 checksum is not checked, the input is our own constant.
export function paymentKeyHash(bech32: string) {
  const bits = [...bech32.slice(bech32.lastIndexOf('1') + 1, -6)].map((c) => CHARSET.indexOf(c).toString(2).padStart(5, '0')).join('')
  const bytes = bits.match(/.{8}/g)!.slice(0, 29).map((b) => parseInt(b, 2))
  return Buffer.from(bytes.slice(1)).toString('hex')
}

export type BankRow = { ref: string; state: State; value: Value }

// An escrow belongs to the bank when its datum names the demo buyer and seller.
export function pickBank(utxos: RawUtxo[], buyer: string, seller: string): BankRow[] {
  return decodeAll(utxos)
    .filter((d) => d.datum && d.datum.buyer.payment.hash === buyer && d.datum.seller.payment.hash === seller)
    .map((d) => ({ ref: d.utxo.ref, state: d.datum!.state, value: d.utxo.value }))
    .sort((a, b) => a.ref.localeCompare(b.ref))
}

const TTL_MS = 15_000
let cache: { at: number; read: Promise<BankRow[]> } | null = null

// Reads the shared preprod V1 address and keeps ours. A provider hole throws: an empty bank must mean "none", not "unknown".
export function getBank(): Promise<BankRow[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.read
  const read = utxosAt('preprod', V1_ADDRESS.preprod).then((r) => {
    if (r.holes) throw new Error('preprod read had holes')
    return pickBank(r.data, paymentKeyHash(BUYER), paymentKeyHash(SELLER))
  })
  read.catch(() => (cache = null))
  cache = { at: Date.now(), read }
  return read
}
