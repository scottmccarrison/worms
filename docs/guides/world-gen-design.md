# World Generation Design

This document is the worms-specific translation of `world-gen-philosophy.md`. Read it side by side with the bible. The bible describes what Terraria does and why. This doc describes what we believe and what we will build, derived from the bible but adapted for our domain.

Sections are keyed one-to-one with the bible's sections. We work through them in order, building consensus per section, before any technical implementation begins.

---

## 1. World as history

**Consensus:** we accept the bible's framing wholesale. A generated world is a history played forward, not a snapshot. The seed is a starting condition. The pass list is the rules. The output is the present moment of a world that has lived through every pass. Every artifact has a cause in an earlier pass; nothing is magic.

**Scope clarification.** This concern ends at t=0. What is done with the generated world - terraforming via weapons, mid-match terrain mutation, player-driven changes - is explicitly out of scope here. That belongs to the object-world interaction philosophy, deferred to worms#161. The bible never talks about post-gen behavior because post-gen behavior is a different bible. We hold that line.

**The mental model we are committing to: "isolated but highly dependent."** Each pass is single-responsibility. It owns one rule about one thing and does not call other passes. But every pass after the first reads what previous passes wrote into shared world state. A weird world is the result of one wonky pass corrupting the substrate that subsequent passes built on. Both properties must hold simultaneously - isolation alone gives you incoherent worlds, dependency alone gives you tangled spaghetti. The discipline is to enforce both.

**Provisional on technical feasibility.** If implementation reveals some aspect of this framing is too heavy for our performance budget (mobile-web 60fps, ~400KB bundle) or impossible on our stack (Phaser + planck + Colyseus), we revisit. Until then this is the foundation.

---

## 2. Shape: a flat ordered named list

**Consensus:** the world-gen pipeline is a flat ordered list of named passes. Not a tree, not a graph, not a declarative rule config. Same shape Terraria ships, for the same reasons:

- Easy logic for coding. A pipeline is a `for` loop over an array.
- Easy logic for debugging. You read top to bottom and know exactly what happens, in what order.
- Clear path. The order itself is the design surface; nothing is hidden in nested structure.

**Length is honest, not target.** Terraria's ~107 passes is honest for Terraria's scope. Ours will likely be shorter (one-screen-ish maps, fewer biomes, no civilization layer) - probably in the 15-30 range to start. We do not artificially compress passes to hit a low number, and we do not pad to hit a high one. If a job deserves its own pass, it gets its own pass.

**Naming discipline.** Each pass name answers "what does this pass do" in a few words. Vague names ("GenerateStuff", "DoTerrainPhase") are a smell that should trigger splitting the pass into named sub-passes. Terraria's "Mount Caves" / "Spreading Grass" / "Final Cleanup" set the bar.

**Additive growth model.** When we want to expand the world - add a new biome, a new feature, a new theme - we add another pass to the flat list. We do not refactor the architecture, we do not introduce nesting, we do not touch other passes. The pipeline is open to extension by appending. This is the long-term win of flat-list shape over any hierarchical alternative.

> **Note for technical implementation.** When this is built, the codebase must include clear, discoverable instructions for how to add a new pass: where the file lives, what the contract is, where it gets registered, how to test it in isolation. The additive growth model only pays off if adding a pass is genuinely easy. A `docs/guides/adding-a-pass.md` (paralleling the existing `adding-a-weapon.md`, `adding-a-map.md`) is the right shape.

---

## 3. Categories of pass

**Consensus: categories are a teaching tool, not an architectural feature.** They are how humans group adjacent passes when explaining or designing. They are not enforced in code. The actual data structure is the flat list from Section 2; categories live in documentation and in our heads. This matches Terraria's approach exactly.

**Categories adopted for v1:**

