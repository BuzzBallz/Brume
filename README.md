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
| Reachability engine, solver, preprod bank, two-leg settlement, try anyway (`src/engine`, `src/solver`, `src/preprod`, stream A) | built and run on preprod, see Transactions sent |
| Masumi payment leg | built; one test purchase completed on preprod |
| Listing on preprod Sokosumi | registered on the preprod registry; not yet visible on the marketplace |
| Transactions | every preprod run is listed below with its hashes and blocks |

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
pnpm sign --role buyer|seller <file> # file-drop signature of a proposal (needs the party's key in .env)
```

`demo:preprod` in `package.json` points at a file that does not exist.

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

The decoder is checked three ways in `src/census/census.test.ts`: against Koios's own decoding of a real mainnet datum, on a set of corrupted datums that must fail (truncated, trailing byte, state as an integer, unknown state, 11 and 15 fields), and on the census arithmetic.

Cross-check: `fixtures/kickoff-2026-10-06.md` holds an independent census from another provider (NOWNodes, Blockfrost-compatible, tips 14031823 to 14031828). It gives the same counts (141 open, 140 decodable, 1 without a datum, 6 / 69 / 4 / 61 by state) and the same Disputed totals, a third read at an earlier tip.

The Pages snapshot in `docs/data/` is a separate read, at tip 14031774.

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

`HIRE_VIA=direct` (default) answers `start_job` with a job id only, for scripted calls. `HIRE_VIA=sokosumi` opens a payment at the Masumi payment service (preprod, `.env` holds `PAYMENT_SERVICE_URL`, `PAYMENT_API_KEY`, `AGENT_IDENTIFIER`) and answers with the specification's payment fields, with the times as the payment service returns them (unix milliseconds, strings) and an `amounts` list. The job runs once the funds are locked and the result hash is then submitted to the service. One test purchase of 2 ADA on preprod from the service's own purchasing wallet went from `awaiting_payment` to `completed` in about 3 minutes; withdrawal of the funds after the unlock time was not observed.

## Transactions sent (preprod, 6 Oct 2026)

Every write is on preprod, against escrows we locked ourselves. Mainnet is read only. Each run below is logged entry by entry in `fixtures/preprod/` and can be re-read on a second indexer with `pnpm verify <tx hash> preprod`.

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
| Stream B rehearsal from the UI, through the agent (escrow `9054b1d8…#6`, 75 % to the seller) | `1a5e3e6e6b4526cded37046a5473d5e0fd73cd51e2d4165d7e6297b087706c84` | `b92d44e4a226d873c12fa40200f5bda40841ad6f86e0c6b298ac52153eb305d4` | 5259766 | refused by the ledger (phase 1) |

### Try anyway: an action the engine predicts refused, sent to the chain

| Escrow | Action | Engine | Result |
|---|---|---|---|
| `8e0d6df4…#0` (Disputed) | buyer `WithdrawRefund` | needs FundsLocked or RefundRequested | refused by the validator (phase 2), body `ae8c0418…` |

### After a concession alone (claim C11, shared script)

The seller concedes without any exit signed (`fd9eb4f3ab29f6aa997289a05c252d16e43973022862c22e9e09d34b74452423`, block 5259672). Every branch the concession closes is then sent anyway:
- seller `SubmitResult`: refused by the validator (phase 2), body `bf2f54c7…`;
- seller `AuthorizeRefund` again: refused by the validator (phase 2), body `b13daa1b…`;
- buyer `SetRefundRequested`: refused by the validator (phase 2), body `4c409776…`.

The buyer, the only party left, exits: `43c16e6b845b2f4e237b85d27864c1d03eda49b4dc31082258bf526941a68bd5`, block 5259675.

### The admin pair, on our own deployment (claim S-2)

This is **our own deployment**, never the deployed bytes: the same compiled V1 code with only the admin set changed (our key three times, threshold 2). Script `d2e72e104b6b4908412f0facfd669821c3587819179ec8d0acf1400d`, not the shared `bd2adb68…`. Details are in `fixtures/preprod/own-deployment.json`.

| Step | Transaction | Block | Result |
|---|---|---|---|
| admin `WithdrawDisputed` on a Disputed escrow | `8e5c49cb3c3077bb77b7cff1054e18c972f8359c5bdf69699bca8523cc6a5fe5` | 5259662 | accepted |
| seller concedes (`AuthorizeRefund`) | `64299c10ef1b75dca69b9de19b3860f43125f2e7bb8cd1a0c111ae0bcde6dad8` | 5259664 | accepted |
| the same admin's `WithdrawDisputed` after the concession | body `a776a247…` | none | refused by the validator (phase 2) |
| buyer exits (`WithdrawRefund`) | `2b0f89ac0df8e81aa89b0a0fff6115c326e8ef1d9afce990e19923c320e2f03d` | 5259665 | accepted |

### The race, measured once (S-1)

In one measured run, the pre-signed exit landed in the same block as the concession, 0.7 s behind it, and a competing exit fired on first sight of the concession was refused.
- Leg 1: `92089c4c57865cea872c496b6e0dd0ae85f8630afc54448bfcbaf3108dc41e47`.
- Leg 2: `bb928f2ea4ecd82d9ad009b3fcd555652de61a9ffa2a6236eb127b87db955cf9`.
- Both legs are in block 5259678.
- The rival was the buyer's own `WithdrawRefund` taking the whole pot. It was refused by the ledger (phase 1, leg 1's output already spent), body `533e4981…`.

This is one run, not a probability. It says nothing about a rival submitting on the same node. The solver keeps the front-run probability at its worst case. Details are in `fixtures/preprod/race-18268b5a…_0.json`.

### Setup transactions

Bank lock: `9054b1d81c9ce47db1e3ea993aa34f0f978eb95629d4319131f149619c68de9d`, block 5259528. Each escrow was then raised to Disputed by its buyer (`SetRefundRequested`, blocks 5259535 to 5259549). Wallet splits and funding are in `fixtures/preprod/txlog-bank.json` and `txlog-wallet-*.json`.

## Limits and rules we hold

- Mainnet is read-only. No transaction is built, evaluated or submitted against a mainnet escrow.
- An HTTP error is a hole, counted and printed, never a data point.
- Until a guard has been exercised on preprod, its cell says "the validator's source says"; the guards exercised so far are listed under Transactions sent. The deployed V1 addresses are reproduced from the committed blueprint with the deployed parameters (`vendor/PROVENANCE.md`).
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
