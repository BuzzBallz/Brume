// An independent check of registry.ts, by another Koios route: policy_asset_info returns every asset of a policy with
// its supply and latest-mint metadata in one listing, where registry.ts lists with policy_asset_list and then reads each
// asset with asset_info. Shares nothing with registry.ts but the policy ids and the words. Prints the Koios tip read
// before and after: compare with registry.ts's receipt only when the tips match (same block), otherwise run both again.
//   node src/census/registry-check.ts
import { KOIOS } from '../../shared/constants.ts'

const POLICIES = { V1: 'ad6424e3ce9e47bbd8364984bd731b41de591f1d11f6d7d43d0da9b9', V2: '67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b' }
const WORDS = ['dispute', 'refund', 'split', 'mediation', 'arbitration', 'arbiter', 'escrow']
type Row = { asset_name: string; total_supply: string; minting_tx_metadata: Record<string, unknown> | null }

async function json<T>(url: string): Promise<T> {
  for (let attempt = 0, wait = 1_000; ; attempt++, wait *= 2) {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(60_000) }).catch(() => null)
    if (res?.ok) return (await res.json()) as T
    if (attempt === 5) throw new Error(`Koios ${url.split('?')[0]}: no answer after retries (a hole: no claim)`)
    await new Promise((r) => setTimeout(r, wait))
  }
}
const tip = async (): Promise<number> => (await json<{ block_no: number }[]>(`${KOIOS.mainnet}/tip`))[0].block_no

const before = await tip()
let total = 0
for (const [version, policy] of Object.entries(POLICIES)) {
  const rows: Row[] = []
  for (let offset = 0; ; offset += 1000) {
    const page = await json<Row[]>(`${KOIOS.mainnet}/policy_asset_info?_asset_policy=${policy}&order=asset_name.asc&offset=${offset}&limit=1000`)
    rows.push(...page)
    if (page.length < 1000) break
  }
  const live = rows.filter((r) => BigInt(r.total_supply) > 0n)
  const noMeta = live.filter((r) => !r.minting_tx_metadata?.['721']).length
  const counts = WORDS.map((w) => `${w} ${live.filter((r) => JSON.stringify(r.minting_tx_metadata?.['721'] ?? '').toLowerCase().includes(w)).length}`)
  console.log(`${version} ${policy.slice(0, 8)}…: ${live.length} live of ${rows.length}, ${noMeta} live without 721 metadata; assets mentioning: ${counts.join(', ')}`)
  total += live.length
}
const after = await tip()
console.log(`tip ${before}${after === before ? '' : ` → ${after} (moved during the read: run again before comparing)`}: ${total} live registrations on mainnet`)
