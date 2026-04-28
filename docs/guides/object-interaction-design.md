# Object Interaction Design

This document is the worms-specific translation of `object-interaction-philosophy.md`. Read it side by side with the bible. The bible derives the principles; this doc translates them to our stack and our game.

Sections 1-8 are keyed one-to-one with the bible's sections. Sections 9+ are worms-specific elaboration: code anchors, schema sketch, open tradeoffs, hosting blocker, next steps.

---

## 1. World as stage

**Consensus:** we accept the bible's framing wholesale. Our world generates to be tactically and visually interesting for a 5-15 minute match. Objects enable interaction or impress visually. They do not populate a living world. There is no progression, no exploration, no persistence beyond the match.

This commitment is the same shape as the world-gen design's "world as history" - both deliberately bound the scope of what world systems are responsible for, freeing every other system to work within that scope.

**Provisional on technical feasibility.** If our framework's costs are higher than expected, we trim the per-object state count before we trim the principle.

---

## 2. The Terraria layers, our response

The bible names three Terraria layers: tiles, tile entities, free-floating entities. Our response to each:

- **Tiles, tile entities:** rejected wholesale. Our terrain is a continuous material mask, not a grid. There is no cell to host a tile entity. The pattern does not translate to our substrate.
- **Free-floating entities:** accepted, generalized, and split. We adopt the "objects live in arrays separate from the world" model. We split that bucket along authority/lifecycle lines (principle 2 of the bible) into world-fixed, match-spawned, and client-paint.

The Terraria autotiling concept survives in spirit, not in form: where dirt meets air we draw grass; where stone meets cave-air we paint moss. This is already what `surfaceDressing` and `caveAmbient` do. We will not invent an autotiler; the existing dressing passes are the worms equivalent.

---

## 3. Why we did not port Terraria's architecture

Restating the bible's three constraints in worms-specific terms:

1. **Our terrain is a continuous mask.** No grid, no cells, no tile-entity hosting site.
2. **Our matches are short.** We do not need 600 prop types. We need a tight catalog where each prop earns its cost.
3. **Our server is constrained.** Phaser client runs in browsers. Our server runtime is limited (see section 11). Per-object state has a real cost.

These are not abstract concerns. Each has bitten us already in adjacent decisions.

---

## 4. Worms-genre influence

We are squarely in the Worms genre: turn-based, destructible terrain, PvP arena, no NPCs, no inventory. Hedgewars (open source Worms clone, Pascal/Qt), Worms Armageddon (closed source, Team17, the genre-defining game), and Liero (real-time Worms variant) all share the same object pattern: small catalog, touch-to-collect, no persistence.

Our object catalog will be in the same shape. The genre's mechanics are not negotiable. They are what makes the game recognizable.

There is one important architectural divergence: Hedgewars and Worms Armageddon use deterministic lockstep simulation (every client runs the same sim, server relays inputs only). We use server-authoritative simulation. This affects how object state is represented and synced (see sections 6.4, 9.2), but it does not affect what objects do.

---

## 5. Source taxonomy applied

The bible's mapping, made concrete:

| Source category | Worms equivalent |
|-----------------|------------------|
| `worldspawn` | The destructible terrain mask |
| Entities | World-fixed and match-spawned objects |
| `prop_static` | Cave ambient, surface dressing (paint only) |
| `prop_dynamic` | Breakable barrels, deployed gadgets |

This is the canonical 3D arena pattern translated to 2D. We are not inventing the split; we are recognizing it.

---

## 6. The five principles, applied

### 6.1 World as stage

Already covered in section 1. The principle informs everything below.

### 6.2 Three-tier taxonomy

Concrete catalog:

**World-fixed** (placed by world gen, server-owned, persists for the match):

