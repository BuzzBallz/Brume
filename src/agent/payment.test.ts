import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canonical, inputHash, resultHash } from './payment.ts'

// RFC 8785 section 3.2.2, input and output character for character. "@u" stands for a backslash followed by "u", so no unicode escape sits in this source.
const U = String.fromCharCode(92) + 'u'
const RFC_INPUT = String.raw`{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],"string":"@u20ac$@u000F@u000aA'@u0042@u0022@u005c\\\"\/","literals":[null,true,false]}`.replaceAll('@u', U)
const RFC_OUTPUT = String.raw`{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$@u000f\nA'B\"\\\\\"/"}`.replaceAll('@u', U)
const RFC_HEX =
  '7b226c69746572616c73223a5b6e756c6c2c747275652c66616c73655d2c226e756d62657273223a5b3333333333333333332e333333333333332c3165' +
  '2b33302c342e352c302e3030322c31652d32375d2c22737472696e67223a22e282ac245c75303030665c6e4127425c225c5c5c5c5c222f227d'

test('canonical form matches the RFC 8785 worked example', () => {
  const out = canonical(JSON.parse(RFC_INPUT))
  assert.equal(out, RFC_OUTPUT)
  assert.equal(Buffer.from(out, 'utf8').toString('hex'), RFC_HEX)
})

// Expected values computed with Python's json.dumps(sort_keys=True, separators=(',', ':')) and hashlib, an independent implementation of MIP-004's `identifier;payload` pre-image.
test('input and result hashes match an independent implementation', () => {
  const id = 'a1b2c3d4e5f6a7b8c9d0'
  const input = { network: 'preprod', escrowRef: 'a7084c50029798fc0530b6c9abc2bf3e203b23e11102a3e8cdb90ede0c64970d#0' }
  assert.equal(inputHash(id, input), '1bc6877be6d8e999da1e57ced4e79aa6738760eeaf927c1e88ca683c5031e6da')
  assert.equal(inputHash(id, { escrowRef: input.escrowRef, network: input.network }), inputHash(id, input), 'key order does not matter')
  assert.equal(resultHash(id, '{"ok":true}'), '49a6fe74ac15e300c6f3a8a3ddbf7cb5ff4553e5a0b0c180445f383a21e8c0df')
})
