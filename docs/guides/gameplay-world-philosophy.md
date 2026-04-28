# Gameplay-World Philosophy

This document is the bible for gameplay-world interaction. Where `world-gen-philosophy.md` answers "how do we build a world?", this answers "how does gameplay operate inside that world?". The two are complements; reading them side by side gives the complete picture of our world model.

This doc lays the conceptual ground so the system can be re-derived in any engine, in any language, ten years from now. It contains no code. It is meant to be read in one sitting alongside the world-gen bible.

Inputs to this doc: an audit of what we do today (`gameplay-world-current-state.md`) and a survey of ten open-source genre and adjacent-stack precedents (`gameplay-world-precedents.md`). Citations to those docs are inline.

## 1. What gameplay-world interaction actually is

For our purposes, gameplay-world interaction is the set of contracts between **entities** (worms, projectiles, transient effects) and **the world** (the destructible mask, decorations, environmental properties). Where world-gen produces the world at t=0, this layer governs everything that happens in the world from t=0 onward except for the mutations that gameplay itself causes.

The framing question: when a player presses an input or fires a weapon, what does the world owe them in response? What does an entity owe the world? Six contracts answer that question:

1. **Spawn**: how an entity gets placed in a world that already exists.
2. **Locomotion**: how an entity moves through and on the world.
3. **Aim and fire**: how an entity reads the world to direct an action through it.
4. **Terrain mutation**: how the world's shape changes in response to gameplay events.
5. **Damage propagation**: how a mutation event affects nearby entities.
6. **Environmental**: how passive world properties affect entities each tick.

The contracts are interlocking. Spawn depends on terrain shape. Locomotion depends on what counts as ground. Damage depends on terrain mutation. Environmental properties depend on world bounds. A bible that answered any one of them in isolation would be brittle.

## 2. Genre frame: the world is an arena, not a sandbox

Just as world-gen is anchored in Terraria's pass-list pattern, gameplay-world is anchored in the **Worms genre lineage**: Worms Armageddon, Hedgewars, Liero, OpenLiero, OpenLierox, Gusanos. These are five-to-fifteen-minute PvP arena matches in destructible 2D worlds, with no persistence, no NPCs, no inventory.

The genre's defining property is that the world is a **stage**: complex enough to produce tactical variety, dispensable enough to be destroyed in service of the match. The world generates, the match plays out, the world is discarded. Nothing is at stake outside the match.

This frame rules out a class of engineering investments that look attractive from outside the genre. Cellular automata, falling-sand simulation, multi-frame liquid flow, persistent damage history, AI-driven NPCs - these are all the right answers for sandbox games (Noita, Powder Toy, Terraria). They are wrong answers for ours, not because they are bad ideas in the abstract but because they buy nothing the genre needs and they cost everything the genre cannot afford.

The genre's positive answer for what the world *should* do is also clearer than it might look. Five independent open-source projects converge on remarkably similar mechanics, with similar tuning ranges, for similar reasons. When five lineages of independent implementation agree, that is genre wisdom and we should respect it unless we have a specific reason not to.

## 3. The Spawn principle

**Worlds enumerate candidates; runtimes verify and nudge.**

