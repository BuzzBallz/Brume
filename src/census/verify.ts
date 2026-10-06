import { existsSync } from 'node:fs'
import { SCRIPT_HASH } from '../../shared/constants.ts'
import { REDEEMER } from '../../shared/types.ts'
import type { Network } from '../../shared/types.ts'
import * as blockfrost from '../read/blockfrost.ts'
import * as koios from '../read/koios.ts'
import type { TxInfo } from '../read/txinfo.ts'

// usage: node src/census/verify.ts <tx hash> [mainnet|preprod]
// Reads the transaction on Koios (keyless) and, with a Blockfrost key in .env, on a second indexer, and prints whether they agree.
if (existsSync('.env')) process.loadEnvFile('.env')

const [hash, netArg] = process.argv.slice(2)
if (!/^[0-9a-f]{64}$/i.test(hash ?? '') || (netArg && netArg !== 'mainnet' && netArg !== 'preprod')) {
  console.error('usage: node src/census/verify.ts <64 hex tx hash> [mainnet|preprod]')
  process.exit(2)
}

async function find(net: Network) {
  const k = await koios.tx(net, hash)
  const b = blockfrost.available(net) ? await blockfrost.tx(net, hash) : null
  return { net, k, b }
}

let found = await find((netArg as Network) ?? 'mainnet')
if (!netArg && !found.k.data && !found.k.holes && !found.b?.data) found = await find('preprod')
const { net, k, b } = found

const holes = k.holes + (b?.holes ?? 0)
const show = (provider: string, t: TxInfo) => {
  console.log(`${provider}: block ${t.blockHeight} ${t.blockHash} · slot ${t.slot} · valid_contract ${t.validContract}`)
  for (const c of t.contracts) {
    const name = c.redeemer === null ? 'redeemer not read' : (REDEEMER[c.redeemer] ?? `constructor ${c.redeemer}`)
    console.log(`  ${c.purpose} · script ${c.scriptHash === SCRIPT_HASH ? 'V1 escrow' : c.scriptHash.slice(0, 12) + '…'} · ${name}`)
  }
  if (t.v1OutputStates.length) console.log(`  V1 escrow outputs: ${t.v1OutputStates.map((s) => s ?? 'state not readable').join(', ')}`)
}

console.log(`${net} · tx ${hash} · ${holes} holes`)
if (k.data) show('koios', k.data)
else console.log(k.holes ? 'koios: no answer (a hole, not proof the tx is absent)' : 'koios: not found')
if (b === null) console.log('blockfrost: skipped (no key). One indexer only, not cross-checked.')
else if (b.data) show('blockfrost', b.data)
else console.log(b.holes ? 'blockfrost: no answer (a hole)' : 'blockfrost: not found')

const tip = await koios.tip(net)
if (k.data && tip.data) console.log(`confirmations (koios tip ${tip.data.height}): ${tip.data.height - k.data.blockHeight}`)

const seen = [k.data, b?.data].filter((t): t is TxInfo => Boolean(t))
const sameBlock = seen.every((t) => t.blockHash === seen[0].blockHash)
const valid = seen.length > 0 && seen.every((t) => t.validContract !== false)
if (!seen.length) {
  console.log(holes ? 'RESULT: no answer (holes), nothing verified' : 'RESULT: not found')
  process.exit(holes ? 1 : 2)
}
if (!sameBlock) console.log('RESULT: MISMATCH, the indexers report different blocks')
else if (!valid) console.log('RESULT: the transaction is on chain but a script failed (valid_contract false)')
else console.log(`RESULT: found on ${seen.length === 2 ? 'two indexers, same block' : 'one indexer'}, valid_contract ${seen[0].validContract}`)
process.exit(sameBlock && valid && holes === 0 ? 0 : 1)
