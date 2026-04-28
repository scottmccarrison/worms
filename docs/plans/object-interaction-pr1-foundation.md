# Object Interaction PR 1: Foundation + Barrel POC

**Position:** PR 1 of ~4 in the object interaction roadmap.
**Status:** Draft. Awaiting user approval.

## Multi-PR roadmap context

References:
- `docs/guides/object-interaction-philosophy.md` (the bible)
- `docs/guides/object-interaction-design.md` (the worms-specific design)

Both shipped 2026-04-28 in PR #179.

This PR establishes the entire object pattern end-to-end with one trivial prop type (a barrel) spawned via a debug hook. World-gen integration and sensor-based interaction come in later PRs.

Roadmap projection:

- **PR 1 (this plan):** foundation. ObjectInstance abstract base, BarrelObject, catalog, Simulation integration, client rendering, debug-spawn hook. Validates the end-to-end pattern.
- **PR 2:** sensor-based interaction. WeaponCrateObject as a proximity-sensor pickup with instant-effect on touch. Adds the second canonical interaction primitive.
- **PR 3:** worldgen integration. New `placeWorldObjects` pass keyed off biome theme. Replaces debug spawn hook with proper procedural placement.
- **PR 4:** catalog growth. Mines, oil drums, spawn pads, breakable crates as catalog-only additions (no architecture change).

## What PR 1 delivers

1. `shared/protocol.ts` additions: `ObjectRenderState`, `ObjectSpawnEvent`, `ObjectDestroyEvent`, `objects[]` field on `SimState`.
2. `worker/src/entities/objectInstance.ts`: abstract base class with planck body lifecycle, `toRenderState()` projection, hibernation serialization hooks.
3. `worker/src/entities/objects/barrel.ts`: first concrete prop type. HP: 1. On destroy: explode (radius/damage tunable).
4. `shared/objectCatalog.ts`: data-driven catalog with one entry (barrel).
5. `Simulation` integration: `objects: Map<string, ObjectInstance>`, integrated tick lifecycle, `SimState.objects[]` projection, hibernation persistence in `SerializedSim`, label-based collision dispatch (`barrel:<id>`).
6. Client rendering: sprite per object instance via `SimState.objects` reconciliation, despawn animation on `object_destroy` event.
7. Debug spawn hook: Room DO passes 3 hardcoded barrels to `Simulation` at match start. World-gen wiring deferred to PR 3.
8. Tests: simulation tests for barrel spawn, damage, destroy, hibernate-resume.

Not in PR 1: world-gen pass integration (PR 3), sensor-based pickup (PR 2), catalog growth (PR 4), tumbling-physics-on-destroy (PR 4 or later).

## Architectural decisions (5-question discipline)

### Decision 1: Class hierarchy - thin abstract base, planck-flavored

| Question | Answer |
|---|---|
| Bible cite | `object-interaction-philosophy.md` §6.2 (three-tier taxonomy by authority and lifecycle) |
| Consensus cite | `object-interaction-design.md` §6.4, §9.1 (Torket `GameBody` pattern stolen) |
| Prior art | Torket `server/src/bodies/GameBody.ts` (verified by reading 2026-04-28). Existing `Worm` and `Projectile` classes already follow the same shape. |
| Simplest sufficient | One abstract class with body field + lifecycle methods. Subclasses add domain logic. Mirrors what we already do. |
| Bite | Subclass explosion if we hit >20 prop kinds. At our scale (8-15 props v1), fine. |

**Decision: `ObjectInstance` abstract class with same shape as `Worm` / `Projectile` (planck body field, `toRenderState()`, hibernation hooks).**

### Decision 2: Catalog format - TypeScript module, not JSON

| Question | Answer |
|---|---|
| Bible cite | `object-interaction-philosophy.md` §6.5 (data-driven prop catalog) |
| Consensus cite | `CLAUDE.md` "Drop-in philosophy" section: weapons live in `src/weapons/<name>.ts` as TS configs, not JSON. Match the convention. |
| Prior art | Source FGD, Doom WAD, Phaser tilemaps. Most modern indie games use TS/JS module configs over JSON. |
| Simplest sufficient | TypeScript module gives type safety + IDE autocomplete + no runtime parse. JSON would require schema validation. |
| Bite | Hot-reload during dev requires code edit (Vite) rather than data edit. We accept; same constraint applies to weapons today. |

