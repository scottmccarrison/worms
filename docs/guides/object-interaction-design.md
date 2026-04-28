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

### 6.4 Sparse server state, event-driven sync

We use Colyseus's `MapSchema` per object type. Concrete sketch (full version in section 9.2):

- `MatchState.worms: MapSchema<WormState>` - 4-8 entries, dense state per worm
- `MatchState.projectiles: MapSchema<ProjectileState>` - high-churn, spawn/despawn each turn
- `MatchState.worldObjects: MapSchema<WorldObjectState>` - 10-30 entries, mostly static
- Decorations and terrain are NOT in schema (see section 9.3)

Tightly typed primitives (`uint8`, `int16`, `float32`) save bytes per delta. Off-schema runtime fields (the planck `Body`, the input buffer) are server-only with no `@type` decoration.

Tombstone-on-delete pattern (steal from Excalidraw): when an object dies, mark `dead: true` for one tick before GC, so a late-arriving message referencing the object does not crash on a missing entity.

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

Patterns we are stealing:

- **`GameBody` abstract base** with `addToWorld` / `removeFromWorld`. Subclasses per object type (PlayerBody, BulletBody, TerrainBlock, BarrelBody). Uniform lifecycle.
- **Two parallel server maps**: `Map<id, GameBody>` (runtime, the truth) plus `MapSchema<EntitySchema>` (the wire). Schema is a projection of body state, not the source of truth.
- **Label-based collision dispatch** with structured prefixes. Per-frame collision events route by label prefix to per-type handlers.
- **Ephemeral broadcast for projectiles**, MapSchema for persistent entities. Confirms our match-spawned vs world-fixed split with working code.
- **Per-domain managers** (PhysicsManager, PlayerManagerServer, TerrainManagerServer) keep the Room class lean.

Patterns we are avoiding:

- Bullets-not-in-schema: a player joining mid-flight does not see them. Acceptable for projectiles; not acceptable for persistent gadgets like mines. Mines must go in MapSchema.
- `playerRef: any` in client-side code: defeats Colyseus codegen typing. Use generated types.
- Full terrain rebuild on every cut: O(N) world rebuild fine at small scale but tanks under heavy explosion load. Replace with incremental update.

### 9.2 colyseus/realtime-tanks-demo (canonical schema reference)

URL: https://github.com/colyseus/realtime-tanks-demo

The canonical Colyseus tank-style game. Schema design we mirror almost wholesale.

```ts
class WormState extends Schema {
  @type("string") name = "";
  @type("uint8")  team = 0;
  @type("float32") x = 0;
  @type("float32") y = 0;
  @type("float32") vx = 0;
  @type("float32") vy = 0;
  @type("float32") angle = 0;
  @type("int16")  hp = 100;
  @type("uint8")  weapon = 0;
  @type("uint8")  ammo = 0;
  // off-schema (no @type): planck.Body, inputBuffer, lastShotAt
}

class ProjectileState extends Schema {
  @type("uint8")  kind = 0;
  @type("string") owner = "";
  @type("float32") x = 0;
  @type("float32") y = 0;
  @type("float32") vx = 0;
  @type("float32") vy = 0;
  @type("uint16") fuse = 0;
}

class WorldObjectState extends Schema {
  @type("uint8")  kind = 0;
  @type("float32") x = 0;
  @type("float32") y = 0;
  @type("int16")  hp = 0;
  @type("boolean") dead = false;
  // per-kind extras packed into a small record
}

class MatchState extends Schema {
  @type("uint8")  phase = 0;
  @type("string") activeTurn = "";
  @type("uint16") timeRemaining = 0;
  @type({ map: WormState })        worms        = new MapSchema<WormState>();
  @type({ map: ProjectileState })  projectiles  = new MapSchema<ProjectileState>();
  @type({ map: WorldObjectState }) worldObjects = new MapSchema<WorldObjectState>();
}
```

Tick rate: `setSimulationInterval(() => step(), 1000/30)`. Patch rate decoupled if needed via `setPatchRate(50)`.

### 9.3 Terrain via sendBytes, not schema

`unity-demo-tanks` puts a 1D `MapSchema<number>` for a destructible grid. For our continuous mask this is wrong: per-cell delta encoding adds too much overhead for a ~50KB blob.

Pattern (from `endel/colyseus-0.15-protocol-buffers`):

- At match start: `client.sendBytes("terrain", uint8)` ships the full mask once.
- Per explosion: `client.sendBytes("terrain:hole", packedXYR)` ships a small fixed-size patch.
- Schema never sees the terrain.

This is the right shape regardless of the hosting question (section 11).

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

## 11. Open question, blocking design completion

**Is Colyseus officially supported on Cloudflare Workers?**

Per agent research, Colyseus issue #851 (Durable Objects) is open with no PRs. PartyKit (CF acquisition) is the de-facto CF-native equivalent. There is no `@colyseus/cloudflare-workers` adapter shipping.

But our codebase has `worker/src/room.ts` running Colyseus. So either:

1. We have a custom adapter, or something works locally but will not scale.
2. We are running on Node hosted somewhere and `worker/` is misleading naming.
3. There is a recent unofficial adapter we are using.

**This must be verified before final schema and tick-rate decisions are made.** Hosting model affects:

- What runtime APIs are available (timers, WebSocket lifecycle, persistent state)
- What CPU and memory budgets we have per match
- How match state survives across reconnects
- Whether per-tick simulation at 30 Hz is realistic or aspirational

The next session step is to read `worker/package.json`, `wrangler.toml` if present, deploy configs, and any deployment docs. Until that is done, sections 6.4 and 9.2 are sketches, not commitments.

---

## 12. Next steps

In order of dependency:

1. **Verify hosting model** (section 11). Until done, all schema design is provisional.
2. **Clone Akip2/torket-game and read end-to-end**. Especially `GameBody.ts`, `MyRoom.ts`, `TerrainManagerServer.ts`, `PhysicsManager.ts`. Roughly 30 minutes of reading.
3. **Clone colyseus/realtime-tanks-demo and read schema + room.** Cross-reference with Torket. Roughly 20 minutes.
4. **Write `docs/plans/object-interaction-pr1.md`** with concrete first-PR scope: probably just the `GameBody` base class plus one trivial prop type (a barrel) end-to-end through gen, schema, sensor interaction, and despawn. Establish the pattern before scaling.

Each subsequent prop type is an additive change once the base pattern lands.
