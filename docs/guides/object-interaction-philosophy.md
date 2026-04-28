# Object Interaction Philosophy

This document is the bible for object interaction in our procedurally generated world. Like `world-gen-philosophy.md`, it is intentionally game-agnostic in shape: an arena game with destructible terrain in any engine, in any language, ten years from now, should be able to re-derive the model from this doc.

It contains no code. It is meant to be read in one sitting alongside the world-gen bible.

## 1. What an object actually is

For our purposes, an "object" is anything in the world that is not terrain and not a player. It is the chest in the corner of a cave, the weapon crate that drops from the sky mid-match, the mine a player deploys, the projectile in flight. It is also the patch of glowing moss painted on a cave wall, though, as we will argue, that one is barely an object at all.

The framing question is: what is the relationship between objects, the procedurally generated world, and the players moving through it? Three tightly coupled sub-questions follow.

1. Where do objects come from? Generated, spawned, dropped?
2. How do players interact with them? Walk into, click on, press a button near?
3. Where does the truth about an object live? Server, client, neither, both?

These three answers together define our object philosophy. They cannot be answered piecewise.

## 2. The Terraria model, enumerated

Terraria is the precedent we rebuilt our world generation on, so it is the obvious place to start for objects too. Terraria's object model has three layers.

**Tiles.** Almost everything in Terraria is a tile. The 2D grid stores not just terrain (dirt, stone) but also doors, chests, signs, torches, vines, statues, gravestones. Over 600 tile types in vanilla. Each tile has a `frame` value derived from the eight neighboring tiles, which is what produces Terraria's coherent autotiled visual style (https://terraria.wiki.gg/wiki/Tile).

**Tile entities.** A small subset of tiles need extra state that does not fit in the tile's two-byte type field. Logic gates, food platters, item frames, weapon racks, training dummies. Terraria stores these in a sparse hash map keyed by tile coordinates. The vast majority of tile types do not have tile entities; the pattern exists for the few that do.

**Free-floating entities.** Items, NPCs, and projectiles live outside the tile grid in flat arrays. Each has full physics, position, velocity, AI state. Items despawn after a timer; NPCs respawn from spawning rules; projectiles disappear on impact or fuse expiry.

The interaction model is uniform across all three layers: **proximity plus intent**. The player has an interaction range; tiles within range that respond to interaction become highlighted; pressing the interact key fires the response. Items use a slightly different model: walk into them, get magnet-pulled if close enough.

Server is authoritative. Only changes sync over the network. Tile changes broadcast as small packets describing which tile changed and to what.

## 3. Why we cannot port Terraria's architecture wholesale

Three constraints rule out direct adoption.

**Our terrain is not a tile grid.** It is a continuous material mask with planck physics. There is no cell to attach a tile entity to. Inventing a tile grid solely to host the tile-entity pattern would be tail wagging dog: we would be transcribing one architecture's ergonomics onto an incompatible substrate.

**We are an arena, not a sandbox.** Terraria matches are forever; ours are five to fifteen minutes. Terraria's "everything is a tile, half of which has extra state" is a richness budget we cannot afford and do not need. We need a small catalog of objects each of which earns its server-state cost.

**Our server runtime is constrained.** Terraria runs on a heavyweight game server. We run on a constrained multiplayer framework with binary delta sync. Per-object state has a bandwidth and memory cost that grows with object count, so we must be sparing.

We are not Terraria. We need a different model that learns from theirs without copying it.

## 4. The Worms-genre model

Our actual genre, Worms Armageddon, Hedgewars, Liero, has a much smaller object surface. None have NPCs. None have inventories. None have persistence. Crates fall from the sky during play. Mines are deployed by players. Projectiles come from weapons. That is essentially the entire object catalog.

The genre's interaction model is implicit:

- Touch a crate: get the contents.
- Touch a mine: it explodes.
- A projectile hits something: it explodes.

There is no "press button to interact." Walking-into is the only verb. The proximity is implicit in the collision.

This is not a poverty of imagination; it is a deliberate match to genre. Worms-style games are about destruction and tactical positioning, not exploration. The world is a stage on which the match plays out. Objects exist to enable interaction with the stage, not to populate a simulated society.

## 5. The Source engine taxonomy

A second precedent worth naming. Valve's Source engine (Half-Life 2, Counter-Strike, Team Fortress 2) ships the canonical "physics arena with interactive objects" architecture. Their split:

- **`worldspawn`**: the level geometry. BSP brushes. Static, per-match, never changes after compile time.
- **Entities**: discrete game objects with logic and state. Doors, buttons, triggers, NPCs, weapons. Networked.
- **`prop_static`**: visual-only meshes baked into the level lighting. No physics, no interaction. Pure decoration.
- **`prop_dynamic`**: physics-enabled props. Bookshelves, barrels. Have bodies, can be moved or broken, but minimal game logic.