**Decision: `shared/objectCatalog.ts` as TypeScript module with typed `OBJECT_CATALOG: Record<string, ObjectConfig>`.**

### Decision 3: Lifecycle - tombstone-on-delete + next-tick reap

| Question | Answer |
|---|---|
| Bible cite | Silent. |
| Consensus cite | `object-interaction-design.md` §6.4 (tombstone pattern stolen from Excalidraw). |
| Prior art | Excalidraw `isDeleted` flag, tldraw `RemoveOp`. Both keep the record around briefly post-delete to avoid client-side dangling-id glitches. |
| Simplest sufficient | One boolean field (`dead`), one tick of grace before reap. Avoids client interpolation seeing an id disappear mid-frame. |
| Bite | One tick of "dead" state on the wire. Cosmetically harmless if the client renders dead objects with a fade-out. |

**Decision: `ObjectInstance.dead: boolean` flag. Set to `true` on death; `Simulation.reapDeadObjects()` runs at end of next tick to remove from map and destroy planck body.**

### Decision 4: Spawn-source seam - Simulation accepts initialObjects, not a generator

| Question | Answer |
|---|---|
| Bible cite | Silent. |
| Consensus cite | `object-interaction-design.md` §12 step 4 (extend `Simulation` with `objects` map, projection, serialization). |
| Prior art | Existing `SimulationInit.teams` pattern: caller passes seed data, Simulation hydrates. Same shape works for objects. |
| Simplest sufficient | `SimulationInit.initialObjects?: Array<{ kind, xPx, yPx }>` defaulting to empty. Caller decides where they come from (debug hardcode for PR 1, gen pass for PR 3). |
| Bite | Two callers eventually (Room DO + tests). Each builds the array. Acceptable. |

**Decision: `SimulationInit` gains `initialObjects?: Array<{ kind: string; xPx: number; yPx: number }>`. Room DO hardcodes 3 barrels for PR 1; PR 3 replaces with generator output.**

### Decision 5: File layout - mirror existing entities/ directory

| Question | Answer |
|---|---|
| Bible cite | Silent. |
| Consensus cite | Existing `worker/src/entities/{worm,projectile,terrain}.ts` is the pattern. |
| Prior art | Torket uses `bodies/` directory for the same thing. Our directory is `entities/`. Same idea. |
| Simplest sufficient | Add `worker/src/entities/objectInstance.ts` (the base) and `worker/src/entities/objects/<kind>.ts` (concrete subclasses). Subdirectory for objects keeps the base separated from siblings. |
| Bite | Concrete subclasses live in a sub-directory while base is one level up. Slight asymmetry. Worth it to keep `entities/` from getting cluttered as catalog grows. |

**Decision: base in `worker/src/entities/objectInstance.ts`, concrete kinds in `worker/src/entities/objects/<kind>.ts`.**

## Workstreams

Three parallel Sonnet agents with disjoint files. Final integration merges all three to one feature branch.

WS-A defines the protocol contract. WS-B and WS-C reference WS-A's types. To enable parallelism, the agents agree on the type stub up-front (in this plan), so each can write against the agreed shape and any drift gets reconciled at integration.

### WS-A: server foundation (the heavy workstream)

**Worktree:** `/home/scott/worms-objpr1-ws-a`
**Branch:** `feature/object-interaction-server`
**Setup:**
```bash
git -C /home/scott worktree add /home/scott/worms-objpr1-ws-a -b feature/object-interaction-server master
test -d /home/scott/worms-objpr1-ws-a/node_modules || ln -s /home/scott/worms/node_modules /home/scott/worms-objpr1-ws-a/node_modules
```

**Files (4 new, 3 modified):**

