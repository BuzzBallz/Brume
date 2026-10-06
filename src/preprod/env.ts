import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Role } from '../../shared/types.ts'

// Keys come from the repo-root .env only. No error message, log or return value ever contains a key.
export const ROOT = join(import.meta.dirname, '..', '..')

export class EnvError extends Error {}

let loaded = false
export function loadEnv(): void {
  if (loaded) return
  loaded = true
  const file = join(ROOT, '.env')
  if (existsSync(file)) process.loadEnvFile(file)
}

export function requireEnv(name: string): string {
  loadEnv()
  const value = process.env[name]?.trim()
  if (!value) throw new EnvError(`${name} is not set (see .env.example)`)
  return value
}

// bech32 root key with the xprv prefix (CIP-1852 account 0 / key 0). Anything else, a mnemonic first, is refused:
// the pre-commit hook recognises this prefix and would not recognise a mnemonic.
// The separator is written as [1] so this source line does not itself trip the hook's key pattern.
const ROOT_KEY = /^xprv[1][02-9ac-hj-np-z]{100,}$/

export function rootKey(role: Role): string {
  const name = `PREPROD_${role.toUpperCase()}_SKEY`
  const value = requireEnv(name)
  if (!ROOT_KEY.test(value)) throw new EnvError(`${name} is not a bech32 root key with the xprv prefix (mnemonics are refused)`)
  return value
}
