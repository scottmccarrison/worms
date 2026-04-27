# World Generation Philosophy

This document is the bible. We are rebuilding our procedural world system on top of a stronger conceptual model than the directory of one-off mask drawers we have today. The model we are adopting is the one Re-Logic shipped in Terraria: world generation as a deterministic, ordered pipeline of named passes, each pass an event in a played-forward history of the world.

This doc lays the philosophy down so we can re-derive the system from scratch in any engine, in any language, ten years from now. It contains no code. It is meant to be read in one sitting.

## 1. What world generation actually is

A generated world is not a snapshot. It is a *history*. The seed is a starting condition. The pass list is the laws of physics and biology applied in order. The output is the present moment of a world that has lived through every pass. You should be able to point at any tile in the final world and answer "which pass put this here, and what came before it."

This reframing matters because it tells us what the artifacts of generation actually are. They are not "a heightmap and some caves." They are "the result of caves carved through stone that was first laid down as a substrate, then ore was injected, then water settled, then chests were placed in cavities the previous passes already created." Every late artifact is parasitic on an earlier one. The pipeline is causal.

The Terraria community wiki says the same thing in fewer words: "World Generation is composed of Passes, and Passes are composed of Steps." (https://hackmd.io/@tModLoader/HJUiVKXzu) The hierarchy matters less than the ordering. The ordering is the whole game.

## 2. The Terraria pass list, enumerated

The complete vanilla Terraria pass list, in the order Re-Logic ships it, taken from the tModLoader wiki's Vanilla World Generation Steps page (https://github.com/tModLoader/tModLoader/wiki/Vanilla-World-Generation-Steps):

Reset, Terrain, Dunes, Ocean Sand, Sand Patches, Tunnels, Mount Caves, Dirt Wall Backgrounds, Rocks In Dirt, Dirt In Rocks, Clay, Small Holes, Dirt Layer Caves, Rock Layer Caves, Surface Caves, Wavy Caves, Generate Ice Biome, Grass, Jungle, Mud Caves To Grass, Full Desert, Floating Islands, Mushroom Patches, Marble, Granite, Dirt To Mud, Silt, Shinies, Webs, Underworld, Corruption, Lakes, Dungeon, Slush, Mountain Caves, Beaches, Gems, Gravitating Sand, Create Ocean Caves, Shimmer, Clean Up Dirt, Pyramids, Dirt Rock Wall Runner, Living Trees, Wood Tree Walls, Altars, Wet Jungle, Jungle Temple, Hives, Jungle Chests, Settle Liquids, Remove Water From Sand, Oasis, Shell Piles, Smooth World, Waterfalls, Ice, Wall Variety, Life Crystals, Statues, Buried Chests, Surface Chests, Jungle Chests Placement, Water Chests, Spider Caves, Gem Caves, Moss, Temple, Cave Walls, Jungle Trees, Floating Island Houses, Quick Cleanup, Pots, Hellforge, Spreading Grass, Surface Ore and Stone, Place Fallen Log, Traps, Piles, Spawn Point, Grass Wall, Guide, Sunflowers, Planting Trees, Herbs, Dye Plants, Webs And Honey, Weeds, Glowing Mushrooms and Jungle Plants, Jungle Plants, Vines, Flowers, Mushrooms, Gems In Ice Biome, Random Gems, Moss Grass, Muds Walls In Jungle, Larva, Settle Liquids Again, Cactus Palm Trees & Coral, Tile Cleanup, Lihzahrd Altars, Micro Biomes, Water Plants, Stalac, Remove Broken Traps, Final Cleanup.

That is roughly 107 named passes. Don't memorize them. Look at the shape.

## 3. Categories of pass, derived from the list

Six categories emerge if you read the list with squinted eyes. These are not Re-Logic's labels; they are ours, inferred from the list.

**Substrate.** The earliest passes establish the canvas the rest will paint on. Reset wipes state. Terrain lays the surface heightmap. Dunes, Ocean Sand, and Sand Patches lay the lateral biomes that exist as substrate, not as decoration. Underworld establishes the bottom band of the world. The Terraria layer model itself (Space, Surface, Underground, Cavern, Underworld) is set up here (https://terraria.wiki.gg/wiki/Layers).

**Carving.** Tunnels, Mount Caves, Dirt Layer Caves, Rock Layer Caves, Surface Caves, Wavy Caves, Spider Caves, Gem Caves, Mountain Caves, Create Ocean Caves. These passes *subtract*. They cut into substrate. They cannot run before substrate exists. They are also the source of nearly all the cavities later passes will fill.

**Material differentiation.** Rocks In Dirt, Dirt In Rocks, Clay, Marble, Granite, Dirt To Mud, Silt. These take the homogenous early substrate and inject heterogeneity. Stone is no longer just stone. The world starts to feel geological. This is *before* ore because ore wants something interesting to be embedded in.

**Biome / regional differentiation.** Generate Ice Biome, Jungle, Full Desert, Floating Islands, Mushroom Patches, Mud Caves To Grass, Wet Jungle, Corruption. These take large subregions and apply rule sets that overwrite or transmute the underlying substrate. A biome is not decoration; it is a region under different physical law.

**Dressing.** Shinies (vanilla ore), Webs, Gems, Random Gems, Moss, Cave Walls, Wall Variety, Stalac, Webs And Honey, Vegetation passes. The world is now varied; we sprinkle the things that decorate it.

**Structures.** Pyramids, Living Trees, Altars, Jungle Temple, Hives, Dungeon, Floating Island Houses, Lihzahrd Altars, Buried Chests, Surface Chests, Water Chests, Hellforge, Statues, Life Crystals. Discrete, mostly multi-tile features that occupy a bounded rectangle. They cannot be drawn earlier because they need empty space (cavities), they need the right substrate, and they cannot have ore-runner code spraying through them after they are placed.

**Civilization and finishing.** Spawn Point, Guide, Settle Liquids, Settle Liquids Again, Tile Cleanup, Quick Cleanup, Final Cleanup, Remove Broken Traps, Smooth World, Waterfalls. These passes either give the world a player (the Guide NPC, the spawn point) or sweep up after everything else. They run last because they read the entire prior world state.

The categories are ordered like a stratigraphy. Substrate at the bottom, structures and life at the top. The pass list is the playthrough of that stratigraphy in fast-forward.

## 4. Why the order is what it is

Read the list as a causal graph and the order stops looking arbitrary.

Dunes runs before Ocean Sand because the desert is a band of substrate; ocean sand needs to know where the desert ends. Tunnels runs before the layered cave passes because tunnels are the long-distance veins; the layered passes carve the local pockets that connect to them. Shinies (ore) runs before Dungeon and before Buried Chests because ore is a "spray" operation that uses a tile-runner with override behavior; if it ran after a chest was placed, it would mangle the multi-tile chest. The tModLoader docs are explicit: "TileRunner is NOT SAFE to use when multitiles are in the world with the override parameter as true, as it will corrupt them" (https://github.com/tModLoader/tModLoader/wiki/World-Generation). The latest pass that safely uses spray semantics is Gems. After Gems, every operation must respect existing structures.

Settle Liquids runs after the lakes, the dungeon, and the major carving passes because liquids flow and we only want to compute that flow once everything that could redirect water is in place. Then Settle Liquids Again runs near the end because later passes (vegetation, structures) sometimes punch new holes, and we want a final, stable hydrology.

Final Cleanup is last because it is the only pass licensed to read the entire world and patch any inconsistency. By that point, every other pass has had its turn.

If you reorder the list, things break in mechanical ways: you get chests with ore growing through them, water that hangs in mid-air over a cave that was carved later, vegetation rooted in tiles that were converted to mud after the plants were placed. The pass list is not an arbitrary sequence. It is a topological sort of a dependency graph, hand-tuned by Re-Logic over a decade of ship-and-fix.

## 5. The shared world state

During generation, the world is one mutable structure. In Terraria's case it is a 2D tile array plus a small set of side tables (the StructureMap, the random number generator, the world configuration). Every pass reads and writes the same array.

This is a hard contract. Passes communicate only through the world. There is no message bus, no event system, no per-pass return value the next pass consumes. If pass N wants pass N+5 to behave differently, the only way is to leave a mark on the world that pass N+5 will notice. That mark might be "this region is now the Jungle biome" expressed as a particular tile type, or it might be "this rectangle is occupied by the Dungeon" expressed as an entry in the StructureMap.

The StructureMap deserves a special call-out. It is the one piece of metadata Re-Logic exposed to coordinate non-overlapping placement. Before placing a structure, a pass can ask "is this rectangle free?" and if yes, occupy it. The tModLoader documentation describes it as "cooperative" (https://github.com/tModLoader/tModLoader/wiki/World-Generation): nothing forces a pass to consult it, but if a pass doesn't, it risks colliding with previously placed structures. The cooperative model is fragile but it works because the pass list itself is curated. New passes added to the curated list are required to play nicely.

The conceptual takeaway is that the world during generation is a single shared mutable canvas, and every pass is both a reader and a writer of that canvas. There is no version control. There is no rollback. If a pass writes the wrong thing, every later pass sees the wrong thing.

## 6. Conditional vs unconditional passes

Most Terraria passes always run. A few are conditional in interesting ways. The "Corruption" pass exists in two flavors (Crimson is a Corruption variant) and only one runs per world. Special seeds like "Drunk World" enable both. The "For the Worthy", "Not the Bees", and "Zenith" seeds change which passes run and how they parameterize themselves (https://terraria.wiki.gg/wiki/World_Seed). Floating Island Houses only runs if Floating Islands ran. Jungle Chests Placement only runs if Jungle Chests located cavities to fill.

Re-Logic does not express conditionality with a pass-skipping graph. It expresses it with substrate. If pass N never wrote anything, then pass N+5 looks at the world, finds nothing to act on, and quietly does nothing. The conditional dependency graph is implicit in the world state. This is elegant and it is also the source of subtle bugs: a pass that "should have skipped" because its substrate is missing can still misbehave if it doesn't check carefully. Pass authors are responsible for asking the world what state it is in.

## 7. Determinism and seeding

The contract is "the same seed always produces the same world." Operationally this requires three things.

One: a single world-generation random number generator, seeded once at the start, used by every pass. Terraria calls this `WorldGen.genRand`. Every random decision in every pass goes through it. The tModLoader guide is emphatic: "It is important that you use WorldGen.genRand for all random decisions, as it facilitates the world seed feature" (https://github.com/tModLoader/tModLoader/wiki/World-Generation). If a pass uses a different RNG, even one seeded from genRand, you get a world that is reproducible only if all the other RNGs are also reproducible, and the cone of fragility expands.

Two: a fixed pass order. If pass order changes between runs, the consumption order of the RNG changes, and the same seed produces different output. This is why mod authors are warned never to insert passes by hard-coded index (https://github.com/tModLoader/tModLoader/wiki/World-Generation): if any other mod inserts a pass before yours, your hard-coded index points at the wrong slot, and the entire world downstream diverges.

Three: no input from outside the seed. No wall-clock time, no system entropy, no per-machine integer width. Terraria 1.4.0.1 explicitly fixed "an issue where different operating systems would see slightly different world seed results" (https://terraria.wiki.gg/wiki/World_Seed). The seed must be the *only* input. Any other input is a leak.

Determinism is brittle. It is also free if you are disciplined. The discipline is: one RNG, fixed order, no external inputs.

## 8. Validation, soft-locks, playability

Terraria does not run a Spelunky-style solution-path validator. There is no "can the player reach the end" check. What it has instead is a tail of cleanup passes that enforce local invariants: Tile Cleanup, Quick Cleanup, Smooth World, Remove Broken Traps, Final Cleanup. These passes scan the world and fix tiles that are in inconsistent states (a half-placed multi-tile, a trap with a missing trigger, a wall pattern that doesn't match its neighbors). They are conservative janitors, not gameplay verifiers.

The deeper point is that Terraria's notion of "playable" is structural rather than goal-oriented. The world is playable if its tiles are coherent. The player is presumed to be capable of digging, climbing, and exploring; the generator does not need to guarantee a path. This is a luxury we share, because a worms world is similarly forgiving: if it has terrain and spawn points and weapons, it is playable.

What Terraria *does* guard against is corruption-of-state: ore through chests, water hanging in air, multi-tile structures cut in half. The cleanup tail exists for that.

## 9. What is Terraria-specific vs universal

Terraria-specific: the tile grid, the layer system (Space/Surface/Underground/Cavern/Underworld), the specific category list (no biomes for us, probably no dungeons), the specific structures, the multi-tile concept itself.

Universal and worth keeping: the named pass model. Deterministic single-RNG seeding. The shared mutable world state during generation. The cooperative structure registry. The convention that destructive spray operations come before placement of fragile features. The validation tail. The explicit topological ordering documented as "this comes before that, and here is why."

For a 2D destructible-mask physics game, the substrate is not tiles, it is a rasterized mask plus whatever metadata we layer on top (spawn zones, weapon caches, surface normals, biome tints). The pass model still applies. Substrate passes lay the mask. Carving passes erase from it. Decoration passes write biome metadata or spawn-zone hints. Structural passes register exclusion rectangles in the worms equivalent of a StructureMap. Validation passes ensure no spawn point is buried under a wall and no weapon cache is in the void.

## 10. Open questions for translation

These are the conversations Scott and I need to have before any types or code exist.

What are worms's analogous phases? Do we have a "substrate" pass that produces the gross silhouette of an island? Do we have "carving" for the worm-traversable tunnels and overhangs? Do we have "dressing" for visual flavor that does not affect physics? The category list above is a hypothesis; we should pressure-test it against actual worms map-making instincts.

Is mid-match destruction a constraint that changes our pass model? Terraria assumes the world is generated once and then mutated by the player. We mutate the world every time a bazooka hits. Does our pass system need to be re-runnable on a sub-region after destruction? Or is destruction a separate concern entirely, operating on the post-gen artifact?

Do we want biomes at our scale? A worms map is small (one screen-ish). Terraria's biome system exists because the map is huge. We might want "themes" instead of biomes, applied per-map rather than per-region.

How does multiplayer determinism interact with seeded gen? If the server generates and broadcasts the world, do clients need the RNG at all? If clients re-run gen from the seed, what is the bandwidth-vs-CPU tradeoff? What happens if a client and server disagree on the post-gen world by one pixel?

What is our equivalent of the StructureMap? A list of reserved rectangles? A signed distance field of "do not place here"? Both? Where does it live, who owns it, and what is its lifetime relative to the match?

What does the validation tail look like for us? Spawn-point reachability? Weapon-cache visibility? Mask connectivity (no orphaned floating islands of pixels)? We should enumerate the "broken world" failure modes we care about before we write the validators.

Does the pass system extend into match time, or does it stop at match start? Terraria stops, then opens a hardmode tasks list. We may want a "during-match passes" concept for spawning weapon crates, dropping airdrops, mutating terrain on a timer. Those would share the same conceptual machinery: ordered, deterministic, reading shared state.

We answer these next. The point of this doc is that we now have a vocabulary to answer them in.

---

## Sibling concern: object-world interaction

This document covers world generation only - the substrate that exists at t=0. How dynamic entities (worms, projectiles, weapons) interact with that substrate at runtime is a distinct concern with a different lineage of references (Worms-the-game, Cortex Command, Noita), and is documented separately. Deferred until the gen philosophy is settled and translated. Tracked in worms#161.

---

## Sources

- tModLoader Vanilla World Generation Steps (the canonical pass list): https://github.com/tModLoader/tModLoader/wiki/Vanilla-World-Generation-Steps
- tModLoader World Generation guide (StructureMap, GenShape/GenAction, multitile safety): https://github.com/tModLoader/tModLoader/wiki/World-Generation
- tModLoader "What is World Generation": https://hackmd.io/@tModLoader/HJUiVKXzu
- GenPass class reference: https://docs.tmodloader.net/docs/1.4-stable/class_terraria_1_1_world_building_1_1_gen_pass.html
- Terraria Wiki, World Generation: https://terraria.wiki.gg/wiki/World_generation
- Terraria Wiki, Layers: https://terraria.wiki.gg/wiki/Layers
- Terraria Wiki, World Seed (determinism, special seeds, OS-level seed bugs): https://terraria.wiki.gg/wiki/World_Seed
- tModLoader issue 2260 (modernization commentary on the GenPass model): https://github.com/tModLoader/tModLoader/issues/2260
- Minecraft Wiki, World generation (corroborating evidence on pipeline-based gen): https://minecraft.wiki/w/World_generation