1. `shared/protocol.ts` (modify) - add types
2. `shared/objectCatalog.ts` (new) - the catalog
3. `worker/src/entities/objectInstance.ts` (new) - abstract base
4. `worker/src/entities/objects/barrel.ts` (new) - first concrete subclass
5. `worker/src/sim/simulation.ts` (modify) - integrate `objects` map, projection, hibernation, collision dispatch
6. `worker/src/sim/simulation.test.ts` (modify) - new tests
7. `worker/src/room.ts` (modify) - pass 3 hardcoded barrels via `initialObjects` at match start

#### `shared/protocol.ts` additions

Append to the existing file, after the existing `ProjectileRenderState` block (around line 174):

```typescript
/**
 * Render-ready world-object state. Catalog kind drives sprite + behavior.
 * Positions are in pixels (matching WormRenderState convention). One entry
 * per object instance in the match.
 *
 * Tombstone semantics: an object marked dead=true is broadcast for one tick
 * post-destruction so client interpolation does not glitch on a missing id,
 * then reaped from the map.
 */
export interface ObjectRenderState {
  id: string;
  /** Catalog kind: "barrel", "weapon_crate", "mine", etc. Drives sprite + client behavior. */
  kind: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  hp: number;
  /** Stays true for one tick before removal. */
  dead: boolean;
  /** Per-kind packed flags. Bit 0 = opened (chest), bit 1 = armed (mine). PR 1 leaves at 0. */
  flags: number;
}
```

Add `objects: ObjectRenderState[]` field to the existing `SimState` interface. Append to existing fields:

```typescript
export interface SimState {
  tick: number;
  worms: WormRenderState[];
  projectiles: ProjectileRenderState[];
  objects: ObjectRenderState[];  // NEW
  activeTeamId: string;
  activeWormId: string;
  turnEndsAt: number;
  wind: number;
  waterLevelPx: number;
}
```

Append the spawn/destroy events alongside the existing event interfaces:

```typescript
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
  cause: "explode" | "open" | "remove";
}
```

Add the corresponding entries to the `ServerMsg` union (around line 283):

```typescript
  | ({ type: "object_spawn" } & ObjectSpawnEvent)
  | ({ type: "object_destroy" } & ObjectDestroyEvent)
```

#### `shared/objectCatalog.ts` (new)

```typescript
/**
 * Object catalog. Sibling to the weapons registry (src/weapons/) but shared
 * between worker and client because both server (sim spawn/damage logic) and
 * client (sprite rendering) consume the catalog.
 *
 * To add a new prop type: add an entry here, possibly add a new sprite asset,
 * and (for behaviors not expressible by data) add a kind branch in
 * worker/src/entities/objects/<kind>.ts.
 */

export interface ObjectConfig {
  /** Catalog id. Matches ObjectRenderState.kind. */
  kind: string;
  /** Sprite key loaded by the client. Matches an Aseprite atlas key. */
  sprite: string;
  /** Hitbox in pixels. Used to build the planck body fixture. */
  hitbox: { widthPx: number; heightPx: number };
  /** Initial HP. 0 means indestructible. */
  hp: number;
  /** Whether the body is static (immovable) or dynamic (gravity-affected). */
  bodyType: "static" | "dynamic";
  /** Optional: explosion on destroy. */
  onDestroy?: { explode: { damagePx: number; radiusPx: number } };
}

export const OBJECT_CATALOG: Record<string, ObjectConfig> = {
  barrel: {
    kind: "barrel",
    sprite: "barrel",
    hitbox: { widthPx: 24, heightPx: 32 },
    hp: 1,
    bodyType: "dynamic",
    onDestroy: { explode: { damagePx: 25, radiusPx: 60 } },
  },
};

export function getObjectConfig(kind: string): ObjectConfig | undefined {
  return OBJECT_CATALOG[kind];
}
```

#### `worker/src/entities/objectInstance.ts` (new)

