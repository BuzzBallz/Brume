import type { MeshWallet } from '@meshsdk/core'
import type { Role } from '../../shared/types.ts'
import { assertPreprodAddress } from './chain.ts'
import { rootKey } from './env.ts'
import { mesh } from './mesh.ts'

export type Party = { role: Role; wallet: MeshWallet; address: string; pkh: string }

// One payment key per role (account 0 / key 0). The wallet never fetches or selects UTxOs: inputs are chosen by the caller.
export async function party(role: Role): Promise<Party> {
  const wallet = new mesh.MeshWallet({ networkId: 0, key: { type: 'root', bech32: rootKey(role) } })
  await wallet.init()
  const address = await wallet.getChangeAddress()
  assertPreprodAddress(address)
  return { role, wallet, address, pkh: mesh.deserializeAddress(address).pubKeyHash }
}
