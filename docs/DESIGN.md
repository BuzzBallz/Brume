# Brume UI: design brief

Scope: the Brume UI in `docs/` (PLAN v3 M-9, D2). Plain HTML, CSS and JS, no framework. Two modes from one codebase:
- **Live**: served by `pnpm agent` (`src/agent`, `node:http`), talks to its JSON API, runs the settle flow on preprod.
- **Read-only**: GitHub Pages, reads `docs/data/*.json` (`pnpm site:data`), replays the recorded run, no actions.

Sources of truth: `PLAN.md` v3 §2–§4 (wins), the specs outside the repo. Copy follows the claims ledger kept with the specs; this file does not restate its forbidden wordings.

## 1. User, job, demo path

**Who uses it.** The two parties of a stuck escrow, reached through the Coworker's job result (verdict + proposed split + a link into this UI). On the project link: judges and builders of agent-commerce deployments.

**The one thing it must do.** Take a disputed escrow from "stuck" to "settled": show what each party can do now, propose the split the solver says both sides can accept, collect both signatures in the safe order, send both legs, show where the value landed.

**On camera (PLAN §2).** 0:00–0:20 is Sokosumi (theirs). Everything from 0:20 to 2:35 is this UI.

| t | View | What the screen shows |
|---|---|---|
| 0:20–0:40 | Escrow (mainnet, read-only) → Reachability | a real disputed escrow, 7 redeemers × buyer / seller / admin, permitted cells lit |
| 0:40–1:40 | Escrow (preprod bank) → Settle | seller proposes the solver's split → buyer accepts and pre-signs the exit (leg 2) → seller concedes (leg 1) → both legs sent → balances land. Hashes visible, small |
| 1:40–2:10 | Escrow (preprod bank) → Reachability | "Try anyway" on a cell the engine marks not permitted → submitted → validator refuses, prediction matched |
| 2:10–2:35 | Escrow → Solver | executable band, what each side gives up by waiting, fee and exposed party per path, per unit of value |

## 2. References and what each one gives

Attribution lives here only. The UI and the deck never show another product's name, logo or illustration.

