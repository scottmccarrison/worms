# Gameplay-World Current State (Step 1 Audit)

This document captures the current state of how worms, weapons, and environmental effects interact with our procedurally-generated world. It is the input to a future philosophy + design pair (parallel to `world-gen-philosophy.md` + `world-gen-design.md`), not the philosophy itself.

The audit is organized as **six contracts** between gameplay systems and the world: spawn, locomotion, aim/fire (including projectile-world), terrain mutation, damage propagation, and environmental. Each section names the files involved, describes current behavior, and lists observed fragility or open questions for follow-up.

This is a snapshot in time (as of master `7ee0d98`). Findings are factual; we are not proposing fixes here. Step 2 (precedent survey) and the bible/design pair come later.

---

## 1. Spawn contract

How a worm gets placed in a generated world, and what "valid spawn point" means.

### Files involved

- `src/maps/passes/distributeSpawnPoints.ts:26-93` - candidate scan + greedy spatial relaxation
- `src/maps/passes/validateSpawnCoherence.ts:17-59` - soft post-gen warning pass
- `worker/src/entities/worm.ts:108-151` - worm constructor (creates body + foot sensor)
- `worker/src/sim/simulation.ts:241-255` - simulation constructor wires team spawns to Worm constructor
- `src/tuning.ts:267-270` - spawn density tuning

### Current behavior

The contract is two-phase: **generation** and **instantiation**.

**Generation** (`distributeSpawnPoints`): the pass scans columns between edge margins and identifies candidates where the surface cell is solid AND the cell directly above is air (the "worm-fits" invariant). It then picks spatially-distributed spawns via greedy relaxation: shuffle candidates, accept picks with minimum spacing `densityPx` (200px tuned), progressively relaxing the spacing constraint (1.0, 0.8, 0.6, 0.4, 0.2, 0) until the target count is reached. Final spawn lists are sorted by x-coordinate and partitioned left/right by the map midline.

**Validation** (`validateSpawnCoherence`): soft check that emits `console.warn` if a side falls below `minPerTeam` (2) or if any spawn's heightmap entry violates the worm-fits invariant. No error thrown.

**Instantiation** (`simulation.ts`): for each worm in each team, a spawn `{ xPx, yPx }` is popped and passed to the Worm constructor. The constructor converts to meters and creates a planck dynamic body (12px = 0.24m radius circle, fixed rotation) plus a foot sensor (60% width, 30% height) at the body's bottom. **Coordinates are taken as-is; the constructor does not validate placement against terrain.**

### Observed fragility

- **No runtime placement validation in Worm constructor.** A coordinate that lands inside a cave, in mid-air with no floor, or off the map will create a body wherever told. Only the gen-phase invariant guards against this, and that invariant only checks the heightmap surface, not lateral or vertical neighbors.
- **Heightmap is single-Y-per-column.** Caves, overhangs, and floating islands aren't represented in the surface heightmap. A spawn placed on the surface above a wide cave entrance is technically valid but may produce surprising movement (worm walks off the edge into the cave on the first frame).
- **Cave-passability not pre-validated.** The cave generator is decoupled from spawn distribution. There's no pre-flight check that cave entrances near spawns are wide enough for a 12px-radius worm.
- **Edge-margin clamping is soft.** `edgeMarginPx = min(60, floor(widthPx / 8))`. On narrow maps the playable spawn zone shrinks; spawn coordinates are not bounds-clamped after distribution.

### Confirmed working

- Pixel-to-meter conversion is consistent (gen produces pixels; constructor calls `toMeters`).
- The worm-fits invariant is reliably enforced for hand-crafted maps and earlier procedural worlds.
- Foot sensor has correct geometry and `isSensor: true` flag.

---

## 2. Locomotion contract

How a worm moves on, around, and through the continuous-mask terrain.

### Files involved

- `worker/src/entities/worm.ts:155-194` - walk + jump methods
- `worker/src/entities/worm.ts:335-352` - `canJump` and foot contact tracking
- `worker/src/sim/simulation.ts:966-977` - foot sensor begin/end contact listeners
- `worker/src/sim/simulation.ts:458` - per-tick `applyWalking` re-application
- `worker/src/entities/worm.ts:359-384` - fall damage accumulation
- `src/tuning.ts:191-200` - walk speed, jump impulse, fall damage thresholds

### Current behavior