```typescript
/**
 * Abstract base for world-fixed and match-spawned objects.
 *
 * Mirrors the shape of Worm and Projectile: holds a planck body, exposes
 * toRenderState() for the wire, and handles destruction via a tombstone
 * flag. Concrete subclasses live in objects/<kind>.ts.
 */

import { Box, Polygon } from "planck";
import type { Body, World } from "planck";
import { type ObjectConfig, getObjectConfig } from "../../../shared/objectCatalog.js";
import type { ObjectRenderState } from "../../../shared/protocol.js";
import { toMeters, toPixels } from "../physics/scale.js";

export interface ObjectInstanceInit {
  id: string;
  kind: string;
  world: World;
  xPx: number;
  yPx: number;
}

export interface ObjectUserData {
  kind: "object";
  object: ObjectInstance;
}

export class ObjectInstance {
  readonly id: string;
  readonly kind: string;
  readonly config: ObjectConfig;
  readonly body: Body;
  hp: number;
  dead: boolean = false;
  /** Cause set by destroy() for the broadcast. */
  destroyCause: "explode" | "open" | "remove" = "remove";
  /** Per-kind packed flags. Subclasses define bit semantics. */
  flags: number = 0;

  constructor(init: ObjectInstanceInit) {
    const config = getObjectConfig(init.kind);
    if (!config) throw new Error(`unknown object kind: ${init.kind}`);

    this.id = init.id;
    this.kind = init.kind;
    this.config = config;
    this.hp = config.hp;

    this.body = init.world.createBody({
      type: config.bodyType,
      position: { x: toMeters(init.xPx), y: toMeters(init.yPx) },
      fixedRotation: true,
    });

    this.body.createFixture({
      shape: new Box(
        toMeters(config.hitbox.widthPx / 2),
        toMeters(config.hitbox.heightPx / 2),
      ),
      density: 1,
      friction: 0.6,
      restitution: 0.1,
    });

    const userData: ObjectUserData = { kind: "object", object: this };
    this.body.setUserData(userData);
  }

  /** Apply damage. Marks dead if HP drops to 0. */
  takeDamage(amount: number): void {
    if (this.dead) return;
    if (this.config.hp === 0) return; // indestructible
    this.hp = Math.max(0, this.hp - amount);
    if (this.hp === 0) {
      this.dead = true;
      this.destroyCause = this.config.onDestroy ? "explode" : "remove";
    }
  }

  /** Mark dead with a specific cause. */
  destroy(cause: "explode" | "open" | "remove"): void {
    if (this.dead) return;
    this.dead = true;
    this.destroyCause = cause;
  }

  toRenderState(): ObjectRenderState {
    const pos = this.body.getPosition();
    const vel = this.body.getLinearVelocity();
    return {
      id: this.id,
      kind: this.kind,
      x: toPixels(pos.x),
      y: toPixels(pos.y),
      vx: toPixels(vel.x),
      vy: toPixels(vel.y),
      hp: this.hp,
      dead: this.dead,
      flags: this.flags,
    };
  }

  /** For SerializedSim during DO hibernation. */
  serialize(): { id: string; kind: string; x: number; y: number; vx: number; vy: number; hp: number; flags: number } {
    const state = this.toRenderState();
    return {
      id: state.id,
      kind: state.kind,
      x: state.x,
      y: state.y,
      vx: state.vx,
      vy: state.vy,
      hp: state.hp,
      flags: state.flags,
    };
  }
}
```

#### `worker/src/entities/objects/barrel.ts` (new)

```typescript
/**
 * Barrel: dynamic body, 1 HP, explodes on destroy.
 *
 * Currently a thin wrapper over ObjectInstance because the catalog
 * carries all behavior. Reserved for kind-specific overrides as the
 * catalog grows (custom collision filters, special behaviors that
 * cannot be expressed as data).
 */

import { ObjectInstance, type ObjectInstanceInit } from "../objectInstance.js";

export class Barrel extends ObjectInstance {
  constructor(init: Omit<ObjectInstanceInit, "kind">) {
    super({ ...init, kind: "barrel" });
  }
}
```

#### `worker/src/sim/simulation.ts` (modify)

