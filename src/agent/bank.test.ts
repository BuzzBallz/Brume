import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { SCRIPT_HASH, V1_ADDRESS } from '../../shared/constants.ts'
import type { RawUtxo } from '../../shared/types.ts'
import { paymentKeyHash, pickBank } from './bank.ts'

test('the bech32 decoder gives the payment key hash', () => {
  // an enterprise script address is a header byte plus the script hash
  assert.equal(paymentKeyHash(V1_ADDRESS.mainnet), SCRIPT_HASH)
  // reference values from @meshsdk/core resolvePaymentKeyHash for the two demo wallets
  assert.equal(paymentKeyHash('addr_test1qqlg6r6ww0kd0qxsw2zh6fd78qyk2f7k2rfgp3696sngcms6y3crsh87un2wt9rkk5g7m0t3z0rturaca94vdzjhzymsfct97t'), '3e8d0f4e73ecd780d072857d25be38096527d650d280c745d4268c6e')
  assert.equal(paymentKeyHash('addr_test1qrvk6sgjjk7nsv9tg3jltr35g65nnsr98f7pw5c5p258geulnltrju4208p9ej3y5tc2nsw7cftqqnssjflvurd4we9stphwwa'), 'd96d411295bd3830ab4465f58e3446a939c0653a7c1753140aa87467')
})

test('the bank keeps only escrows naming the demo buyer and seller', () => {
  const hex: string = JSON.parse(readFileSync(new URL('../../shared/mock/utxo-disputed.mock.json', import.meta.url), 'utf8')).utxo.inline_datum.bytes
  const utxo = (ref: string, inlineDatumCbor: string | null): RawUtxo => ({ ref, address: 'a', value: { lovelace: '1' }, inlineDatumCbor })
  const rows = [utxo('b#0', hex), utxo('a#0', hex), utxo('c#0', null), utxo('d#0', hex.slice(0, -2))]
  const buyer = '98d1fbc32e7063cbc6283d178598818779f36c063b545ce4eab049d2'
  const seller = 'b6a4dd0012febb08a87ca114b7127c51cd52901d6cc249b0551d17f3'
  assert.deepEqual(pickBank(rows, buyer, seller), [{ ref: 'a#0', state: 'Disputed', value: { lovelace: '1' } }, { ref: 'b#0', state: 'Disputed', value: { lovelace: '1' } }])
  assert.deepEqual(pickBank(rows, seller, buyer), [], 'buyer and seller are not interchangeable')
})
