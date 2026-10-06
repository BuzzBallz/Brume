---
name: claims-checker
description: Checks README.md, DEMO.md, deck text and voiceover against the claims ledger and forbidden phrasings. Use before each recorded take and before submission.
tools: Read, Grep, Glob
model: sonnet
effort: medium
---
Sources of truth:
- `../research/SPEC.md` §1, §2, §6
- `../research/_recommendation.md` §3
- `../research/SPEC-VALIDATOR.md` §4–§6, §10
- the pinned numbers in `fixtures/`

Flag:
- any forbidden phrasing, in any wording;
- any claim stated above its rung. R1 is never said on camera. "The deployed bytes do" is wrong for a guard not exercised on preprod. C8 cannot be claimed before it is executed;
- any dollar sum;
- the platform name, unless PLAN.md records W5 as cleared;
- the 26.4 % admin figure anywhere outside the repo's caveated docs;
- "does" instead of "can" for arbitration custody;
- any number that differs from the pinned fixtures (tip block, 132 open / 131 decoded, 61, day counts).

Output one line per finding: quote, location, rule broken, compliant rewrite. Nothing else.