1. Import additions at top:
```typescript
import { ObjectInstance, type ObjectUserData } from "../entities/objectInstance.js";
import type { ObjectRenderState } from "../../../shared/protocol.js";
```

2. Add to `SimEvent` union:
```typescript
export interface SimEventObjectSpawn {
  type: "object_spawn";
  id: string;
  kind: string;
  x: number;
  y: number;
}

export interface SimEventObjectDestroy {
  type: "object_destroy";
  id: string;
  cause: "explode" | "open" | "remove";
}

export type SimEvent =
  | SimEventTerrainCut
  | SimEventFire
  | SimEventDamage
  | SimEventWormDied
  | SimEventObjectSpawn   // NEW
  | SimEventObjectDestroy; // NEW
```

3. Extend `SimState`:
```typescript
export interface SimState {
  tick: number;
  worms: WormRenderState[];
  projectiles: ProjectileRenderState[];
  objects: ObjectRenderState[];  // NEW
  wind: number;
  waterLevelPx: number;
}
```

4. Extend `SimulationInit`:
```typescript
export interface SimulationInit {
  // ...existing...
  initialObjects?: Array<{ kind: string; xPx: number; yPx: number }>;
}
```

5. Extend `SerializedSim`:
```typescript
export interface SerializedSim {
  // ...existing...
  objects: Array<{
    id: string;
    kind: string;
    x: number;
    y: number;
    vx: number;
    vy: number;
    hp: number;
    flags: number;
  }>;
}
```

6. Add to `Simulation` class fields:
```typescript
private readonly objects: Map<string, ObjectInstance> = new Map();
private objectIdCounter = 0;
```

7. In constructor, after worms are spawned, hydrate initial objects:
```typescript
for (const seed of init.initialObjects ?? []) {
  this.spawnObject(seed.kind, seed.xPx, seed.yPx);
}
```

8. Add public methods:
```typescript
spawnObject(kind: string, xPx: number, yPx: number): ObjectInstance {
  const id = `obj_${++this.objectIdCounter}`;
  const obj = new ObjectInstance({ id, kind, world: this.world, xPx, yPx });
  this.objects.set(id, obj);
  this.events.push({ type: "object_spawn", id, kind, x: xPx, y: yPx });
  return obj;
}

private reapDeadObjects(): void {
  for (const [id, obj] of this.objects) {
    if (!obj.dead) continue;
    // Detonate-on-destroy if config asked for it
    if (obj.destroyCause === "explode" && obj.config.onDestroy) {
      const pos = obj.body.getPosition();
      const xPx = toPixels(pos.x);
      const yPx = toPixels(pos.y);
      this.terrain.cutCircle(xPx, yPx, obj.config.onDestroy.explode.radiusPx, "explode");
      // Damage radius: reuse explode helper with the object's config
      explode(this, xPx, yPx, obj.config.onDestroy.explode.damagePx, obj.config.onDestroy.explode.radiusPx, null);
    }
    this.events.push({ type: "object_destroy", id, cause: obj.destroyCause });
    this.world.destroyBody(obj.body);
    this.objects.delete(id);
  }
}
```

9. Call `reapDeadObjects()` at the end of each `tick()` after the existing post-step processing.

10. Extend collision dispatch (find existing post-solve/begin-contact handler) with the projectile-vs-object case. Pseudocode:
```typescript
// Inside whichever begin-contact handler exists
const aData = bodyA.getUserData() as { kind: string };
const bData = bodyB.getUserData() as { kind: string };
if ((aData?.kind === "projectile" && bData?.kind === "object") ||
    (aData?.kind === "object" && bData?.kind === "projectile")) {
  const projData = aData.kind === "projectile" ? aData : bData;
  const objData  = aData.kind === "object" ? aData : bData;
  // queue object damage; do not destroy bodies inside the contact callback
  this.pendingObjectHits.push({ obj: (objData as ObjectUserData).object, projectile: (projData as ProjectileUserData).projectile });
}
```

Drain `pendingObjectHits` after the world step (alongside `pendingDetonate`):
```typescript
for (const hit of this.pendingObjectHits) {
  hit.obj.takeDamage(1);
  hit.projectile.markDetonated();
}
this.pendingObjectHits = [];
```