| Reference | Role | What we take |
|---|---|---|
| Linear ([redesign notes](https://linear.app/now/how-we-redesigned-the-linear-ui), [workflow statuses](https://linear.app/docs/configuring-workflows)) | **lead** | inverted-L chrome (slim top bar + left list), list + detail split view, theme from three inputs (base, accent, contrast), neutral chrome with one accent, strict alignment, dense calm rows, status as shape + label |
| L2BEAT ([project page](https://l2beat.com/scaling/projects/arbitrum): Risk summary, Upgrades & Governance) | grid language | "who can act, at what threshold, after what time" as permission sentences; threshold chips (2 of 3), time chips (opens at …) |
| GitHub Actions ([run graph](https://docs.github.com/en/actions/monitoring-and-troubleshooting-workflows/monitoring-workflows/using-the-visualization-graph)) | settle flow | one row per step, status icon left of the name, the active step open, a failing step opened with its reason |
| Tenderly ([simulator](https://tenderly.co/transaction-simulator)) | try anyway, balances | predicted outcome with the deciding condition; decoded state changes as the "where the value landed" table |
| Our World in Data ([chart page](https://ourworldindata.org/grapher/life-expectancy)) | provenance | footer under every figure: source, pinned at, next refresh |
| Cexplorer ([preprod](https://preprod.cexplorer.io)) | link target | where preprod tx hashes open |

## 3. Aesthetic direction

### Option A, recommended: "Linear, in the cat's colors"
Linear's structure: a 44 px top bar, a left list of escrows grouped by network, the selected escrow in the detail pane, one accent, neutral chrome, rows aligned to a 4 px grid. Base is Radix **sand** (Radix's natural gray for brown); accent is the logo itself, tan `#cbb698` with ink `#21201c`. The tan appears in two places only, both meaning "this will go through": permitted grid cells, and the step of the settle flow that is waiting on someone. Everything else is sand. Light theme, because the mark is a light mark. L2BEAT gives the permission sentences, GitHub Actions the step list, Tenderly the balance table, OWID the provenance footer.

### Option B: "Terminal sibling"
Radix brown-dark surfaces, JetBrains Mono everywhere, log rows as the main structure, tan as the only light color. Coherent with CLI signing, but it lands on two templated looks (near-black with one accent; monospace as decoration) and loses Linear's calm. Not recommended.

**Why A.** One bold element (the tan "this will go through" signal) on a quiet surface. In the take, the eye goes to tan every time: lit cells at 0:20, the waiting step at 0:40–1:40.

## 4. Tokens (Option A)

Values from `@radix-ui/colors@3.0.0` (MIT), copied as CSS variables, no package. Logo colors sampled from `docs/brand/brume-cat.jpg`.

| Token | Value | Use | Contrast |
|---|---|---|---|
| `--bg` | sand-1 `#fdfdfc` | page | — |
| `--panel` | sand-2 `#f9f9f8` | list, panels | — |
| `--line` | sand-6 `#dad9d6` | hairlines, unlit cell border | — |
| `--ink` | sand-12 `#21201c` | primary text, glyphs | 16.0:1 on bg |
| `--ink-2` | sand-11 `#63635e` | secondary text, 14 px minimum | 5.9:1 on bg |
| `--brume` | `#cbb698` | permitted cell, waiting step | ink on it 8.3:1 |
| `--accent` | brown-11 `#815e46` | links, focus ring, selected row bar, primary button | 5.7:1 on bg; brown-1 text on it 5.7:1 |
| `--accent-soft` | brown-3 `#f6eee7` | selected row, hover | brown-12 on it 10.7:1 |
| `--ok` | grass-11 `#2a7e3b` | icon: confirmed, prediction matched | 5.0:1 |
| `--warn` | amber-9 `#ffc53d` + amber-3 `#fff7c2` | icon and band: snapshot, holes, fixture | label text stays `--ink` |
| `--bad` | tomato-11 `#d13415` | icon: refused, failed, mismatch | 4.9:1 |

Rules: text always wears `--ink` / `--ink-2`, never a status color. A state is never color alone: icon + label. The tan is 1.9:1 against the panel, so a permitted cell also carries a filled glyph and the word "can". No white text on brown-9 (3.5:1).

**Type.** IBM Plex Sans (UI) + IBM Plex Mono (hashes, refs, slots, quantities), OFL-1.1, WOFF2 self-hosted in `docs/fonts/`, no CDN. The page is full of hex and quantities: Plex Mono has tabular figures and distinct `0/O`, `1/l`; one superfamily keeps the two in tune. Scale (px): 14 / 16 / 18 / 24 / 36, body 16, nothing under 14. Weights 400 and 600. Sentence case, no all-caps labels.

**Space and shape.** 4 px base: 4, 8, 12, 16, 24, 32, 48. Radius 6 px controls, 4 px cells, 0 page frame. One shadow, popovers only: `0 4px 16px rgb(33 32 28 / .12)`.

**Motion.** One orchestrated moment: when an escrow is opened with the mouse or on first load, its 21 cells resolve in reading order, 14 ms stagger, about 400 ms total, `cubic-bezier(0.23, 1, 0.32, 1)`. Never on keyboard navigation or back/forward. Popover: opacity + `scale(0.97)` to 1 in 150 ms from the cell it describes, instant exit. Buttons and cells: `scale(0.97)` on press, 160 ms. Hover styles only on fine pointers. `prefers-reduced-motion`: no stagger, popover fades only.

**Navigation.** In-page, no reload: escrow and view live in the URL (`?escrow=…&view=…`), back and forward work. `j` / `k` move through the escrow list, `Enter` opens; arrow keys move between view segments.

## 5. Layout

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ [cat] Brume                                   Live · preprod + mainnet   Reset │  top bar 44px
├────────────────────────┬──────────────────────────────────────────────────────┤
│ Mainnet · read-only    │ <ref>   Disputed   Preprod                            │
│ ▸ <ref>  Disputed 318d │ [ Reachability | Settle | Solver ]                   │
│   …                    │                                                      │
│ Preprod bank           │  ✓ Seller proposes 0.40 of the value      <hash>     │
│   <ref>  Ready         │  ● Buyer accepts and pre-signs the exit   waiting    │
│   <ref>  Settled       │     pnpm sign --role buyer proposal.json   [Copy]    │
│                        │  ○ Seller concedes                                   │
│                        │  ○ Both legs sent                                    │
│                        │  ○ Balances                                          │
├────────────────────────┴──────────────────────────────────────────────────────┤
│ Source: agent (live) · 2nd provider skipped (hole) · holes 0 · slot S         │  provenance footer
└───────────────────────────────────────────────────────────────────────────────┘
```

Left-aligned throughout. List 340 px, detail fills the rest; at 1280×720 the 7×3 grid or the five settle steps fit without scrolling. Below 900 px the list collapses above the detail. Mainnet escrows open on Reachability and Solver only: the Settle tab and every action are absent, not disabled.

## 6. Screen and component inventory

| Screen / component | PLAN v3 | Notes |
|---|---|---|
| Shell: top bar, mode badge, Reset, provenance footer | MUST M-9 | Reset clears UI state and selects the next unused bank escrow (on-chain state cannot be undone; the bank absorbs takes) |
| Escrow list grouped by network | MUST M-9 | mainnet disputed (read-only) + preprod bank (6–8) with their status |
| Escrow header: ref, state, network, datum on demand | MUST M-9 | 16-field datum in a disclosure, not on screen by default |
| Reachability grid + cell popover | MUST M-3, M-9 | 21 verdicts; popover: deciding guards, output rules, rung |
| Try anyway (preprod only) | MUST M-6, M-9 | in the popover of a not-permitted cell |
| Settle flow (6 steps) | MUST M-5, M-9 | the stepper is a real sequence (SPEC-TRANSACTIONS §4): 1 buyer raises the dispute (`SetRefundRequested`, done before the take if the bank escrow is already `Disputed`) · 2 seller proposes the split (both bodies built, leg 1 hash shown) · 3 buyer pre-signs the exit (leg 2, `WithdrawRefund`, hash shown) · 4 seller signs the concession (leg 1, `AuthorizeRefund`) · 5 seller sends both legs, in order · 6 balances read back |
| Balances table | MUST M-9 | per party, per asset, before / after, read back |
| Solver panel | MUST M-7, M-9 | two paths, band per unit of value, fee, exposed party, one range bar per horizon (H = 7 / 30 / 90) on a shared 0–100% axis, all visible at once; fee, floor and defector take as a share of each asset, never summed across assets; `p` not in `SolverOutput` yet |
| Read-only mode (Pages) | MUST M-9 | same views from `docs/data/*.json`; Settle shows the recorded run with its hashes |
| Keyboard navigation in the list | M4 polish | `j` / `k` move, `Enter` opens |
| CIP-30 signing | SHOULD S-3 | built next to the file drop, never instead of it: a "Sign with <wallet>" button per detected wallet in the waiting step; states in §7 |
| Hazard term, measured `p`, own-deployment pair | SHOULD S-4, S-1, S-2 | one row each in Solver / Reachability; own deployment tagged, never shown as the deployed bytes |
| Census screen | dropped (R-14) | census lives in the README |

## 7. States

**Data and source**

| Area | States | Treatment |
|---|---|---|
| Mode | live · read-only snapshot · fixture | badge in the top bar; fixture adds a full-width amber band "Fixture data, slot S" |
| Agent | reachable · unreachable | unreachable in live mode: "Brume agent not running. Start it with `pnpm agent`." and the snapshot is shown |
| Second provider | agreed · differs · skipped | skipped is counted as a hole, never shown as agreement |
| Loading | first paint | skeleton with the final geometry; no layout shift |
| Empty | unknown ref | "No escrow at this reference. It may have been spent." + back to the list |

**Grid**

| State | Treatment |
|---|---|
| permitted | tan fill + filled glyph + "can"; until the guard ran on preprod the popover says "the validator's source says" |
| not permitted | panel fill + hollow glyph + the deciding guard in one line |
| try anyway: sending → refused as predicted | "Engine predicted refused. Node refused: <guard>." with `--ok` check, raw error one click away |
| try anyway: accepted (mismatch) | shown in `--bad`, never hidden |

**Settle flow (file-drop signing, the guaranteed path)**

| Step state | Treatment |
|---|---|
| not started | hollow circle, ink-2 label |
| awaiting signature | tan row, the exact command with a Copy button, "Waiting for the signed file" and a live elapsed time; the UI polls the agent |
| signed | check, the body hash in mono |
| proposal locked | from the moment leg 2 is signed, the share, fee and validity bounds are read-only and shown with a lock: any change to leg 1 changes its hash and voids leg 2. Changing the split means "Start over" (new proposal, both signatures again) |
| sending | spinner in place of the icon, tx hash + Cexplorer link as soon as known |
| confirmed | check, block / slot |
| refused or failed | `--bad` icon, the node's reason rewritten to the guard it hit, raw error one click away, what to do next (retry on the next bank escrow) |

**CIP-30 (S-3)**: no wallet detected (button absent, file drop only) · connecting · wrong network (`getNetworkId() !== 0`: refused before anything is signed; CIP-30 cannot tell preprod from preview) · confirm in your wallet (polling holds so the button is not re-rendered) · signature declined (`TxSignError` 2: message kept across re-renders, nothing sent) · wallet lacks the key (`TxSignError` 1) · access refused (`APIError` -3). The buyer signs leg 2, the seller leg 1, always `partialSign = true`. Waiting steps also show a live elapsed counter (live mode).

## 8. Data contract

`shared/types.ts` lands at M0; these are PLAN v3 §4 shapes, re-checked field by field at M0. In live mode the UI calls the agent's API (`src/agent`, built in the back-end session; the routes below are this side's request to it). In read-only mode the same shapes come from `docs/data/*.json`. Routes take the ref as a query parameter (`?ref=`, URL-encoded) because refs contain `#`. Snapshot mode reads `docs/data/<kind>.json`; mock mode reads `shared/mock/*.mock.json` and needs the repo root served (local only). Every response may be the bare object or wrapped under its kind (`{"grid": …}`), as the mocks are.

**Datum, 16 fields** (SPEC-TRANSACTIONS §0, in order): `buyer`, `seller` (nested addresses), `reference_key`, `reference_signature`, `seller_nonce`, `buyer_nonce`, `collateral_return_lovelace`, `input_hash`, `result_hash`, `pay_by_time`, `submit_result_time`, `unlock_time`, `external_dispute_unlock_time`, `seller_cooldown_time`, `buyer_cooldown_time`, `state`. Times are milliseconds. The header shows `state`, whether `result_hash` is empty, and the four clocks that gate the grid (`submit_result_time`, `unlock_time`, `external_dispute_unlock_time`, both cooldowns) as relative time ("opened 318 days ago") with the UTC timestamp on hover; the rest sits in the datum disclosure.

| View | Consumes | Live route (proposal, B) |
|---|---|---|
| List | `Census` (mainnet rows, `byState`, tip, holes, 2nd provider) | `GET /api/census` |
| Header | `Datum` (16 fields, SPEC-TRANSACTIONS §0), `State` | `GET /api/datum?net=<network>&ref=<ref>` |
| Reachability | `Grid {ref, atMs, state, verdicts[21]}`, `Verdict {redeemer, role, allowed, failed[], outputRules[]}` | `GET /api/grid?ref=<ref>` |
| Try anyway | `TxLogEntry` from `tryAnyway(escrowRef, redeemer, role)` | `POST /api/try` `{escrowRef, redeemer, role}` → `TxLogEntry`; preprod escrows only, never offered on mainnet |
| Settle | `Proposal {escrowRef, sellerShare, solverBand, leg1?, leg2?, signatures}` from `prepare` / `sign` | `POST /api/proposal` `{escrowRef, sellerShare}`; `GET /api/proposal/<ref, URL-encoded>` polled every 2 s while a signature is missing (404 = no proposal yet) |
| Wallet signature (S-3) | witness set from `api.signTx(leg.cborHex, true)` | `POST /api/proposal/<ref>/witness` `{role, witnessSet}` (requested): the agent adds the witness to the leg and updates `signedBy` |
| Send + balances | `TxLogEntry[]` from `submit(Proposal)`, `readback` | `POST /api/proposal/<ref>/submit`; `GET /api/txlog?ref=<ref>` (requested; 404 = no run yet) |
| Solver | `SolverOutput` | `GET /api/solver?ref=<ref>` |
| Preprod bank list | `{ref, state}[]` | `GET /api/bank` (requested; 404 = empty bank) |
| Job result link | `JobResult` (verdict + split + UI link) | `uiUrl` = `…/?escrow=<ref, URL-encoded>`; the UI also accepts the raw `#<index>` landing in the fragment |

**Interface requests** (to propose in PLAN.md with a §11 entry; not applied here):
1. `TxLogEntry.status` is `accepted | refused`; the UI needs `submitted | confirmed | refused` plus `slot?` to draw sending vs confirmed.
2. `Proposal.signatures`: per entry `{role, leg, bodyHash, at}`, so each step knows who signed what.
3. `readback.balances?: {party: "buyer" | "seller" | "fee", asset: string, before: string, after: string}[]` on the leg-2 entry (asset = unit as in `Value`, quantities as decimal strings), read back from the second indexer. The UI renders the balances table when the field is present. Token decimals (USDM) belong in `shared/constants.ts`; until then tokens show in base units.
4. Join between `Verdict` and `TxLogEntry` (`redeemer`, `role` on the entry), so a cell can show the tx that exercised it (R5).
5. `explorerUrl(network, txHash)` in `shared/constants.ts`.
6. A mock input for `site:data`, so `docs/data/*.json` can be produced from `shared/mock/*.mock.json` (Pages does not serve `shared/`).
7. A `deployment: "deployed" | "own"` tag on `TxLogEntry` for S-2.

## 9. Copy

English, sentence case, plain verbs; an action keeps its name through the flow ("Pre-sign the exit" → "Exit pre-signed"). The project is **Brume**. Naming Masumi and the contract is allowed (PLAN v3 §10); the money rule stays: counts and clocks, never a sum, no fiat. "Can", never "does". Until a guard ran on preprod, its cell says "the validator's source says". Errors say what failed and what to do next; they don't apologize.

## 10. Decisions

1. Native quantities: one escrow's native quantities may appear (header, balances); no cross-escrow totals; no fiat.
2. Preprod tx links open in Cexplorer. The URL format (`https://preprod.cexplorer.io/tx/<hash>` expected) is checked by eye on the first real tx before it ships.
3. Logo: `docs/brand/brume-cat.jpg` (1280×1552, cat on tan, no wordmark). Top bar: tan square tile + "Brume" in Plex Sans; favicon: a crop of the same file.
4. Keyboard navigation in the list: `j` / `k` move, `Enter` opens, at M4.
5. Mainnet escrows never show Settle or Try anyway (mainnet is read-only).
6. Scope: this session builds `docs/` only. `src/agent`, `shared/` and M0 belong to the back-end session; the routes in §8 are requests to it.
7. The admin-refusal control (`WithdrawDisputed` after the concession) runs on our own deployment (S-2): its escrows are listed in their own group, "Our deployment", and every view of them carries that label.

## 11. Gallery picks (via [Component Gallery](https://component.gallery))

Patterns only, no code copied. Chosen from the systems closest to our references: Carbon (IBM, built on the same Plex family as our type), Primer (GitHub, the same language as the GitHub Actions reference), GOV.UK (plain-language status), Geist (restraint close to Linear).

| UI piece | Pick | What we take |
|---|---|---|
| Settle flow, step glyphs | [Carbon progress indicator](https://carbondesignsystem.com/components/progress-indicator/usage/), vertical | outlined circle + check = done, half-filled circle = current, empty circle = not started, distinct error glyph; labels as verb + noun; vertical for reading |
| Settle flow, status text | [GOV.UK task list](https://design-system.service.gov.uk/components/task-list/) | one row per step, status in sentence case at the row's end; done is plain text, the step that needs someone is the only tagged one ("Waiting for buyer"); later steps read "Cannot start yet" |
| Preprod run history | [Primer Timeline](https://primer.style/design/components/timeline), condensed | icon badge + one line + timestamp on a connector line, for sent / confirmed / refused and the replay check |
| Escrow state and network chips | [Primer StateLabel](https://primer.style/design/components/state-label) | icon + text for `Disputed`, `Refund requested`, `Settled`, `Preprod`, `Mainnet, read-only`; our tokens, not their colors |
| Settle / Reachability / Solver | [Primer SegmentedControl](https://primer.style/design/components/segmented-control) (alt: [Carbon content switcher](https://carbondesignsystem.com/components/content-switcher/usage)) | equal segments, one selected, keyboard arrows |
| Grid cell detail | popover, click-triggered (Component Gallery: popovers open on click and may hold actions; tooltips are hover-only) | needed because "Try anyway" lives inside it and hover doesn't show on video |
| Loading | [Carbon loading pattern](https://carbondesignsystem.com/patterns/loading-pattern/) + [Geist skeleton](https://vercel.com/geist/skeleton) | skeleton for first paint at final geometry, inline spinner only inside a step that is sending |
| Empty, agent not running, unknown ref | [Primer Blankslate](https://primer.style/design/components/blankslate), [Geist empty state](https://vercel.com/geist/empty-state) | one sentence on what happened, one action |
| Balances table | [Carbon data table](https://carbondesignsystem.com/components/data-table/usage/) | compact rows, numbers right-aligned in mono, before / after side by side |

Left out: Ant Design, Chakra, Flowbite, Bootstrap (generic look); the Component Gallery "stepper" page, which is a numeric +/- input, not a step list.
