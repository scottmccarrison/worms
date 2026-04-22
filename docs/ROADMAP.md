# worms roadmap

Source of truth: [GitHub issues](https://github.com/scottmccarrison/worms/issues). This file mirrors them with status, PR links, and plan docs.

> **Framework pivot 2026-04-20**: stack is now Phaser 3 + planck + Colyseus + Aseprite. See [ADR-001](decisions/001-framework-pivot.md). Epic descriptions below reflect the new approach; issue bodies were updated with pivot notes.

## Worms-in-Terraria-world direction (2026-04-22)

Playtest feedback on the 1280x720 geometric-arena MVP was "maps are small and boring." After exploring options (see [ADR-003](decisions/003-terraria-world-pivot.md)), the new direction is:

**Keep the turn-based Worms gameplay loop exactly as-is. Drop it inside a procedurally generated Terraria-style side-scrolling world.** The world is the new visual + gen layer; the game that happens inside it (teams, 9 weapons, wind/water/fall damage, 45s turns, retreat window) is unchanged.

The pixel-mask physics model is actually _better_ suited to this than to full Terraria (pixel-perfect crater destruction still works; tile rendering is purely a visual composite over the alpha mask).

**Phased delivery:**

- **Phase 1** (current epic): world size 2560x1024+ with scrolling camera, tile-atlas loader, single-biome tile-texture fill, basic heightmap surface gen. Proves the pattern; 10x visual upgrade on its own.
- **Phase 2**: cave carving (cellular automata / noise), decoration stamps (trees, rocks, ore), 3-4 biome presets, parallax backdrop.
- **Phase 3**: polish - biome-specific ambient (particles, tint), optional weather.

**What stays the same**: turn arbiter, teams, 9 weapons, planck rigid bodies, per-pixel destruction, Cloudflare DO netcode, reconnection, mobile touch, wind/water/fall-damage/retreat. Nothing in the gameplay layer changes.

**Superseded by this direction**:
- "Real arena maps" (#41, shipped in PR #94) stays as fallback/test content; procgen replaces it for production.
- "Sprites + audio" (#84 inventory, #11 sprites) narrows - tile art comes from Kenney / OpenGameArt CC0 packs, not commissioning. Worm + weapon + VFX sprites still needed.
- "Procedural map generation + themes" (#22) is absorbed into this epic.

**Still deferred until Phase 1+ lands**: weapon expansion (#16/#17/#39), rope in networked mode (#82), game modes (#24), replay/bots (#25), team customization (#23), backflip on mobile (#75), jetpack radial (#91).

## MVP epics

| #  | Epic                                     | Status   | PR       | Plan                                               |
|----|------------------------------------------|----------|----------|----------------------------------------------------|
| 1  | Modernize build system                   | Done     | #26      | [epic-1-2-foundation](plans/epic-1-2-foundation.md) |
| 2  | Cleanup dead code                        | Done     | #26      | [epic-1-2-foundation](plans/epic-1-2-foundation.md) |
| 3  | Terrain: port algorithm + Phaser wrapper | Done     | -        | [epic-3-terrain](plans/epic-3-terrain.md)          |
| 4  | Worm entity (Phaser sprite + planck body) | Done (4a + 4b) | - | [epic-4a-worm](plans/epic-4a-worm.md) / [epic-4b-utilities](plans/epic-4b-utilities.md) |
| 5  | Turn state + win condition (xstate)      | Done     | (PR #TBD) | [epic-5-turns](plans/epic-5-turns.md)             |
| 6  | Weapon system (data-driven, 8 + Bazooka) | Partial  | (6a PR TBD) | [epic-6a-weapons-infra](plans/epic-6a-weapons-infra.md) |
| 7  | Map loading + starter maps               | Done     | (Epic 7 PR) | [epic-7-maps](plans/epic-7-maps.md)             |
| 8  | Colyseus integration: lobby + rooms [*]  | Done     | (Epic 8 PR) | [epic-8-lobby](plans/epic-8-lobby.md)           |
| 9  | Colyseus integration: state schema [*]   | Done (Option C) | (Epic 9 PR) | [epic-9-netcode](plans/epic-9-netcode.md)    |
| 10 | Colyseus integration: reconnection [*]   | Done     | (Epic 10 PR) | [epic-10-reconnect](plans/epic-10-reconnect.md) |
| 11 | Source original sprite assets (Aseprite) | Todo     | -        | -                                                  |
| 12 | Source original audio assets             | Todo     | -        | -                                                  |
| 13 | Deploy pipeline (Cloudflare Workers + DO) | Done    | (Epic 13 PR) | [epic-13-workers](plans/epic-13-workers.md) |
| 45 | Server-authoritative sim (graduation from Option C) | Done | (Epic 45 PR) | [epic-45-server-sim](plans/epic-45-server-sim.md) |
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
- **M2 Single-player playable** (Phaser + planck): #3 → #4 → #5 → #6 → #7 — **DONE**
- **M3 Multiplayer** (Colyseus integration, collapsed; ultimately ported to Cloudflare DOs): #8/#9/#10 + #45 — **DONE**
- **M4 Deployed**: #13 — **DONE** (mccarrison.me/worms)
- **M5 Playtest polish**: Classic Worms Feel (#19/#20/#21) + real arena maps (#41) — **DONE** (shipped in PRs #86 + #94)
- **M6 Worms-in-Terraria-world** (current phase): Phase 1 (world + tile rendering + basic gen) → Phase 2 (caves + biomes + backdrop) → Phase 3 (polish). See [ADR-003](decisions/003-terraria-world-pivot.md).
- **M7 Content expansion** (post-world-pivot): weapons (#16/#17/#39), rope netcode (#82), game modes (#24), team customization (#23), replay/bots (#25)

Parallelization: tile-pack sourcing (#84 revised scope) doesn't block code work and can run alongside Phase 1. Worm/weapon/VFX sprite sourcing (#11 narrower scope) can run throughout M6.

## Session log

One-line-per-session record. Detailed history: `git log`, PR descriptions, brain-mem.

- **2026-04-20**: Forked repo, triaged and filed 15 epic + 10 enhancement issues, wrote foundation plan, shipped PR #26 (archive legacy under reference/, add Vite+TS5+Biome scaffolding + minimal CI). Established project docs convention via PR #27 (CLAUDE.md, ROADMAP.md, docs/plans/), added plan-time resources via PR #28 (Context7 MCP, references-by-epic, mandated skill invocation). Later same day: **framework pivot** (ADR-001) from hand-rolled Canvas + Socket.IO to Phaser 3 + Colyseus + planck + Aseprite. Added `server/` workspace scaffold, drop-in workflow guides in `docs/guides/`.
- **2026-04-20**: Epic 3 shipped (terrain port). planck.js integration + destructible mask + Phaser Scene demo + dat.gui tuning + Vitest. Bundled Vitest setup + CI test step (partial #14/#15 progress). Deleted reference/src/environment/Terrain.ts.
- **2026-04-20**: Epic 4a shipped (core worm movement). Worm entity (planck dynamic body + foot sensor + Phaser Graphics placeholder), walk/jump/backflip/aim, fall damage via post-solve contact listeners, Team class, InputController (arrow keys + Tab cycling), spawn point scanner, health HUD. 11 commits, ~700 LOC. Deleted 6 reference files. 4b (ninja rope + jetpack) deferred.
- **2026-04-20**: Epic 4b shipped (NinjaRope + JetPack utilities + first touch overlay). NinjaRope class (raycast + DistanceJoint chain + extend/retract), JetPack class (impulse + fuel drain), TouchControls mobile overlay (R/J buttons bottom-right), InputController state-dependent dispatch, Worm walk/jump guards, terrain-cut hit-test gate. 10 commits, ~700 LOC. Deleted reference/weapons/(NinjaRope|JetPack|BaseWeapon).ts. Closes #4 fully.
- **2026-04-20**: Epic 5 shipped (turn-based game state + win condition). xstate v5 turnMachine, TurnManager (Phaser-aware wrapper, velocity-based settle detection, win check every frame), TurnHUD (48px timer top-center, 80px end-turn button top-right, team banner pulse, game-over banner), InputController refactored (active worm set by TurnManager, TAB within team only, Enter ends turn, input locked outside turnActive), GameScene wired. 9 commits, ~500 LOC new + ~100 modified. 10 new tests (45 total). Deleted reference/src/(Game|GameStateManager|gui/CountDownTimer).ts. Closes #5.
- **2026-04-21**: Epic 6a shipped (weapon infrastructure + 3 reference weapons). Data-driven WeaponConfig system (3 archetypes: hitscan/projectile/throwable), ProjectileManager (fuse + contact detonation), explode() pure function (terrain cut + AABB damage + impulse), WeaponManager per-team ammo, WeaponDrawer bottom-center HUD, AimHUD (arrow + power bar), drag-to-aim touch gesture, keyboard 1/2/3/F/[/] bindings. 12 commits. Deleted 7 ported reference files. 60+ tests.