11. Extend `toSimState()`:
```typescript
toSimState(): SimState {
  return {
    // ...existing fields...
    objects: Array.from(this.objects.values()).map(o => o.toRenderState()),
  };
}
```

12. Extend serialize/deserialize for hibernation:
```typescript
serialize(): SerializedSim {
  return {
    // ...existing...
    objects: Array.from(this.objects.values()).map(o => o.serialize()),
  };
}

// In static fromSerialized (or wherever hydration happens), after worms/projectiles:
for (const seed of serialized.objects ?? []) {
  const obj = sim.spawnObject(seed.kind, seed.x, seed.y);
  obj.body.setLinearVelocity({ x: toMeters(seed.vx), y: toMeters(seed.vy) });
  obj.hp = seed.hp;
  obj.flags = seed.flags;
  // Note: object_spawn event fired by spawnObject is fine on resume (re-emits to mid-flight clients).
}
```

#### `worker/src/sim/simulation.test.ts` (modify)

Add a new `describe` block:

```typescript
describe("objects", () => {
  it("spawns initial objects from init.initialObjects", () => {
    const sim = createSim({ initialObjects: [{ kind: "barrel", xPx: 200, yPx: 100 }] });
    sim.tick(50);
    const state = sim.toSimState();
    expect(state.objects).toHaveLength(1);
    expect(state.objects[0].kind).toBe("barrel");
  });

  it("emits object_spawn event for initial objects", () => {
    const sim = createSim({ initialObjects: [{ kind: "barrel", xPx: 200, yPx: 100 }] });
    const result = sim.tick(50);
    expect(result.events.find(e => e.type === "object_spawn")).toBeDefined();
  });

  it("damages barrel on projectile contact", () => {
    const sim = createSim({ initialObjects: [{ kind: "barrel", xPx: 200, yPx: 100 }] });
    sim.applyFire(/* fire toward barrel */);
    // step until projectile hits
    for (let i = 0; i < 60; i++) sim.tick(50);
    const state = sim.toSimState();
    expect(state.objects).toHaveLength(0); // barrel destroyed (hp 1)
  });

  it("emits object_destroy event when barrel dies", () => {
    // similar setup, assert event fired with cause=explode
  });

  it("survives hibernation round-trip", () => {
    const sim = createSim({ initialObjects: [{ kind: "barrel", xPx: 200, yPx: 100 }] });
    sim.tick(50);
    const serialized = sim.serialize();
    const restored = Simulation.fromSerialized(serialized, /* mask, etc. */);
    expect(restored.toSimState().objects).toHaveLength(1);
  });
});
```

#### `worker/src/room.ts` (modify)

Find where `Simulation` is constructed (search for `new Simulation`). Add the debug barrel spawn:

```typescript
// PR 1 debug: hardcode 3 barrels for end-to-end testing.
// PR 3 will replace this with worldgen output.
const initialObjects = [
  { kind: "barrel", xPx: 600,  yPx: 400 },
  { kind: "barrel", xPx: 1280, yPx: 400 },
  { kind: "barrel", xPx: 1960, yPx: 400 },
];

const sim = new Simulation({
  // ...existing init...
  initialObjects,
});
```

### WS-B: client rendering

**Worktree:** `/home/scott/worms-objpr1-ws-b`
**Branch:** `feature/object-interaction-client`

**Files (1 new, 1 modified):**

1. `src/objects/objectSprite.ts` (new) - Phaser GameObject wrapper for one object instance
2. `src/scenes/GameScene.ts` (modify) - reconcile `SimState.objects` with sprite map; play VFX on `object_destroy`

#### `src/objects/objectSprite.ts` (new)