- **Substrate.** Establish the canvas. The terrain mask, the sky/ground silhouette, the gross shape of the world.
- **Carving.** Subtract from substrate. Tunnels, caves, overhangs.
- **Material differentiation.** Inject heterogeneity into the substrate. For us this is horizontal bands (dirt / rock / sand layers feeding the existing stratum painter), not Terraria's interleaved "Rocks In Dirt + Dirt In Rocks" pattern. Smaller scale, same idea.
- **Theme.** Per-map flavor (snow map, jungle map, canyon map). One theme per generated world. This replaces Terraria's per-region biome category for v1.
- **Dressing.** Decorate without affecting physics. Surface details, ambient flora, parallax hints, color variation.
- **Spawn-point distribution.** Late-stage passes that read the settled world and place worm spawns where they will be safe and reachable. Gameplay-critical, must run after every other gen pass has settled.
- **Validation / cleanup.** Final passes that enforce structural invariants. No orphaned floating mask islands, no spawn buried under a wall, no weapon cache in the void.

**Categories dropped from Terraria:**

- **Civilization.** No NPCs, no quest-bearing chests, no dungeons. Spawn-point placement (above) is the one civilization-flavored thing that survives, and it gets its own category because of how late it has to run.
- **Hydrology.** Our water is a runtime concern - global rising waterline (sudden death), projectile-borne water effects. Not a gen-time concern.
- **Structures (Terraria-style).** No multi-tile bounded rectangles like dungeons or floating-island houses in v1.

**Deferred to future enhancements (added later via append, per Section 2 growth model):**

- **Biomes.** Per-region differentiation inside a single map. Out of scope until our maps grow large enough that "the whole map is one theme" stops feeling rich enough.
- **Structural drops.** Spelunky-style template carves (bunkers, fortifications, ruined buildings). Out for v1; can be added as a category later when we want recognizable geometry inside procgen terrain.

---

## 4. Why the order is what it is

**Consensus: order encodes a hand-tuned causal graph.** The pass list is not arbitrary; each pass's prerequisites live as substrate that earlier passes wrote. We do not compute a topological sort from declared dependencies. We hand-order passes, find bugs, reorder, and arrive at a sequence that works. The order itself is institutional knowledge captured in the list.

**No spray/place cutoff for us.** Terraria designates an explicit boundary ("after Gems, every operation must respect existing structures") because they have ore-runners that corrupt multi-tile structures. We do not have ore-runners or multi-tile structures. World-gen is one piece of what we are building and we are not going to import discipline that does not protect against problems we have. If we ever add structural drops (deferred), we revisit.

**Late-pass-invalidates-earlier-pass is a pattern to watch for.** Terraria runs Settle Liquids twice because late passes punch holes that re-trigger flow. We do not have flowing liquids in gen, but the underlying pattern - "if a late pass invalidates an earlier pass's output, the earlier pass may need to re-run" - could still apply (example: dressing punches through the mask in a way that breaks a connectivity check earlier passes assumed). We do not pre-design for this; we let it emerge during implementation if it does.

**Final Cleanup is mandatory and runs last.** It is the only pass licensed to read the entire world and patch inconsistencies. Specifics of what it checks are deferred to Section 8 (validation).

---

## 5. The shared world state

**Consensus: a single shared mutable structure during gen, and passes communicate only through it.** Whatever data the pipeline needs to read or write lives in one place. Passes get to it through that structure; they do not call each other, raise events, or return values to a coordinator. If pass N wants to influence pass N+5, the only mechanism is to leave a mark on the world that pass N+5 will notice. This discipline keeps the pipeline simple and matches our world's scope.

**No version control, no rollback.** If a pass writes the wrong thing, every later pass sees the wrong thing. The implication is that pass-authoring discipline matters - a pass should be small enough to reason about and test in isolation, because once it runs, its output is the truth.

**Cooperative coordination registry deferred.** Terraria's StructureMap exists to prevent multi-tile structures from overlapping. We have no multi-tile structures in v1, so we have no placement-collision problem to solve. When structural drops are added (deferred per Section 3), we introduce the registry then.

