// Offline: each committed witness walk is bound to its settlement on chain. Leg 1 spends the escrow the file is named
// after, and leg 2 spends leg 1's continuation (output 0), so "no admin key" is said of this settlement's two txs.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { Settlement } from './witnesses.ts'

test('every committed walk: leg 1 spends its escrow, leg 2 spends leg 1 output 0', () => {
  const dir = new URL('../../fixtures/preprod/', import.meta.url)
  const files = readdirSync(dir).filter((n) => /^witnesses-[0-9a-f]{64}_\d+\.json$/.test(n))
  assert.ok(files.length >= 11)
  for (const n of files) {
    const w = JSON.parse(readFileSync(new URL(n, dir), 'utf8')) as Settlement
    assert.equal(`witnesses-${w.escrowRef.replace('#', '_')}.json`, n)
    assert.equal(w.legs[0].redeemer.spends, w.escrowRef, n)
    assert.equal(w.legs[1].redeemer.spends, `${w.legs[0].txHash}#0`, n)
  }
})