```typescript
/**
 * Client-side Phaser sprite wrapping one ObjectRenderState.
 *
 * GameScene maintains a Map<id, ObjectSprite> and reconciles each tick:
 *   - state.objects has id we don't track   -> new ObjectSprite()
 *   - id is in our map but not in state     -> sprite.destroy()
 *   - id is in both                          -> sprite.update(state)
 */

import Phaser from "phaser";
import type { ObjectRenderState } from "../../shared/protocol";
import { getObjectConfig } from "../../shared/objectCatalog";

export class ObjectSprite extends Phaser.GameObjects.Sprite {
  private targetX: number;
  private targetY: number;

  constructor(scene: Phaser.Scene, state: ObjectRenderState) {
    const config = getObjectConfig(state.kind);
    if (!config) throw new Error(`unknown object kind: ${state.kind}`);
    super(scene, state.x, state.y, config.sprite);
    scene.add.existing(this);
    this.targetX = state.x;
    this.targetY = state.y;
  }

  /** Called on every SimState reconciliation to lerp toward the new server state. */
  applyState(state: ObjectRenderState): void {
    this.targetX = state.x;
    this.targetY = state.y;
    if (state.dead) {
      this.setAlpha(0.5);
    }
  }

  /** Called from the scene's update() at 60fps to interpolate between server snapshots. */
  interpolate(_dt: number): void {
    this.x = Phaser.Math.Linear(this.x, this.targetX, 0.3);
    this.y = Phaser.Math.Linear(this.y, this.targetY, 0.3);
  }

  playDestroyVfx(cause: "explode" | "open" | "remove"): void {
    if (cause === "explode") {
      // particle burst placeholder; refine in PR 4
      this.scene.cameras.main.shake(150, 0.005);
    }
    this.destroy();
  }
}
```

#### `src/scenes/GameScene.ts` (modify)

Add the object reconciliation + event handlers. Find where `WormSprite` and `ProjectileSprite` reconciliation happens and mirror.

```typescript
// in scene class fields
private objectSprites = new Map<string, ObjectSprite>();

// in onSimState handler (where worms + projectiles already reconcile)
const seenObjectIds = new Set<string>();
for (const objState of state.objects) {
  seenObjectIds.add(objState.id);
  let sprite = this.objectSprites.get(objState.id);
  if (!sprite) {
    sprite = new ObjectSprite(this, objState);
    this.objectSprites.set(objState.id, sprite);
  }
  sprite.applyState(objState);
}
// reap any sprites no longer in state (covers tombstone -> reap transition)
for (const [id, sprite] of this.objectSprites) {
  if (!seenObjectIds.has(id)) {
    sprite.destroy();
    this.objectSprites.delete(id);
  }
}

// in update(time, delta)
for (const sprite of this.objectSprites.values()) sprite.interpolate(delta);

// in object_destroy event handler
this.netClient.onMessage("object_destroy", (e) => {
  const sprite = this.objectSprites.get(e.id);
  sprite?.playDestroyVfx(e.cause);
});
```

Asset: add `barrel.png` placeholder to `public/assets/objects/` (or inline a colored rectangle for PR 1; we accept the visual is rough).

### WS-C: hibernation + DO wiring tests

**Worktree:** `/home/scott/worms-objpr1-ws-c`
**Branch:** `feature/object-interaction-do-tests`

**Files (1 modified, 1 new):**

1. `worker/src/__tests__/room-hibernation.test.ts` (new) - end-to-end hibernation round-trip test for objects
2. `worker/src/room.test.ts` (modify, if exists) - add a test that the sim_state broadcast carries `objects[]`

#### `worker/src/__tests__/room-hibernation.test.ts` (new)

```typescript
/**
 * End-to-end test: spawn a Room DO with 3 barrels, advance a few ticks,
 * hibernate (serialize), wake (deserialize), verify barrels still exist
 * with correct positions.
 *
 * Uses the wrangler-vitest test helper for DO instantiation.
 */

import { describe, it, expect } from "vitest";
import { unstable_dev } from "wrangler"; // or appropriate harness

describe("Room DO hibernation: objects", () => {
  it("preserves barrels across hibernate-resume", async () => {
    // 1. Create room, join 2 players, transition to playing phase
    // 2. Verify state.storage.put was called with objects field
    // 3. Simulate hibernation by reading from storage and reconstructing
    // 4. Assert objects map matches pre-hibernation state
  });
});
```