**No premature shape commitment.** We are not enumerating the fields of the v1 world state in this doc. The exact fields fall out of which passes we write. The conceptual contract is: one shared structure, accessed only via that structure, no out-of-band communication.

---

## 6. Conditional vs unconditional passes

**Consensus: every pass always runs; conditionality is internal to the pass.** There is no orchestrator-level pass-skipping. The pipeline is uniform - the same flat list executes for every seed. A pass whose substrate is missing does nothing on its own; the "is my substrate present?" check is the pass's responsibility.

**Risk acceptance.** This pattern is elegant *and* brittle, and we are choosing to accept that tradeoff. Elegant because there is no conditional logic in the orchestrator, no graph of declared dependencies, no skip-registration mechanism. Brittle because pass authors must implement the substrate check correctly, and a pass that misbehaves on missing substrate can quietly mangle the world. The alternative (a graph-based skip system) would be more code and less debuggable, and inconsistent with the flat-list shape from Section 2. We accept the brittleness because the elegance pays back every time we add a new pass.

**Theme-variant passes follow this pattern.** The canonical worms example: a "place snow piles" pass and a "place jungle vines" pass both exist in the flat list, and both run on every world. Each one reads the theme metadata an earlier pass wrote, and if the theme does not match, it does nothing. We get themed worlds without ever introducing a pass-skipping mechanism.

**Most v1 passes are unconditional.** Substrate, carving, validation always have work to do. Conditional passes are the theme-variant decoration and dressing slots. Conditionality is invisible from outside the pass.

---

## 7. Determinism and seeding

**Consensus: the same seed produces the same world. Always. Operationally this is three rules:**

1. **One RNG, seeded once, used by every pass.** We already have `xorshift` and it is platform-independent. Every random decision in every pass goes through it. No second RNG, no Math.random, no system entropy.
2. **Fixed pass order.** Reordering changes RNG consumption order and the world downstream diverges. The flat list from Section 2 is the order. Adding a pass means appending; mid-list inserts are a determinism event.
3. **No input from outside the seed.** No wall-clock time, no Date.now, no platform-specific math, no iteration order over an unsorted collection. The seed is the only input.

**Multiplayer is not a special case at the philosophy level.** World generation is singular: a seed maps to a world. Whether the server runs the pipeline and broadcasts the artifact, or the server broadcasts the seed and every client re-runs the pipeline locally, is a transport decision that does not change the philosophy. If the three rules hold, the output is identical regardless of who computed it. The transport choice is an implementation concern (bandwidth vs CPU, trust model) and is deferred.

**Seeds are a product surface, not just an internal mechanism.** Players should be able to see the seed of a generated world and input one in the lobby when readying up. "Save a good seed, share it with your friend, play that exact world next time" is a feature worth shipping. Terraria does this and it is one of the things people love about the game. The philosophy of one-seed-one-world is what makes that feature trivial: if determinism holds, the seed is a complete description of the world.

---

## 8. Validation, soft-locks, playability

**Consensus: structural playability is the standard. Not goal-oriented playability.** A world is playable if it has terrain, spawn points, and the metadata gameplay needs - not if a path can be proved between any two points. Worms players have jetpack, drill, rope, jumping, walking, and weapons; between those tools, traversal is a player problem, not a generator problem. We do not run a Spelunky-style traversal validator and we do not check "can a worm physically reach this other worm." Same call Terraria made for the same reason.

**The cleanup tail enforces local invariants.** Final passes scan the settled world and patch inconsistencies. The categories of invariant we will care about (exact checks emerge from implementation):

- **Spawn coherence.** Every spawn point has open air above and solid ground below. No spawn buried under a late-placed wall, no spawn floating in void.
- **Mask hygiene.** No orphaned 1-pixel (or sub-threshold) mask islands. The threshold for "too small to physically matter" is implementation-tunable.
- **Material coherence.** Every solid pixel has a material assigned. No pixels of solid-but-unspecified.
- **Per-theme invariants.** Each theme can declare what it requires of the final world. Examples: a canyon-theme map needs its central gap intact (the bottomless void is gameplay-load-bearing, not a defect to fix). The cleanup tail respects per-theme constraints, which means the tail is theme-aware.

