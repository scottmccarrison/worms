# Gameplay-World Precedents (Step 2 Survey)

Companion to `gameplay-world-current-state.md`. That doc described what we do today across six contracts (spawn, locomotion, aim/fire, terrain mutation, damage propagation, environmental). This doc surveys what other open-source projects do and identifies concrete patterns to copy or adapt - and patterns to skip.

Sources surveyed:

1. **Hedgewars** (Pascal/Qt, 20+ years) - the canonical open-source Worms clone. Lockstep-deterministic; some mechanics don't transfer to our authoritative-server model.
2. **OpenLiero / OpenLieroX / Gusanos** (C++) - real-time Worms-variant lineage. Pixel-mask terrain, weapons, multiplayer.
3. **OpenSoldat** (Pascal) - 2D side-scrolling shooter with polygon (not pixel) terrain. Multiplayer-first.
4. **Cortex Command Community Project** (C++) - the most ambitious open-source destructible-pixel engine.
5. **Atomic Tanks** (C++) - turn-based artillery; the rare project with line-of-sight blocking.
6. **Akip2/torket-game** (TS, our stack) - re-skim for gameplay-layer (we covered objects in PR 1).
7. **Phaser destructible-terrain demos** - quadtree dirty-cell pattern is standard.
8. **planck.js / Box2D community** - foot-sensor idioms, slope-aware locomotion, raycast usage.
9. **Cloudflare DO + PartyKit** - server-authoritative real-time game patterns.
10. **Noita / Sandspiel / Powder Toy / Terraria / Lemmings** - conceptual broadening on world mutation.

Each section below covers one of the six contracts and ends with a recommendation for our codebase. The bottom of the doc has cross-cutting patterns and a prioritized "actionable" list.

---

## 1. Spawn contract

### What precedents do

- **Hedgewars `FindPlace`** (`uGearsUtils.pas:943`) does a random-x scan with multi-pass relaxation: first pass respects proximity to other gears, then ignores neighbors, then allows overlap. Inside each x-column it walks y from sky to water-line, alternating "find empty band" / "find solid below" - so cave airpockets qualify naturally because every (sky-above, solid-below) transition is a candidate.
- **OpenLiero / Gusanos** validates spawn by probing the worm's hitbox points (4-8 corner samples) against the pixel mask. If any are solid, scan outward in a spiral until clear.
- **Cortex Command** has `ResolveTerrainIntersection()` as a fallback nudge for compound bodies that spawn intersecting terrain.
- **OpenSoldat** uses sector-bucketed polygon collision; spawn validity is a per-polygon test.

### What we should adopt

1. **Multi-pass relaxation is already what we do** (`distributeSpawnPoints.ts`). Hedgewars' version is more aggressive (allows full overlap on the third pass) but otherwise identical in shape. No change needed.

2. **Add a runtime-spawn validation in the Worm constructor** that probes the body's would-be hitbox against the terrain mask. If the hitbox intersects solid pixels, nudge the spawn outward (1px at a time, up to N px) before creating the body. This is OpenLiero's pattern, costs O(hitbox-pixel-count) per spawn, and addresses the gap we flagged in step 1: today the constructor takes `(xPx, yPx)` as gospel even if it lands inside terrain.

3. **Enumerate full vertical bands per column at gen time**, not just the surface heightmap entry. Hedgewars' alternating sky/solid scan is the correct way to enumerate spawn candidates in a world with caves and overhangs - our current heightmap-only check produces gen-time validity that becomes runtime-invalidity once caves are added. Bands above caves AND ledges inside caves both qualify if the worm fits.

### What to skip

Hedgewars' RNG is bound to lockstep determinism; we use a server-side seeded RNG and don't need engine-wide reproducibility.

---

## 2. Locomotion contract

### What precedents do

