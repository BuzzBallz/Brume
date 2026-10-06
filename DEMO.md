# Demo

3:00, recorded, product first. The script is `PLAN.md` §2. This file fixes the inputs. Rows marked "pending" depend on stream A's engine and preprod helper and are filled when they land.

## Fixed inputs

| Input | Value |
|---|---|
| `<HERO_REF>`, a real mainnet Disputed escrow, read-only | `a7084c50029798fc0530b6c9abc2bf3e203b23e11102a3e8cdb90ede0c64970d#0` |
| Census pinned for the video | tip block 14031954, `fixtures/mainnet/utxos-*.json`, both providers (`READ_SOURCE=fixture`). `?source=snapshot` and Pages show tip 14033251 (168 open, 61 Disputed): say which one is on screen |
| `<BANK_REF>`, a preprod escrow we locked | `9054b1d81c9ce47db1e3ea993aa34f0f978eb95629d4319131f149619c68de9d#7` for the settle (20 tADA + 10 tUSDM). Backup with the same content: `47db047faf629b6894cbe2f9f307d1f2e1482c47291c14285531af7a2b5d7644#0`. `#6` was the rehearsal and is spent |
| Split proposed by the seller | 0.75 to the seller, as in the rehearsal (seller 15 tADA + 7.5 tUSDM, buyer 5 tADA + 2.5 tUSDM on a 20 tADA + 10 tUSDM pot) |
| Action the engine marks impossible, for "try anyway" | buyer `WithdrawRefund` on a Disputed bank escrow (needs FundsLocked or RefundRequested): refused by the validator, phase 2, as stream A ran it on `8e0d6df4…#0` |

## Order of the take

Settling spends the escrow, so "try anyway" runs on another bank escrow: one of `c3e0b68acf3e8307dd962b6ee6f2b436640878086c19d5c2827ec9abbb7999c0#0` to `#3` (Disputed, wallets 1 and 2, but only 20 tADA + 2 tUSDM each, so not for the settle). A refusal does not consume the escrow. Order as in the script: settle `#7` (0:40), then try anyway on `c3e0b68a…#0` (1:40). If the settle take fails, redo it on `47db047f…#0`.

## Rehearsal, 6 Oct (escrow `#6`, from the UI)

| Step | Transaction | Block | Result |
|---|---|---|---|
| Leg 1, concession (`AuthorizeRefund`) | `1a5e3e6e6b4526cded37046a5473d5e0fd73cd51e2d4165d7e6297b087706c84` | 5259766 | accepted |
| Leg 2, pre-signed exit (`WithdrawRefund`) | `b92d44e4a226d873c12fa40200f5bda40841ad6f86e0c6b298ac52153eb305d4` | 5259766 | accepted |
| Replay of leg 2 | same body | none | refused by the ledger (phase 1) |

Both legs found on two indexers in the same block, `valid_contract` true (`pnpm verify <hash> preprod`).

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
