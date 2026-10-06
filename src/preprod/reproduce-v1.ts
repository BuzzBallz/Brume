// Judge-runnable, keyless, offline: rebuilds the deployed V1 escrow script from the vendored blueprint and the deployed
// parameters, and prints whether it matches the live script hash and both addresses.
// Usage: node src/preprod/reproduce-v1.ts
import { PARAMS, SCRIPT_HASH, V1_ADDRESS } from '../../shared/constants.ts'
import { applyV1, blueprint, BLUEPRINT_UNAPPLIED_HASH } from './script.ts'

const bp = blueprint()
const s = applyV1(PARAMS)
const mark = (ok: boolean): string => (ok ? 'MATCH' : 'DIFFERS')
console.log(`blueprint   vendor/masumi-payment-service/plutus.json, Aiken ${bp.compiler}, unapplied hash ${BLUEPRINT_UNAPPLIED_HASH}`)
console.log(`params      required_admins=${PARAMS.requiredAdmins} admins=[${PARAMS.adminKeyHashes.map((h) => h.slice(0, 8) + '…').join(', ')}] fee_permille=${PARAMS.feePermille} cooldown_ms=${PARAMS.cooldownMs}`)
console.log(`applied     ${s.cbor.length / 2} bytes with @meshsdk/core-cst 1.9.0-beta.90`)
console.log(`script hash ${s.hash}  ${mark(s.hash === SCRIPT_HASH)} deployed ${SCRIPT_HASH}`)
console.log(`preprod     ${s.address.preprod}  ${mark(s.address.preprod === V1_ADDRESS.preprod)}`)
console.log(`mainnet     ${s.address.mainnet}  ${mark(s.address.mainnet === V1_ADDRESS.mainnet)}`)
if (s.hash !== SCRIPT_HASH) process.exit(1)
