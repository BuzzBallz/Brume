import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { State, Value } from '../../shared/types.ts'
import { HttpError, readDatum, ROOT } from './escrow.ts'

export type BankRow = { ref: string; state: State; value: Value }

// One source of truth with tryAnyway: fixtures/preprod/bank.json, the escrows stream A locked for stream B ("owners": "B").
// Each is read on its own; a spent one drops out, a provider hole fails the call (an empty bank must mean "none", not "unknown").
const ours = (): string[] =>
  (JSON.parse(readFileSync(join(ROOT, 'fixtures', 'preprod', 'bank.json'), 'utf8')) as { ref: string; owners?: string }[])
    .filter((e) => e.owners === 'B')
    .map((e) => e.ref)

const TTL_MS = 15_000
let cache: { at: number; read: Promise<BankRow[]> } | null = null

// Cached 15 s: the UI reads the bank on each navigation, and every row is one provider call.
export function getBank(): Promise<BankRow[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.read
  const read = readBank()
  read.catch(() => (cache = null))
  cache = { at: Date.now(), read }
  return read
}

async function readBank(): Promise<BankRow[]> {
  const reads = await Promise.all(
    ours().map((ref) =>
      readDatum('preprod', ref).then(
        (r): BankRow => ({ ref, state: r.datum.state, value: r.value }),
        (e) => {
          if (e instanceof HttpError && e.status === 404) return null
          throw e
        },
      ),
    ),
  )
  return reads.filter((r): r is BankRow => r !== null).sort((a, b) => a.ref.localeCompare(b.ref))
}
