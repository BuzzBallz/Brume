# fixtures/preprod — evidence index

Every file here was written by a run against Cardano **preprod**, on escrows we locked with our own preprod keys. Nothing here touched mainnet. Each section says what a file proves, where it is on chain, how to re-check it, and what may and may not be said from it.

- **Shared V1 script** (the escrow Masumi deployed): hash `bd2adb685621e224aae7571cb6bd8f0beb0fdd31875eb3a27feee6c0`, address `addr_test1wz7j4kmg2cs7yf92uat3ed4a3u97kr7axxr4avaz0lhwdsqukgwfm`. The same compiled bytes as on mainnet: the committed V1 blueprint with the deployed parameters reproduces both addresses (PLAN §10, "Measured 6 Oct").
- **Our own deployment** (S-2 only): the same blueprint with only the admin set changed to our key ×3, threshold 2: hash `d2e72e104b6b4908412f0facfd669821c3587819179ec8d0acf1400d` (`own-deployment.json`).

## Re-check any of it without a key

```
pnpm verify <tx hash> preprod         # Koios, plus Blockfrost when BLOCKFROST_PREPROD_PROJECT_ID is set: block, slot, valid_contract, redeemer
pnpm engine <txHash#index> --net preprod   # the 7×3 grid of a bank escrow that is still open
node src/preprod/reproduce-v1.ts         # offline: the vendored V1 blueprint + the deployed params give the deployed script hash and both addresses
```

Explorer: `https://preprod.cardanoscan.io/transaction/<tx hash>`. The sections name files and escrows by their first 8 hex characters; the last section lists every transaction with its full hash, generated from the logs, never retyped.

## How to read a txlog

One JSON array per run, one entry per (step, transaction), updated in place from pending to confirmed:

| Field | Meaning |
|---|---|
| `expected` | what the engine predicted before the send: `accept` or `refuse` |
| `status`, `stage` | `accepted` / `refused`, at `submit` (the node's answer) or `confirm` (seen in a block) |
| `refusal.phase` | **1** = the ledger refused before any script ran (inputs spent or unknown, integrity hash). **2** = the node ran the validator and it failed (`ValidationTagMismatch (IsValid True) … PlutusFailure`): rejected from the mempool, so no collateral was taken |
| `via` | the provider that took the submit (`koios` or `blockfrost`) |
| `block` | height, hash and slot once confirmed |
| `readback` | leg 2 only: what buyer and seller received, re-read on the **other** indexer from leg 2's own inputs, outputs and fee, never copied from the proposal |

An HTTP error or a timeout is a hole, never a refusal: it is recorded as one (`error: "hole: …"`) and counted, never presented as an answer.

## 0. Run it yourself: `pnpm demo:preprod`

```
pnpm demo:preprod --keygen    # once: two fresh preprod root keys into .env; only the addresses are printed
                              # then fund the buyer address with ≥ 80 tADA from the preprod faucet
                              # (https://docs.cardano.org/cardano-testnets/tools/faucet) and set BLOCKFROST_PREPROD_PROJECT_ID
pnpm demo:preprod             # [--ada 10] [--share 0.4]
```

Each step is confirmed on chain before the next: the separate UTxOs D13 needs (paid by the buyer, so the seller needs no funding) → lock one escrow → the buyer's dispute → the engine's grid → try anyway (the buyer's `WithdrawRefund`, predicted refused) → the seller-first settlement, the replay, the read-back. Exit code 0 only if every step did what the engine predicted.

First run, 6 Oct, our keys (`txlog-824bbdd3…_0.json`): wallet tx in block 5260093, lock 5260096, dispute 5260099, try anyway refused in phase 2, both legs in block 5260101, replay refused in phase 1, read back on Koios: buyer 6, seller 4 tADA, the agreed split. 241 s from the first send to leg 2's block, exit code 0.

## 1. Settlements (path B, seller first)

The seller concedes in leg 1 (`AuthorizeRefund`: Disputed → RefundRequested, result hash emptied); leg 2 (`WithdrawRefund`, buyer's required signature) was signed by the buyer **against leg 1's output before leg 1 existed**, and pays the agreed split with no fee output and no collateral output. Both legs landed in the same block every time. Leg 2 replayed byte for byte is refused by the ledger (phase 1, inputs spent), not by the validator.

| File | Run | Block | Split read back (buyer / seller) |
|---|---|---|---|
| `txlog-spike-6d3b12d4…_0.json` | A2 spike, first settle on the shared script | 5259491 | 12 / 8 tADA (40 % to the seller), the same on Koios and Blockfrost; read for this index, not stored in the log (the run predates the field) |
| `txlog-7a37751b…_0.json` | A5 file drop: `pnpm sign --prepare`, `--role buyer`, `--role seller` | 5259570 | 12 tADA + 6 tUSDM / 8 tADA + 4 tUSDM |
| `txlog-b475bad5…_0.json` | settle, ADA-only pot | 5259631 | 14 / 6 tADA |
| `txlog-9054b1d8…_6.json` | stream B's UI rehearsal through the agent (B's machine) | 5259766 | 5 tADA + 2.5 tUSDM / 15 tADA + 7.5 tUSDM |
| `txlog-9e7c0991…_0.json` | Integration 1 dry run through stream B's agent API (A's machine) | 5259954 | 12 tADA + 1.2 tUSDM / 8 tADA + 0.8 tUSDM |
| `txlog-824bbdd3…_0.json` | `pnpm demo:preprod`, from nothing in one command | 5260101 | 6 / 4 tADA |

On our logged settles (`7a37751b`, `b475bad5`, `9e7c0991`, and `824bbdd3`, where the demo checks it itself) the readback equals the proposal's `payout` to the unit, and Koios and Blockfrost give the same balances (checked on `b475bad5` and `9e7c0991`). `9054b1d8…#6`'s proposal is on stream B's machine: its UI makes that comparison.

Rerun (needs `PREPROD_BUYER_SKEY`, `PREPROD_SELLER_SKEY` and a Disputed escrow of yours): `pnpm sign --prepare <ref> --share 0.4`, then `pnpm sign --role buyer <file>`, then `pnpm sign --role seller <file>`. Readback of a settled log: `node src/preprod/readback.ts <ref>`.

**Sayable (R5):** the deployed bytes accept `SetRefundRequested` (ResultSubmitted → Disputed), `AuthorizeRefund` (Disputed → RefundRequested) and `WithdrawRefund` from RefundRequested with no fee or collateral output; an exit was signed against an output that did not exist yet and landed (C8). **Not sayable:** anything about a front-run from these runs (each handed both legs to one node: favourable, not a race). That is section 4.

## 2. Bank and fixtures

| File | What it holds |
|---|---|
| `bank.json` | The registry: 26 escrows (path, owners A or B, pot, lock tx, dispute tx). Its `state` is what our runs last wrote; the chain is the truth: `node src/preprod/bank.ts list` re-reads every one. 18 reached Disputed through a real buyer-signed `SetRefundRequested`, as the 61 mainnet escrows did; 8 were locked directly in Disputed (stream B's 7, whose keys are not ours, and the path A one) |
| `txlog-bank.json` | Every lock (11, blocks 5259528–5260008) and every dispute (18, all accepted). One lock was refused at the mempool ("All inputs are spent", phase 1): its inputs were already spent when it reached the node; nothing landed, and the next lock (`2263b7a8…`, block 5259724) was built from live UTxOs |
| `txlog-spike-e83f32f8…_0.json` | The first fixture: lock in ResultSubmitted (5259457); the first dispute refused in phase 1 with `ScriptIntegrityHashMismatch` (Mesh beta.96's stale PlutusV3 cost model, kept as evidence of the trap), then accepted with the chain's cost model (5259468) |
| `txlog-wallet-buyer.json`, `txlog-wallet-seller.json` | Wallet preparation: UTxO splits (the seller needs ≥ 2 independent UTxOs, D13) and the seller → buyer tUSDM transfer |

Escrows still open (6 Oct 17:05 SGT; `bank.ts list` for now): stream B's `9054b1d8…#7` (20 tADA + 10 tUSDM), `c3e0b68a…#0–#3` (20 tADA + 2 tUSDM each) and `47db047f…#0` (20 tADA + 10 tUSDM); 8 of ours, all Disputed.

Rerun: `node src/preprod/bank.ts fast --usdm 0` (one escrow from nothing to Disputed, timed), `bank.ts topup --owners A --count N --ada 20 --usdm 0`.

## 3. Controls: the engine predicts a refusal, the tx is sent anyway

Each control is built without local evaluation and sent, so the node runs the validator. Before each, the engine's reason is written into the step.

| File | Control | Result |
|---|---|---|
| `txlog-8e0d6df4…_0.json` | buyer's `WithdrawRefund` while Disputed (engine: needs FundsLocked or RefundRequested) | refused, phase 2: the first refusal by the deployed bytes (A4) |
| `txlog-5aee2110…_0.json` | the same control through stream B's agent (`POST /api/try`) | refused, phase 2 |
| `txlog-c11-8e0d6df4…_0.json` | C11, first run: after the seller's concession alone (5259672), `SetRefundRequested` (buyer), `SubmitResult` and `AuthorizeRefund` (seller), then the buyer's exit | all three refused in phase 2; the buyer's `WithdrawRefund` accepted (5259675). **Only `SetRefundRequested` is isolated here**: the two seller refusals ran inside the seller cooldown the concession armed, which alone explains them |
| `txlog-c11-isolated-7e37dc3f…_0.json` | C11, seller branches isolated: concession with the minimal cooldown (5259745), each control sent once the engine named no cooldown | `SubmitResult` refused (emptied result hash the only failing guard) and `AuthorizeRefund` refused (state the only failing guard), both phase 2; buyer's exit accepted (5259786) |
| `txlog-c11-withdraw-9054b1d8…_5.json` | C11's last branch and C12: after the concession (5259926), the seller's `Withdraw` with BOTH mandatory outputs (5 % of every asset to the fee address, `c` lovelace to the buyer, both tagged with the escrow's own reference) | refused, phase 2; buyer's exit accepted (5259927). **Positive control:** the same output construction on an escrow where `Withdraw` is open (lock 5259931) — accepted (5259933), so the refusal is the guards, not a malformed tx |
| `own-deployment.json`, `txlog-own-deployment.json` | S-2 on our own deployment: escrow X, the admin's `WithdrawDisputed` before any concession; escrow Y, the seller's `AuthorizeRefund`, then the same admin tx | X accepted (5259662); Y conceded (5259664), the admin then refused in phase 2, the buyer's exit accepted (5259665) |

**Sayable (R5):** after the seller's concession alone, every branch but the buyer's exit was refused by the deployed bytes (C11): `SetRefundRequested`, `SubmitResult`, `AuthorizeRefund` and `Withdraw` on the shared script, `WithdrawDisputed` on our own deployment of the same compiled code. C12's fee rule ran on the deployed bytes. **Not sayable:** the admin branch on the shared script (its keys are Masumi's): there it is still "the validator's source says". A phase-1 refusal is never "refused by the validator".

Rerun: `node src/preprod/controls.ts c11 <Disputed ref>`, `c11-isolated <ref>`, `c11-withdraw <ref past unlock_time>`; `node src/preprod/own.ts info | fund-admin | lock | concede <ref> | arbitrate <ref> | exit <ref>`.

## 4. S-1: the race, five runs

`race-*.json` holds each run's timings and outcome; `txlog-race-*.json` its transactions. In every run the rival is the buyer's own `WithdrawRefund` taking the whole pot, pre-built from leg 1's hash (which the buyer knows from the leg 2 it signed) and evaluated as a valid exit against leg 1's pending output twice before the run: the positive control that a refusal of it is not a malformed tx. In the four contended runs the legs went to Blockfrost, and the rival watched Blockfrost's mempool and fired through Koios. Times are from leg 1 being sent.

| File (escrow) | Block, both legs | Leg 1 / leg 2 answered | Rival first saw leg 1 | Rival's answers |
|---|---|---|---|---|
| `race-18268b5a…_0.json` | 5259678 | +414 / +711 ms (both to Koios) | +49 s, after the block: **uncontended** | refused, phase 1 (`BadInputsUTxO`: leg1#0 already spent) |
| `race-e6b2b96f…_0.json` (file label "run 1") | 5259750 | +286 / +558 ms | +986 ms | refused, phase 1 (`BadInputsUTxO`) |
| `race-f1f19395…_0.json` (label "run 2") | 5259751 | +290 / +546 ms | +979 ms | 4 attempts, last kept answer a hole |
| `race-e738e5b0…_0.json` (also labelled "run 2"; the third contended run by time) | 5259754 | +363 / +659 ms | +1063 ms | 1 attempt, a hole |
| `race-970ecd3a…_0.json` (label "run 4"; raw POSTs, 2.5 s timeout) | 5259799 | +254 / +503 ms | +314 ms | 5 attempts: 4 × `BadInputsUTxO` (leg1#0 unknown to Koios's node, then spent once the block landed at +1.1 s), 1 × HTTP 500 |

In the rival's phase-1 answers, `ValueNotConservedUTxO` and `ScriptIntegrityHashMismatch` accompany `BadInputsUTxO`: a node that cannot resolve an input can neither value it nor find the script it spends. The positive control above is what shows the rival itself was well formed.

**Sayable (R5):** both legs in the same block in 5 of 5 runs; leg 2 accepted 503–711 ms after leg 1 was sent; in the four contended runs, the seller's gap between leg 1 and leg 2 at one endpoint was 249–296 ms, against a watcher's first sight of leg 1 at +314 to +1063 ms — the same order of magnitude, so no safety claim follows. **Not sayable:** that the front-run was measured (no run gave the rival a clean window), a count of rival refusals presented as a result, any probability, or any claim that the settlement is immune to a race. The solver keeps the front-run probability at its worst case (1).

Rerun: `node src/preprod/race.ts <Disputed ref of yours> --share 0.4 --run k`.

## Neighbours

- `../solver-61-14032495.json`: the solver and the engine over the 61 mainnet Disputed escrows (read-only, tip 14032495).
- `../kickoff-2026-10-06.md`: the kickoff census and freshness check.
- PLAN.md §10 holds the same results with their reasoning; this file is the index.

## Not here yet

- **Path A settlement** (buyer first): priced by the solver, shown as a comparison in the UI, not built and never run, by decision (PLAN §10, D16).

## Every transaction, per file

Generated from the logs (step, role, the engine's prediction, result, block, full hash).

### `txlog-5aee2110a6a7c407a24258899ed051aa6c878c8cfe7105c2674c3ce79b071386_0.json`

| Step | Role | Expected | Result | Block | Tx |
|---|---|---|---|---|---|
| try anyway: WithdrawRefund by the buyer | buyer | refuse | refused, phase 2 | - | `a816d4d7d42e045115e6c6a01d7f7fa51e234e475c78ada3324e037a805ab2c5` |

### `txlog-7a37751b9633f64ef043d5d6e53e062862c60d7cf63c1921a34f25dd8021ba8e_0.json`

| Step | Role | Expected | Result | Block | Tx |
|---|---|---|---|---|---|
| AuthorizeRefund (leg 1) | seller | accept | accepted | 5259570 | `be1a2161b8c451309549265337893cc05bd4f75e9a7e3b971ccca86d7bcb4df8` |
| WithdrawRefund (leg 2, pre-signed) | buyer | accept | accepted | 5259570 | `ccb04dd233010d1e71ca0ebacb68cc83c28247e78e16b5f84a096389b2eab637` |
| replay leg 2 (same bytes) | seller | refuse | refused, phase 1 | - | `ccb04dd233010d1e71ca0ebacb68cc83c28247e78e16b5f84a096389b2eab637` |

### `txlog-824bbdd3fbeec6fa5a2ed1edf995d3edfdc2d523a447a944415982b5d2be0eca_0.json`

| Step | Role | Expected | Result | Block | Tx |
|---|---|---|---|---|---|
| demo wallets: 2 × 10 tADA to the buyer, 2 × 10 tADA to the seller | - | - | accepted | 5260093 | `d776ff566405c29ae0acaca758815bcd2e6d551a36680c576edf902277c41a48` |
| lock 1 fixture escrow(s) | - | - | accepted | 5260096 | `66c8a028366bad8e638e1d5059fa1d72f10e55ddc9ec8fcfb87ac8035578d7a5` |
| SetRefundRequested (buyer raises) | buyer | accept | accepted | 5260099 | `824bbdd3fbeec6fa5a2ed1edf995d3edfdc2d523a447a944415982b5d2be0eca` |
| try anyway: WithdrawRefund by the buyer | buyer | refuse | refused, phase 2 | - | `e282ef2462c9a601905cf9bca49da16c996e23502acbaee73e1a77608fe096ce` |
| AuthorizeRefund (leg 1) | seller | accept | accepted | 5260101 | `022b23f436a9a1d82e4bc5025e8b9e6fd904a0c1aa30bf41985539c3e41a1cd9` |
| WithdrawRefund (leg 2, pre-signed) | buyer | accept | accepted | 5260101 | `d1331e54b38bb18a00f8c64f095dc77e4aca5742ce9bfdcecafa4d078ec3a92c` |
| replay leg 2 (same bytes) | seller | refuse | refused, phase 1 | - | `d1331e54b38bb18a00f8c64f095dc77e4aca5742ce9bfdcecafa4d078ec3a92c` |

### `txlog-8e0d6df4c39144d674aab1f7a0503a26a497da964316d2831fcf58c22ec2bf57_0.json`

| Step | Role | Expected | Result | Block | Tx |
|---|---|---|---|---|---|
| try anyway: WithdrawRefund by the buyer | buyer | refuse | refused, phase 2 | - | `ae8c04182fbc67ed43858ebc85f87d236631af54abd88d9036f04cb62939b19a` |

### `txlog-9054b1d81c9ce47db1e3ea993aa34f0f978eb95629d4319131f149619c68de9d_6.json`

| Step | Role | Expected | Result | Block | Tx |
|---|---|---|---|---|---|
| AuthorizeRefund (leg 1) | seller | accept | accepted | 5259766 | `1a5e3e6e6b4526cded37046a5473d5e0fd73cd51e2d4165d7e6297b087706c84` |
| WithdrawRefund (leg 2, pre-signed) | buyer | accept | accepted | 5259766 | `b92d44e4a226d873c12fa40200f5bda40841ad6f86e0c6b298ac52153eb305d4` |
| replay leg 2 (same bytes) | seller | refuse | refused, phase 1 | - | `b92d44e4a226d873c12fa40200f5bda40841ad6f86e0c6b298ac52153eb305d4` |

### `txlog-9e7c0991247df977603972775e449cbeb90152f3273a9611f0f37ce1d31e697a_0.json`

| Step | Role | Expected | Result | Block | Tx |
|---|---|---|---|---|---|
| AuthorizeRefund (leg 1) | seller | accept | accepted | 5259954 | `a6e624e5ebe3ca6db80abdaf8d8f8537aaf74823c13bc094ddae23934b54e246` |
| WithdrawRefund (leg 2, pre-signed) | buyer | accept | accepted | 5259954 | `87b4bffa372b25879da8f92ac2d58e64573a8470a770691618baa0432adeefe3` |
| replay leg 2 (same bytes) | seller | refuse | refused, phase 1 | - | `87b4bffa372b25879da8f92ac2d58e64573a8470a770691618baa0432adeefe3` |

### `txlog-b475bad59115308bc51609d794aee1cf8d3ed26c70f41052aad56a6763f9c99b_0.json`

| Step | Role | Expected | Result | Block | Tx |
|---|---|---|---|---|---|
| AuthorizeRefund (leg 1) | seller | accept | accepted | 5259631 | `764f803f96fc4f0c950d1dd0f00bb98437f3bab2a6ff3f9478d0e2ce09a507db` |
| WithdrawRefund (leg 2, pre-signed) | buyer | accept | accepted | 5259631 | `ee822b4e4c2f4a0375a5fe92b0301883adef60b138a5ef794813d80bf7d72aee` |
| replay leg 2 (same bytes) | seller | refuse | refused, phase 1 | - | `ee822b4e4c2f4a0375a5fe92b0301883adef60b138a5ef794813d80bf7d72aee` |

### `txlog-bank.json`

| Step | Role | Expected | Result | Block | Tx |
|---|---|---|---|---|---|
| lock 8 fixture escrow(s) | - | - | accepted | 5259528 | `9054b1d81c9ce47db1e3ea993aa34f0f978eb95629d4319131f149619c68de9d` |
| SetRefundRequested (buyer raises) | buyer | accept | accepted | 5259535 | `5aee2110a6a7c407a24258899ed051aa6c878c8cfe7105c2674c3ce79b071386` |
| SetRefundRequested (buyer raises) | buyer | accept | accepted | 5259536 | `3be437b109bdbaeb3c094773ad620e8052118344f051342bb21dcad8bbb99777` |
| SetRefundRequested (buyer raises) | buyer | accept | accepted | 5259539 | `a6be661e4304110a49cfb2eb62dd187a81025b66e2cb201e516c081da47b6974` |
| SetRefundRequested (buyer raises) | buyer | accept | accepted | 5259541 | `18268b5a82f9d5a9a526cd00a28f47bb76656b711d3040276cd94abc768f0e9d` |
| SetRefundRequested (buyer raises) | buyer | accept | accepted | 5259543 | `8e0d6df4c39144d674aab1f7a0503a26a497da964316d2831fcf58c22ec2bf57` |
| lock 1 fixture escrow(s) | - | - | accepted | 5259544 | `a5642c65f98dbb65576e03a480cbf830cd131dfd11ddab1a7bf0415fcfff74e9` |
| SetRefundRequested (buyer raises) | buyer | accept | accepted | 5259545 | `7a37751b9633f64ef043d5d6e53e062862c60d7cf63c1921a34f25dd8021ba8e` |
| lock 1 fixture escrow(s) | - | - | accepted | 5259547 | `70c19fc6115bdb11d43ad5ce57be5ef420ac2b1787fccd6e2dedab2df5f5dcf9` |
| SetRefundRequested (buyer raises) | buyer | accept | accepted | 5259549 | `b475bad59115308bc51609d794aee1cf8d3ed26c70f41052aad56a6763f9c99b` |
| lock 1 fixture escrow(s) | - | - | accepted | 5259723 | `c776678795d8cfd4ab41706e415b6f01b5ce2e014cb5170fe13a7e8112844894` |
| lock 1 fixture escrow(s) | - | - | refused, phase 1 | - | `f69be23399cb2080a2e89bac3721cb9ad2a64ced4c6f994f461065e44cf2c51a` |
| lock 1 fixture escrow(s) | - | - | accepted | 5259724 | `2263b7a84c681c6c714410b9b2c31f7138208c76bf6650c6f950e9d9ed590169` |
| SetRefundRequested (buyer raises) | buyer | accept | accepted | 5259725 | `7e37dc3fd7cdef7c28e9766627f887c65ab5560060f27fdf3e351b619a3926ee` |
| lock 1 fixture escrow(s) | - | - | accepted | 5259726 | `75fd6edfbb075898442e593a46c8235b8c4f936025f34c254d0a15e358e1bab5` |
| SetRefundRequested (buyer raises) | buyer | accept | accepted | 5259733 | `e6b2b96f5c04214db75d8413fb860e808a5b425aa6a5af30989f2826fb4b28c1` |
| lock 1 fixture escrow(s) | - | - | accepted | 5259735 | `f8250a04e1eb82e31df4e47c04f3cfa81a3867df17370a097de081a9ead356bf` |
| SetRefundRequested (buyer raises) | buyer | accept | accepted | 5259735 | `e738e5b0496b448f41ec04a7b936f470fbc81b641b25d0c0421e7a70f9e7feb8` |
| SetRefundRequested (buyer raises) | buyer | accept | accepted | 5259736 | `f1f193952baaf8b2ee20dd3ba5004a288af93a27e6f337ea42a2c100c6c3c94b` |
| lock 1 fixture escrow(s) | - | - | accepted | 5259737 | `f34266af219d57162f8a18c9f89d86084a8e0a511d3009bd9ff6778afd2aad68` |
| SetRefundRequested (buyer raises) | buyer | accept | accepted | 5259739 | `970ecd3afc383dfc68e0b72a40b3c844e6351c592523e5431464c3124c17ed16` |
| lock 4 fixture escrow(s) | - | - | accepted | 5259904 | `c3e0b68acf3e8307dd962b6ee6f2b436640878086c19d5c2827ec9abbb7999c0` |
| lock 6 fixture escrow(s) | - | - | accepted | 5259905 | `fc3a5d5fe7f51149b0ebe266cdb70212f1b6ae545efc176e5b49c533ca9d4317` |
| SetRefundRequested (buyer raises) | buyer | accept | accepted | 5259906 | `9e7c0991247df977603972775e449cbeb90152f3273a9611f0f37ce1d31e697a` |
| SetRefundRequested (buyer raises) | buyer | accept | accepted | 5259907 | `1cad2cc76436eb09b3f062b74327d26e38cff5151c9c92d97b5d0a6525099639` |
| SetRefundRequested (buyer raises) | buyer | accept | accepted | 5259909 | `b1b4b569ec679bd650a980bf012682cbe6d37f8448e9670d94ff3fdb3bc9bc9d` |
| SetRefundRequested (buyer raises) | buyer | accept | accepted | 5259910 | `97f533e554d21b15fbcd6a5bbf870d6faaa23feecd206b0f9ef81f242428fc7d` |
| SetRefundRequested (buyer raises) | buyer | accept | accepted | 5259915 | `c4d7093933631491da39a0f77e2d64a1ec51190c533db849a672f9bd58c3801f` |
| SetRefundRequested (buyer raises) | buyer | accept | accepted | 5259916 | `2a34d591d826bc7d15519c9eca84acfbf24c43a13a69860b417928d421d336da` |
| lock 1 fixture escrow(s) | - | - | accepted | 5260008 | `47db047faf629b6894cbe2f9f307d1f2e1482c47291c14285531af7a2b5d7644` |

### `txlog-c11-8e0d6df4c39144d674aab1f7a0503a26a497da964316d2831fcf58c22ec2bf57_0.json`

| Step | Role | Expected | Result | Block | Tx |
|---|---|---|---|---|---|
| AuthorizeRefund alone (C11: the concession, no exit signed) | seller | accept | accepted | 5259672 | `fd9eb4f3ab29f6aa997289a05c252d16e43973022862c22e9e09d34b74452423` |
| try anyway: SubmitResult by the seller | seller | refuse | refused, phase 2 | - | `bf2f54c7d7b99cab9aa1e3f99ae4943894e3200cb25760972540e6ea4292b8a2` |
| try anyway: AuthorizeRefund by the seller | seller | refuse | refused, phase 2 | - | `b13daa1bea5b8ea488d58e2054207a3b3d74f839708ed4b0f2eb1ca06b4dc58a` |
| try anyway: SetRefundRequested by the buyer | buyer | refuse | refused, phase 2 | - | `4c40977697f6f5452b43aa97a65bce9d1eb06496c63f227877db34d23d8efa5b` |
| WithdrawRefund by the buyer (C11: the only party left) | buyer | accept | accepted | 5259675 | `43c16e6b845b2f4e237b85d27864c1d03eda49b4dc31082258bf526941a68bd5` |

### `txlog-c11-isolated-7e37dc3fd7cdef7c28e9766627f887c65ab5560060f27fdf3e351b619a3926ee_0.json`

| Step | Role | Expected | Result | Block | Tx |
|---|---|---|---|---|---|
| AuthorizeRefund alone (C11: the concession, no exit signed; minimal seller cooldown) | seller | accept | accepted | 5259745 | `794370a207b45c07c397ea9662e80011a0eb1b24bd121e19d2bc0e9fa352d5a8` |
| try anyway: SubmitResult by the seller | seller | refuse | refused, phase 2 | - | `97282a2bdefa78eb17ba9c6e8cf122b669a1928838c912d8ae64390c6ccbc52d` |
| try anyway: AuthorizeRefund by the seller | seller | refuse | refused, phase 2 | - | `cb5bfbe58da950af73b91f9349d881c2f902fd03b0f69566d3dc90924d7dd875` |
| WithdrawRefund by the buyer (C11: the only party left) | buyer | accept | accepted | 5259786 | `b6019d87369106952e5f69440c5251a6be526de9f935c04d2475e7100eaf9b65` |

### `txlog-c11-withdraw-9054b1d81c9ce47db1e3ea993aa34f0f978eb95629d4319131f149619c68de9d_5.json`

| Step | Role | Expected | Result | Block | Tx |
|---|---|---|---|---|---|
| AuthorizeRefund alone (C11: the concession, no exit signed) | seller | accept | accepted | 5259926 | `20735c8a88b0e2dcba89de66fa205059880f45807e19ca3a7ffccd763f4036ea` |
| try anyway: Withdraw by the seller | seller | refuse | refused, phase 2 | - | `af190171a850627cb2c0c84d41b0d6df6bffbe19ae3337973276715fa70fa3f6` |
| WithdrawRefund by the buyer (C11: the only party left) | buyer | accept | accepted | 5259927 | `516a8f4a491230340f672bff905921fccef32acdea609d57d3946e860e403b0d` |
| lock for the positive control (ResultSubmitted, unlock_time past) | - | - | accepted | 5259931 | `4e95f1a4dbd19b1f97712d5bfe903078bdde6c7c08ca3b8f8820d7938c7d58ce` |
| Withdraw by the seller, same tagged outputs (positive control: must be accepted) | seller | accept | accepted | 5259933 | `b0a9da352ee9a4039e2aee3803097e129fd64b99d1c80437477fde4528eed2d3` |

### `txlog-own-deployment.json`

| Step | Role | Expected | Result | Block | Tx |
|---|---|---|---|---|---|
| buyer → admin 2 × 15 tADA (fee and collateral for the admin control) | - | - | accepted | 5259657 | `7fdc41a9e201388595f2cbacf9901dcc25e093add0159f52c70eb6b1f0283392` |
| lock 2 fixture escrow(s) at our own deployment (a lock runs no validator) | - | - | accepted | 5259660 | `78523249b908a52a3cce35f9eb1670c3df3be34ff6b67d07de818ca13109ab8d` |
| WithdrawDisputed by the admin at our own deployment | admin | accept | accepted | 5259662 | `8e5c49cb3c3077bb77b7cff1054e18c972f8359c5bdf69699bca8523cc6a5fe5` |
| AuthorizeRefund by the seller at our own deployment | seller | accept | accepted | 5259664 | `64299c10ef1b75dca69b9de19b3860f43125f2e7bb8cd1a0c111ae0bcde6dad8` |
| WithdrawDisputed by the admin at our own deployment | admin | refuse | refused, phase 2 | - | `a776a247abcee829b8b353f167ef0ce5da882832d8c0f6c2d2561d20f8e5e72b` |
| WithdrawRefund by the buyer at our own deployment | buyer | accept | accepted | 5259665 | `2b0f89ac0df8e81aa89b0a0fff6115c326e8ef1d9afce990e19923c320e2f03d` |

### `txlog-race-18268b5a82f9d5a9a526cd00a28f47bb76656b711d3040276cd94abc768f0e9d_0.json`

| Step | Role | Expected | Result | Block | Tx |
|---|---|---|---|---|---|
| AuthorizeRefund (leg 1) | seller | accept | accepted | 5259678 | `92089c4c57865cea872c496b6e0dd0ae85f8630afc54448bfcbaf3108dc41e47` |
| WithdrawRefund (leg 2, pre-signed) | buyer | accept | accepted | 5259678 | `bb928f2ea4ecd82d9ad009b3fcd555652de61a9ffa2a6236eb127b87db955cf9` |
| rival: the buyer's own WithdrawRefund, fired on first sight of leg 1 | buyer | refuse | refused, phase 1 | - | `533e4981a19e2485c72aad37536ac643126d43e1ebcee21e8bb1fb2968414659` |

### `txlog-race-970ecd3afc383dfc68e0b72a40b3c844e6351c592523e5431464c3124c17ed16_0.json`

| Step | Role | Expected | Result | Block | Tx |
|---|---|---|---|---|---|
| AuthorizeRefund (leg 1) | seller | accept | accepted | 5259799 | `6331ca92f6e8a2bf097dc1178657377b2977656bf77409f46c030c4c459919f3` |
| WithdrawRefund (leg 2, pre-signed) | buyer | accept | accepted | 5259799 | `3f4abd689b785830628ac893517a196a30ceb60056057fd54888fc0169edb063` |
| rival (run 4): the buyer's own WithdrawRefund, fired through Koios on first sight of leg 1 in Blockfrost's mempool, retried until leg1#0 is spent | buyer | refuse | refused, phase 1 | - | `37087b798e6cdaf05639cb92218786b7af8292f1f3d391865e5a8338258e00af` |

### `txlog-race-e6b2b96f5c04214db75d8413fb860e808a5b425aa6a5af30989f2826fb4b28c1_0.json`

| Step | Role | Expected | Result | Block | Tx |
|---|---|---|---|---|---|
| AuthorizeRefund (leg 1) | seller | accept | accepted | 5259750 | `409d9e2a32701d64953355afc07dd35cc0f2f04a2efad0e8169bcab1bedd7684` |
| WithdrawRefund (leg 2, pre-signed) | buyer | accept | accepted | 5259750 | `953c3de01cedaaeb66b0ce5a2144f9ffd98f265b1ef17e9f38cf343e3b00f165` |
| rival (run 1): the buyer's own WithdrawRefund, fired through Koios on first sight of leg 1 in Blockfrost's mempool | buyer | refuse | refused, phase 1 | - | `adc7ff7528e85cc5b78302efeca47363448dfc973c6da6516176865a0d7b3b9a` |

### `txlog-race-e738e5b0496b448f41ec04a7b936f470fbc81b641b25d0c0421e7a70f9e7feb8_0.json`

| Step | Role | Expected | Result | Block | Tx |
|---|---|---|---|---|---|
| AuthorizeRefund (leg 1) | seller | accept | accepted | 5259754 | `3f26bdb6311de071bd751fdf8831f32f052fda254c5998eb47d26cd8b595d93a` |
| WithdrawRefund (leg 2, pre-signed) | buyer | accept | accepted | 5259754 | `941c042b90a52b78a1c2f1c78510a357d8da082e5971297a32ec4390c7266d15` |
| rival (run 2): the buyer's own WithdrawRefund, fired through Koios on first sight of leg 1 in Blockfrost's mempool, retried until leg1#0 is spent | buyer | refuse | hole (no answer kept, not a refusal) | - | `83ba486f40b59824028d67e65511eaf8c4627e10ed1f911754c1551391691169` |

### `txlog-race-f1f193952baaf8b2ee20dd3ba5004a288af93a27e6f337ea42a2c100c6c3c94b_0.json`

| Step | Role | Expected | Result | Block | Tx |
|---|---|---|---|---|---|
| AuthorizeRefund (leg 1) | seller | accept | accepted | 5259751 | `6f0d67cef821dd7f6d76d08288a2bafaa9a373a758725ac1761ea94e9f9361f4` |
| WithdrawRefund (leg 2, pre-signed) | buyer | accept | accepted | 5259751 | `8b2bb5eeba534f44d1ecf8cfacf1a66338692608c17ea6ca186eab64862d1691` |
| rival (run 2): the buyer's own WithdrawRefund, fired through Koios on first sight of leg 1 in Blockfrost's mempool, retried until leg1#0 is spent | buyer | refuse | hole (no answer kept, not a refusal) | - | `8ea5a76719a3c32b5bc4d5d4197a1ee862ed9cbe01a13d97a4b83d784fea9a1a` |

### `txlog-spike-6d3b12d47ea116e9512c3e70b26863fa10cc6d5be858fb4446be7789aadbeca0_0.json`

| Step | Role | Expected | Result | Block | Tx |
|---|---|---|---|---|---|
| AuthorizeRefund (leg 1) | seller | accept | accepted | 5259491 | `4cd4dd854be5b6d71ab7d62d9ef329846a89dc21926b19c3c549a3680ca386b3` |
| WithdrawRefund (leg 2, pre-signed) | buyer | accept | accepted | 5259491 | `ecfd489b84d60da78bc03f6826ee1348714a4afbc6a895c1430e08d4b1e90117` |
| replay leg 2 (same bytes) | seller | refuse | refused, phase 1 | - | `ecfd489b84d60da78bc03f6826ee1348714a4afbc6a895c1430e08d4b1e90117` |

### `txlog-spike-e83f32f8aa966dcba1391eb5eac2bef36065a5a26699360c79ebf5c4fe1796a3_0.json`

| Step | Role | Expected | Result | Block | Tx |
|---|---|---|---|---|---|
| lock fixture (ResultSubmitted) | - | - | accepted | 5259457 | `e83f32f8aa966dcba1391eb5eac2bef36065a5a26699360c79ebf5c4fe1796a3` |
| SetRefundRequested (buyer raises) | buyer | accept | refused, phase 1 | - | `555a8acc50c9b40f5f4eef11857359ab44754951ed7260ed984d52cd0c89ce93` |
| SetRefundRequested (buyer raises) | buyer | accept | accepted | 5259468 | `6d3b12d47ea116e9512c3e70b26863fa10cc6d5be858fb4446be7789aadbeca0` |

### `txlog-wallet-buyer.json`

| Step | Role | Expected | Result | Block | Tx |
|---|---|---|---|---|---|
| split buyer into 6 × 10 tADA | - | - | accepted | 5259530 | `03c17e12a6d7153d8208169805b2869b656df23924d2f34130c6714feac91474` |

### `txlog-wallet-seller.json`

| Step | Role | Expected | Result | Block | Tx |
|---|---|---|---|---|---|
| split seller into 5 × 15 tADA | - | - | accepted | 5259438 | `24d563285e08a1a900fe61ca0cb78706925ac09546c915de30e6d4308fc219f4` |
| seller → buyer 90 tUSDM | - | - | accepted | 5259526 | `7170d91ecfe746b8e5d55ead07404ee686b3a912dce868c42549ffd91af27a68` |
