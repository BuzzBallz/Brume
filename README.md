# Brume

TOKEN2049 Origins, Cardano track, team BuzzBallz. Brume reads escrows held by the deployed V1 payment-escrow validator and shows what each party can do with them right now.

Input: an escrow UTxO reference. Output: for each of the 7 redeemers and each of buyer, seller and admin, whether the validator's source says the action can succeed now. No model decides anything: every verdict comes from the validator's guards, read from its source (rung R4) until a guard has been exercised on preprod (rung R5).

This README states what exists today. The status table says what does not.

## Status

| Part | State |
|---|---|
| Keyless read layer, 429 retry, hole counter (`src/read`), transaction lookup on two indexers (`pnpm verify`) | built; the read layer is tested, `verify` was run on a real V1 transaction |
| 16-field V1 datum decoder and census from the UTxO set (`src/census`) | built, tested, reproducible from a committed fixture |
| Agent server: UI API and MIP-003 job interface (`src/agent`) | built; every route serves stream A's engine, solver and settlement, no mocks |
| UI (`docs/`): list, escrow, grid, settle flow, solver | built over the live agent; `?source=snapshot` for Pages, `?source=mock` for offline building |
| Reachability engine, solver, preprod bank, two-leg settlement, try anyway (`src/engine`, `src/solver`, `src/preprod`, stream A) | built and run on preprod: 10 logged settles on path B and 5 race runs, see Transactions sent |
| Masumi payment leg | built; one test purchase completed and withdrawn on preprod, exported to `fixtures/masumi/test-purchase.json` |
| Listing on preprod Sokosumi | registered on the preprod Masumi registry (agent identifier `67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b10623ce443d4137e7acc0839c20c4ba0c022940ab6de665dea00cc8c16000001`; a metadata update replaced `…cc8c16000000`, the identifier the test purchase used); not yet visible on preprod Sokosumi |
| Transactions | listed below with hashes and blocks; the full index, the earlier settles included, is `fixtures/preprod/README.md` |

## Run it

A judge needs no key. Node 22.18 or later and pnpm.

```
pnpm install
pnpm check                          # tsc + node --test
pnpm census:mainnet                 # live, keyless (Koios), plus Blockfrost if a key is set; READ_SOURCE=fixture for offline
pnpm agent                          # UI and API on http://127.0.0.1:8787 (PORT to change)
pnpm site:data                      # snapshot docs/data/*.json for GitHub Pages
pnpm verify <tx hash> [network]     # read a transaction on Koios and, with a key, Blockfrost; says whether they agree
pnpm engine <ref> [--net preprod]   # the 7×3 reachability grid of one escrow
pnpm solver <ref> [--net preprod]   # the split bands of one escrow, path B by default
node src/solver/all.ts              # the solver and engine over every Disputed mainnet escrow, read-only
pnpm sign --prepare <ref> [--share 0.4]  # seller side: writes the proposal file
pnpm sign --role buyer|seller <file> # file-drop signature of a proposal (needs the party's key in .env)
```

To run the whole settlement yourself on preprod, with your own throwaway keys:

```
pnpm demo:preprod --keygen          # makes demo keys and prints the buyer's address
# fund that address from the preprod faucet, then:
pnpm demo:preprod                   # locks an escrow, settles it in two legs, writes the run to fixtures/preprod/
```

`READ_SOURCE=fixture pnpm census:mainnet` reads `fixtures/mainnet/utxos-koios.json` and `utxos-blockfrost.json` and reprints the census below, with its two-provider comparison, with no network. A live run reads the chain again, so its tip and counts will have moved.

## Census, mainnet, read-only

Pinned to tip block **14031954**, hash `e4d15bf4126618bbf9c9ae9d0d3077e90815a1fa2aaf466fc8560fedeb2b72d1`, read 6 Oct 2026 from two providers (Koios and Blockfrost), 0 holes on both. Totals are summed from the UTxO set at the V1 script address, never from an address summary.

| | |
|---|---|
| Open UTxOs | 141 |
| Decoded as 16-field V1 datums | 140 |
| Not decodable | 1 (`6be625f6…0f5afe#26`, no inline datum) |
| By state | FundsLocked 6, ResultSubmitted 69, RefundRequested 4, Disputed 61 |
| Disputed, held | 295.342750 ADA and 498.15 USDM (native units, no fiat) |

The two providers agree: 141 refs on each, the same values, the same inline datums and the same totals (794.769350 ADA, 669.70 USDM and 1 unit of one other asset over all open UTxOs), printed as `diff: none`. A run without `BLOCKFROST_MAINNET_PROJECT_ID` in `.env` is single-provider and says so; `pnpm census:mainnet --pin` re-reads both providers and re-pins the two snapshots.