- Spawn pads (already in the gen plan)
- Weapon crates (Crazy Crates game mode, Post-MVP enhancement #24)
- Breakable barrels and oil drums (genre standard)
- Biome set-pieces: frozen statues, cave shrines, ruined towers (placed by themed passes)
- Chests if we add them; currently scoped out per ADR-003

**Match-spawned** (created during play, server-owned, transient):

- Projectiles
- Mid-match weapon-crate drops (drop from sky in turns)
- Deployed mines, drills, holy hand grenades
- Gadgets dropped by destroyed worms if applicable

**Client-only paint** (no state, render-only, no networking):

- Cave ambient features (`caveAmbient`)
- Surface dressing features (`surfaceDressing`)
- Particle effects (explosions, smoke, debris)
- Background parallax props

The split is by *what the engine does with it*, not by visual class. A barrel might be world-fixed (placed by gen) or match-spawned (dropped from a crate). Both look identical to the player. They are different categories in the architecture.

### 6.3 Proximity sensor as interaction primitive

Concrete approach in our stack:

- Each interactive object owns a planck sensor fixture in addition to (or in place of) its solid body.
- The server's contact listener uses **structured collision labels** to dispatch interactions: `pickup:<id>`, `mine:<owner>:<id>`, `chest:<id>`. The Akip2/torket-game codebase (see section 9.1) does this for projectile/player/terrain dispatch and we steal the pattern wholesale.
- Server-side `onInteract` handlers consult the prop catalog (principle 5) to decide what happens.
- The client never decides. It observes the resulting schema delta or event broadcast and renders accordingly.

This unifies pickups, mines, chests, doors, switches under one mechanism.

### 6.4 Server-authoritative state, event-driven sync

We extend the existing `SimState` snapshot pattern (`shared/protocol.ts`). The Durable Object broadcasts a full `SimState` at 20Hz containing every worm and projectile; we add a third array for world objects:

- `SimState.worms: WormRenderState[]` - existing, 4-8 entries
- `SimState.projectiles: ProjectileRenderState[]` - existing, high-churn
- `SimState.objects: ObjectRenderState[]` - NEW, world-fixed and match-spawned objects with mutable state

Decorations and terrain are not in `SimState`. Decorations live client-side only; terrain ships as a packed mask once at match start (`shared/maskPack.ts`) and is patched per-explosion via `terrain_cut` events (see section 9.3).

VFX-only events (`object_spawn`, `object_destroy`) follow the existing `terrain_cut` / `fire_event` / `damage_event` pattern: fire-and-forget triggers for sound, particles, screen shake. Authoritative state continues to arrive via `sim_state`.

Tombstone-on-delete pattern (steal from Excalidraw): when an object dies, set `dead: true` and keep it in the array for one tick before removal, so any in-flight client interpolation does not glitch on a missing object id.

### 6.5 Data-driven prop catalog

A new file `props.json` (or `props.ts`) sibling to `weapons.json`. Each entry describes one prop type with its sprite, hitbox, sensor radius, hp, on-destroy behavior, on-interact behavior. World gen places by id. Match-time spawning instantiates by id. The catalog is the only source of truth for "what types of objects exist." Adding a new prop is a JSON entry plus possibly a sprite. No code changes for a new prop unless it requires a new behavior class.

This matches our existing convention for weapons, maps, characters. The pattern is established; we are extending it.

A guide doc `adding-a-prop.md` (paralleling `adding-a-weapon.md`) lands with the first implementation PR.

---

## 7. The rejected principle

We considered the bible's principle 6 candidate ("anchor + support") and reject it for the same reason the bible does. Worms Armageddon's simpler model wins: object has a body, body settles via gravity, body falls when terrain disappears. The Akip2/torket-game codebase confirms this works in practice.

---

## 8. Out of scope (worms confirmation)

Consistent with the bible:

- **NPCs.** Excluded by ADR-003 (Terraria world pivot) for world-gen scope; we extend the exclusion to runtime.
- **Inventory.** Worms-style pickups are instant-effect (heal, ammo, weapon-swap). We do not implement bag inventory.
- **Persistence beyond match.** No save system. No carryover. Match-bound.
- **Player-driven placement** beyond what weapons already do (mines, drills).

This is not a TODO list. These are commitments. Re-introducing any requires revisiting the bible.

---

## 9. Reference architecture

Three open-source codebases anchor our implementation. We are not inventing patterns; we are translating these.

### 9.1 Akip2/torket-game (primary code reference)

URL: https://github.com/Akip2/torket-game

A Worms Armageddon clone in TypeScript + Phaser + Colyseus + Matter.js. Last commit 2026-04-26. It is the closest stack-and-genre match we found.

We steal Torket's **class architecture** (GameBody hierarchy, parallel runtime + state maps, label-based collision dispatch). We do NOT steal its **schema design or transport**, because Torket runs Colyseus with binary delta sync and we run hand-rolled JSON over a Cloudflare Durable Object (see section 11).

Patterns we are stealing:

- **`GameBody` abstract base** with `addToWorld` / `removeFromWorld`. Subclasses per object type (PlayerBody, BulletBody, TerrainBlock, BarrelBody). Uniform lifecycle.
- **Two parallel server maps**: a runtime `Map<id, GameBody>` (the truth) plus a wire-format projection (their `MapSchema`, our `ObjectRenderState[]` in `SimState`). The runtime map owns the planck body and game logic; the wire projection is regenerated each tick.
- **Label-based collision dispatch** with structured prefixes. Per-frame collision events route by label prefix to per-type handlers.
- **Per-domain managers** (PhysicsManager, PlayerManagerServer, TerrainManagerServer) keep the Room class lean. Our equivalent: split `Simulation` responsibilities across helper classes rather than letting the DO grow.

Patterns we are avoiding:

- Torket broadcasts bullets ephemerally so a mid-flight join does not see them. We do not have this problem because our `SimState` snapshots include every projectile and object every tick. Late joiners get the full picture on first snapshot.
- Untyped `any` references for state objects on the client. We have generated types from `shared/protocol.ts`; use them.
- Full terrain rebuild on every cut. O(N) rebuild is fine at small scale but tanks under heavy explosion load. Replace with incremental update if it becomes a hot spot.

### 9.2 Wire format: extend `shared/protocol.ts`

We do not introduce a schema framework. We extend the existing TypeScript-interface protocol that lives at `shared/protocol.ts` and is broadcast as plain JSON. The existing pattern is full `SimState` snapshots at 20Hz plus fire-and-forget VFX events.

Additions:

```ts
// shared/protocol.ts (additions)

/**
 * Render-ready world-object state. Catalog kind drives sprite + behavior.
 * Positions are in pixels (matching WormRenderState convention). One entry
 * per object instance in the match.
 */
export interface ObjectRenderState {
  id: string;
  /** Catalog kind: "barrel", "weapon_crate", "mine", "spawn_pad", etc. */
  kind: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  hp: number;
  /** Stays true for one tick before removal so client interp does not glitch. */
  dead: boolean;
  /** Per-kind packed flags. e.g. bit 0 = opened (chest), bit 1 = armed (mine). */
  flags: number;
}

export interface SimState {
  // ...existing fields (tick, worms, projectiles, activeTeamId, ...)
  objects: ObjectRenderState[];  // NEW
}

/** Spawn VFX trigger. Fired once per object creation. */
export interface ObjectSpawnEvent {
  id: string;
  kind: string;
  x: number;
  y: number;
}

/** Destroy VFX trigger. Fired once per object death. */
export interface ObjectDestroyEvent {
  id: string;
  /** Optional cause for VFX selection. */
  cause?: "explode" | "open" | "remove";
}
```

Server-side, the `Simulation` class (`worker/src/sim/simulation.ts`) gains an `objects: Map<string, ObjectInstance>` parallel to its existing worm and projectile maps. Each tick, `Simulation.toSimState()` projects the map to an array of `ObjectRenderState`. Spawn and destroy events broadcast immediately, like the existing `terrain_cut` flow in `worker/src/room.ts`.

Persistence: the `Simulation` already serializes for DO hibernation. Object serialization joins that path. Planck bodies are recreated on resume from the serialized state, same pattern as worms.

### 9.3 Terrain sync via packed mask, unchanged

Terrain is not in `SimState` and the object addition does not change that. The existing `shared/maskPack.ts` (1-bit-per-pixel packing, `packMask` / `unpackMask`) handles match-start delivery. Per-explosion mutations broadcast via the existing `terrain_cut` event with `{ x, y, r, seq }`.

Object architecture sits above this layer. World-fixed objects are anchored to terrain coordinates but their physics bodies are independent. When terrain underneath an object disappears, planck gravity drops the body. No "terrain-object link" data structure exists or is needed.

### 9.4 Patterns we DO NOT borrow

CRDT libraries (Yjs, Liveblocks) solve multi-writer convergence which we do not have. Their `LiveObject` and `Y.Map` machinery has overhead that buys us nothing. We are server-authoritative; the server overrides client state, we do not merge.

---

## 10. Open tradeoffs

These need explicit decisions during implementation. The bible is silent on them; this is where worms answers.

- **Liquids in v1?** Probably not. Liquids are state-heavy and break "stage not simulation." Defer to v2 if a game mode demands.
- **Destruction physics: tumbling vs despawn?** When a barrel's support drops, does it become a tumbling planck dynamic body, or just despawn with a particle effect? Tumbling is satisfying but multiplies physics cost. Default: despawn for v1; tumbling per-prop opt-in via catalog.
- **NPCs:** still excluded.
- **Inventory:** still excluded. Pickups are instant-effect.
- **Visual variety:** 2-4 sprite variants per prop, chosen at gen time by biome. Cheap at runtime, modest gen complexity.

---

## 11. Hosting model, verified

We do **not** use Colyseus. The earlier ADR-001 plan for Colyseus + Fly.io was superseded; the actual stack is:

- **Cloudflare Workers.** `worker/wrangler.toml` routes `mccarrison.me/worms` and `mccarrison.me/worms/*` to a Worker. Static assets served from `../dist` via the `[assets]` binding.
- **Durable Object class `Room`.** One DO per match, SQLite-backed (`new_sqlite_classes = ["Room"]` migration). Owns the lobby, the simulation, and the WebSocket connections.
- **Hand-rolled JSON over hibernation-safe WebSocket.** No schema framework. Wire format is the TypeScript interfaces in `shared/protocol.ts`. `shared/protocol.ts:11-14` calls this out explicitly: "Transport is hand-rolled JSON over a single hibernation-safe WebSocket per client (no @colyseus/schema patch deltas)."
- **Planck simulation inside the DO.** `worker/src/sim/simulation.ts` owns the planck world. A 50ms (20Hz) DO alarm advances the sim, drains inputs, broadcasts state, persists for hibernation, schedules the next alarm.
- **Full-state `sim_state` broadcasts each tick.** Plus fire-and-forget VFX events: `terrain_cut`, `fire_event`, `damage_event`, `worm_died`, `game_over`. See `worker/src/room.ts:11-14`.
- **Hibernation-aware persistence.** `state.storage.put` saves lobby, rosters, arbiter, and serialized sim. The DO can hibernate mid-match and resume cleanly.

Implications for object architecture:

1. **Schema design is a TypeScript interface in `shared/protocol.ts`**, not a schema-framework class. Section 9.2 reflects this.
2. **Sim tick rate is fixed at 20Hz.** Object simulation cost rolls up into the existing planck step in `Simulation.advance`.
3. **Object state must serialize for DO hibernation.** Planck bodies are recreated on resume from serialized object state, same pattern as worms.
4. **CF Workers CPU-time per request is the binding constraint**, not bandwidth. Per-tick alarm execution must stay under the limit even with the full object catalog active. We measure before scaling object count.
5. **Bandwidth is not a concern at our scale.** Per `shared/protocol.ts:13`: "Total state is <1 KB so this is trivially cheap at our scale." Adding ~30 objects at ~50 bytes each is ~1.5KB per snapshot, still cheap at 20Hz.

The Colyseus-on-CF-Workers question (Colyseus issue #851) was a red herring. We are not running Colyseus anywhere.

---

## 12. Next steps

Hosting verification (former step 1) is complete; section 11 captures the finding. Remaining work in dependency order:

1. **Read Akip2/torket-game end-to-end** for class architecture only. Focus on `GameBody.ts` and per-domain manager classes. Skip their schema and transport layers; those do not apply to us. Roughly 30 minutes of reading.
2. **Extend `shared/protocol.ts`**: add `ObjectRenderState`, the `objects: ObjectRenderState[]` field on `SimState`, and `ObjectSpawnEvent` / `ObjectDestroyEvent`.
3. **Add the prop catalog** at `data/props.json` (or `src/objects/catalog.ts`) with one starter prop type (a barrel) plus a `loadProps()` consumer.
4. **Implement `ObjectInstance` server class** in `worker/src/sim/`: planck body wrapper, `Map<id, ObjectInstance>` in `Simulation`, `toRenderState()` projection, hibernation-safe serialization.
5. **Wire `object_spawn` and `object_destroy` event broadcasts** following the existing `terrain_cut` pattern in `worker/src/room.ts`.
6. **Add label-based collision dispatch** (`barrel:<id>`, `pickup:<id>`, etc.) to the Simulation's contact listener.
7. **Write `docs/plans/object-interaction-pr1.md`** with concrete first-PR scope: barrel as proof-of-concept end-to-end through gen, sim, sync, sensor, despawn. Establish the pattern before scaling.
8. **Write `docs/guides/adding-a-prop.md`** alongside the first PR, paralleling `adding-a-weapon.md`.

Each subsequent prop type is an additive change once the base pattern lands.
