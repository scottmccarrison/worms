# Gameplay-World Design

This document is the worms-specific translation of `gameplay-world-philosophy.md`. Read it side by side with the bible. The bible derives the principles; this doc translates them to our stack and our game.

Inputs: the bible, the audit (`gameplay-world-current-state.md`), and the precedent survey (`gameplay-world-precedents.md`). Citations to those docs are inline; citations to specific code use `file:line` references.

Sections 1-10 are keyed one-to-one with the bible. Sections 11+ are worms-specific elaboration: gap-to-issue mapping, open design questions, next steps.

---

## 1. What gameplay-world interaction is for worms

**Consensus:** we accept the bible's framing wholesale. The world generates at t=0 (per `world-gen-design.md`); from t=0 onward gameplay-world governs how entities interact with that world via six contracts. Server-authoritative simulation, hand-rolled JSON over WebSocket, planck physics inside a Cloudflare Durable Object. Match-based, 5-15 minutes, no persistence.

The interaction layer is the largest single body of code in our codebase. `worker/src/entities/`, `worker/src/sim/simulation.ts`, `worker/src/weapons/`, and parts of `src/scenes/GameScene.ts` together implement it. The audit catalogued where it lives today.

---

## 2. Genre frame: we are squarely in the genre

**Consensus:** we are a Worms-genre PvP arena game. The closest open-source siblings (Hedgewars, OpenLiero, OpenLierox, Gusanos, OpenSoldat) span 20 years and converge on similar mechanics for similar reasons. We adopt their convergent answers as our defaults; we revise only with cause.

Where the genre and our stack diverge is in network model. Hedgewars and most siblings use lockstep deterministic networking (every client runs the same sim). We use server-authoritative simulation with full-state snapshot broadcast at 20Hz. This rules out the genre's `hwFloat` fixed-point arithmetic and per-pixel substepping, but keeps everything above the network layer (mechanics, feel, tuning) intact.

Specifically, the closest production-quality reference for our exact stack (TypeScript + planck on Cloudflare Workers + Durable Objects) is `chungwu/combat-lander` (PartyKit + Rapier). We do not copy their physics engine but their architecture (snapshot ring, alarm-driven ticks, hibernation-aware) is the right shape.

---

## 3. Spawn (worms-specific)

**Consensus:** the bible's "worlds enumerate candidates; runtimes verify and nudge" applies as-is.

**Where we are today.** `src/maps/passes/distributeSpawnPoints.ts` produces a list of candidate `{xPx, yPx}` pairs via greedy spatial relaxation. The Worm constructor in `worker/src/entities/worm.ts` consumes the list one-at-a-time, converts to meters, and creates the body. **There is no runtime probe step.** Audit §1 flagged this as the biggest spawn gap.

**Where we need to be.** Add a runtime probe in the Worm constructor: after body creation, call `world.testOverlap` between the worm fixture and any terrain fixture in the spawn cell. If overlap, nudge the spawn position outward (1px steps in a spiral pattern, up to N attempts). If no clear position found, fall through to the next candidate from the gen-produced list.

This is **issue #190** (runtime hitbox validation in Worm constructor).

**Worms-specific revision.** The bible says "gen produces a list, sim consumes them in order." Today gen produces exactly the count requested. We may need to ask gen to over-produce so the sim has fallback options. Tracked as a sub-task within #190; resolve at implementation time.

---

## 4. Locomotion (worms-specific)

**Consensus:** the bible's "walking is universal step-up; ground is a count, not a flag" applies. Genre-default mid-air ballistic-only behavior accepted.

**Where we are today.** Foot sensor uses a counter (`footContactCount` in `worm.ts`); audit §2 confirmed this works correctly. Walking is constant-velocity reapplication each tick. **There is no step-up handling.** Slope-awareness is absent: walk velocity is unclamped on steep slopes, and steep upward terrain causes the worm to slide back when walking forward.

**Where we need to be.** Three locomotion improvements, ordered by impact:

- **Auto-step ledge nudge** (issue #185): N-pixel vertical nudge when wall-blocked + grounded. Use `world.testOverlap` to find the smallest clearance. Damp horizontal velocity per step. Tier 1 priority.
- **Slope-aware walking** (issue #192): PreSolve normal check; above threshold (~60° from vertical) zero tangent friction (slide); below threshold rotate walk velocity along the surface. Pairs with #185.
- **Fall damage on vertical impact velocity** (issue #191): replace normal-impulse threshold with peak-vy-since-grounded. Shape-independent.

**Worms-specific revision.** Step-up threshold: Hedgewars uses 5px against a 12px-radius worm; OpenLiero uses 1px. Our 24px-radius worms may want a larger threshold (4-6px); resolve via playtest. Document the chosen value in `src/tuning.ts`.

---

## 5. Aim and fire (worms-specific)

**Consensus:** the bible's "fire is an event; the world is read, not negotiated with" applies. Per-weapon configuration, not implementation.

**Where we are today.** `applyFire` validates and dispatches; per-archetype handlers (projectile/throwable/hitscan) compute origin and velocity from the fire context. Audit §3 noted that the spawn offset is fixed at `wormRadius + projRadius + 2 ~ 18px` regardless of weapon, which assumes a worm on flat ground.

**Where we need to be.**

- **Per-weapon launch offset** (issue #188): `WeaponConfig.launchOffset?: { dxPx, dyPx }` rotated by aim and mirrored by facing at projectile spawn. Default: same as today. Per-weapon overrides for muzzle position. Tier 1 priority.
- **Drill stream-of-mini-erasures** (issue #187): replace the swept-circle drill cuts with a stream of small erasures along path. Cleaner code, better feel. Tier 1.
- **Per-projectile wind opt-in flag** (issue #189, sub-task B): `WeaponConfig.affectedByWind?: boolean`. Today wind applies blanket; the bible has it as opt-in.

**Worms-specific revision.** Hedgewars' `AmmoProps` bitmask is more general than our current weapon config. We do not need the full Pascal-style bitmask but the shape (per-weapon flags for `Power`, `NeedTarget`, `Timerable`, `SetBounce`) is worth borrowing as we add weapons. Track for the next weapon-system refactor (no issue yet).

**Future / deferred.**

- **Single-endpoint spring rope** when ninja rope is wired (post-MVP per CLAUDE.md). Bible §5 cites OpenLiero pattern.
- **Box2D bullet flag with sensor pitfall**: bullet CCD bypasses sensor fixtures. We currently use `bullet: true` for projectiles and Box fixtures (not sensors) for objects/terrain, so this isn't a problem now, but flag for future weapons that use sensor fixtures.

---

## 6. Terrain mutation (worms-specific)

**Consensus:** the bible's "mutation is local, event-driven, chunked; material modulates" applies.

**Where we are today.** `terrain.cutCircle` does pixel mask erasure and rebuilds bodies in a Y-band around the cut. Audit §4 noted this is coarser than the genre standard (chunks) and will tank on bigger maps. `materialMap` is gen-time-only and never consulted at cut time.

**Where we need to be.**

- **Material hardness via materialMap** (issue #186): consult `materialMap` in `cutCircle`. Per-material thresholds: STONE requires larger blast radius to remove. Tier 1; existing data, one guard. Highest immediate impact for tactical depth.
- **Damage ring as separate flag** (issue #189, sub-task C): Hedgewars' `lfDamaged` separate from `lfBasic`. Lets us paint scorched walls without modifying solidity. Tier 1.
- **Chunked dirty-tracking** (issue #193): replace Y-band rebuild with N×N chunk grid (32 or 64 px). Tier 2; structural change, do when mobile perf tanks or before scaling map size further.
- **Detached-chunk collapse** (issue #194): flood-fill after cuts, convert disconnected solid clusters to falling planck dynamic bodies. Tier 2; large gameplay impact, has design-question dependencies.

**Worms-specific revision.** Cortex Command's MOPixel debris is rejected (per bible §10); cosmetic Phaser particles are fine. Probabilistic erasure for explosion edges (Liero pattern) is a tier-3 cosmetic; defer until visual polish.

**Critical decision.** Detached-chunk collapse (#194) introduces design questions: do falling chunks damage worms? Become destructible themselves? Block movement? Resolve before implementation; until then issue stays open.

---

## 7. Damage propagation (worms-specific)

**Consensus:** the bible's "damage is radial, linear, walls do not block by default" applies. Five Worms-genre sources confirm; we hold this line.

**Where we are today.** AABB query into the planck world, per-target Euclidean distance check, linear falloff `maxDamage * (1 - distM / radiusM)`. Self-damage tracked, not reduced. Impulse uniform across worms (density fixed at 1.0).

**Where we need to be.** Mostly already there. Two refinements:

- **Density-divided impulse**: when we have varied-density entities (objects from PR #181 already in the catalog have density), divide impulse by density so heavy objects get less knockback. Hedgewars-canonical. Small change; folded into the next weapons-or-objects refactor (no standalone issue yet).
- **Per-weapon LoS opt-in** (deferred): Atomic Tanks' Bresenham pixel-walk is the proven primitive when we eventually want a sniper rifle or focused beam. Bible §7 says "default off, per-weapon opt-in." No issue today; revisit when a weapon design requires it.

**Worms-specific revision.** Hedgewars' formula `(base - dist) / 2 capped at radius` produces a wider damage plateau near the center than our current `(1 - dist/radius)`. Adopt only if playtest feedback wants the change; not a structural issue.

---

## 8. Environmental (worms-specific)

**Consensus:** the bible's "world ticks against entities via opt-in flags; bounds are generous and proportional" applies.

**Where we are today.** Per-tick application of wind, off-map kill, water drown, fall damage. Wind applies uniformly to all in-flight projectiles. Off-map margin is hardcoded at 200px regardless of map width. Water level uses a sentinel for "no water." Fall damage uses normal impulse threshold.

**Where we need to be.**

- **Off-map margin scales with width** (issue #189, sub-task A): `OFF_MAP_MARGIN_PX = max(200, widthPx * 0.1)`. Tier 1, one-line fix.
- **Per-projectile wind opt-in** (issue #189, sub-task B): covered in §5 above.
- **Fall damage on vy** (issue #191): covered in §4 above.

**Worms-specific revision.** Water remains Y-threshold check; no buoyancy or drowning animation per genre default (bible §10 out-of-scope confirmation). Wind force tuning calibrated to original 0.07kg projectile is acceptable; revisit only if v1 maps' larger scale produces visibly different feel (no issue today).

**Future / deferred.**

- Atanks parachute-drag wind formula: tested on playtest before adopting. Currently uniform force is "good enough."
- Powder Toy pressure model: rejected per bible §10.

---

## 9. Cross-cutting in our codebase

The bible's five cross-cutting principles (server authority, mobile-first cost, dormant data activation, genre wisdom, one source of truth) all apply. Specifics for our stack:

**Server authority over the world.** We are server-authoritative; this is non-negotiable. Hibernation-aware: `state.storage` for serialization, alarm-driven 20Hz tick (not `setInterval`, which blocks DO hibernation per the PartyKit gotcha). Confirm we do this in `worker/src/room.ts`; flag if not.

**Mobile-first cost discipline.** Tier 1 issues (#185-189) are all low-cost-high-impact precisely for this reason. Tier 2 issues (#190-194) are structural; do them when we hit perf walls or before scaling further. Do not pre-optimize.

**Dormant data is wasted potential.** `materialMap` is the leading example: gen produces it; runtime ignores it. Issue #186 addresses this. If gen-state-vs-sim-state divergence appears for other fields (decorations, biome flags) treat them with the same lens.

**Genre wisdom over invention.** When five sources agree (auto-step nudge, no-LoS damage, chunked dirty-tracking, opt-in wind), we adopt. We do not invent a sixth approach without a specific reason rooted in our stack.

**One source of truth per concept.** The mask is solidity. The catalog is weapon parameters. The server is state. We do not maintain parallel representations for "convenience."

**Snapshot ring + input rebase** (deferred, no issue). Combat-lander's pattern for late-input replay. Not needed for turn-based phases (only one player has authority); becomes valuable for rope/jetpack continuous-action moments. Revisit when those are wired.

---

## 10. Out of scope (worms confirmation)

Consistent with the bible's §10:

- **Cellular automata, falling-sand, water flow, fire spread.** Out. None ship in any v1 game mode.
- **Per-pixel debris physics** (MOPixel-style). Out. Cosmetic Phaser particles for visual feedback are fine.
- **Re-solidification of debris.** Out. Debris is short-lived visual-only.
- **Persistent damage history.** Out. The mask is the damage record; no separate event log changes future behavior.
- **Lockstep determinism.** Out. We are server-authoritative.
- **Mid-air locomotion control** beyond items (jetpack, rope). Out.
- **NPCs, AI, persistent world state across matches.** Out (already excluded by world-gen and object-interaction philosophies).

This is not a gap list. These are commitments. Re-introducing any requires revisiting the bible.

---

## 11. Map of gaps to follow-up issues

The audit (step 1) identified gaps. The precedent survey (step 2) identified solutions. The bible (step 3) committed to principles. This doc maps each principle to concrete follow-up GitHub issues.

### Tier 1 (atomic, ready-to-build, high-impact-low-cost)

| # | Title | Bible | Audit | Precedent |
|---|-------|-------|-------|-----------|
| #185 | Auto-step ledge nudge in worm locomotion | §4 | §2 | §2 |
| #186 | Material hardness gate in cutCircle (activate dormant materialMap) | §6 | §4 | §4 |
| #187 | Drill weapon: stream-of-mini-erasures | §6 | §3 | §3, §4 |
| #188 | Per-weapon launch offset | §5 | §3 | §3 |
| #189 | Tuning hygiene bundle: off-map margin scales, wind opt-in, damage ring | §6, §8 | §3, §4, §6 | §4, §6 |

### Tier 2 (structural, larger refactors, design-dependent)

| # | Title | Bible | Audit | Precedent |
|---|-------|-------|-------|-----------|
| #190 | Runtime spawn validation in Worm constructor | §3 | §1 | §1 |
| #191 | Fall damage threshold on vertical impact velocity, not normal impulse | §8 | §6 | §6 |
| #192 | Surface-normal-aware locomotion (slope sliding) | §4 | §2 | §2 |
| #193 | Chunked dirty-tracking for terrain rebuild + texture re-upload | §6 | §4 | §4 |
| #194 | Detached-chunk collapse via flood-fill | §6 | §4 | §4 |

### Tier 3 (deferred, no issue today)

- **Density-divided impulse** in damage propagation. Hedgewars-canonical. Fold into next weapons-or-objects refactor.
- **Single-endpoint spring rope** when ninja rope is wired. Bible §5; OpenLiero pattern.
- **Snapshot ring + input rebase** when rope/jetpack continuous-action feel suffers from latency. Combat-lander reference.
- **Bresenham LoS pixel-walk** when a weapon design requires it. Atomic Tanks pattern.
- **Probabilistic erasure for explosion edges**. Liero pattern; cosmetic.
- **Hedgewars-style damage curve** (`(base - dist) / 2 capped`). Adopt only on playtest feedback.

### Tier 4 (rejected, do not file)

Per bible §10: cellular automata, falling-sand, MOPixel debris, debris re-solidification, persistent damage history, lockstep determinism, mid-air control, parachute-drag wind formula, Powder Toy pressure model.

---

## 12. Open design questions

These need decisions before implementation, captured here so they don't get lost.

- **Step-up threshold for our 24px-radius worm.** Hedgewars uses 5px against a 12px-radius worm. Linear scale would suggest ~10px for us; that may produce "ledge popping" feel. Resolve via playtest of #185.
- **Slope-walk threshold** in #192. Genre default is ~60° from vertical for "slide vs climb." Tunable per playtest.
- **Detached-chunk damage and movement-blocking** in #194. Does a falling chunk hurt worms it lands on? Become destructible itself (cuts apply to it)? Block walking? Three discrete questions; resolve before implementation.
- **Chunk granularity** in #193. Hedgewars uses 32x32. Phaser xjxxjx1017 uses 64x64 quadtree. Pick one for v1; tune via playtest.
- **Material hardness thresholds** in #186. Specific pixel-radius values per material. Resolve via playtest after shipping the data path.
- **Issue dependencies.** #194 (detached-chunk collapse) benefits from #193 (chunked dirty-tracking) for efficient flood-fill scoping. Resolve order: #193 first, then #194.

---

## 13. Next steps

In rough order, by readiness:

1. **Triage tier 1 issues (#185-189).** All are ready to plan/build. Pick one to scope first; #186 (material hardness) has the highest user-perceptible-impact-per-line ratio.
2. **Resolve open design questions** for tier 2 issues (#190-194) before scoping.
3. **Schedule playtest** to inform tunable thresholds (#185 step-up, #192 slope, #186 hardness, etc.). Playtest before tuning is preferable to tuning before playtest.
4. **Optional: build a "gameplay-world telemetry" mode** (dat.gui overlay) that surfaces foot contact count, current slope angle, current material at cursor, etc. for tuning sessions. Not an issue, just a tooling thought.

After tier 1 ships, the codebase will significantly close the gap between the audit and the bible, with most of the genre-default fixes in place. Tier 2 work is then unlocked when ready.
