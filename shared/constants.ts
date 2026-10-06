// Deployed V1 escrow validator. Same script hash on mainnet and preprod (K44).
export const SCRIPT_HASH = 'bd2adb685621e224aae7571cb6bd8f0beb0fdd31875eb3a27feee6c0'
export const V1_ADDRESS = {
  mainnet: 'addr1wx7j4kmg2cs7yf92uat3ed4a3u97kr7axxr4avaz0lhwdsq87ujx7',
  preprod: 'addr_test1wz7j4kmg2cs7yf92uat3ed4a3u97kr7axxr4avaz0lhwdsqukgwfm',
} as const

// Deployed parameters (SPEC-VALIDATOR §8), with their rung.
export const PARAMS = {
  feePermille: 50, // R5, 8/8 Withdraw txs
  feeAddress: 'addr1qyfuahzn3rpnlah2ctcdjxdfl4230ygdar00qxc32guetexyg7nun6hggw9g2gpnayzf22sksr0aqdgkdcvqpc2stwtqgrp4f9', // R5
  requiredAdmins: 2, // R5 for V2, R3 for V1
  cooldownMs: 420_000, // R5 for V2, open for V1
} as const

export const USDM = 'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad0014df105553444d'

// Measured disagreement point (C9, SPEC-VALIDATOR §6) and arbiter dormancy start (C3).
export const BUYER_ARB_SHARE: Record<string, number> = { lovelace: 1, [USDM]: 0.736 }
export const ARBITER_LAST_ACTION_MS = Date.parse('2025-11-27T22:27:00Z')

export const KOIOS = {
  mainnet: 'https://api.koios.rest/api/v1',
  preprod: 'https://preprod.koios.rest/api/v1',
} as const
export const BLOCKFROST = {
  mainnet: 'https://cardano-mainnet.blockfrost.io/api/v0',
  preprod: 'https://cardano-preprod.blockfrost.io/api/v0',
} as const
