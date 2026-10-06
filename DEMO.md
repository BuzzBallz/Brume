# Demo

3:00, recorded, product first. The script is `PLAN.md` §2. This file fixes the inputs. Rows marked "pending" depend on stream A's engine and preprod helper and are filled when they land.

## Fixed inputs

| Input | Value |
|---|---|
| `<HERO_REF>`, a real mainnet Disputed escrow, read-only | `a7084c50029798fc0530b6c9abc2bf3e203b23e11102a3e8cdb90ede0c64970d#0` |
| Census pinned for the video | tip block 14031954, `fixtures/mainnet/utxos-*.json`, both providers (`READ_SOURCE=fixture`) |
| `<BANK_REF>`, a preprod escrow we locked | pending (stream A fixture) |
| Split proposed by the seller | pending (solver output) |
| Action the engine marks impossible, for "try anyway" | pending (engine output) |

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

Say "the validator's source says" for any guard not yet exercised on preprod. Counts and clocks, never a sum of the frozen value, no fiat. The solver is per unit of escrow value. Never "cannot be raced": the race is not measured.

A replay of a leg whose input is already spent is refused by the ledger (phase 1), so say "the ledger refused it". Only a refusal in phase 2, after the script ran, is "the validator refuses". A transaction log entry without a block is pending, not confirmed.