The solver over all 61 Disputed escrows is in `fixtures/solver-61-14032495.json` (stream A, mainnet tip 14032495, `node src/solver/all.ts`). On path B the band is feasible at every horizon for 61 of 61, and the 30-day band is 0 to 75 % of the value to the seller on every one: the ADA, of which arbitration gave the buyer 100 %, binds everywhere. Path A is feasible at 30 days for 16 of 61; the other 45 would need the seller to top up the fee. The same file cross-checks the engine on all 61: the seller can concede now, then the buyer can exit, and the admin set cannot arbitrate.

The solver also shows the option to wait as break-evens, never as a value (PLAN §10 D17). No arbitration since 27 November 2025, verified through block 14033013 on one provider (`fixtures/solver-61-14033013.json`); at 95 %, the arbiter acts at most once every 104 days on average, and nothing puts a floor under that. For a buyer who would wait at most 30 days, any seller share up to 75 % beats waiting, even at that bound. A 25 % seller share beats waiting for a buyer who would stop within 144 days, or who discounts at 222 %/yr or more. These are break-evens, not a recommended split: the chain bounds the arbiter, it cannot measure the buyer's patience.

The decoder is checked three ways in `src/census/census.test.ts`: against Koios's own decoding of a real mainnet datum, on a set of corrupted datums that must fail (truncated, trailing byte, state as an integer, unknown state, 11 and 15 fields), and on the census arithmetic.

Cross-check: `fixtures/kickoff-2026-10-06.md` holds an independent census from another provider (NOWNodes, Blockfrost-compatible, tips 14031823 to 14031828). It gives the same counts (141 open, 140 decodable, 1 without a datum, 6 / 69 / 4 / 61 by state) and the same Disputed totals, a third read at an earlier tip.

The Pages snapshot in `docs/data/` is a separate, later read, at tip 14033251: 168 open, 61 Disputed, 0 holes, no difference between the two providers. It also replays the settled UI rehearsal on bank escrow `9054b1d8…#6`, with its run log and read-back balances.

## Mocks

The agent serves no mock: every route answers from the chain and stream A's code. Mocks remain only for building the UI offline (`?source=mock`), in `shared/mock/*.mock.json`. Each is hand-made, not evidence, and says so in its `_note`.

| Mock | Used for |
|---|---|
| `census`, `datum-disputed`, `utxo-disputed` | the escrow list and header. The UTxO file is a real Koios row; the other two are decoded by hand from it |
| `grid`, `solver`, `proposal`, `txlog` | the grid, solver and settle views |
| `job-result` | shape reference for the MIP-003 result |

## Agent interface (MIP-003)

```
curl http://127.0.0.1:8787/availability
curl http://127.0.0.1:8787/input_schema
curl -X POST http://127.0.0.1:8787/start_job -H 'content-type: application/json' \
  -d '{"identifier_from_purchaser":"x","input_data":{"escrowRef":"<tx hash>#<index>"}}'
curl 'http://127.0.0.1:8787/status?job_id=<id from start_job>'
```