(Implementation depends on how the existing test harness instantiates DOs; agent should match the convention of existing DO tests.)

## Integration

After all three workstreams pass independently:

1. **Merge order:** WS-A first (everyone needs the types). WS-B and WS-C in either order.
2. **Final integration branch:** `feature/object-interaction-pr1`
3. **PR title:** `feat(objects): foundation + barrel POC`
4. **PR body skeleton:**
   ```
   ## Summary
   - Establishes the object interaction architecture from `docs/guides/object-interaction-{philosophy,design}.md`
   - Adds `ObjectInstance` abstract base + `Barrel` concrete prop
   - Extends `SimState` with `objects[]` and adds `object_spawn` / `object_destroy` events
   - 3 hardcoded barrels per match for end-to-end testing (PR 3 wires worldgen)
   - Catalog at `shared/objectCatalog.ts` ready for additive growth

   ## Test plan
   - [ ] Run `npm test` (server + client unit tests pass)
   - [ ] Run `npm run typecheck`
   - [ ] Mobile playtest: barrels visible, can be destroyed via projectile, no perf regression
   - [ ] Hibernation: kill DO mid-match, reconnect, barrels still exist with correct hp/positions

   Closes #161 (object interaction philosophy/design landed).
   ```

## Acceptance criteria

- [ ] `SimState.objects` populated with 3 barrels at match start
- [ ] Client renders 3 barrel sprites at correct positions
- [ ] Firing a projectile that hits a barrel: barrel takes 1 damage, dies, fires explosion event, despawns
- [ ] `object_destroy` event triggers client VFX (camera shake at minimum)
- [ ] Mid-match join sees existing barrels via initial `SimState`
- [ ] Hibernation: `state.storage.put('sim', ...)` includes `objects[]`; resume rehydrates them
- [ ] All existing tests still pass
- [ ] Bundle size delta < 5KB gzipped on the client
- [ ] No new biome lint warnings; `npm run typecheck` clean

## Bugcheck expectations (for /bugcheck before merge)

Edge cases and lenses:

- **Concurrency:** projectile detonates on barrel and worm in same tick. Order of damage application?
- **Hibernation race:** DO hibernates mid-tick after `dead=true` but before reap. On resume, the dead barrel exists in serialized state. Does it reap correctly?
- **Terrain interaction:** terrain destroyed under barrel. Does the barrel fall? Does it spawn `terrain_cut` events?
- **Max objects:** what if `initialObjects` has 100 entries? Performance regression?
- **Sprite mismatch:** server says `kind: "unknown"`. Client should not crash; should log + skip.
- **Visual:** dead-tombstone tick visible to user? Should fade or hide cleanly.
- **Network:** `object_spawn` fires on hibernation resume - that's intentional, but verify no duplicate sprite creation client-side.
- **State drift:** `flags` field default 0 round-trips through serialize/deserialize.

## Out of scope (explicit for /review)

Items deferred to later PRs, listed for clarity:

- Sensor-fixture-based pickups (proximity interaction) - PR 2
- Worldgen pass placement of barrels - PR 3
- Catalog growth beyond barrel - PR 4
- Tumbling-physics-on-destroy - PR 4 or later
- Background parallax props - never (client-paint per philosophy §6.2)
- NPCs, inventory, persistence beyond match - never (philosophy §8)

## Files-touched summary

```
shared/protocol.ts                              MODIFY
shared/objectCatalog.ts                         NEW
worker/src/entities/objectInstance.ts           NEW
worker/src/entities/objects/barrel.ts           NEW
worker/src/sim/simulation.ts                    MODIFY
worker/src/sim/simulation.test.ts               MODIFY
worker/src/room.ts                              MODIFY (3-line debug spawn)
worker/src/__tests__/room-hibernation.test.ts   NEW
src/objects/objectSprite.ts                     NEW
src/scenes/GameScene.ts                         MODIFY (object reconciliation)
public/assets/objects/barrel.png                NEW (placeholder OK)
```