Walking is two-tier: a discrete input (`walk(dir)`) sets `walkingDir` and immediately applies `direction * walkSpeedMps` (2.5 m/s = 75 px/s) as linear velocity. Every tick, `applyWalking()` re-applies the same velocity, overwriting gravity and friction so horizontal speed stays constant while the input is held.

Jumping is conditional on `canJump()`: foot contact count > 0 AND `|vel.y| < 0.5`. A jump applies an impulse of `(1.5 * facing, -2 * 1.5) * density`. Backflip uses `(-2.3 * facing, -2 * 2.3) * density`. Both are mass-aware via density.

Foot contact is tracked by a contact listener that increments/decrements `footContactCount` for any contact between the foot sensor (a small isSensor box at the body's bottom) and a non-sensor, non-self fixture. "On ground" is defined operationally as `footContactCount > 0`.

Fall damage is independent of locomotion. The post-solve listener accumulates per-tick max normal impulse; if the accumulated impulse exceeds `8 * density`, damage is dealt up to a 25 HP cap.

### Observed fragility

- **Walk velocity reapplication overrides knockback.** Each tick re-sets horizontal velocity to `walkSpeedMps`. A worm hit by an explosion mid-walk will have the explosion's lateral knockback partially cancelled on the next tick. This is implicit; the worm appears to "snap back" toward walk direction.
- **Foot sensor on slopes and edges.** The sensor is a fixed-size box. On steep slopes (>45°) it may only contact one corner; on terrain vertices the contact could miss entirely or be ambiguous. "On ground" is not equivalent to "physically able to walk forward."
- **Contact-count enables wall-jumping.** A worm jumping into a cave alcove that touches the alcove's side fixture gets `footContactCount > 0` and can re-jump immediately. There is no surface-normal check.
- **No mid-air control** between jump and landing. The worm is fully ballistic until `footContactCount` returns above 0. May produce "stuck mid-air" sensations in tight caves.
- **Fall damage threshold is impulse-based, not velocity-based.** A worm falling onto a 30° slope generates a smaller normal impulse than one falling onto flat terrain, even at the same velocity. Fall damage is therefore terrain-shape-dependent in a way the tuning doesn't expose.
- **Walk speed unclamped by slope.** On a steep upward slope the constant 2.5 m/s walk velocity may be insufficient to climb against gravity, so the worm slides backward. Reverse on steep downhill: walk velocity throttles gravity-driven slide.

### Confirmed working

- Jump impulse is correctly mass-scaled.
- `canJump()` prevents double-jumps and mid-air jumps via the velocity check.
- Fall damage uses MAX-per-tick (not SUM) to avoid phantom damage from repeated small contacts on slopes.
- Foot contact listener correctly excludes worm-vs-worm contacts.

---

## 3. Aim and fire contract

How a player aims a weapon, fires it, and how the resulting projectile travels through the world. Combines what we previously called the aim/fire contract and the projectile-world contract.

### Files involved

- `worker/src/weapons/fire.ts:53-179` - main fire dispatcher and per-archetype handlers
- `worker/src/weapons/types.ts:27-35` - WeaponConfig shape (tunnel, restitution, fuse)
- `worker/src/sim/simulation.ts:382-441` - `applyFire` validation + projectile spawn
- `worker/src/sim/simulation.ts:489-516` - tick (fuse decrement, wind application)
- `worker/src/sim/simulation.ts:910-977` - begin-contact handler
- `worker/src/sim/simulation.ts:979-1007` - post-solve fall-impulse handler
- `worker/src/entities/projectile.ts` (full) - projectile body + fuse + tunnel logic
- `src/worm/aimAngle.ts` - client-side aim clamping (-π/2 to π/2)

### Current behavior

**Fire validation (server, `applyFire`):** confirms active worm, ammo > 0, and projectile cap (`MAX_PROJECTILES = 8`). Builds a fire context with `aimRadians`, `aimPower01`, `firer.facing` (-1/+1), and dispatches to one of three archetype handlers.

**Projectile / throwable:** computes origin offset from worm center using `cos(aim) * facing * spawnOffset`, then `velocityMps = { x: speed * cos(aim) * facing, y: speed * sin(aim) }` where `speed = aimPower01 * powerCap`. Spawns a planck dynamic body with a Circle fixture (radius from `projectileRadiusPx / 30`) and `bullet: true` for continuous collision detection. Self-fire is excluded from contacts via owner-id check.

**Hitscan (shotgun, minigun):** raycasts from origin to a 2000px endpoint in aim direction, skipping the firer's body. Shotgun fires 1 shot per activation; minigun fires 12. Both apply Bates-2 triangular jitter (~0.08 rad spread).

**Wind (per tick):** if `wind !== 0`, every in-flight projectile receives `applyForce({ x: wind * 0.8, y: 0 }, true)`. Wake flag wakes sleeping bodies. No drag.

**Detonation paths:**
- Contact-based (bazooka, `fuseMs === null`): begin-contact queues detonation if the projectile hits terrain or worm (excluding self).
- Fuse-based (grenade, drill, `fuseMs > 0`): tick decrements `fuseRemainingMs`; when 0, marked for detonation.
- Worm-contact override: even fused projectiles detonate immediately on worm contact.

**Tunnel carving (drill only):** `tickTunnel()` accumulates time; when `msSinceLastCut >= cutIntervalMs` (40ms), calls `terrain.cutCircle()` at body position. Initialized to `cutIntervalMs` so first cut fires promptly.

### Per-weapon notes

- **Bazooka**: restitution 0.1, radius 5px, no fuse. Reliable contact detonation.
- **Grenade (handgrenade)**: restitution 0.55, fuse 3000ms, radius 6px. Bouncy, can roll into corners. Worm contact detonates early.
- **Drill**: restitution 0, fuse 3500ms, radius 6px, tunnel cut radius 14px every 40ms. Tunnels through terrain without bouncing; detonates on worm contact.
- **Shotgun**: hitscan, 1 pellet per activation, raycast against live fixture set.
- **Minigun**: hitscan, 12 pellets per activation, same jitter as shotgun.

### Observed fragility

- **No line-of-sight validation on fire.** Hitscan correctly raycasts, but projectile spawn uses an offset (`wormRadius + projRadius + 2 ~ 18px`) that assumes the worm is on flat ground. A wedged worm could spawn a projectile inside terrain.
- **MAX_PROJECTILES = 8 silent rejection.** No client-side feedback when fire is rejected for cap reasons. Two players firing bazookas in quick succession could see a "missed" shot.
- **Custom geometric weapons use Circle fixtures.** Drill is a circle, not a polygon. Tunnel shape is round, not slot-shaped. Reference codebase used polygons. Untested with v1's narrow caves.
- **Terrain bodies rebuild on cuts.** Each `terrain.cutCircle()` destroys and recreates fixtures in the affected band. Projectiles already in flight don't see the new fixture set until the next `world.step()`. A drill mid-tunnel could pass through a freshly-carved hole before the body refresh.
- **Wind tuned at original map scale.** WIND_FORCE = 0.8 N/unit was calibrated against 0.07 kg projectiles on smaller maps. v1's larger maps make wind effects scale-dependent and uncalibrated.
- **Aim line preview ignores wind.** Client renders a straight ray; players can't predict deflection. Acceptable for casual play, but untested at v1 scale.
- **Restitution untested at scale.** Bouncy projectiles (grenade) on terraworld v1 caves and biome boundaries may behave unexpectedly; no regression test confirms restitution behavior across body rebuilds.
- **Fuse decrement assumes constant tick cadence.** Planck steps at 50ms internally, but if `tick(dtMs)` varies due to the DO alarm pattern, fuse expiration drifts.

### Confirmed working

- Fire validation (ammo, alive, weapon lookup) is tight.
- Hitscan correctly excludes firer.
- Self-contact exclusion (firer doesn't self-detonate) is gated by `ownerId`.
- Worm-contact override correctly detonates fused projectiles for drill kills.
- Projectile cleanup (body destroyed on detonate) does not leak.

---

## 4. Terrain mutation contract

How destructive events modify the world's mask and physics bodies.

### Files involved

- `worker/src/entities/terrain.ts:83-94` - `cutCircle` entry point
- `worker/src/entities/terrain.ts:101-137` - `rebuildBodiesInRegion`
- `worker/src/entities/terrain.ts:168-185` - `eraseCircleInMask`
- `worker/src/weapons/explode.ts:48` - explode helper calls `cutCircle`

### Current behavior

When an explosion or drill cut occurs, `terrain.cutCircle(x, y, radiusPx, sourceTag)` is invoked. It:

1. Erases solid mask bytes within a circular radius using pixel-center distance (`x + 0.5 - cxPx, y + 0.5 - cyPx`).
2. Recomputes physics bodies in the affected Y-band only, calculated as `[yMin - rowHeight, yMax + rowHeight]` to handle bodies straddling the cut boundary.
3. The `scanMaskForBoxes` algorithm re-scans the modified region and recreates static terrain bodies from scratch in that band.
4. Logs the cut as a `TerrainCut` record (with monotonic `seq`) for client broadcast via `terrain_cut` event.

The mask is solidity-only (0 = air, 1 = solid); `materialMap` (gen-time only) is not modified by cuts. Decorations and spawn points are not updated on cuts; they exist in `World` (gen state), not in the simulation's live terrain entity.

### Observed fragility

- **Material map not invalidated on cut.** The visual `materialMap` is never cleared. After a cut, clients rendering terrain may see "ghost" material bytes where solid pixels used to be. Likely intentional (the rendered terrain only paints where mask is solid), but worth confirming.
- **Spawn points are static after gen.** A cut that craters a spawn point doesn't re-validate or relocate. If a respawn ever lands on a destroyed spawn point, it could place a worm in a hole.
- **Decorations are gen-state, not live state.** `caveAmbient` and `surfaceDressing` arrays are committed at gen time and not pruned after cuts. A glow tuft painted on a wall that's been blown away will still render as if the wall were there. (Probably acceptable since they're paint-only and fall outside the visible mask.)
- **Body rebuild bands are bounded by `[yMin - rowHeight, yMax + rowHeight]`.** Sound in principle but untested on v1's larger maps with multi-level caves. A body whose center sits just outside the band but whose edge touches the cut won't be caught.
- **Pixel-center erase formula** uses `(x + 0.5 - cxPx)^2 + (y + 0.5 - cyPx)^2 < r^2`. Deterministic and float-safe, but no smoothing. Thin walls (≤ 2px) may be partially erased in ways that produce jagged edges.

### Confirmed working

- Cut sequence numbering (`cutSeq++`) provides reliable client-side dedup.
- AABB bounds calculation for the rebuild band is safe (clamped to world dims).
- Mask erasure is deterministic.

---

## 5. Damage propagation contract

How an explosion's effects propagate to nearby entities.

### Files involved

- `worker/src/weapons/explode.ts:50-98` - AABB query + per-worm damage calculation
- `worker/src/sim/simulation.ts:899-907` - `detonateProjectile` calls `explode`
- `worker/src/sim/simulation.ts:864-887` - `emitExplodeEvents` broadcasts damage
- `worker/src/entities/worm.ts:309-319` - `takeDamage` applies HP loss + sets alive flag

### Current behavior

Explosions perform an AABB query on the planck world to find candidate worm bodies within `damageRadiusPx`. For each result, actual Euclidean distance (in meters) is computed. If `distM < damageRadiusPx`, damage is `maxDamage * max(0, 1 - distM / damageRadiusPx)` (linear falloff to zero at the radius edge). Impulse is applied as `radial unit * impulseMag`, with an upward fallback for point-blank cases.

**There is no line-of-sight check.** A worm behind a wall takes full damage if it's within the radius. Self-damage (`firedByWormId === worm.id`) is tracked but not reduced.

### Observed fragility

- **Explosions punch through walls.** This may match Worms-genre intent (Armageddon explosions ignore terrain too), but on terraworld v1 with thick caves and biome walls, no test confirms this design choice still produces the intended gameplay feel.
- **Linear falloff is abrupt at the radius edge.** A worm 0.1px outside the radius takes zero damage, while one at the midpoint takes 50%. Realistic explosions usually use a curved falloff.
- **AABB query then radial filter has redundancy** (filter by box, then by circle). Correct but not the tightest spatial structure for high-density worm scenarios. Not a bug.
- **Impulse is mass-independent in practice.** Worm mass is fixed at density 1.0, so all worms get the same lateral push regardless of contextual properties.

### Confirmed working

- `takeDamage` correctly transitions alive → dead.
- Self-damage tracking via `firedByWormId` is deduped.
- Impulse direction is safe for distM > 0.001 with upward fallback for point-blank.
- AABB-then-radial filter correctly discards false positives.

---

## 6. Environmental contract

Passive world properties that affect entities each tick: wind, off-map kill, water, fall damage.

### Files involved

- `worker/src/sim/simulation.ts:285-291` - wind setter
- `worker/src/sim/simulation.ts:500-512` - wind force application per tick
- `worker/src/sim/simulation.ts:289-291` - water level setter
- `worker/src/sim/simulation.ts:560-584` - water drown check
- `worker/src/sim/simulation.ts:544-558` - off-map kill floor
- `worker/src/sim/simulation.ts:469-487` - `applyPendingFallDamage`
- `worker/src/entities/worm.ts:359-384` - fall damage accumulator + threshold

### Current behavior

Each tick, in this order:

1. **Wind**: if `wind !== 0`, every in-flight projectile receives `wind * 0.8 N` horizontal force. Compounds across ticks for curved trajectories.
2. **Off-map kill**: worms with x or y beyond `OFF_MAP_MARGIN_PX = 200` of map bounds are killed. Top boundary is intentionally excluded (gravity returns airborne worms).
3. **Water drown**: if `waterLevelPx !== Number.MAX_SAFE_INTEGER`, worms at `y > waterLevelPx` are killed with 999 damage.
4. **Fall damage**: the post-solve listener accumulates per-tick max normal impulse. If accumulated > `FALL_DAMAGE_THRESHOLD * density` (8.0), damage is dealt with a piecewise-linear formula, capped at 25 HP per landing.

### Observed fragility

- **Off-map margin is hardcoded at 200px.** On v1's larger maps (e.g., 2560×1024), 200px is barely off-screen. A worm pushed 200px sideways stays within the playable area visually but is killed. Margin should likely scale with map dimensions.
- **Water level is a pure Y threshold.** No buoyancy, no gradual drowning, no swimming. Set or sentinel; instant death on cross. Untested in maps with water (most v1 maps don't set it explicitly).
- **Fall damage formula has a hard threshold knee.** Damage spikes from 0 to ~1 HP at impulse 8.1, then ramps to 25 HP at impulse 16. Feels arbitrary; impact-based rather than velocity-based by design but not documented.
- **Fall damage on slopes is muted.** A worm landing on a steep slope generates a smaller normal impulse than one landing flat at the same speed. Fall damage is therefore slope-dependent in a way the threshold tuning doesn't expose.
- **Wind units calibrated against legacy projectile mass.** WIND_FORCE = 0.8 was tuned for the original 0.07 kg projectile on smaller maps. v1 hasn't re-validated wind feel.
- **No symmetry test for wind direction.** Wind clamps to [-1, 1] but no automated check that negative and positive winds produce mirrored deflections.
- **Water setter clamps yPx >= 0** but doesn't clamp against `heightPx`. A water level above the map sky is technically valid and would instantly drown all worms.

### Confirmed working

- Off-map check correctly excludes top boundary (issue #141 rationale documented in code comment).
- Wind force uses `applyForce(..., true)` to wake sleeping bodies.
- Sentinel `Number.MAX_SAFE_INTEGER` for "no water" is reliable.
- Fall damage dedup via `diedThisTick` set prevents double-emit when a worm dies from fall + water in the same tick.

---

## Cross-contract themes

A few patterns surface across multiple contracts:

- **Hardcoded thresholds tuned for the legacy maps.** Off-map margin, wind force, fall damage thresholds, projectile cap, and aim/power scales were all calibrated when maps were ~640×400. v1's 2560×1024 maps haven't re-validated any of these.
- **Gen-state vs sim-state divergence.** Spawn points, decorations, materialMap all live in gen state and are never updated by cuts. This is intentional but means we have no contract for "world state at gen time" vs "world state during play."
- **No line-of-sight checks anywhere.** Damage propagation, fire trajectories, and aim previews all ignore terrain occlusion. This may be a deliberate genre choice (Worms Armageddon ignores LoS too) but is not documented as such.
- **Continuous-mask terrain hasn't been combo-tested with non-circular shapes.** Drill, rope, and any future polygon weapon assume the mask + body rebuild cooperates with arbitrary collision geometry. Untested.
- **Foot sensor is a fixed box.** Slope, edge, and corner cases all collapse into "any contact = on ground." This is operationally fine but produces non-obvious behavior on steep or narrow geometry.

These cross-cutting concerns are likely the driving questions for the philosophy doc.

---

## What this audit is for

The findings here are the input to step 2 (precedent survey: what do other 2D destructible-arena games do for these contracts?) and ultimately to a `gameplay-world-philosophy.md` + `gameplay-world-design.md` pair. The fragility observations are not bugs to fix yet; they are claims to test against precedents and against the actual feel of v1 maps in playtest.
