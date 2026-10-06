// Masumi agent registrations on mainnet, read-only and keyless (Koios): every live NFT of the V1 and V2 registry
// policies, and whether its registration metadata (CIP-25 label 721, from the asset's latest mint) mentions any of the
// words below. The policies are Masumi's own, from the payment service's config (REGISTRY_POLICY_ID_MAINNET and
// REGISTRY_POLICY_ID_V2_MAINNET). Live = total supply > 0. A failed read is a hole, counted: the claim needs 0 holes.
// Koios's offset paging is only stable with an explicit order, so the listing is ordered by asset name.
//   node src/census/registry.ts [--out fixtures/masumi/registry-<tip>.json]
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'
import { KOIOS } from '../../shared/constants.ts'
import { request } from '../read/http.ts'
import * as koios from '../read/koios.ts'

export const REGISTRIES = [
  { version: 'V1', policy: 'ad6424e3ce9e47bbd8364984bd731b41de591f1d11f6d7d43d0da9b9' },
  { version: 'V2', policy: '67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b' },
] as const
export const WORDS = ['dispute', 'refund', 'split', 'mediation', 'arbitration', 'arbiter', 'escrow'] as const
const PAGE = 1000
const BATCH = 20

type Listed = { asset_name: string; total_supply: string }
type Info = { asset_name: string; minting_tx_metadata: Record<string, unknown> | null }
export type RegistryRead = {
  version: string
  policy: string
  minted: number
  live: number
  read: number // live assets whose asset_info came back
  with721: number
  holes: number
  mentions: Record<string, string[]> // word → the live assets whose 721 metadata contains it
  context: Record<string, string[]> // word → up to 3 snippets around the first match
}

const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) })

export async function readRegistry(version: string, policy: string, base = KOIOS.mainnet): Promise<RegistryRead> {
  const out: RegistryRead = { version, policy, minted: 0, live: 0, read: 0, with721: 0, holes: 0, mentions: Object.fromEntries(WORDS.map((w) => [w, []])), context: {} }
  const live: string[] = []
  for (let offset = 0; ; offset += PAGE) {
    const res = await request(`${base}/policy_asset_list?_asset_policy=${policy}&order=asset_name.asc&offset=${offset}&limit=${PAGE}`, { headers: { accept: 'application/json' } })
    if (res?.status !== 200 || !Array.isArray(res.body)) {
      out.holes++
      break
    }
    const page = res.body as Listed[]
    out.minted += page.length
    live.push(...page.filter((a) => a.total_supply !== '0').map((a) => a.asset_name))
    if (page.length < PAGE) break
  }
  out.live = live.length
  for (let i = 0; i < live.length; i += BATCH) {
    const chunk = live.slice(i, i + BATCH)
    const res = await request(`${base}/asset_info`, post({ _asset_list: chunk.map((name) => [policy, name]) }))
    if (res?.status !== 200 || !Array.isArray(res.body)) {
      out.holes += chunk.length
      continue
    }
    const rows = res.body as Info[]
    out.read += rows.length
    out.holes += chunk.length - rows.length // an asset missing from the answer is a hole, never "no mention"
    for (const r of rows) {
      const m = r.minting_tx_metadata?.['721']
      if (!m) continue
      out.with721++
      const text = JSON.stringify(m).toLowerCase()
      for (const w of WORDS) {
        const at = text.indexOf(w)
        if (at < 0) continue
        out.mentions[w].push(r.asset_name)
        if ((out.context[w] ??= []).length < 3) out.context[w].push(text.slice(Math.max(0, at - 80), at + 60))
      }
    }
  }
  return out
}

if (process.argv[1]?.endsWith('registry.ts')) {
  const { values } = parseArgs({ options: { out: { type: 'string' } } })
  const before = await koios.tip('mainnet')
  if (!before.data) throw new Error('Koios mainnet tip: no answer, nothing can be pinned')
  const reads: RegistryRead[] = []
  for (const r of REGISTRIES) reads.push(await readRegistry(r.version, r.policy))
  const holes = reads.reduce((n, r) => n + r.holes, 0)
  const receipt = {
    label: "Masumi agent registrations on mainnet: live registry NFTs and their 721 metadata, searched for dispute-related words",
    network: 'mainnet',
    tipBefore: before.data,
    policySource: 'masumi-payment-service config: REGISTRY_POLICY_ID_MAINNET (V1), REGISTRY_POLICY_ID_V2_MAINNET (V2)',
    method: 'Koios policy_asset_list ordered by asset_name (live = total_supply > 0), then asset_info in batches of 20; minting_tx_metadata label 721 of the latest mint, lowercased JSON text search',
    words: WORDS,
    holes,
    registries: reads,
  }
  for (const r of reads) {
    const counts = WORDS.map((w) => `${w} ${r.mentions[w].length}`).join(', ')
    console.log(`${r.version} ${r.policy.slice(0, 8)}…: ${r.live} live of ${r.minted} minted, ${r.read} read, ${r.with721} with 721 metadata, ${r.holes} holes; assets mentioning: ${counts}`)
  }
  const total = reads.reduce((n, r) => n + r.live, 0)
  const none = ['dispute', 'refund', 'split', 'mediation', 'arbitration'].every((w) => reads.every((r) => r.mentions[w].length === 0))
  console.log(`tip ${before.data.height}: ${total} live registrations on mainnet; ${holes === 0 ? (none ? 'none mentions dispute, refund, split, mediation or arbitration' : 'some mention a dispute-related word (see above)') : `${holes} holes: no claim`}`)
  if (values.out) {
    mkdirSync(dirname(values.out), { recursive: true })
    writeFileSync(values.out, JSON.stringify(receipt, null, 2) + '\n')
    console.log(`→ ${values.out}`)
  }
}
