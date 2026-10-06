# Brume — TOKEN2049 Origins, Cardano track (team BuzzBallz)

Window: Tue 6 Oct 12:00 → Wed 7 Oct 23:59 SGT. `PLAN.md` is the source of truth (scope, milestones, demo path).
Specs live in `../research/` (SPEC.md, SPEC-VALIDATOR.md, SPEC-TRANSACTIONS.md, _recommendation.md) — outside the repo, never committed.

## Hard rules
- Nothing committed before Tue 6 Oct 12:00 SGT. Never force-push, squash or rewrite history: the public log is the build evidence.
- Mainnet is read-only: never build, evaluate or submit a tx against mainnet. Preprod writes only, on escrows we locked. Never call the platform's API.
- An HTTP error is a hole, never a data point: retry 429 with backoff, count holes, print them. Census = two providers when the key is set, diff printed.
- Every number is pinned to a tip block in `fixtures/`.
- No secret in code, logs, commits or chat. Keys come from `.env` only (`.env.example` lists the names). Never read `.env*`.
- Never copy upstream example code or `research/probes`; write it here.
- Wording: SPEC §2 claims ledger + forbidden phrasings (SPEC §2, _recommendation §3). Never "cannot be raced". No dollar sums.
- MeshSDK pinned exactly (`@meshsdk/core@1.9.0-beta.96`, `@meshsdk/core-cst@1.9.0-beta.90`); never bump, never mix with Evolution SDK. Say "the validator's source says" until a guard ran on preprod.

## Streams — never edit the other stream's folders
- A (Alexandre, branch `a/tx`): `src/engine/`, `src/solver/`, `src/preprod/`, `fixtures/preprod/`, `vendor/` (third-party blueprint, licence + commit)
- B (Andrea, branch `b/ui`): `src/read/`, `src/census/`, `src/agent/`, `docs/`, `fixtures/mainnet/`, `deck/`, `README.md`, `DEMO.md`
- Shared (change = PLAN.md §11 entry + both agree): `shared/`, `package.json`, lockfile, `tsconfig.json`, `.gitignore`, `.env.example`, `.githooks/`, `PLAN.md`, `CLAUDE.md`, `.claude/`

## Build rules
- Demo path first (PLAN §2). MUST before SHOULD. No feature after the Wed 13:00 freeze.
- Node ≥ 22.18 runs `.ts` directly: no `enum`/`namespace`/parameter properties, imports end in `.ts`, use `as const`.
- No abstraction, config layer or test suite the demo doesn't need. `node --test` only on: decoder, engine guards, solver, tx construction constraints.
- Every tx goes through the `src/preprod` helper (SPEC-VALIDATOR §7 constraints + preprod-only guard): explicit `invalid_hereafter` with a wide margin, signer in required signers, one escrow input.
- Datum = 16 fields (SPEC-TRANSACTIONS §0); upstream examples use 11 — never reuse their indices. Build against V1 only, never V2.
- No LLM decides anything in the product. Server = `node:http`, UI = static `docs/`, no framework.
- Mocks only in `shared/mock/*.mock.json`; fixture mode prints a FIXTURE banner; every mock is listed in the README.
- Stuck > 20 min: stop, tell the human, propose the fallback from PLAN §9.
- After each milestone: run it, fix it, tick PLAN.md, commit, 3-line status (done / skills + models used / next).

## Git
- One branch per stream; merge into main only at the PLAN §5 sync points, after `pnpm check` is green. main must always run.
- Small commits, imperative EN, `type(scope): message`. No AI attribution trailer. Stage only your scope.

## Models
- haiku: scaffolding, renames, docs edits, search, run + summarize. sonnet/medium: standard features.
- sonnet/high: decoder, engine, solver, integration, debugging. opus/high: `/shared` changes, leg-2 construction, review of fund-moving code.
- fable: never without approval.
- Session: `/model opusplan`, `/effort medium`, plan mode at each milestone start. "ultrathink" only for the PLAN §7 turns.
- Agents: `explorer` (haiku), `implementer` (sonnet), `contract-reviewer` (opus), `claims-checker` (sonnet). Max 2 in parallel, independent tasks only; say how many and why.
- Token hygiene: never read node_modules, lockfiles or `docs/data/*.json` in full; delegate broad search to `explorer`; edit, don't rewrite; `/clear` between milestones, `/compact` when long.

## Commands
```
pnpm install
pnpm check                          # tsc --noEmit + node --test
pnpm census:mainnet                 # keyless; READ_SOURCE=fixture for offline
pnpm engine <ref>                   # 7×3 reachability grid
pnpm solver <ref>
pnpm verify <txhash>
pnpm agent                          # MIP-003 + UI API, serves docs/ (live mode)
pnpm sign --role buyer|seller <file> # file-drop signature, needs .env keys
pnpm site:data                      # snapshot docs/data/*.json for GitHub Pages
```
Deploy: GitHub Pages serves `docs/` from `main` (Settings → Pages → main /docs). Merging to main = deploy.

## Skills
`/ship` commit · `/review-fast` before a merge · `/code-review high` on `src/preprod` + `src/engine` · `/tdd` for decoder, engine, solver · `security-review` before touching keys · context7 for tx-library docs · `reste` for status · `minimalist-ui` + `dataviz` for `docs/` · `/demo`, `/pitch`, pptx at M4–M5 · `revise-claude-md` at milestone end.
