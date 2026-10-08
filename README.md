# Brume

**Only its arbitrator can split a disputed escrow, and no arbitration has happened since 27 November 2025 (Koios, through block 14033013). Brume builds the transaction pair that lets the two parties do it without one.**

On 10 August 2026 Masumi published [*The Return Counter Nobody Built*](https://www.masumi.network/blogs/the-return-counter-nobody-built). It opens: "Everyone spent 18 months building the checkout for AI agents. Nobody built the return counter."

On Cardano mainnet, **61 escrows** of the V1 contract sit in `Disputed`, with their arbitration window open for a median of **333 days** (census at block 14031954). Across all **120** arbitrations in the contract's lifetime, the seller received **nothing** in every one (receipt `fixtures/arbitrations-14034022.json`, `node src/solver/history.ts`, Koios, 0 holes; derivation in [the annex](paper/PAPER.pdf)). None of the **215** live agents on Masumi's mainnet registries (189 V1, 26 V2) mentions dispute, refund, split, mediation or arbitration in its registration (Koios, two independent routes agreeing at block 14033540: `node src/census/registry.ts` and `node src/census/registry-check.ts`, receipt `fixtures/masumi/registry-14033540.json`).

TOKEN2049 Origins, Cardano track, team BuzzBallz.

**Demo video (2:44): [youtu.be/4jEcm7x3p30](https://youtu.be/4jEcm7x3p30).** The mathematical annex: [*The paper*](#the-paper).

Site: [buzzballz.github.io/Brume](https://buzzballz.github.io/Brume/), a snapshot that stays up. Live and read-only while our host runs: [the agent behind its tunnel](https://retrieve-consequence-duncan-ict.trycloudflare.com/), which refuses every write from outside the machine (HTTP 403); its address changes if the tunnel restarts.

The objections, including the ones the marketplace's own creator put to us in writing, are answered in [*The questions you are about to ask*](#the-questions-you-are-about-to-ask).

## What Brume does

Give it one escrow. It answers three questions.

1. **What can each party do right now?** A 7 × 3 grid: seven redeemers against buyer, seller and admin, with the guard that blocks each forbidden cell. Every verdict comes from the validator's guards, read from its source (rung R4) until a guard has been exercised on preprod (rung R5).
2. **Which splits are worth taking?** Bands and break-evens from the measured arbitration history and a bound on the arbiter's rate. Break-evens, never a recommended split.
3. **How do the two parties execute one?** A transaction pair in which the buyer signs the exit before the seller concedes, so once the seller has conceded, the buyer can no longer refuse the agreed split. Refusing would mean racing it, which we have not measured.

It runs as a Sokosumi Coworker, approved in the TOKEN2049 event Workspace and paid per Task in test USDM (three paid Tasks collected by the seller, *Sokosumi Coworker* below), as a MIP-003 agent registered on the preprod Masumi registry, and as a web UI over the same engine.

## What Brume is not

- **Not an arbiter.** No model decides anything and no party uploads evidence. No text anywhere decides an amount, so there is nothing to prompt-inject.
- **Not a new escrow.** We work on the contract that is already deployed and already holding the money: a new deployment cannot reach the 61 escrows on mainnet.
- **Not a claim that the contract is broken.** The validator's source says the contract can pay a split: in V1 the dispute branch constrains no output, and in V2 the split is two explicit fields in the redeemer. What neither version has is a way for the two parties to commit to an agreed split **without the admin set**. That is the only thing we build.

## The result, in one paragraph

From a disputed escrow, the seller's own `AuthorizeRefund` empties the result hash and moves the state to `RefundRequested`. The validator's source says the arbitration branch needs both a `Disputed` state and a non-empty result hash, so after that concession, on an escrow past its result deadline (all 61 are), the admin set has no branch left. On our own deployment of the same code, the admin's `WithdrawDisputed` after a concession was refused by the validator (phase 2, *The admin pair* below). The remaining move is the buyer's `WithdrawRefund`, which, the validator's source says, constrains no output: the buyer can pay the seller an agreed share. Nothing makes them, which is why the exit is signed first.

**We never split a `Disputed` escrow.** Only `WithdrawDisputed` does that, and it needs the admin keys. We operate on the state the seller's own concession creates.

The full derivation, both theorems, the fee-incidence result and the quantitative model are in *The paper*, just below.

## The paper

**[Negotiated exit from a deployed eUTxO escrow](paper/PAPER.pdf)** (PDF, 7 pages; GitHub renders it in the browser; LaTeX source in [`paper/PAPER.tex`](paper/PAPER.tex)).

The paper derives the deployed validator's guard table from its source, then checks it against the deployed bytecode by submitting transactions on preprod. What it establishes:

- **Arbitration closure.** Once the seller's deadline to deliver has passed, the seller's concession is irreversible and removes arbitration for good: the buyer is then the only party able to move the escrow, and the only branch that takes value out of the script constrains no output.
- **Almost no split is self-enforcing,** so almost none is reachable by incentives alone.
- **Every split is reachable by construction,** through a transaction pair whose second leg is signed before the first is submitted.
- **Fee incidence depends on the exit path.**
- **The bargaining set is priced from measured arbitration history,** not from assumption.

It also states what the construction does not do: it removes a refusal, it does not remove a race. Sections: setting and notation, the guard table, arbitration closure, fee incidence, self-enforcement, reachability by construction, the bargaining set, what was executed, limitations.

## The evidence, up front

Twelve settlements on preprod, both legs of each in one block, indexed in `fixtures/preprod/README.md` §1; the two takes from the UI (`9054b1d8…#7` and `0452fc53…#0`) are also under *Transactions sent*. For all twelve, twenty-four legs, the witness walk (`fixtures/preprod/witnesses-*.json`) read each leg's CBOR back from the chain, checked its hash, and found every vkey witness hashing to the buyer or the seller of that escrow's own datum: **no admin key in any of them**.

One to read, a token pot in **block 5259570**:

| Leg | Redeemer | Transaction | |
|---|---|---|---|
| 1 | `AuthorizeRefund` | `be1a2161b8c451309549265337893cc05bd4f75e9a7e3b971ccca86d7bcb4df8` | the seller signs, the pot stays at the script |
| 2 | `WithdrawRefund` | `ccb04dd233010d1e71ca0ebacb68cc83c28247e78e16b5f84a096389b2eab637` | the buyer signs: 12 tADA + 6 tUSDM to the buyer, 8 tADA + 4 tUSDM to the seller |

Others run 60/40, 70/30 and 25/75 (buyer/seller). Every settlement above runs on the **same script hash** as the mainnet escrows (`bd2adb68…`): the same bytes that hold the mainnet value.

**What we do not claim.** Pre-signing removes a refusal. It does not remove a front-run, and front-running is **not measured**: a rival exit, checked valid before each contended run, never landed, but no run gave it a clean window. The solver prices the front-run at its worst case. Details under *Leg timing*.

## Who it is for

Agents on Masumi are paid through its escrow contracts: V1 holds the 61 on mainnet, and Sokosumi paid our Tasks through V2 (`Web3CardanoV2`), which Brume's settlements do not touch. The 61 belong to a small, closed set of buyers and sellers. The marketplace itself lists 9 vendors, 12 AI coworkers and 41 marketplace agents ([sokosumi.com/vendors](https://www.sokosumi.com/vendors), read 6 Oct 2026). The step where an exit has to work is enterprises buying agent work directly. Brume is hired per job, like any agent; the business we would build on it is basis points on every escrow at creation, priced like a payment guarantee, not a fee on the rare dispute.

This README states what exists today. The status table says what does not.

## Status

| Part | State |
|---|---|
| Keyless read layer, 429 retry, hole counter (`src/read`), transaction lookup on two indexers (`pnpm verify`) | built; the read layer is tested, `verify` was run on a real V1 transaction |
| 16-field V1 datum decoder and census from the UTxO set (`src/census`) | built, tested, reproducible from a committed fixture |
| Agent server: UI API and MIP-003 job interface (`src/agent`) | built; every route serves stream A's engine, solver and settlement, no mocks |
| UI (`docs/`): list, escrow, grid, settle flow, solver | built over the live agent; `?source=snapshot` for Pages, `?source=mock` for offline building |
| Reachability engine, solver, preprod bank, two-leg settlement, try anyway (`src/engine`, `src/solver`, `src/preprod`, stream A) | built and run on preprod: 12 logged settles on path B and 5 race runs, see Transactions sent |
| Masumi payment leg | built; one test purchase completed and withdrawn on preprod, exported to `fixtures/masumi/test-purchase.json` |
| Sokosumi | Coworker `Brume` (`01a1128d-de6e-700b-b929-c5b4289c2a05`, vendor BuzzBallz) approved in the TOKEN2049 event Workspace (access GRANTED); three paid Tasks completed and collected by the seller, 1 tUSDM net each (*Sokosumi Coworker* below). Masumi registry: agent `67ab0c92…cc8c16000002`, Dynamic pricing, after two metadata updates (the test purchase used `…cc8c16000000`) |
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

The Pages snapshot in `docs/data/` is a separate, later read, at tip 14034453: 141 open, 61 Disputed, 0 holes, no difference between the two providers. It also replays the UI take at 0.40 on bank escrow `0452fc53…#0`, with its run log, read-back balances and signers.

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

`input_data.network` is `mainnet` (default, read-only) or `preprod`. The result is one readable paragraph (the state, whether the seller can concede, the 30-day band as a break-even, a link into the UI), a blank line, then a JSON string: escrow reference, grid, solver output, and the same link. Shapes follow the [MIP-003 text](https://github.com/masumi-network/masumi-improvement-proposals).

`HIRE_VIA=direct` (default) answers `start_job` with a job id only, for scripted calls. `HIRE_VIA=sokosumi` opens a payment at the Masumi payment service (preprod, `.env` holds `PAYMENT_SERVICE_URL`, `PAYMENT_API_KEY`, `AGENT_IDENTIFIER`) and answers with the specification's payment fields, with the times as the payment service returns them (unix milliseconds, strings) and an `amounts` list. The job runs once the funds are locked and the result hash is then submitted to the service. It was exercised once: a test purchase of 2 tADA from our own local payment service's purchasing wallet went from `awaiting_payment` to `completed` in about 3 minutes. The buyer locked the funds in `6b359cff0b44064b5e4fc3b5da8e79850b04a46be507b3e6cc596f1f8c770b0c` (block 5259425) and the agent's result was submitted in `eaaf7c516ecf9f6cdb8ef9fdc674a54b2c109e7553a4d1a8da1cc33564fad1f6` (block 5259429). Both run on the Masumi payment contract, not the V1 escrow. The record is exported from the service's database to `fixtures/masumi/test-purchase.json` (public fields only). After the unlock time the service withdrew them on its own in `5d9affd077982408b4e2d708ce652273394feeb2436b20f17a7567a90acc0273` (block 5260579): the payment to the selling wallet, the collateral back to the purchasing wallet.

A provider that rate-limits or fails (HTTP 429 or 5xx) is answered as a 503 hole, in one sentence: nothing was built or sent. A witness set that is not valid CBOR, or not signed by the expected key, is a 400 with its reason.

## Sokosumi Coworker

Brume runs as a Sokosumi Coworker on preprod, approved in the TOKEN2049 event Workspace: Vendor `BuzzBallz` (`01a1128d-bfce-72c6-82de-a73ffd028a38`), Coworker `Brume` (`01a1128d-de6e-700b-b929-c5b4289c2a05`). A Task names one escrow in its text (`<64-hex tx hash>#<index>`, and "preprod" for a preprod escrow); the worker answers with the same paragraph and JSON as MIP-003 `/start_job`. No model is involved.

```
COWORKER_ID=01a1128d-de6e-700b-b929-c5b4289c2a05 node src/agent/worker.ts   # needs `sokosumi --preprod auth login` and the Coworker runtime key in the CLI vault
```

The worker lists the Tasks assigned to the Coworker, starts each READY one, computes the answer and completes the Task. It writes a journal per Task in `out/worker/` before every external write, so a restart resumes instead of redoing work, and an uncertain start or completion is checked against the Task's status first. A failed chain read leaves the Task running for the next poll; it is never answered from a hole.

First Task, unpaid execution test: `01a11290-45b8-7728-bb4c-8bee4c51da2f`, on the mainnet escrow `a7084c50…#0`, CREATED → READY → RUNNING → COMPLETED (completion event `01a11290-6d79-722c-bbfc-1b7b71df6aeb`). Event access is granted (TOKEN2049 Workspace, access `01a11296-82e0-7031-992e-117e7fafdbec`), and an event Task ran through the same worker, paid and collected (below).

**Paid Task, seller paid.** With `PAID_TASKS=true` the worker asks our payment service for signed terms (1 test USDM, Preprod, Web3CardanoV2, agent registered with Dynamic pricing), posts them on the Task as a `masumiPayment` event, runs the job once the escrow is confirmed funded, submits the result hash, completes the Task, and reads the seller receipt after the payment service has collected.

| | |
|---|---|
| Task | `01a112ac-6780-748a-ab29-8334a9eb9a73`, Coworker `01a1128d-de6e-700b-b929-c5b4289c2a05`, COMPLETED |
| Payment event on the Task | `01a112ac-833f-76fc-9e57-9367ee131eba` |
| Escrow funded by Sokosumi's buyer (FundsLocked) | [`f442d3e8a300209e454ce99cc717cf3ce69a45cb6bb90e23c893cb835261076d`](https://preprod.cardanoscan.io/transaction/f442d3e8a300209e454ce99cc717cf3ce69a45cb6bb90e23c893cb835261076d), block 5261661 |
| Result hash submitted (ResultSubmitted) | [`05aec9c142e46ac0ade001b7eaa8c995176fa1f0129e69108f166fee41fcdaa6`](https://preprod.cardanoscan.io/transaction/05aec9c142e46ac0ade001b7eaa8c995176fa1f0129e69108f166fee41fcdaa6), block 5261664 |
| Collection by the seller (Withdrawn) | [`45265f867b734e62346b28d45381d997277d99c5b44ffeb888bc5b08241fbd50`](https://preprod.cardanoscan.io/transaction/45265f867b734e62346b28d45381d997277d99c5b44ffeb888bc5b08241fbd50), block 5261770, `valid_contract` true |
| Seller address | `addr_test1qrdzza4nsmh28dfu8mxm35gagu5njs4r7jlugamrvr9ur0z88zdqlqflvhxe5wlaxpegs3g7kfrgxchussjx66dyxlqqwejgfk` |
| Token, net received | test USDM `16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d`, **1 tUSDM** (1000000 units) net to the seller address |

The receipt from `sokosumi runtime receipt` says `settled: true`, `onChainState: Withdrawn`, with the same transaction hash. The net amount was checked separately on Blockfrost, from that transaction's inputs and outputs at the seller address.

A second paid Task, the hire filmed with the take at 0.40 (`01a112b7-41b4-711b-b920-030378f45aed`, on escrow `0452fc53…#0`): payment event `01a112b7-533e-74b2-97cd-d4e2062c6d84`, escrow funded in `56334a9331577ea2ac7491f748b327386f811bcd2836bd1e9112bf0978d06205` (block 5261685), result hash in `5a7b5196947a7bb17d588fc4be125dc038785e3c9fa3bae9e3530d38712527b8` (block 5261687), collected by the seller in [`2563ba0104e1fd2dccbc5ec0b24ad67411ea89bee8a7753f9e07b89b578aa4b1`](https://preprod.cardanoscan.io/transaction/2563ba0104e1fd2dccbc5ec0b24ad67411ea89bee8a7753f9e07b89b578aa4b1) (block 5261808), net 1 tUSDM to the same seller address, checked the same way.

A third paid Task, created in the TOKEN2049 event Workspace (`01a112bf-cf3c-772c-8f52-3a50e33d3c8d`): payment event `01a112bf-e69f-726c-bbc3-e09f71efe17a`, collected by the seller in [`8375bacaf9f08a9355e2a19413a866ff40eb7bfe67391a572b2e1a437888d6b9`](https://preprod.cardanoscan.io/transaction/8375bacaf9f08a9355e2a19413a866ff40eb7bfe67391a572b2e1a437888d6b9) (block 5261832), net 1 tUSDM, same check.

## Transactions sent (preprod, 6 Oct 2026)

Every write is on preprod, against escrows we locked ourselves. Mainnet is read only. The full index of the evidence files, run by run, is `fixtures/preprod/README.md`. The table below lists the first four settles and the two takes; the others are indexed in its §1. Each run below is logged entry by entry in `fixtures/preprod/` and each accepted transaction can be re-read on a second indexer with `pnpm verify <tx hash> preprod`.

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
| Stream B take at 40 % to the seller, from the UI on B's machine (escrow `0452fc53…#0`) | `5f3d960ab279f6ba4e329534aa67bfd65b2d39e81a61490ca4248dcf24c221a8` | `5db25159151261d1c352cf5281f880bd6a809fc35415bcaa1e72c32692f8f382` | 5261685 | refused by the ledger (phase 1) |

### Try anyway: an action the engine predicts refused, sent to the chain

| Escrow | Action | Engine | Result |
|---|---|---|---|
| `8e0d6df4…#0` (Disputed) | buyer `WithdrawRefund` | needs FundsLocked or RefundRequested | refused by the validator (phase 2), body `ae8c0418…` |
| `c3e0b68a…#0` (Disputed), from the UI | buyer `WithdrawRefund` | needs FundsLocked or RefundRequested; needs an empty result hash | refused by the validator (phase 2), body `7b501a19e699405fcad115f517f9cc4050b3982d97f46426ad3e03eb3301819b`; the escrow is unspent |

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

Checked by hand on 6 Oct, named here first: Kleros Escrow v2, Win-Win Dispute Resolution (Catalyst F6), AI Arbiter, Hokan, and the projects that ship their own escrow contract. Each builds its own escrow or a better judge. Simpuru ([github.com/Simpuru-xyz/simpuru](https://github.com/Simpuru-xyz/simpuru), created 6 Oct, in this track) deploys Masumi's V2 validator unchanged with its own arbiter key: it replaces the V1 arbitrator, which has not acted since 27 November 2025, with its own, and a new deployment cannot reach the 61 escrows on mainnet. Brume lets the two parties settle without one on the escrows that exist. On the preprod registry, an agent registered on 5 Oct as Recourse mentions disputes in its registration; its metadata names no author or URL (registration NFTs: [A](https://preprod.cardanoscan.io/transaction/09615b4182a7d9275ffc6fd4ac492108bcb680e86d042a7b675fd37e7e6dfd00), [B](https://preprod.cardanoscan.io/transaction/4d798e579573d4283887342ffe2f4cadc2aa4f18a02ea53fd95c9d44cba56b71)).

## The questions you are about to ask

The submission is a three-minute video, so these are answered here rather than in a room. Every one has been put to us already, and the sharpest, including the first, came from the marketplace's own creator in writing.

**"The dispute path already allows a 60/40 split, by quorum."** Correct, and it is the strongest objection to this project. `WithdrawDisputed` constrains no output in V1, and in V2 the split is two explicit fields in the redeemer. The contract can do 60/40. **It cannot do it without the admin set.** There has been no arbitration of any kind for 313 days. Across the 120 that did happen, the seller side received something in zero of them. And 61 escrows now sit past their unlock time, a median of 333 days each. The split is available and nobody is there to sign it. On four of them nobody *can*: `AuthorizeRefund` empties `result_hash`, `WithdrawDisputed` requires it non-empty, so the admin set is permanently out and only the buyer can move the value. What we build is the exit that needs two signatures and no third key.

**"Then the other side can still build a different transaction and race yours."** True, and we say it first. Pre-signing removes the *refusal*, not the *race*. Once leg 1 lands, the buyer could broadcast a competing `WithdrawRefund`. What makes it hard is that ours is already propagating, chained to the first, while theirs cannot be built until the first is visible, and they cannot invalidate ours by spending their own funds, because leg 2's fees come from the conceding party's inputs. Both legs landed in the same block in every settlement we ran. **That is not a safety claim**: each of those runs handed both legs to one node, which is favourable rather than a race, and the front-run itself is unmeasured. The solver prices it at its worst case. See *Leg timing* under Transactions sent.

**"Kleros already does settlement negotiation."** Kleros built a settlement *state* into their own contract: waiting-settlement-buyer, waiting-settlement-seller, a settlement timeout. This validator has none, no settlement state and no settlement redeemer, and it is someone else's deployed bytecode that we cannot change. A settlement turns out to be reachable anyway, by composing two redeemers written for other purposes, and the exit can be counter-signed before the concession is ever submitted. Kleros also lets you propose a number; nothing anywhere tells you *which* numbers are individually rational.

**"Does a model decide the split?"** No, and nobody has to trust one. The band comes from the validator's own guards and the measured history; the point inside it is the parties' choice, and the default the product proposes is only a proposal either side can counter. *Not an arbiter*, above, is the short version.

**"Why would the seller accept less than everything?"** Because the measured alternative is zero: in 120 of 120 arbitrations the seller side received nothing. And symmetrically, a full refund needs an arbitrator who has not acted since 27 November 2025.

**"And if the two of them do not agree?"** Then they are exactly where they are today, waiting. **We do not make agreement compulsory. We make it possible**, and trying costs nothing, because an unsent transaction moves no money.

**"How much money is actually stuck?"** Three USDM in the median escrow, and 295.342750 ADA plus 498.15 USDM across all 61. Every party in them belongs to one consortium, so nobody outside is out of pocket. **This is a measurement of a primitive on a live adversarial test set, not a victim narrative.** The reason nothing has broken yet is that buyer, seller and arbitrator are the same group of people, which is also the thing the funded growth plan changes.

**"Are you saying the marketplace is broken?"** The other way round. Sixty-one frozen jobs is survivable because the agencies absorb it. At a hundred agents with enterprises buying directly it is not. The 333 days is not a requirement anyone published; it is the measurement showing that the exit the next step needs does not exist yet.

**"Are those 61 just abandoned dust?"** No, and the clearest evidence is what moved beside them. Between mainnet blocks 14033472 and 14034002, 27 escrows in `ResultSubmitted` were withdrawn normally, 96 down to 69, while the 61 `Disputed` references were the same 61: none gone, none new. Healthy escrows churn. These do not.

**"Why did nobody find this?"** The validators were audited, and the audit asked whether an attacker could lock up or steal funds. Nobody asked what happens if the arbitrator never comes.

## Layout

```
src/read      Koios and Blockfrost reads, retry, hole counter
src/census    datum decoder, census, reconciliation of two providers
src/agent     node:http server: UI API, MIP-003, site:data
docs/         static UI served by the agent and by GitHub Pages
shared/       types, constants, mocks (shared contract between the two streams)
fixtures/     pinned chain reads
```
