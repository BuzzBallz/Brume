# Demo

3:00, recorded, product first. The script is `PLAN.md` §2. This file fixes the inputs. Rows marked "pending" depend on stream A's engine and preprod helper and are filled when they land.

## Fixed inputs

| Input | Value |
|---|---|
| `<HERO_REF>`, a real mainnet Disputed escrow, read-only | `a7084c50029798fc0530b6c9abc2bf3e203b23e11102a3e8cdb90ede0c64970d#0` |
| Census pinned for the video | tip block 14031954, `fixtures/mainnet/utxos-*.json`, both providers (`READ_SOURCE=fixture`). `?source=snapshot` and Pages show tip 14034352 (141 open, 61 Disputed): say which one is on screen |
| `<BANK_REF>`, a preprod escrow we locked | `0452fc53b168baad73414e4980ccc4cbb7cd69df9a95fd3a132b15b4612658c6#0` for the settle at 0.40 (20 tADA + 10 tUSDM). Unspent backups with the same content: `0452fc53…#1`, `47db047faf629b6894cbe2f9f307d1f2e1482c47291c14285531af7a2b5d7644#0`. `9054b1d8…#6` (rehearsal), `#7` (first take, 0.75) and `0452fc53…#0` (take at 0.40) are spent |
| Split proposed by the seller | 0.40 to the seller, typed in the UI (seller 8 tADA + 4 tUSDM, buyer 12 tADA + 6 tUSDM on a 20 tADA + 10 tUSDM pot). The UI prefills the top of the solver's band, 0.75 |
| Action the engine marks impossible, for "try anyway" | buyer `WithdrawRefund` on a Disputed bank escrow (needs FundsLocked or RefundRequested): refused by the validator, phase 2, as stream A ran it on `8e0d6df4…#0` |

## Order of the take

Settling spends the escrow, so "try anyway" runs on another bank escrow: one of `c3e0b68acf3e8307dd962b6ee6f2b436640878086c19d5c2827ec9abbb7999c0#0` to `#3` (Disputed, wallets 1 and 2, but only 20 tADA + 2 tUSDM each, so not for the settle). A refusal does not consume the escrow. Order as in the script: settle `0452fc53…#0`, then try anyway on `c3e0b68a…#0`. If the settle take fails, redo it on `0452fc53…#1` or `47db047f…#0`. Run `node src/preprod/preflight.ts --escrow <ref>` first: all PASS.

## Rehearsal, 6 Oct (escrow `#6`, from the UI)

| Step | Transaction | Block | Result |
|---|---|---|---|
| Leg 1, concession (`AuthorizeRefund`) | `1a5e3e6e6b4526cded37046a5473d5e0fd73cd51e2d4165d7e6297b087706c84` | 5259766 | accepted |
| Leg 2, pre-signed exit (`WithdrawRefund`) | `b92d44e4a226d873c12fa40200f5bda40841ad6f86e0c6b298ac52153eb305d4` | 5259766 | accepted |
| Replay of leg 2 | same body | none | refused by the ledger (phase 1) |

Both legs found on two indexers in the same block, `valid_contract` true (`pnpm verify <hash> preprod`).

## Take, 6 Oct (escrow `#7`, from the UI)

| Step | Transaction | Block | Result |
|---|---|---|---|
| Leg 1, concession (`AuthorizeRefund`) | `5c5e323a0af1485f13c6df6a6d04de09e991397c0cead8c70bc59223a3300cf3` | 5260711 | accepted |
| Leg 2, pre-signed exit (`WithdrawRefund`) | `90bb281f89a3d8b5e1ebfa47fc05aaae75843e175d818428a379a5984b19420c` | 5260711 | accepted |
| Replay of leg 2 | same body | none | refused by the ledger (phase 1) |

Both legs found on two indexers in the same block, `valid_contract` true. Leg 2 read back on Koios: the buyer received 5 tADA + 2.5 tUSDM, the seller 15 tADA + 7.5 tUSDM, as proposed. Log: `fixtures/preprod/txlog-9054b1d8…_7.json`.

## Take at 0.40, 7 Oct (escrow `0452fc53…#0`, from the UI on B's machine)

| Step | Transaction | Block | Result |
|---|---|---|---|
| Leg 1, concession (`AuthorizeRefund`) | `5f3d960ab279f6ba4e329534aa67bfd65b2d39e81a61490ca4248dcf24c221a8` | 5261685 | accepted |
| Leg 2, pre-signed exit (`WithdrawRefund`) | `5db25159151261d1c352cf5281f880bd6a809fc35415bcaa1e72c32692f8f382` | 5261685 | accepted |
| Replay of leg 2 | same body | none | refused by the ledger (phase 1) |

Both legs found on two indexers in the same block, `valid_contract` true. Leg 2 read back on Koios: the buyer received 12 tADA + 6 tUSDM, the seller 8 tADA + 4 tUSDM, as proposed. Signers: seller on leg 1; buyer required on leg 2, seller also signing for its own fee input; admin keys: none of the 3 (`fixtures/preprod/witnesses-0452fc53…_0.json`). Log: `fixtures/preprod/txlog-0452fc53…_0.json`.

## Wallets

Both demo wallets are ours: two throwaway preprod wallets generated locally. Their phrases are in `.env` (`PREPROD_WALLET_MNEMONIC`, `PREPROD_WALLET_2_MNEMONIC`) and are never printed or committed. Wallet 1 plays the buyer, wallet 2 the seller. Addresses, public:

```
buyer   addr_test1qqlg6r6ww0kd0qxsw2zh6fd78qyk2f7k2rfgp3696sngcms6y3crsh87un2wt9rkk5g7m0t3z0rturaca94vdzjhzymsfct97t
seller  addr_test1qrvk6sgjjk7nsv9tg3jltr35g65nnsr98f7pw5c5p258geulnltrju4208p9ej3y5tc2nsw7cftqqnssjflvurd4we9stphwwa
```

A judge re-running the key-bearing commands uses their own funded preprod wallet.

## Before recording

```
pnpm check
pnpm site:data          # refresh the snapshot, note the tip block it prints
pnpm agent              # http://127.0.0.1:8787
```

Open `http://127.0.0.1:8787/?escrow=a7084c50029798fc0530b6c9abc2bf3e203b23e11102a3e8cdb90ede0c64970d#0`. "Reset" in the top bar returns to the default URL.

## Offline fallback

`?source=snapshot` reads `docs/data/` and needs no network or agent. `?source=mock` reads `shared/mock/` and says so in the banner. Self-hosted fonts, no CDN.

## Say, and do not say

Say "the validator's source says" for any guard not yet exercised on preprod. Counts and clocks, never a sum of the frozen value, no fiat. The solver is per unit of escrow value. Same block, 5 runs of 5, is measured; front-running is not. Never "cannot be raced".

A replay of a leg whose input is already spent is refused by the ledger (phase 1), so say "the ledger refused it". Only a refusal in phase 2, after the script ran, is "the validator refuses". A transaction log entry without a block is pending, not confirmed.
