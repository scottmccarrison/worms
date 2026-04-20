# worms roadmap

Source of truth: [GitHub issues](https://github.com/scottmccarrison/worms/issues). This file mirrors them with status, PR links, and plan docs.

> **Framework pivot 2026-04-20**: stack is now Phaser 3 + planck + Colyseus + Aseprite. See [ADR-001](decisions/001-framework-pivot.md). Epic descriptions below reflect the new approach; issue bodies were updated with pivot notes.

## MVP epics

| #  | Epic                                     | Status   | PR       | Plan                                               |
|----|------------------------------------------|----------|----------|----------------------------------------------------|
| 1  | Modernize build system                   | Done     | #26      | [epic-1-2-foundation](plans/epic-1-2-foundation.md) |
| 2  | Cleanup dead code                        | Done     | #26      | [epic-1-2-foundation](plans/epic-1-2-foundation.md) |
| 3  | Terrain: port algorithm + Phaser wrapper | Done     | -        | [epic-3-terrain](plans/epic-3-terrain.md)          |
| 4  | Worm entity (Phaser sprite + planck body) | Todo    | -        | -                                                  |
| 5  | Turn state + win condition (xstate)      | Todo     | -        | -                                                  |
| 6  | Weapon system (data-driven, 8 + Bazooka) | Todo     | -        | -                                                  |
| 7  | Map loading + starter maps               | Todo     | -        | -                                                  |
| 8  | Colyseus integration: lobby + rooms [*]  | Todo     | -        | -                                                  |
| 9  | Colyseus integration: state schema [*]   | Todo     | -        | -                                                  |
| 10 | Colyseus integration: reconnection [*]   | Todo     | -        | -                                                  |
| 11 | Source original sprite assets (Aseprite) | Todo     | -        | -                                                  |
| 12 | Source original audio assets             | Todo     | -        | -                                                  |
| 13 | Deploy pipeline (Cloudflare + Fly.io)    | Todo     | -        | -                                                  |
| 14 | CI/CD                                    | Partial  | #26      | (minimal CI landed in #26; full auto-deploy TBD)   |
| 15 | Test harness (Vitest)                    | Todo     | -        | -                                                  |

[*] Epic 8/9/10 were originally three separate epics (lobby / netcode / reconnection). Per [ADR-001](decisions/001-framework-pivot.md), Colyseus provides all three out of the box; work now collapses into one integration epic. Issues #8/#9/#10 remain as tracked sub-deliverables.

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
- **M2 Single-player playable** (Phaser + planck): #3 → #4 → #5 → #6 → #7 + #15 (tests along the way) + placeholder assets from #11/#12
- **M3 Multiplayer** (Colyseus integration, collapsed): #8/#9/#10 in one or two PRs
- **M4 Shipped**: #13 (Cloudflare Pages + Fly.io/EC2) + #14 done + real assets from #11, #12

Parallelization: assets (#11, #12) and infra (#13, #14) don't block game logic and can run in parallel with core work once foundation is done.

## Session log

One-line-per-session record. Detailed history: `git log`, PR descriptions, brain-mem.

- **2026-04-20**: Forked repo, triaged and filed 15 epic + 10 enhancement issues, wrote foundation plan, shipped PR #26 (archive legacy under reference/, add Vite+TS5+Biome scaffolding + minimal CI). Established project docs convention via PR #27 (CLAUDE.md, ROADMAP.md, docs/plans/), added plan-time resources via PR #28 (Context7 MCP, references-by-epic, mandated skill invocation). Later same day: **framework pivot** (ADR-001) from hand-rolled Canvas + Socket.IO to Phaser 3 + Colyseus + planck + Aseprite. Added `server/` workspace scaffold, drop-in workflow guides in `docs/guides/`.
- **2026-04-20**: Epic 3 shipped (terrain port). planck.js integration + destructible mask + Phaser Scene demo + dat.gui tuning + Vitest. Bundled Vitest setup + CI test step (partial #14/#15 progress). Deleted reference/src/environment/Terrain.ts.