**Important non-invariant: "world is fully bounded by solid."** This is NOT universal. The canyon theme intentionally has a no-floor void, and worms that fall in are killed by the off-map system. The cleanup tail must not "fix" this. Per-theme invariants override global expectations.

**Cleanup is conservative janitorial, not gameplay verification.** It fixes states that are wrong, not states that are sub-optimal. A world with one boring spawn placement is not broken; a world with a spawn point inside a rock is broken.

---

## 9. What is Terraria-specific vs universal

This section is mostly a recap of decisions already made in Sections 1-8. Capturing it explicitly so future readers see the line clearly.

**Universal, adopted:**

- The named pass model (Section 2).
- Deterministic single-RNG seeding (Section 7).
- Shared mutable world state during generation (Section 5).
- Conditionality via substrate, not via pass-skipping (Section 6).
- Hand-tuned topological ordering, documented as "this before that and here is why" (Section 4).
- Structural-playability validation tail (Section 8).

**Terraria-specific, rejected:**

- The tile grid. Our substrate is a pixel mask plus metadata (heightmap, material map, theme, spawn candidates). The pass model still applies; the data shape is different.
- The five-layer system (Space / Surface / Underground / Cavern / Underworld). Our maps are one-screen-ish; we don't have layers, we have a single substrate band.
- The civilization category (NPCs, quest chests, dungeons).
- The hydrology category. Water is a runtime concern.
- The StructureMap, for now. Deferred until we add structural drops.

**Adapted, not adopted wholesale:**

- Categories: theme (per-map) instead of biome (per-region); simpler material differentiation (horizontal bands, not interleaved spray); spawn-point distribution promoted to its own category because it has to run after everything else has settled.
- No spray-before-place cutoff. We have no ore-runners or multi-tile structures, so the cutoff Terraria designates at "Gems" has no analog for us.

**The substrate model in concrete form.** For a 2D destructible-mask physics game, the substrate is a rasterized mask plus metadata layered on top: heightmap, material assignments, theme tag, spawn-point candidates, exclusion zones (when we have them). Substrate passes lay the mask. Carving passes erase from it. Material passes paint stratum. Theme passes write theme metadata. Decoration passes read theme and place ambient features. Spawn passes read the settled world and place spawns where they will be safe. Validation passes scan and patch. The abstract pipeline maps onto this concrete substrate cleanly.

---

## 10. Status of the bible's open questions

The bible enumerated seven open questions for translation. Walking through Sections 1-9 resolved or deferred six of them.

**Resolved or deferred:**

- *Is mid-match destruction a constraint that changes our pass model?* Sibling concern. Out of scope for gen. Tracked in worms#161.
- *Do we want biomes at our scale?* No for v1. Theme (per-map) instead; biomes as future enhancement. (Section 3)
- *How does multiplayer determinism interact with seeded gen?* Not a philosophy-level issue. Determinism is determinism; transport is implementation. (Section 7)
- *What is our equivalent of the StructureMap?* Deferred until we add structural drops. (Section 5)
- *What does the validation tail look like for us?* Structural-playability, conservative janitorial, named invariant categories. (Section 8)
- *Does the pass system extend into match time?* Sibling concern. Out of scope for gen. Tracked in worms#161.

**Genuinely still open after this doc:**

- *What are worms's analogous phases?* We have categories (Section 3); we do not have a specific pass list. This is the next conversation - the bridge from philosophy to specification. The output is a draft v1 pass list, ordered, named, and slotted into the categories above.

When that draft is written, this section gets updated to point at it.

---

## Done

This document captures consensus on world-gen philosophy as of the conversation that produced it. The bible at `world-gen-philosophy.md` remains the unmodified extraction of Terraria's model. This doc is what we believe and what we are building. They are read together.

Next: draft the v1 pass list. Then we move technical.
