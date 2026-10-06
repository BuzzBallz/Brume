# Brume

TOKEN2049 Origins, Cardano track, team BuzzBallz. Brume reads escrows held by the deployed V1 payment-escrow validator and shows what each party can do with them right now.

Input: an escrow UTxO reference. Output: for each of the 7 redeemers and each of buyer, seller and admin, whether the validator's source says the action can succeed now. No model decides anything: every verdict comes from the validator's guards, read from its source (rung R4) until a guard has been exercised on preprod (rung R5).

This README states what exists today. The status table says what does not.

## Status

| Part | State |
|---|---|
| Keyless read layer, 429 retry, hole counter (`src/read`) | built, tested |
| 16-field V1 datum decoder and census from the UTxO set (`src/census`) | built, tested, reproducible from a committed fixture |
| Agent server: UI API and MIP-003 job interface (`src/agent`) | built; grid, solver, try and settle routes serve mocks |
| UI (`docs/`): list, escrow, grid, settle flow, solver | built over live data and mocks |
| Reachability engine, solver, preprod fixture, two-leg settlement (`src/engine`, `src/solver`, `src/preprod`) | not in this branch yet |
| Masumi payment leg and listing on preprod Sokosumi | not done: `start_job` answers without the payment fields |
| Transactions | none sent yet; the hash table below is empty on purpose |

## Run it

A judge needs no key. Node 22.18 or later and pnpm.

```
pnpm install
pnpm check                          # tsc + node --test
pnpm census:mainnet                 # live, keyless (Koios); READ_SOURCE=fixture for offline
pnpm agent                          # UI and API on http://127.0.0.1:8787 (PORT to change)
pnpm site:data                      # snapshot docs/data/*.json for GitHub Pages
```

Commands listed in `package.json` for `engine`, `solver`, `verify`, `sign` and `demo:preprod` point at files that do not exist yet.

`READ_SOURCE=fixture pnpm census:mainnet` reads `fixtures/mainnet/utxos-koios.json` and reprints the census below with no network. A live run reads the chain again, so its tip and counts will have moved.

## Census, mainnet, read-only

Pinned to tip block **14031729**, hash `99c2eeeb831fa611dfac3b8ec48b8f769e09c7b5e35ef63766217cf2f09af525`, read 6 Oct 2026 from one provider (Koios), 0 holes. Totals are summed from the UTxO set at the V1 script address, never from an address summary.

| | |
|---|---|
| Open UTxOs | 141 |
| Decoded as 16-field V1 datums | 140 |
| Not decodable | 1 (`6be625f6…0f5afe#26`, no inline datum) |
| By state | FundsLocked 6, ResultSubmitted 69, RefundRequested 4, Disputed 61 |
| Disputed, held | 295.342750 ADA and 498.15 USDM (native units, no fiat) |

What this run does not show: the second-provider cross-check. It needs a Blockfrost key, none was set, so this census is **not** cross-checked. With `BLOCKFROST_MAINNET_PROJECT_ID` in `.env`, `pnpm census:mainnet --pin` reads both providers, prints the per-row and per-total differences, and pins both snapshots.

The decoder is checked three ways in `src/census/census.test.ts`: against Koios's own decoding of a real mainnet datum, on a set of corrupted datums that must fail (truncated, trailing byte, state as an integer, unknown state, 11 and 15 fields), and on the census arithmetic.

Cross-check: `fixtures/kickoff-2026-10-06.md` holds an independent census from another provider (NOWNodes, Blockfrost-compatible, tips 14031823 to 14031828). It gives the same counts (141 open, 140 decodable, 1 without a datum, 6 / 69 / 4 / 61 by state) and the same Disputed totals as the Koios census above, so the two providers agree at two tips.

The Pages snapshot in `docs/data/` is a separate read, at tip 14031774.

## Mocks

Every mock lives in `shared/mock/*.mock.json`. Each is hand-made, not evidence, and says so in its `_note`.

| Mock | Used for |
|---|---|
| `grid` | `GET /api/grid`, the grid in `docs/data/grid.json`, the job result |
| `solver` | `GET /api/solver`, `docs/data/solver.json`, the job result |
| `txlog` | `POST /api/try`, `POST /api/proposal/:id/submit` |
| `proposal` | `POST /api/proposal`, `GET /api/proposal/:id` |
| `census`, `datum-disputed`, `utxo-disputed` | `?source=mock` in the UI. The UTxO file is a real Koios row; the other two are decoded by hand from it |
| `job-result` | shape reference for the MIP-003 result |

Live agent routes answer mocks with the header `x-brume-source: mock`, and the UI then shows "Live, partly mock". The job result carries `"mock": ["grid","solver"]`. The Pages snapshot does not flag them: its grid cells read "mock" and nothing else says so.

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

## Transactions sent

None yet. Every write will be on preprod, against escrows we locked ourselves, and each hash will be listed here with its state and the second-indexer read-back.

## Limits and rules we hold

- Mainnet is read-only. No transaction is built, evaluated or submitted against a mainnet escrow.
- An HTTP error is a hole, counted and printed, never a data point.
- Until a guard has been exercised on preprod, its cell says "the validator's source says". The deployed V1 addresses were reproduced by stream A from the committed blueprint with the deployed parameters (PLAN §10, 6 Oct); a script a judge can run follows with the own-deployment work.
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
