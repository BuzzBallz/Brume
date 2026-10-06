# vendor/ — provenance

Nothing in this folder was written by us, and nothing in it is modified. `vendor/.gitattributes` turns off line-ending conversion so the files stay byte-identical to upstream.

## `masumi-payment-service/plutus.json`

- **What:** the compiled Aiken blueprint of the Masumi V1 payment escrow (`vested_pay.vested_pay.spend`). It holds the unapplied validator code, compiled with Aiken v1.1.7+e2fb28b, unapplied hash `e6d17c4860df984673606cbc92f682b3b5236e3450deab62500b0795`, plus the blueprint's type definitions. It is a compiled artefact, not source: it contains no code we run, and nothing of ours depends on its internals beyond the compiled script.
- **From:** https://github.com/masumi-network/masumi-payment-service, path `smart-contracts/payment/plutus.json`, commit `46f495259f47eddd963d9fe875e22fe147b9b088` (2026-09-17).
- **Unmodified:** git blob `740c8f183f9ed5ea3c53fc6eb1c764cf18c762f1`, the same object as upstream at that commit; sha256 `13e3f02a1ea0b3ac423b4f8bad5fe2899ff33db870f8586642232dd2d30b70eb`. Check: `git hash-object vendor/masumi-payment-service/plutus.json`.
- **Licence:** MIT, Copyright (c) 2024 NMKR. The full text is next to it in `masumi-payment-service/LICENSE` (git blob `7b4a7b7a2babde0f2b6f72c519d2b69dde9ad557`, same commit).
- **Why it is here:** two uses, both in `src/preprod/script.ts`.
  1. **Reproduction.** Applying the deployed parameters to this blueprint with `@meshsdk/core-cst@1.9.0-beta.90` gives exactly the deployed V1 script hash `bd2adb68…6c0`, on preprod and on mainnet. `node src/preprod/reproduce-v1.ts` prints the derivation. Every preprod spend of the shared escrow uses those reproduced bytes, after checking the hash.
  2. **Our own deployment (S-2).** The same compiled code with our parameters: an admin key we hold, listed three times. It is labelled as our own deployment wherever it appears.
