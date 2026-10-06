import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PARAMS, SCRIPT_HASH, V1_ADDRESS } from '../../shared/constants.ts'
import { applyV1, deployedV1 } from './script.ts'

test('vendored blueprint + deployed params reproduce the deployed V1 script on both networks', () => {
  const s = deployedV1()
  assert.equal(s.hash, SCRIPT_HASH)
  assert.equal(s.address.preprod, V1_ADDRESS.preprod)
  assert.equal(s.address.mainnet, V1_ADDRESS.mainnet)
})

test('control: one parameter off by one gives another script', () => {
  assert.notEqual(applyV1({ ...PARAMS, cooldownMs: PARAMS.cooldownMs + 1 }).hash, SCRIPT_HASH)
  assert.notEqual(applyV1({ ...PARAMS, adminKeyHashes: [...PARAMS.adminKeyHashes].reverse() }).hash, SCRIPT_HASH)
})
