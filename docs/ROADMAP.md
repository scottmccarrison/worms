# worms roadmap

Source of truth: [GitHub issues](https://github.com/scottmccarrison/worms/issues). This file mirrors them with status, PR links, and plan docs.

## MVP epics

| #  | Epic                                     | Status   | PR   | Plan                                               |
|----|------------------------------------------|----------|------|----------------------------------------------------|
| 1  | Modernize build system                   | Done     | #26  | [epic-1-2-foundation](plans/epic-1-2-foundation.md) |
| 2  | Cleanup dead code                        | Done     | #26  | [epic-1-2-foundation](plans/epic-1-2-foundation.md) |
| 3  | Port destructible terrain to planck.js   | Todo     | -    | -                                                  |
| 4  | Port worm physics + movement             | Todo     | -    | -                                                  |
| 5  | Port turn-based game state + win cond    | Todo     | -    | -                                                  |
| 6  | Port weapon system (8 + Bazooka)         | Todo     | -    | -                                                  |
| 7  | Map loading + starter maps               | Todo     | -    | -                                                  |
| 8  | Room code lobby system                   | Todo     | -    | -                                                  |
| 9  | Authoritative server netcode             | Todo     | -    | -                                                  |
| 10 | Reconnection + disconnect handling       | Todo     | -    | -                                                  |
| 11 | Source original sprite assets            | Todo     | -    | -                                                  |
| 12 | Source original audio assets             | Todo     | -    | -                                                  |
| 13 | Deploy pipeline                          | Todo     | -    | -                                                  |
| 14 | CI/CD                                    | Partial  | #26  | (minimal CI landed in #26; full auto-deploy TBD)   |
| 15 | Test harness (Vitest)                    | Todo     | -    | -                                                  |

## Post-MVP enhancements

| #  | Enhancement                                        | Status |
|----|----------------------------------------------------|--------|
| 16 | Weapon wave 1 (classic Worms set, +16)             | Todo   |
| 17 | Weapon wave 2 (Hedgewars additions, +10)           | Todo   |
| 18 | Utility items system                               | Todo   |
| 19 | Wind mechanic                                      | Todo   |
| 20 | Water rising + drowning (sudden death)             | Todo   |
| 21 | Fall damage + retreat window                       | Todo   |
| 22 | Procedural map generation + themes                 | Todo   |
| 23 | Team customization (names, colors, worm names, hats) | Todo |
| 24 | Game modes (Rope Race, Crazy Crates, Fort, CTF, Last Hog Standing) | Todo |
| 25 | Replay + spectator + bots                          | Todo   |

## Proposed build order

- **M1 Foundation**: #1, #2 — **DONE** (PR #26)
- **M2 Single-player playable**: #3 → #4 → #5 → #6 → #7 + #15 (tests along the way) + placeholder assets from #11/#12
- **M3 Multiplayer local**: #8 → #9 → #10
- **M4 Shipped**: #13 + #14 done + real assets from #11, #12

Parallelization: assets (#11, #12) and infra (#13, #14) don't block game logic and can run in parallel with core work once foundation is done.

## Session log

One-line-per-session record. Detailed history: `git log`, PR descriptions, brain-mem.

- **2026-04-20**: Forked repo, triaged and filed 15 epic + 10 enhancement issues, wrote foundation plan, shipped PR #26 (archive legacy under reference/, add Vite+TS5+Biome scaffolding + minimal CI). Also established project docs convention: CLAUDE.md, this roadmap, and `docs/plans/` (separate PR).
