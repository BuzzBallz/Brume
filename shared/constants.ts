import type { Params } from './types.ts'

// Deployed V1 escrow validator. Same script hash on mainnet and preprod (K44).
export const SCRIPT_HASH = 'bd2adb685621e224aae7571cb6bd8f0beb0fdd31875eb3a27feee6c0'
export const V1_ADDRESS = {
  mainnet: 'addr1wx7j4kmg2cs7yf92uat3ed4a3u97kr7axxr4avaz0lhwdsq87ujx7',
  preprod: 'addr_test1wz7j4kmg2cs7yf92uat3ed4a3u97kr7axxr4avaz0lhwdsqukgwfm',
} as const

// Deployed V1 parameters (SPEC-VALIDATOR §8), all R5: applied in this order to the committed V1 blueprint
// (unapplied hash e6d17c48…0795) with @meshsdk/core-cst 1.9.0-beta.90, they reproduce both V1 addresses exactly
// (re-run 6 Oct 2026, PLAN §10). The same call through @meshsdk/core (core-cst beta.96) gives a different script.
export const PARAMS: Params = {
  requiredAdmins: 2,
  adminKeyHashes: [
    'fc16a1fcf309aed03ec18bb2176f5ea29acea70bb79145ebaffa8e75',
    '7f78161369549d8e2b138fee724c9fa606d6107a66720bdb4c48ada6',
    '89eef9ea84e0ee7fe4921fa93eb2873ff6e34473f751d5d52cb75aa6',
  ],
  feeAddress: {
    payment: { type: 'key', hash: '13cedc5388c33ff6eac2f0d919a9fd5517910de8def01b11523995e4' },
    stake: { type: 'key', hash: 'c447a7c9eae8438a852033e904952a1680dfd035166e1800e1505b96' },
  },
  feePermille: 50, // also measured: 8/8 Withdraw txs
  cooldownMs: 420_000,
}

// The fee address above, per network (same credentials, different header). Path A's Withdraw on preprod pays the testnet form.
export const FEE_ADDRESS = {
  mainnet: 'addr1qyfuahzn3rpnlah2ctcdjxdfl4230ygdar00qxc32guetexyg7nun6hggw9g2gpnayzf22sksr0aqdgkdcvqpc2stwtqgrp4f9',
  preprod: 'addr_test1qqfuahzn3rpnlah2ctcdjxdfl4230ygdar00qxc32guetexyg7nun6hggw9g2gpnayzf22sksr0aqdgkdcvqpc2stwtqt4u496',
} as const

export const USDM = 'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad0014df105553444d'
// Preprod USDM as the Masumi dispenser hands it out; the bank escrows carry it so the per-asset split shows.
export const TUSDM = '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d'
// Display decimals per unit (quantities stay integer strings everywhere else).
export const DECIMALS: Record<string, number> = { lovelace: 6, [USDM]: 6, [TUSDM]: 6 }

// Measured disagreement point (C9, SPEC-VALIDATOR §6) and arbiter dormancy start (C3).
export const BUYER_ARB_SHARE: Record<string, number> = { lovelace: 1, [USDM]: 0.736 }
export const SELLER_ARB_SHARE: Record<string, number> = { lovelace: 0, [USDM]: 0 } // 0 in 120 of 120
export const ARBITER_LAST_ACTION_MS = Date.parse('2025-11-27T22:27:00Z')

export const KOIOS = {
  mainnet: 'https://api.koios.rest/api/v1',
  preprod: 'https://preprod.koios.rest/api/v1',
} as const
export const BLOCKFROST = {
  mainnet: 'https://cardano-mainnet.blockfrost.io/api/v0',
  preprod: 'https://cardano-preprod.blockfrost.io/api/v0',
} as const