The split is not arbitrary. It matches the lifecycle and authority of each thing: world is fixed, entities are stateful, decoration is render-only, dynamic props are interactive set dressing.

This translates almost directly to a 2D arena game with destructible terrain. Our terrain is the dynamic equivalent of `worldspawn`. Our objects are the entity layer. Our paint-only decorations (cave glow, surface tufts) are `prop_static`. Our breakable barrels and physics-y crates are `prop_dynamic`.

Source did not invent these categories; Quake had something similar before it; Doom's WAD format too. But Source ships the cleanest, most-documented version of the pattern, and is the right modern reference.

## 6. The five principles, derived

Read the three precedents, Terraria, Worms genre, Source, with squinted eyes. Five principles emerge that survive all three frames.

**Principle 1: the world is a stage, not a simulation.** The Worms genre is unanimous on this. The world generates to be tactically and visually interesting for a short match. Objects enable interaction or impress visually. They do not populate a living world. Persistence, NPCs, progression, all out. This principle shapes every other.

**Principle 2: three-tier taxonomy by authority and lifecycle.** Source's split, translated:

- *World-fixed*: placed at world generation time, server-owned, persists for the match. Chests, weapon crates, breakable set-pieces.
- *Match-spawned*: created during play, server-owned, transient. Projectiles, drops, deployed mines.
- *Client-only paint*: no state, no physics, render-only. Cave ambient, surface dressing.

The split is by *authority and lifecycle*, not by visual category. A "barrel" might be world-fixed (placed by gen) or match-spawned (dropped from a crate), and the architecture treats those differently even though they look identical. The category is what the engine does with it, not what the player sees.

**Principle 3: proximity sensor as the universal interaction primitive.** Box2D's sensor fixture is the right tool. Every interactive object exposes a sensor; entering the sensor fires an event; the object's data-driven config decides what happens. Pickups fire on enter. Mines fire on enter. Chests fire on enter and show a prompt. Doors fire on enter and check intent. One mechanism, many behaviors.

This is the Worms-genre model (touch-to-collect) plus the Terraria model (proximity plus optional intent), unified.

**Principle 4: sparse server state, event-driven sync.** Only objects with mutable state hit the network at all. World-fixed objects sync once at match start. Decorations never sync. State changes (chest opened, barrel broken, mine triggered) sync as deltas, not as full reads. Transient objects (projectiles) sync at spawn and despawn, with positions updated at the simulation tick rate.

This is Quake's edicts pattern, modernized. It is also the only viable approach given our networking framework's costs.

**Principle 5: data-driven prop catalog.** New object types are configuration, not code. Each prop type declares its sprite, hitbox, sensor radius, behavior on interact, behavior on destroy. World gen and match-time spawning both consume the same catalog. Adding a new prop is a JSON entry plus possibly a sprite. Code changes only when a fundamentally new behavior class is needed.

This matches our existing convention for weapons, maps, characters. It is also Source's `.fgd` pattern in a smaller, JSON-flavored form.

## 7. The principle we considered and rejected

We considered a sixth principle: **anchor + support requirement**. Each world-fixed object would declare what terrain must exist beneath or around it, and the object would react when destruction breaks support: fall, break, despawn.

We rejected it. The Worms-genre precedents (Hedgewars, Worms Armageddon) and the Colyseus reference games all use a simpler model: the object has a physics body, the body settles on terrain via gravity, the body falls when terrain underneath disappears. The "support requirement" formalism added complexity with no observable benefit over what physics already provides.

The principle was a synthesized invention without precedent. The simpler model wins.

## 8. What is explicitly out of scope

Just as the world-gen bible says nothing about post-gen behavior, this bible says nothing about:

- **NPCs.** Non-player characters with AI, dialogue, faction affiliation. Out. The Worms genre does not have them, our game does not need them, and they imply pathfinding, persistence, and behavior trees that have no place in an arena.
- **Inventory.** Players holding objects in a bag, swapping, dropping. Out. Worms-style games handle pickups as instant effects (heal, ammo, weapon swap), not bag additions. We follow.
- **Persistence beyond the match.** No object lives across matches. No world saves. No carry-over. The match is the unit of state.
- **Player-driven object placement** beyond what weapons already do (mines, deployable gadgets). No "build mode," no "decoration tools."
- **Multi-client physics determinism.** We are server-authoritative. We do not need lockstep determinism, and so we do not pay its cost.

These exclusions are not gaps to be filled later. They are commitments to the philosophy. Reintroducing them would require revisiting the bible.