`input_data.network` is `mainnet` (default, read-only) or `preprod`. The result is a JSON string: escrow reference, grid, solver output, and a link into the UI. Shapes follow the [MIP-003 text](https://github.com/masumi-network/masumi-improvement-proposals).

`HIRE_VIA=direct` (default) answers `start_job` with a job id only, for scripted calls. `HIRE_VIA=sokosumi` opens a payment at the Masumi payment service (preprod, `.env` holds `PAYMENT_SERVICE_URL`, `PAYMENT_API_KEY`, `AGENT_IDENTIFIER`) and answers with the specification's payment fields, with the times as the payment service returns them (unix milliseconds, strings) and an `amounts` list. The job runs once the funds are locked and the result hash is then submitted to the service. It was exercised once: a test purchase of 2 tADA from our own local payment service's purchasing wallet went from `awaiting_payment` to `completed` in about 3 minutes. The buyer locked the funds in `6b359cff0b44064b5e4fc3b5da8e79850b04a46be507b3e6cc596f1f8c770b0c` (block 5259425) and the agent's result was submitted in `eaaf7c516ecf9f6cdb8ef9fdc674a54b2c109e7553a4d1a8da1cc33564fad1f6` (block 5259429). Both run on the Masumi payment contract, not the V1 escrow. The record is exported from the service's database to `fixtures/masumi/test-purchase.json` (public fields only). After the unlock time the service withdrew them on its own in `5d9affd077982408b4e2d708ce652273394feeb2436b20f17a7567a90acc0273` (block 5260579): the payment to the selling wallet, the collateral back to the purchasing wallet.

A provider that rate-limits or fails (HTTP 429 or 5xx) is answered as a 503 hole, in one sentence: nothing was built or sent. A witness set that is not valid CBOR, or not signed by the expected key, is a 400 with its reason.

## Transactions sent (preprod, 6 Oct 2026)

Every write is on preprod, against escrows we locked ourselves. Mainnet is read only. The full index of the evidence files, run by run, is `fixtures/preprod/README.md`. The table below lists the first four settles and the take on `#7`; the others are indexed in its §1. Each run below is logged entry by entry in `fixtures/preprod/` and each accepted transaction can be re-read on a second indexer with `pnpm verify <tx hash> preprod`.

A refused transaction never reaches a block, so its hash is a body hash, not something an explorer will show. Where the refusal was decided matters, and the log records it:
- **phase 1**: the ledger refused it before any script ran (for example, an input already spent);
- **phase 2**: the validator ran and refused it.

### The pre-signed exit, on the shared V1 script

The buyer signs leg 2 against leg 1's output before that output exists. The seller then concedes (leg 1), and both legs go out. Script `bd2adb68…`: the same script hash as the mainnet escrows.

| Run | Leg 1, the concession (`AuthorizeRefund`) | Leg 2, the pre-signed exit (`WithdrawRefund`) | Block | Replay of leg 2 |
|---|---|---|---|---|
| A2 spike | `4cd4dd854be5b6d71ab7d62d9ef329846a89dc21926b19c3c549a3680ca386b3` | `ecfd489b84d60da78bc03f6826ee1348714a4afbc6a895c1430e08d4b1e90117` | 5259491 | refused by the ledger (phase 1) |
| Token pot, through `prepare` → `sign` → `submit` | `be1a2161b8c451309549265337893cc05bd4f75e9a7e3b971ccca86d7bcb4df8` | `ccb04dd233010d1e71ca0ebacb68cc83c28247e78e16b5f84a096389b2eab637` | 5259570 | refused by the ledger (phase 1) |
| Rewritten submit path | `764f803f96fc4f0c950d1dd0f00bb98437f3bab2a6ff3f9478d0e2ce09a507db` | `ee822b4e4c2f4a0375a5fe92b0301883adef60b138a5ef794813d80bf7d72aee` | 5259631 | refused by the ledger (phase 1) |
| Stream B rehearsal from the UI, through the agent (escrow `9054b1d8…#6`) | `1a5e3e6e6b4526cded37046a5473d5e0fd73cd51e2d4165d7e6297b087706c84` | `b92d44e4a226d873c12fa40200f5bda40841ad6f86e0c6b298ac52153eb305d4` | 5259766 | refused by the ledger (phase 1) |
| Stream B take from the UI, through the agent (escrow `9054b1d8…#7`, 75 % to the seller) | `5c5e323a0af1485f13c6df6a6d04de09e991397c0cead8c70bc59223a3300cf3` | `90bb281f89a3d8b5e1ebfa47fc05aaae75843e175d818428a379a5984b19420c` | 5260711 | refused by the ledger (phase 1) |

### Try anyway: an action the engine predicts refused, sent to the chain

| Escrow | Action | Engine | Result |
|---|---|---|---|
| `8e0d6df4…#0` (Disputed) | buyer `WithdrawRefund` | needs FundsLocked or RefundRequested | refused by the validator (phase 2), body `ae8c0418…` |

### After a concession alone (claim C11, shared script)

After the seller's `AuthorizeRefund` alone, with no exit signed, every branch the concession closes was sent anyway. Each one counts only when the guard we name is the only one failing.
- **First run** (`fixtures/preprod/txlog-c11-8e0d6df4…_0.json`). The concession is `fd9eb4f3ab29f6aa997289a05c252d16e43973022862c22e9e09d34b74452423`, block 5259672.
  - The buyer's `SetRefundRequested` was refused by the validator (phase 2), the state guard being the only one failing (body `4c409776…`).
  - The seller's `SubmitResult` and second `AuthorizeRefund` were refused too. The concession's seller cooldown was still running, so that cooldown alone explains them: they are not counted.
  - The buyer then exits: `43c16e6b845b2f4e237b85d27864c1d03eda49b4dc31082258bf526941a68bd5`, block 5259675.
- **Isolated re-run** (`fixtures/preprod/txlog-c11-isolated-7e37dc3f…_0.json`). The concession is `794370a207b45c07c397ea9662e80011a0eb1b24bd121e19d2bc0e9fa352d5a8`, block 5259745, written with the minimal seller cooldown. Each seller control was sent only after that cooldown expired.
  - The seller's `SubmitResult` was refused by the validator (phase 2), the emptied result hash being the only guard failing (body `97282a2b…`).
  - The seller's second `AuthorizeRefund` was refused by the validator (phase 2), the state being the only guard failing (body `cb5bfbe5…`).
  - The buyer then exits: `b6019d87369106952e5f69440c5251a6be526de9f935c04d2475e7100eaf9b65`, block 5259786.

`Withdraw` was not sent: its mandatory tagged outputs, not the state guard, would decide. On the shared script, the admin branch still reads "the validator's source says"; it was run on our own deployment only (below).

### The admin pair, on our own deployment (test S-2, part of C11)

This is **our own deployment**, never the deployed bytes: the same compiled V1 code with only the admin set changed (our key three times, threshold 2). Script `d2e72e104b6b4908412f0facfd669821c3587819179ec8d0acf1400d`, not the shared `bd2adb68…`. Details are in `fixtures/preprod/own-deployment.json`.

Two identical Disputed escrows, X and Y, with the arbitration window open.

| Step | Transaction | Block | Result |
|---|---|---|---|
| X: admin `WithdrawDisputed` on a Disputed escrow | `8e5c49cb3c3077bb77b7cff1054e18c972f8359c5bdf69699bca8523cc6a5fe5` | 5259662 | accepted |
| Y: seller concedes (`AuthorizeRefund`) | `64299c10ef1b75dca69b9de19b3860f43125f2e7bb8cd1a0c111ae0bcde6dad8` | 5259664 | accepted |
| Y: the same admin's `WithdrawDisputed` after the concession | body `a776a247…` | none | refused by the validator (phase 2) |
| Y: buyer exits (`WithdrawRefund`) | `2b0f89ac0df8e81aa89b0a0fff6115c326e8ef1d9afce990e19923c320e2f03d` | 5259665 | accepted |

### Leg timing, five runs (S-1)

Over five runs (`fixtures/preprod/race-*.json`), both legs landed in the same block five times out of five (blocks 5259678, 5259750, 5259751, 5259754 and 5259799). Leg 2 was accepted 503 to 711 ms after leg 1 was sent, both legs handed to one provider.

Front-running is **not measured**, and we make no safety claim about it. A rival exit, pre-built by the buyer and checked to be valid before each of the four contended runs, never landed, but no run gave it a clean window. The seller's gap between the legs (249 to 296 ms in the contended runs) is the same order of magnitude as an attacker's first sight of leg 1 (as early as 314 ms here, up to 1063 ms). The solver keeps the front-run probability at its worst case.

### Setup transactions

Bank escrows were locked from block 5259528 (`9054b1d81c9ce47db1e3ea993aa34f0f978eb95629d4319131f149619c68de9d`) to 5260008, and raised to Disputed by their buyer between 5259535 and 5259916. Three were locked directly in Disputed. The A2 spike escrow was locked at 5259457 and raised at 5259468. All entries are in `fixtures/preprod/bank.json` and `txlog-bank.json`; wallet splits and funding are in `txlog-wallet-*.json`, the latest being the seller's split `7033b725d83f4b903a8d54a91d8a6a237ce0e58fc80e2c402f073c22eb43d7f5` (block 5260615).

## Limits and rules we hold

- Mainnet is read-only. No transaction is built, evaluated or submitted against a mainnet escrow.
- An HTTP error is a hole, counted and printed, never a data point.
- Until a guard has been exercised on preprod, its cell says "the validator's source says"; the guards exercised so far are listed under Transactions sent. The deployed V1 addresses are reproduced from the committed blueprint with the deployed parameters (`vendor/PROVENANCE.md`); this supersedes the earlier measurement that the bytes were not reproducible (claim C14), and the team's wording decision on it (PLAN Q-K) is still under review.
- Our own deployment (the admin control) is always labelled as ours and never presented as the deployed bytes.
- Only the 16-field V1 datum is supported. A 19-field V2 escrow shows as not decodable.
- Keys come from `.env` only. Nothing secret is printed or committed.

## Prior art

Checked by hand on 6 Oct, named here first: Kleros Escrow v2, Win-Win Dispute Resolution (Catalyst F6), AI Arbiter, Hokan, and the projects that ship their own escrow contract. Each builds its own escrow or a better judge.

## Layout

```
src/read      Koios and Blockfrost reads, retry, hole counter
src/census    datum decoder, census, reconciliation of two providers
src/agent     node:http server: UI API, MIP-003, site:data
docs/         static UI served by the agent and by GitHub Pages
shared/       types, constants, mocks (shared contract between the two streams)
fixtures/     pinned chain reads
```
