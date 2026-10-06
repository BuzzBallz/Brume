import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Credential, Params } from '../../shared/types.ts'
import { PARAMS, SCRIPT_HASH, V1_ADDRESS } from '../../shared/constants.ts'
import { ROOT } from './env.ts'
import { cst } from './mesh.ts'

// The V1 escrow script, rebuilt from the vendored blueprint (vendor/PROVENANCE.md) and checked against the deployed hash.
export class ScriptMismatchError extends Error {}

export const BLUEPRINT_UNAPPLIED_HASH = 'e6d17c4860df984673606cbc92f682b3b5236e3450deab62500b0795'
const BLUEPRINT = join(ROOT, 'vendor', 'masumi-payment-service', 'plutus.json')

type Blueprint = { preamble: { compiler: { version: string } }; validators: { title: string; hash: string; compiledCode: string }[] }

export function blueprint(): { compiler: string; compiledCode: string } {
  const bp = JSON.parse(readFileSync(BLUEPRINT, 'utf8')) as Blueprint
  const v = bp.validators.find((x) => x.title === 'vested_pay.vested_pay.spend')
  if (!v || v.hash !== BLUEPRINT_UNAPPLIED_HASH) throw new ScriptMismatchError('vendored blueprint is not the V1 escrow (unapplied hash differs)')
  return { compiler: bp.preamble.compiler.version, compiledCode: v.compiledCode }
}

const cred = (c: Credential): { alternative: number; fields: string[] } => ({ alternative: c.type === 'key' ? 0 : 1, fields: [c.hash] })

export type Script = { cbor: string; hash: string; address: { preprod: string; mainnet: string } }

// Parameter order and encoding of the deployed script: [required admins, admin key hashes, fee address, fee permille, cooldown ms].
// Applied with the direct @meshsdk/core-cst import (beta.90): @meshsdk/core's copy (beta.96) gives a different script.
export function applyV1(p: Params): Script {
  const feeStake = p.feeAddress.stake ? { alternative: 0, fields: [{ alternative: 0, fields: [cred(p.feeAddress.stake)] }] } : { alternative: 1, fields: [] }
  const cbor = cst.applyParamsToScript(blueprint().compiledCode, [
    p.requiredAdmins,
    p.adminKeyHashes,
    { alternative: 0, fields: [cred(p.feeAddress.payment), feeStake] },
    p.feePermille,
    p.cooldownMs,
  ])
  const preprod: string = cst.resolvePlutusScriptAddress({ code: cbor, version: 'V3' }, 0)
  const mainnet: string = cst.resolvePlutusScriptAddress({ code: cbor, version: 'V3' }, 1)
  return { cbor, hash: cst.resolvePlutusScriptHash(preprod), address: { preprod, mainnet } }
}

let deployed: Script | null = null
// The shared V1 script: refuses to return anything whose hash is not the deployed one.
export function deployedV1(): Script {
  if (deployed) return deployed
  const s = applyV1(PARAMS)
  if (s.hash !== SCRIPT_HASH || s.address.preprod !== V1_ADDRESS.preprod || s.address.mainnet !== V1_ADDRESS.mainnet) {
    throw new ScriptMismatchError(`rebuilt V1 script hash ${s.hash} is not the deployed ${SCRIPT_HASH}`)
  }
  deployed = s
  return s
}
