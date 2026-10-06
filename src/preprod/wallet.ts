import type { MeshWallet } from '@meshsdk/core'
import type { Role } from '../../shared/types.ts'
import { assertPreprodAddress } from './chain.ts'
import { EnvError, rootKey } from './env.ts'
import { mesh } from './mesh.ts'

export type Party = { role: Role; wallet: MeshWallet; address: string; pkh: string }

// One payment key per role (account 0 / key 0). The wallet never fetches or selects UTxOs: inputs are chosen by the caller.
export async function party(role: Role): Promise<Party> {
  // A key that passes the format check but fails its bech32 checksum makes Mesh throw an error that quotes the key:
  // that error is replaced, never chained, so no message or stack can carry the value.
  let wallet: MeshWallet
  try {
    wallet = new mesh.MeshWallet({ networkId: 0, key: { type: 'root', bech32: rootKey(role) } })
    await wallet.init()
  } catch (error: unknown) {
    if (error instanceof EnvError) throw error
    throw new EnvError(`PREPROD_${role.toUpperCase()}_SKEY could not be decoded as a bech32 root key`)
  }
  const address = await wallet.getChangeAddress()
  assertPreprodAddress(address)
  return { role, wallet, address, pkh: mesh.deserializeAddress(address).pubKeyHash }
}
