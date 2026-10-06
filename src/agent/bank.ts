import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { State, Value } from '../../shared/types.ts'
import { EnvError } from '../preprod/env.ts'
import { party } from '../preprod/wallet.ts'
import { HttpError, readDatum, ROOT } from './escrow.ts'

export type BankRow = { ref: string; state: State; value: Value }

// One source of truth with tryAnyway: fixtures/preprod/bank.json. With preprod keys in .env, the bank is every escrow whose
// buyer or seller is one of them, so each machine lists what it can settle. Without keys, stream B's escrows, read-only.
// Each is read on its own; a spent one drops out, a provider hole fails the call (an empty bank must mean "none", not "unknown").
const entries = () => JSON.parse(readFileSync(join(ROOT, 'fixtures', 'preprod', 'bank.json'), 'utf8')) as { ref: string; owners?: string }[]

let localKeys: Promise<Set<string> | null> | null = null
const keys = () =>
  (localKeys ??= Promise.all([party('buyer'), party('seller')]).then(
    (ps) => new Set(ps.map((p) => p.pkh)),
    (e) => {
      if (e instanceof EnvError) return null
      localKeys = null
      throw e
    },
  ))

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
  const mine = await keys()
  const refs = entries().filter((e) => mine || e.owners === 'B').map((e) => e.ref)
  const reads = await Promise.all(
    refs.map((ref) =>
      readDatum('preprod', ref).then(
        (r): BankRow | null =>
          !mine || mine.has(r.datum.buyer.payment.hash) || mine.has(r.datum.seller.payment.hash) ? { ref, state: r.datum.state, value: r.value } : null,
        (e) => {
          if (e instanceof HttpError && e.status === 404) return null
          throw e
        },
      ),
    ),
  )
  return reads.filter((r): r is BankRow => r !== null).sort((a, b) => a.ref.localeCompare(b.ref))
}