- **Hedgewars** (`uGearsHedgehog.pas:1140-1190`) has an **explicit unrolled step-up ladder**: tries y-shifts of -1, -2, -3, -4, -5 pixels in order; each step damps horizontal velocity progressively (`*0.96`, `*0.93`, `*0.9`, `*0.87`, `*0.84`). On-ground = AABB-overlap test 1px below the worm, NOT a contact listener (decouples grounded state from physics-engine flicker).
- **OpenLiero `worm.cpp:285-310`** is the canonical 1-pixel-nudge auto-step: `if (reacts[Down] < 2 && reacts[Up] > 0 && (reacts[Left] > 0 || reacts[Right] > 0)) pos.y -= itof(1)`. Single-pixel vertical nudge when wall-blocked with ground contact; no threshold, just retry horizontal.
- **OpenLierox / Gusanos** uses **directional reaction-force collision** - 4-direction probe points around the body with non-passable pixel counts per direction. More robust than a single raycast.
- **planck.js / Box2D community idiom**: foot sensor uses a **contact counter**, not a boolean, incremented on `BeginContact` and decremented on `EndContact`. Boolean breaks when the sensor straddles two fixtures (BeginContact fires twice, EndContact once -> false reads). Reference: [iforce2d sensors tutorial](https://www.iforce2d.net/b2dtut/sensors).
- **Box2D PreSolve normal check**: read `worldManifold.normal` and disable the contact (or zero tangent friction) when the surface normal angle from vertical exceeds the walk threshold - otherwise apply along-surface velocity.
- **Box2D ChainShape ghost vertices** prevent fixtures from snagging on segment seams when terrain is built from joined chains. Critical once your terrain rebuild produces segmented bodies.

### What we should adopt

1. **The 5-step explicit step-up ladder.** This is the single most actionable finding in the survey and directly addresses our "foot sensor on slopes" fragility. Implement: when a walk input collides with a wall, try `body.setPosition({ x, y - 1px... -5px })` and `world.testOverlap` against terrain at each step; first non-overlap wins. Damp horizontal velocity per step. Cleaner than chain-shape-with-raycast and matches genre feel exactly. Cite Hedgewars + OpenLiero as proof.

2. **Verify our foot sensor uses a counter, not a boolean.** Step 1 audit didn't surface this explicitly. If we're using a boolean, switch to a counter. (Quick check during implementation.)

3. **Surface-normal-aware walking via `PreSolve` callback.** Read the contact normal; if it exceeds a slope threshold (e.g., 60° from vertical), zero tangent friction or slide instead of walk. This addresses our "walk speed unclamped by slope" issue.

4. **Build terrain bodies as `ChainShape` with prev/next ghost vertices** rather than segmented box arrays. This addresses the "fixtures snag on terrain rebuild boundaries" problem we'd hit once terrain bodies are sectioned for performance.

### What to skip

- **Hedgewars `doStepPerPixel` substepping** - planck handles CCD via the `bullet` flag for fast bodies. Don't reimplement.
- **Mid-air control** - none of the precedents add mid-air horizontal acceleration except via specific items (Jetpack). Worms players expect ballistic post-jump. Keep our model.

---

## 3. Aim and fire contract

### What precedents do

- **Hedgewars** has a single `Attack(Gear)` switch that produces a new gear; per-ammo properties live in an `AmmoProps` bitmask (`ammoprop_Power`, `ammoprop_NeedTarget`, `ammoprop_AltAttack`, `ammoprop_Timerable`, `ammoprop_SetBounce`). Per-ammo `getLaunchOffset(angle, facing)` so projectiles spawn at the muzzle, not the body center.
- **OpenLiero** rope is a **single-endpoint spring**: only the hook position is tracked, force = `(hookPos - wormPos) * pullForce / length` applied to the worm when current length exceeds max length. Confirmed across both OpenLiero and Gusanos. No segmented rope physics.
- **Torket** sends `[angle, power]` action events to the server, not per-frame aim positions. Charge is client-side; server only learns about the fire on release.
- **OpenLierox** uses **sub-step-per-tick projectile motion** based on weapon `repeat` value: faster projectiles get more sub-steps. This is a cleaner version of our `bullet: true` CCD reliance.
- **Atanks** has **per-weapon blast radius modifier** (`x_rad = DRILLER == weapType ? weap->radius / 20 : weap->radius`) so the same explode helper produces drill-cuts vs grenade-cuts via a single field.
- **Box2D `world.rayCast` with callback** for hitscan and trajectory preview. Returns fraction (0=stop, 1=continue, 0..1=clip-to-closest, -1=skip). Box2D's broadphase makes this O(log n).
- **Box2D bullet-flag pitfall**: bullet CCD bypasses sensor fixtures. If projectiles use sensor fixtures for hit detection they can tunnel. Reference: [Box2D issue #457](https://github.com/erincatto/Box2D/issues/457).

### What we should adopt

1. **Per-weapon `getLaunchOffset(angle, facing)` so projectiles spawn at the muzzle.** Today our offset is a fixed `wormRadius + projRadius + 2`. Per-weapon offsets fix the "wedged worm spawns projectile inside terrain" gap from step 1.

2. **Single-endpoint spring rope.** When we eventually wire ninja rope (deferred per CLAUDE.md), use the OpenLiero/Gusanos pattern. No segments. Server-authoritative friendly because state is just (hookX, hookY, isAttached).

3. **Move drill from "one circle body that bounces" to "small kinematic body that streams mini-erasures".** Hedgewars confirms: blowtorch and pickhammer call `doMakeExplosion` once per ~47 ticks while moving. This is structurally simpler than swept-capsule CSG and gives the staccato visual for free.

4. **Per-weapon explode radius modifier.** Atanks' single-field approach is cleaner than special-casing in the explode helper. Drill could be `radiusMultiplier: 0.05` of bazooka while sharing the same explode call.

### What to skip

- **Hedgewars' Pascal-flavored 200-line `Attack` case statement.** Use a registry of `WeaponHandler` objects in TypeScript (we already do).
- **Per-frame aim position broadcast.** Torket's "action events only" model is correct for our authority boundary; we already follow it.

---

## 4. Terrain mutation contract

### What precedents do

- **Hedgewars `DrawExplosion`** (`uLandGraphics.pas:457`) is a midpoint-circle scanline fill that flips solid->air pixels and copies background color, marking 32x32 chunks dirty in `LandDirty[]` for lazy GL re-upload. `DrawExplosionBorder` (line 526) is a separate sweep that marks `lfDamaged` for the ash ring without modifying solidity. Drill/blowtorch is a **stream of damageless mini-explosions** every 47 ticks. **No support physics**: floating terrain stays floating, by design.
- **OpenLiero `sobject.cpp`** uses **probabilistic erasure**: circle the bounding rectangle, check `anyDirt() && game.rand(8) == 0`. The 1-in-8 chance produces organic crater edges without Perlin noise.
- **Cortex Command** has the most sophisticated approach: `SLTerrain::EraseSilhouette()` is a cookie-cutter cut accepting rotation and scale, with `m_UpdatedMaterialAreas` deque for incremental re-render. **MOPixel** instances eject from removed area as physics-affected debris (sharpness-decay, stick-on-rest).
- **Phaser destructible-terrain reference** (`xjxxjx1017/Destructible-Terrain-With-Phaser`): **quadtree dirty-cell tracking**. Only cells containing changed pixels trigger physics body rebuild. ~32-64px cells. The standard pattern in the JS world.
- **Box2D + Clipper.js** community pattern: terrain stored as polygons; explosions are polygon-difference operations; rebuild only the affected chain-loop fixtures. References: [AntonioR Worms-like terrain](https://antonior-software.blogspot.com/2014/08/i-made-little-demonstration-of-worms.html), [Emanuele Feronato Box2D destructible step 2](https://emanueleferonato.com/2013/10/17/how-to-create-destructible-terrain-using-box2d-step-2/).
- **Lemmings (1991)**: Digger, Miner, and Basher remove pixels via role-specific shaped templates. Destruction is directional and shape-parameterized, not radial.

### What we should adopt

1. **32x32 (or 64x64) dirty-chunk grid** for both texture re-upload and body rebuild. Step 1 flagged that we rebuild bodies in a Y-band on every cut; chunked rebuild is finer-grained and the standard pattern. Critical for mobile re-upload performance.

2. **Damage ring as a separate flag** (Hedgewars `lfDamaged`). Lets us render the dark border around explosions without modifying the solidity bit. Our current cut produces clean circles; a stained border adds visual feedback for free.

3. **Stream-of-mini-erasures for tunneling weapons**, not swept-capsule CSG. Hedgewars confirms this is simpler and gives better feel. Replace the drill's `cutCircle` once per `cutIntervalMs` with N small `cutCircle` calls along the path.

4. **Probabilistic erasure for explosion edges.** A 1-in-8 chance to skip the outer ring of the cut produces ragged crater rims. Tiny code change, big perceptual impact.

5. **Material hardness via existing `materialMap`.** Step 1 noted `materialMap` is gen-time-only and never consulted at cut time. Add a guard: if the pixel's material is `STONE`, require blast radius > threshold to remove it. We already have the data; we're not using it. This adds strategic depth (stone tunnels are stable, dirt tunnels collapse easier) with one if-statement.

6. **Optional: detached-chunk collapse via flood-fill.** After a cut, flood-fill from the dirty rect and detect disconnected solid clusters. Convert each cluster to a falling planck dynamic body with an approximate convex hull. This addresses the genre-old complaint that overhangs float. Noita and Cortex Command both do versions of this. Medium-cost (one flood-fill per cut over the dirty rect), high gameplay value.

### What to skip

- **Cortex Command's MOPixel system** (per-pixel debris physics). Beautiful but too expensive for our server budget on Cloudflare Workers.
- **Lemmings agent-shaped destruction at the locomotion layer.** Worms is turn-based; we don't have continuously-mining agents. But shape-parameterized cuts at the *weapon* layer (drill = thin column, basher = horizontal slice) are still interesting if a weapon family demands it.

---

## 5. Damage propagation contract

### What precedents do

- **Hedgewars `doMakeExplosion`** (`uGearsUtils.pas:88`) uses linear distance falloff with cap: `dmgBase = Radius * 2 + cHHRadius / 2`, then `dmg = (dmgBase - distance) / 2`, clamped to `Radius`. **No line-of-sight**. Impulse is `dmg * 0.005 + cHHKick`, divided by density (heavy objects get less knockback). The famous "10 damage on direct hit" is just a side-effect of the formula plus the radius=10 grenade.
- **OpenLierox / Gusanos / OpenLiero** all confirm: pure radial damage, no LoS check. AABB query then radial filter is the standard.
- **Atomic Tanks** is the rare exception: `checkPixelsBetweenTwoPoints` Bresenham pixel-walk for SDI (point-defense) targeting. The function exists and is used; it's just not applied to blast damage by default.
- **Cortex Command** uses material-strength gating during AtomGroup `TryPenetrate()` calls; not LoS in the strict sense but related.

### What we should adopt

1. **Linear falloff with cap matches genre.** Our current `maxDamage * (1 - dist / radius)` is close but not identical to Hedgewars. Hedgewars' formula gives a wider damage plateau near the center and a sharper cliff at the edge, which feels better. Tunable; copy if playtests want it.

2. **Density-divided impulse.** We currently apply uniform impulse (worm density is fixed at 1.0 so it doesn't matter today). When we add objects with varying density (already in the catalog system), divide impulse by density so heavy objects get less push. Hedgewars-canonical.

3. **Optional per-weapon LoS flag.** Hedgewars and the Liero family all skip LoS by genre default. Atanks is the proof that you CAN add LoS via Bresenham pixel-walk if you want it for specific weapons (e.g., focused-beam laser, sniper rifle). Default off; per-weapon opt-in.

### What to skip

- **Adopting LoS as a default.** It's expensive (raycast or pixel-walk per damaged worm), and the "hide behind a wall, take half damage" emotional beat is core to Worms-genre play. Hedgewars is correct here.
- **Adopting `world.rayCast` for damage filter.** We considered swapping our AABB-then-radial for a circular cast. After thought: AABB is fine because the target set (4-8 worms) is small. The optimization isn't load-bearing. (Where it WOULD matter: trajectory preview, line-of-sight queries for AI - but we don't have AI.)

---

## 6. Environmental contract

### What precedents do

- **Hedgewars wind**: per-gear `dX += cWindSpeed/Density` each tick, applied **selectively** via a per-gear `WindSpeed` flag. Bazooka shells yes, bullets no. NOT a blanket physics force.
- **Hedgewars water**: pure Y threshold (`Y > cWaterLine`) with `doStepDrowningGear` dropping the gear at `cDrownSpeed` until off-screen, then deletes. No buoyancy.
- **Hedgewars fall damage**: `dmg = 1 + (dY - 0.4) * 70`. Linear in vertical impact velocity past a threshold. Plays bump sound + dust particles + `dsFall` damage source.
- **Hedgewars off-map**: 250+ pixel overshoot before delete (so the "homerun" event animates before the worm vanishes).
- **Atanks wind**: parachute-drag formula `xv += (wind - xv) / mass * (drag + 0.35) * env.viscosity`. Smoother feel than direct force, and wind affects different masses differently for free.
- **Powder Toy pressure model**: explosions write a scalar pressure value into 8x8 tiles; pressure decays each tick; entities in high-pressure tiles receive force. This produces shockwave-around-corners feel without LoS.

### What we should adopt

1. **Per-projectile wind opt-in flag.** Hedgewars confirms genre intent: light objects get carried, bullets don't. Add `affectedByWind: boolean` to `WeaponConfig`. Default on for projectiles, off for hitscan (already true), explicit off for fast/heavy projectiles like the holy hand grenade. Step 1 flagged that wind force is hardcoded uniform - this is the fix.

2. **Off-map margin should scale with map dimensions.** Our hardcoded 200px is generous on 640px maps and stingy on 2560px maps. Hedgewars uses generous overshoot (250px+) regardless of map size, which works because their "homerun" animation is the visual cue. Suggested: `OFF_MAP_MARGIN_PX = max(200, widthPx * 0.1)`. One-line fix.

3. **Fall damage threshold in vertical impact velocity, not normal impulse.** Step 1 noted our impulse-based threshold is slope-shape-dependent. Hedgewars uses `dY > 0.4` (vertical velocity) which is shape-independent. Simpler too; check vy at landing time.

4. **Bresenham LoS as a future primitive** (not adopted now, but document it). When we eventually want a sniper rifle or trajectory preview, atanks' `checkPixelsBetweenTwoPoints` is the right pattern. Cost is one pixel-walk per query.

### What to skip

- **Atanks parachute-drag formula** is appealing but indistinguishable from our current uniform force at low wind values. Adopt only if playtest shows wind feels wrong.
- **Powder Toy pressure model** is conceptually elegant but a whole new simulation layer for marginal feel improvement. Skip.
- **Hedgewars `WorldEdge` enum** (sea/bounce/wrap variants). Our PvP arena needs only "kill on overshoot." Don't generalize.

---

## Cross-cutting patterns

A few themes recurred across multiple contracts.

### Server-authoritative in our stack

The closest production-quality reference for our specific stack (TS + planck on CF Workers + Durable Objects) is **`chungwu/combat-lander`** (PartyKit + Rapier). They implement:

- 60Hz physics tick (we do 20Hz - probably fine, but verify with playtest)
- Per-client snapshot ring buffer
- **Git-rebase-style input replay**: late input arrives -> rewind to that timestep snapshot -> reapply -> fast-forward
- Periodic full-state broadcast (~5s) as resync against drift
- Client validates snapshots against known inputs before applying

We currently do simple full-state broadcast at 20Hz with no input rebase. For a turn-based game where only one player has authority at a time, this is probably fine. For continuous-action moments (rope swing, jetpack flight), the input-rebase pattern is what makes lag tolerable.

**Hibernation gotcha** (also from PartyKit): a continuous tick loop via `setInterval` blocks Durable Object hibernation. Use alarm-driven ticks; only spin the 20Hz loop when players are mid-turn. Confirm we do this.

### Quadtree / chunk-based dirty tracking

Five separate sources (Hedgewars 32x32 chunks, Phaser xjxxjx1017 quadtree, Cortex Command UpdatedMaterialAreas deque, Sandspiel chunked CA, Box2D-Clipper sectorized rebuild) all agree: **divide the world into chunks; track which chunks are dirty per cut; rebuild only the dirty chunks' bodies and re-upload only the dirty chunks' textures**. This is the canonical pattern. Step 1's "rebuild Y-band on every cut" is coarser than this and will likely tank on mobile once maps grow.

### No-LoS damage is genre-correct

Five Worms-genre projects (Hedgewars, Liero, OpenLiero, OpenLierox, Gusanos) all skip line-of-sight on damage by default. Atanks adds it for one specific weapon (SDI defense). The Worms-genre player expectation is "near miss + wall = chip damage", not "wall = total cover." We should hold this line.

### Auto-step ledge nudge is universal

Three independent sources (Hedgewars 5-step ladder, OpenLiero 1-pixel nudge, Gusanos directional reaction force) all implement some form of "if you walk into a wall but you're on ground, try shifting up by N pixels and retrying." The exact threshold differs (1px, 5px, etc.) but the pattern is identical. **This is the single most important locomotion finding** and the easiest to apply.

### Material-aware mechanics are dormant in many designs

We have a `materialMap` that's never consulted at runtime. Hedgewars has an `lfIndestructible` flag. WA had per-pixel material flags. None of these are exotic - they're all "if material is X, modify behavior." Activating ours costs a few if-statements and produces noticeable strategic depth.

---

## Actionable patterns, prioritized

Ordered by ratio of player-perceptible impact to implementation cost.

### Tier 1: high-impact, low-cost (do first)

1. **Auto-step ledge nudge in locomotion.** OpenLiero's 1px-or-5px ladder. Critical fix.
2. **Foot sensor counter (verify, fix if boolean).** Quick check during locomotion work.
3. **Material hardness in `cutCircle`.** Use existing `materialMap` data. One guard.
4. **Per-weapon launch offset** instead of fixed body offset. Fixes wedged-worm projectile-spawn-in-terrain issue.
5. **Off-map margin scales with map width.** One-line fix.
6. **Per-projectile wind opt-in flag.** Fixes "uniform wind" feel issue.
7. **Damage ring as separate flag** (`lfDamaged`-equivalent) to render explosion borders without modifying solidity.
8. **Stream-of-mini-erasures for drill** instead of one-shot circle per interval. Better feel, simpler code.

### Tier 2: structural changes (do during real work, not standalone)

9. **Quadtree / 32-64px chunked dirty tracking.** Replace Y-band rebuild. Higher cost; do when mobile perf tanks.
10. **`ChainShape` ghost vertices for terrain bodies.** Prevents fixture snags. Couple with chunked rebuild.
11. **PreSolve normal-aware walking.** Slope sliding above threshold. Couple with auto-step.
12. **Fall damage threshold on vertical velocity, not normal impulse.** Replaces existing threshold cleanly.
13. **Spawn validation in Worm constructor** (probe hitbox, nudge outward).
14. **Detached-chunk collapse via flood-fill** after big cuts. Marching-squares-to-polygon body.

### Tier 3: deferred (do when feature requires)

15. **Single-endpoint spring rope.** When ninja rope is wired (post-MVP).
16. **Snapshot ring + input rebase** (combat-lander pattern). When projectile / rope feel suffers from latency.
17. **Bresenham LoS pixel-walk.** When a weapon needs it (sniper, focused beam).
18. **Probabilistic erasure for explosion edges.** Cosmetic; do after more important visual work lands.

### Tier 4: rejected for our domain

- Full per-pixel cellular automata (Noita, Sandspiel scale)
- MOPixel debris physics (Cortex Command)
- Re-solidification of debris back into terrain
- LoS as default in damage propagation
- Atanks parachute-drag wind formula (over-engineering)
- Powder Toy pressure-wave model

---

## What this audit is for

The actionable patterns above feed the bible / design pair. Specifically: every pattern in tiers 1-2 should appear in the bible as a contract decision (with citations to the precedents that support it), and the design doc should map each to a concrete action item or follow-up issue. Tier 3 items become "deferred per design" notes; tier 4 become explicit out-of-scope statements.

Step 3 is the bible. Step 4 is the design and follow-up issues.