Spawn is a two-phase contract. The world-gen pass enumerates candidate coordinates that satisfy a worm-fits invariant (a body of the worm's footprint can rest at this point with at least the required clearance above). The runtime construction phase trusts the candidate but verifies the live mask before constructing the body, and nudges outward if the candidate is invalid. Both phases are required; neither alone is sufficient.

Gen-only validity is brittle because terrain may have shifted by the time the runtime spawns (if any), or because the mask may differ from the heightmap on which gen made its decision. Caves, overhangs, and floating islands all break gen-time-only validity. Runtime-only validity is wasteful because the gen pass has already done the spatial-distribution and density-relaxation work; throwing that out and probing from scratch each match is a regression.

Hedgewars' multi-pass relaxation (proximity strict, then loose, then permissive) and OpenLiero's spiral-outward nudge from a candidate are the two halves of the canonical contract. We adopt both.

Corollary: world-gen owes the simulation a *list* of candidates, not a single point. The simulation's nudge phase operates within the candidate region; it does not invent new candidates. The handoff is the candidate list, sorted by gen's preference; the runtime takes them in order.

## 4. The Locomotion principle

**Walking is universal step-up; ground is a count, not a flag.**

The genre player expects to walk over small rocks and ledges without explicit input. Three independent sources implement this as a *step-up nudge*: when horizontal motion is blocked but the body is grounded, shift vertically by N pixels and retry the horizontal motion. The threshold (N) varies (1px in Liero, 5px in Hedgewars), but the pattern is universal. Worms that cannot step over small ledges feel broken in a way that matters.

Ground state is operationally defined by counter: a contact begins, the count increments; a contact ends, the count decrements; the body is grounded when the count is positive. Boolean ground flags break in two cases that occur regularly: when a body's foot sensor straddles two segmented terrain fixtures (BeginContact fires twice, EndContact once), and when contact flickers across a vertex (mathematically valid contact lifecycle producing visually wrong "airborne" frames). The counter is correct by construction; the flag is correct only by accident.

Jump validity follows from ground state. A grounded body with near-zero vertical velocity can jump; nothing else can. Mid-air control is genre-rejected: once airborne, the body is ballistic until landing, except via dedicated items (jetpack, rope) that establish a different physics regime.

Corollary: surface normals matter for slope detection but are not the primary mechanism. The step-up nudge handles the common case of small obstacles regardless of normal angle. Surface normals enter the picture only when the slope exceeds a walk threshold (steep slopes should slide, not climb) or when fall damage requires direction-aware impulse interpretation.

## 5. The Aim and fire principle

**Fire is an event; the world is read, not negotiated with.**

The aim and fire contract is single-event: when a player commits to firing, the entire kinematic state of the resulting projectile (or hitscan ray) is sealed at that moment. The server learns about the fire as a discrete event (`fire(angle, power)`), not as a stream of input frames. The projectile's spawn position, velocity, fuse, and other kinematics are derived from the event payload + the firer's state at the event time; nothing else.

This frees aim from being an authoritative-state concern. Aim is a client-side display; the player charges power locally; only the trigger commit hits the server. Five precedents (Hedgewars, Liero family, Soldat, Torket, Atomic Tanks) converge on this pattern. The genre's lag tolerance comes from this property: aim feels instant because the server doesn't need to know about it until release.

Per-weapon launch offset is a separate concern from aim. The projectile spawns at the muzzle, not the body center, and the muzzle position is per-weapon (a long bazooka extends further than a pistol). This is data, not code: each weapon declares its launch offset relative to the body in body-local coordinates.

Corollary: weapons should differ by configuration, not implementation. Damage radius, impulse scale, fuse, restitution, gravity scale, wind affectation - all data. The implementation handles dispatch by archetype (projectile, hitscan, throwable, tunneler) but the per-weapon variants are config. A single wind-affectation flag turns the same projectile from "feels like a missile" to "feels like a leaf in the wind"; this is a design decision, not a code path.

## 6. The Terrain mutation principle

**Mutation is local, event-driven, and chunked. Material modulates.**

When the world's shape changes, only the affected region changes, and only the dirty chunks of the affected region rebuild. This is not an optimization; it is a correctness requirement once the world is large enough that whole-world rebuilds tank performance, especially on mobile. Five precedents (Hedgewars 32x32 chunks, Phaser quadtree, Cortex Command UpdatedMaterialAreas, Sandspiel, Box2D-Clipper sectors) converge on chunked dirty-tracking.

Mutation is event-driven, not continuous. There is no world-tick that integrates damage over time; events fire, the world updates, the world is stable until the next event. This rules out simulated water flow, falling sand, and similar continuous mutation. The match is short; the world need not pretend it is alive.

Material composition modulates how mutations apply. Stone resists; dirt yields; rock is intermediate. The genre has always done this (Worms Armageddon's `lfIndestructible`, Hedgewars' indestructible-flag, Liero's rock vs dirt) but it is also the cheapest possible feature: a single guard at mutation time consulting an existing data field. We have a `materialMap` that is currently dormant; activating it is a contract decision, not a feature request.

Corollary: damage rings (the visible scorch around an explosion) are a separate flag from solidity. Mutating only the visual flag, not the solidity bit, is a precedent (`lfDamaged`) and a feature: it lets the world *look* hurt without being functionally weakened. This is gameplay subtext (a wall got blackened but didn't break) that becomes possible the moment damage and solidity are separately representable.

## 7. The Damage propagation principle

**Damage is radial, linear, and walls do not block it.**

When a mutation event causes damage, the damage propagates radially with linear falloff from the event center. There is no line-of-sight check by default. Five Worms-genre sources confirm this is the canonical answer: Worms players expect to take chip damage from a near-miss-behind-a-wall, not zero damage. The "wall as cover" emotional beat that LoS would create is the wrong feel for the genre.

Falloff is linear because the genre treats damage radius as both a *reach* (how far the blast extends) and a *cap* (how much damage a direct hit deals). Hedgewars' formula `damage = (base - distance) / 2`, capped at `radius`, encodes both at once: a worm at the center takes the full radius value; a worm at the edge takes near zero; the formula is a single algebraic expression with one tuning knob.

Impulse is mass-aware. Heavy objects (crates, mines, dense decorations) get less knockback per unit damage than light ones (worms, debris). The classic Hedgewars `dmg / density` is the genre default. This is the only place where mass enters gameplay; we use it to give physical objects weight without simulating mass elsewhere.

Corollary: line-of-sight remains available as a per-weapon opt-in for specific weapons that need it (focused beams, sniper rifles). Atomic Tanks' Bresenham pixel-walk is the proven primitive; cost is one pixel-walk per damaged target. Default off, per-weapon on. We do not adopt LoS as a default and we do not engineer for it; we leave the door open at the data layer.

## 8. The Environmental principle

**The world ticks against entities via opt-in flags; bounds are generous and proportional.**

Passive world properties (wind, water, kill floor, fall damage) affect entities each tick. Each property has a per-entity opt-in flag: a property does not apply unless the entity declares it should. Wind affects bazooka shells but not bullets; fall damage applies to worms but not projectiles; water drowns living things but not rubble. The flag is per-entity-type, not global, and configured at the catalog layer.

This rules out blanket physics forces. The genre's Hedgewars confirms this: wind is a per-gear flag, not a world property. The architecture follows: each environmental tick iterates the entity list, checks the flag, applies the property. Skipping unaffected entities is not an optimization; it is the contract.

Bounds are generous. The off-map kill floor is at least N pixels beyond the world edge, scaled to map dimensions, so the player sees the visual feedback of an entity flying off-screen before it is removed. Hedgewars' 250+ pixel overshoot is the genre default. A worm crossing the edge by one pixel and instantly disappearing is a feel bug, not a correctness one.

Fall damage is measured in vertical impact velocity at landing time, not accumulated normal impulse. The velocity-based threshold is shape-independent: a worm landing at the same vertical speed on flat terrain or on a slope takes the same damage. The impulse-based threshold (which we use today) is shape-dependent because slopes deflect normal impulses; the genre default avoids this complication.

Corollary: water is a Y-threshold check, not a fluid simulation. The genre never simulates water flow; rising or falling water is acceptable as a tuning curve, but cells of water moving according to fluid laws is out of genre. Drowning is instant on cross.

## 9. Cross-cutting principles

Five themes recur across the contracts. They are not contracts themselves but they shape how every contract is implemented.

**Server authority over the world.** The world's authoritative state lives on the server; the client renders a projection. Every mutation event is server-decided; the client emits intents (fire, walk) and observes outcomes. This is the genre default for non-lockstep games and the only viable model when latency varies. It also rules out client-side prediction for world state: the world cannot lie to the client even briefly without producing rollback artifacts.

**Mobile-first cost discipline.** Every contract has a feel-vs-performance trade-off. The genre defaults are conservative: chunked dirty-tracking instead of whole-world rebuild, event-driven mutation instead of continuous simulation, opt-in environmental flags instead of blanket forces. These are not optimizations; they are prerequisites for shipping the game on a phone.

**Dormant data is wasted potential.** Where world-gen has produced data (material maps, biome assignments, decoration arrays), gameplay should consult it where the consultation costs nothing. Material hardness, biome-specific environmental flags, and indestructible regions are all "the gen layer told us something; the play layer should listen." The cost is one if-statement per consult; the value is non-trivial gameplay variety.

**Genre wisdom over invention.** When five independent precedents agree on a pattern (auto-step nudge, no-LoS damage, radial linear falloff), the right move is to adopt it and document why. When precedents diverge (1px vs 5px step thresholds; per-frame substepping vs CCD bullet flag), pick whichever fits our stack. Inventing a sixth approach without precedent is rarely the right answer at the contract layer.

**One source of truth per concept.** The world's mask is the world's solidity. The catalog is the source of weapon parameters. The server is the source of state. Duplicating any of these for "convenience" produces drift bugs. Where we currently maintain parallel representations (gen-state vs sim-state, materialMap vs mask), the bible's posture is: explicit consult, not silent duplication.

## 10. What is explicitly out of scope

This bible says nothing about the following, and adding any of them would require revisiting the bible:

- **Cellular automata.** Per-pixel simulation (Noita, Sandspiel, Powder Toy) is the wrong kind of richness for our genre. The world does not need to feel alive in that way; it needs to feel destructible.
- **Falling-sand mechanics, water flow, fire spread.** Continuous mutation is out. If a future game mode demands one, it gets its own bible.
- **MOPixel-style debris physics.** Cortex Command's per-pixel debris is beautiful; our genre cannot afford it. Cosmetic debris (short-lived particles with no physics state) is fine; physically-simulated debris is not.
- **Re-solidification of debris.** Once a pixel is gone, it is gone. Particles do not become terrain.
- **Persistent damage history.** The mask is the damage record. We do not maintain a separate event log that affects later behavior; if a game mode needs that, it gets its own bible.
- **Lockstep determinism.** We are server-authoritative. We do not need bit-exact reproducibility, and so we do not pay its cost.
- **Mid-air control of locomotion.** A jumped worm is ballistic. Items (jetpack, rope) establish their own regimes.
- **NPCs, AI-driven entities, persistent world state across matches.** Excluded by the world-gen and object-interaction philosophies; this bible inherits those exclusions.

These are commitments. Re-introducing any of them would require revisiting the contract or contracts they affect, with explicit justification.

## 11. The contracts in one sentence each

A summary, for the reader who reads the rest of this in any order.

1. **Spawn**: gen enumerates, runtime verifies, both phases required.
2. **Locomotion**: walking is universal step-up; ground is a count, not a flag.
3. **Aim and fire**: fire is an event; the world is read, not negotiated with.
4. **Terrain mutation**: mutation is local, event-driven, chunked; material modulates.
5. **Damage propagation**: damage is radial, linear, no LoS by default.
6. **Environmental**: passive properties tick via opt-in flags; bounds are generous and proportional.

The design doc translates each into a worms-specific implementation contract.
