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

export async function getBank(): Promise<BankRow[]> {
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
