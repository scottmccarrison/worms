# Epic 4a: Worm entity + core movement (walk, jump, aim, health, fall damage)

## Context

Port core worm entity from `reference/src/Worm.ts` to modern TypeScript + Phaser 3 + planck.js per [ADR-001](/home/scott/worms/docs/decisions/001-framework-pivot.md). This is Epic 4 "split" — **4a ships core movement + health**; Epic 4b (ninja rope + jetpack) is a separate follow-up PR. Closes most of [issue #4](https://github.com/scottmccarrison/worms/issues/4) (rope + jetpack deferred).

**End state**: `npm run dev` shows the Epic 3 terrain with 4 worms (2 teams × 2, different colors) placed on it. Arrow keys / WASD move the active worm. Tab cycles active worm. Worms walk along slopes, jump, aim (reticle visible above worm). Falls from height deal damage. Damage flashes red, health HUD above each worm updates. All constants tunable via dat.gui.

## Why split

| Sub-epic | Scope | LOC estimate | Why separate |
|---|---|---|---|
| **4a (this PR)** | Core movement, health, fall damage, team coloring, input, spawn points | ~600-700 | Ships a playable worm-on-terrain demo. Low complexity once physics core is solid. |
| **4b (next PR)** | Ninja rope (chain of distance joints) + jetpack (fuel + impulse) | ~500-600 | Distance joint chain is subtle physics + state machine; needs its own review and tuning pass. Blocking 4a on it creates a huge PR. |

## Strategy

- **Modernize walk from reference**: reference used direct `body.SetPosition()` teleport per frame (hacky). Use `body.setLinearVelocity({x: direction*speed, y: current.y})` instead — physics-based, handles slopes naturally via friction.
- **Foot sensor**: small box fixture beneath the worm body with `isSensor: true`. Track ground contact via planck's event-based listener (`world.on("begin-contact"/"end-contact", ...)`), not the old callback-object pattern.
- **Fall damage**: post-solve event (`world.on("post-solve", ...)`) reads normal impulse, applies damage above threshold. Matches reference algorithm.
- **Aim**: angle stored on Worm class, clamped to [-π/2, π/2]. Rendered as a short line from worm center in aim direction. Pure helper function for clamping (testable).
- **Team + active worm**: flat structure — GameScene owns `Team[]`, each Team has `Worm[]` + color. Scene tracks active worm index. Simpler than reference's Player → Team → Worm chain; we add Player for Epic 5 when turn state matters.
- **Placeholder sprites**: Phaser Graphics (colored rectangles, ~40×30 px per team color). Real Aseprite atlases land in Epic 11.
- **No animations**: no state machine yet (reference's WormAnimationManger is tied to sprite frames we don't have). Red-flash on damage is just a Phaser tween.
- **Single worktree**. All files new or in one scene; coupling is tight.
- **Port-then-delete** these reference files in the same PR:
  - `reference/src/Worm.ts`
  - `reference/src/WormManager.ts`
  - `reference/src/Team.ts`
  - `reference/src/Player.ts`
  - `reference/src/WormAnimationManger.ts`
  - `reference/src/system/Controls.ts`
  - (KEEP `reference/src/weapons/NinjaRope.ts`, `JetPack.ts`, `BaseWeapon.ts` for Epic 4b)

## File plan

```
src/
  worm/
    aimAngle.ts              Pure: clamp, step aim angle
    aimAngle.test.ts         Vitest
    fallDamage.ts            Pure: impulse -> HP damage
    fallDamage.test.ts       Vitest
    spawnPoints.ts           Pure: scan ImageData for N surface points
    spawnPoints.test.ts      Vitest
    Team.ts                  Class: id, name, color, worms
    Worm.ts                  Class: planck body + foot sensor + Phaser graphics + walk/jump/aim/health
  input/
    InputController.ts       Keyboard -> active-worm actions; Tab cycles
  scenes/
    GameScene.ts             Modified: spawn teams, wire input, health HUD, pointer cut (still)
  tuning.ts                  Extended: worm.* + teams.* sections
  debug/
    tuningPanel.ts           Extended: add worm folder
```

Untouched (per convention):
- `src/physics/` (stable)
- `src/terrain/` (stable; Worm uses Terrain.physics.world for body creation — already exposed)
- `src/rendering/debugDraw.ts` (renders worm fixtures automatically — no changes)

## Exact contracts

### `src/worm/aimAngle.ts`
```ts
/** Pure aim angle helpers (radians; 0 = aim right/horizontal, -PI/2 = up, +PI/2 = down). */

export const AIM_MIN = -Math.PI / 2;
export const AIM_MAX = Math.PI / 2;

/** Clamp an angle to the aim range. */
export function clampAim(angle: number): number;

/**
 * Step an angle toward a direction.
 * @param current current angle (radians)
 * @param direction -1 = rotate up, +1 = rotate down, 0 = no change
 * @param speed radians/sec
 * @param dtSeconds time step
 */
export function stepAim(current: number, direction: -1 | 0 | 1, speed: number, dtSeconds: number): number;
```

### `src/worm/fallDamage.ts`
```ts
import type { tuning } from "../tuning";

/**
 * Compute damage from a landing impulse.
 * Returns an integer HP value (0 if below threshold).
 *
 * Matches reference: threshold at `threshold * density`, linear scaling,
 * capped at `maxDamage`.
 */
export function fallDamageFromImpulse(
  normalImpulse: number,
  config: { density: number; threshold: number; maxDamage: number },
): number;
```

### `src/worm/spawnPoints.ts`
```ts
export interface SurfacePoint {
  xPx: number;
  yPx: number;   // top of terrain at this X (pixel coord)
}

/**
 * Find N spawn points evenly distributed across the terrain's surface.
 * Scans each selected column top-down for the first opaque pixel.
 * Returns [] if fewer than N columns have terrain.
 */
export function findSpawnPoints(
  data: Uint8ClampedArray,
  widthPx: number,
  heightPx: number,
  count: number,
  alphaSolid?: number,  // default 255
): SurfacePoint[];
```

Implementation: split the width into N equal slots; in each slot, scan a few X columns top-down for the first solid pixel; emit the one nearest slot center.

### `src/worm/Team.ts`
```ts
import type { Worm } from "./Worm";

export interface TeamInit {
  id: string;          // "red", "blue" etc.
  name: string;        // "Team Red"
  color: number;       // 0xff4444 - Phaser color int
}

export class Team {
  readonly id: string;
  readonly name: string;
  readonly color: number;
  readonly worms: Worm[] = [];

  constructor(init: TeamInit);
  addWorm(worm: Worm): void;
  aliveCount(): number;
  isEliminated(): boolean;
}
```

### `src/worm/Worm.ts` (the core file)

```ts
import type Phaser from "phaser";
import type { Body } from "planck";
import type { PhysicsSystem } from "../physics/PhysicsSystem";
import type { Team } from "./Team";

export interface WormInit {
  scene: Phaser.Scene;
  physics: PhysicsSystem;
  team: Team;
  spawnXPx: number;
  spawnYPx: number;
  wormName?: string;
}

export class Worm {
  readonly team: Team;
  readonly body: Body;                 // dynamic planck body (circle)
  readonly footSensor: Body;            // static child sensor via welded joint OR extra fixture on body
  readonly name: string;

  // Public state
  health: number;                       // 0..maxHealth
  aimAngle: number;                     // radians
  facing: -1 | 1;                       // walk/aim direction
  pendingDamage: number;                // accumulated; applied on next tick when stationary
  isAlive: boolean;

  // Private visual state handled internally (Phaser Graphics + Text)

  constructor(init: WormInit);

  // Movement (called by InputController)
  walk(direction: -1 | 0 | 1): void;    // -1 left, +1 right, 0 stop
  jump(): void;                         // upward + facing direction impulse
  backflip(): void;                     // upward + opposite facing, bigger impulse
  aim(direction: -1 | 0 | 1): void;     // step aim; pass 0 when idle
  setFacing(dir: -1 | 1): void;         // flips visuals

  // Health
  takeDamage(amount: number): void;     // adds to pendingDamage
  applyPendingDamage(): void;           // called from GameScene.update when world is mostly stationary
  
  // Lifecycle
  update(dtMs: number): void;           // called every frame: sync visuals to body, handle aim step, update HUD
  destroy(): void;                      // cleanup body, fixture, Phaser objects

  // Foot contact (called by world contact listener)
  onFootContactBegin(): void;
  onFootContactEnd(): void;
  private canJump(): boolean;           // true when foot contact count > 0 AND vertical velocity < small
}
```

Worm body construction:
- Type: `dynamic`
- Shape: Circle radius ~12 pixels (0.4 meters in planck)
- Density: `tuning.worm.density` (default 1.0)
- Friction: 1.0
- Restitution: 0.1
- `fixedRotation: true` (worm stays upright; no tumbling)
- `linearDamping: tuning.worm.linearDamping` (default 0.1; natural-feeling slowdown)
- Foot sensor: small box fixture beneath body `(w: radius*0.6, h: radius*0.3)` marked `isSensor: true`
- User data on body: `{ kind: "worm", worm: this }` so contact listeners can identify

Walk implementation:
```ts
walk(direction: -1 | 0 | 1): void {
  const vel = this.body.getLinearVelocity();
  const targetVx = direction * tuning.worm.walkSpeedMps;
  this.body.setLinearVelocity({ x: targetVx, y: vel.y });
  if (direction !== 0) this.setFacing(direction);
}
```

Jump implementation (matches reference impulse math):
```ts
jump(): void {
  if (!this.canJump()) return;
  const d = tuning.worm.density;
  this.body.applyLinearImpulse(
    { x: this.facing * 1.5 * d, y: -2 * 1.5 * d },
    this.body.getPosition(),
  );
}
```

Backflip (reference 2.3x, opposite facing):
```ts
backflip(): void {
  if (!this.canJump()) return;
  const d = tuning.worm.density;
  this.body.applyLinearImpulse(
    { x: -this.facing * 2.3 * d, y: -2 * 2.3 * d },
    this.body.getPosition(),
  );
}
```

Damage flash: use `scene.tweens.add({ targets: graphics, alpha: [1, 0.3, 1], duration: 300 })`.

### `src/input/InputController.ts`
```ts
import type Phaser from "phaser";
import type { Worm } from "../worm/Worm";

export interface InputControllerInit {
  scene: Phaser.Scene;
  worms: Worm[];   // all worms, alive + dead
}

export class InputController {
  private activeIndex: number;

  constructor(init: InputControllerInit);

  /** Called from GameScene.update. Polls keys, dispatches to active worm. */
  update(dtMs: number): void;

  /** Cycle to next alive worm. */
  cycleActive(): void;

  getActiveWorm(): Worm | null;   // null if all dead
}
```

Key bindings (from tuning.input; bindings below are defaults):
- LEFT / A = walk left
- RIGHT / D = walk right
- SPACE = jump
- BACKSPACE / SHIFT = backflip
- UP / W = aim up
- DOWN / S = aim down
- TAB (on keydown, not held) = cycle active

Implementation notes:
- Use Phaser's `scene.input.keyboard.addKey()` for each binding; poll `isDown` in update.
- Tab uses `Phaser.Input.Keyboard.JustDown(tabKey)` for single-fire.
- When no keys pressed in walk/aim axis, pass `0` to worm.walk/aim so it stops.

### `src/scenes/GameScene.ts` (modified)

Additions in `create()`:
```ts
// After terrain creation, extract mask data for spawn point scan
const maskImgData = this.getTerrainMaskData();
const spawnPts = findSpawnPoints(maskImgData.data, maskImgData.width, maskImgData.height, 4);

// Create 2 teams
const red = new Team({ id: "red", name: "Red", color: 0xff4444 });
const blue = new Team({ id: "blue", name: "Blue", color: 0x4488ff });

// Alternate spawns between teams
const allWorms: Worm[] = [];
spawnPts.forEach((pt, i) => {
  const team = i % 2 === 0 ? red : blue;
  const w = new Worm({
    scene: this,
    physics: this.physicsSystem,
    team,
    spawnXPx: pt.xPx,
    spawnYPx: pt.yPx - 20,  // spawn a bit above surface
    wormName: `${team.id}-${team.worms.length + 1}`,
  });
  team.addWorm(w);
  allWorms.push(w);
});

// Input
this.inputController = new InputController({ scene: this, worms: allWorms });

// Contact listener for foot sensor + fall damage
this.physicsSystem.world.on("begin-contact", this.onBeginContact);
this.physicsSystem.world.on("end-contact", this.onEndContact);
this.physicsSystem.world.on("post-solve", this.onPostSolve);
```

Additions in `update()`:
```ts
this.inputController.update(deltaMs);
for (const w of this.allWorms) w.update(deltaMs);
```

Contact handlers:
```ts
private onBeginContact = (contact: planck.Contact): void => {
  const a = contact.getFixtureA(), b = contact.getFixtureB();
  if (a.isSensor() && a.getBody().getUserData()?.kind === "worm") {
    (a.getBody().getUserData() as any).worm.onFootContactBegin();
  }
  if (b.isSensor() && b.getBody().getUserData()?.kind === "worm") {
    (b.getBody().getUserData() as any).worm.onFootContactBegin();
  }
};
// Similar for end-contact (onFootContactEnd)
// post-solve: read impulse.normalImpulses[0]; if a worm was involved, call fallDamageFromImpulse + worm.takeDamage
```

Helper `getTerrainMaskData()`: reads the terrain's canvas via `this.terrain` (need a public getter on Terrain, add one).

### `src/tuning.ts` extensions

```ts
export interface Tuning {
  world: { gravityY: number };
  weapons: { testCutRadiusPx: number };
  terrain: { rowHeight: number };
  worm: {
    radiusPx: number;        // default 12
    density: number;         // default 1.0
    walkSpeedMps: number;    // default 2.5
    aimSpeedRadPerSec: number; // default 2.0
    maxHealth: number;       // default 100
    linearDamping: number;   // default 0.1
    fallDamageThresholdImpulse: number;  // default 8 (multiplied by density at use site)
    fallDamageCapHp: number; // default 25
  };
  team: {
    wormsPerTeam: number;    // default 2
  };
  input: {
    aimCoalesceFrames: number;  // default 1 (future: touch smoothing)
  };
}

export const tuning: Tuning = {
  // ... existing ...
  worm: {
    radiusPx: 12,
    density: 1.0,
    walkSpeedMps: 2.5,
    aimSpeedRadPerSec: 2.0,
    maxHealth: 100,
    linearDamping: 0.1,
    fallDamageThresholdImpulse: 8,
    fallDamageCapHp: 25,
  },
  team: { wormsPerTeam: 2 },
  input: { aimCoalesceFrames: 1 },
};
```

### `src/debug/tuningPanel.ts` extension

Add a "Worm" folder with sliders for: `walkSpeedMps`, `aimSpeedRadPerSec`, `linearDamping`, `fallDamageThresholdImpulse`, `fallDamageCapHp`.

No onChange callback needed — these are read live on next action.

## Tests

`aimAngle.test.ts`:
- Clamps: [-π/2, π/2] exact, values beyond clamp
- Step up: moves toward -π/2 at speed
- Step down: moves toward +π/2 at speed
- Step 0: no change

`fallDamage.test.ts`:
- Below threshold (impulse < 8 * density): returns 0
- Above threshold: linear scaling
- Above cap: returns cap
- Non-integer impulse: returns rounded integer

`spawnPoints.test.ts`:
- Full mask: returns N evenly-spread points at top row with opaque pixels
- Hollow center: only left+right columns have terrain — returns fewer
- All transparent: returns []
- Single column with terrain: returns 1 point

## Commit chain (10 commits, single branch)

Worktree: `/home/scott/worms-ws1`, branch `feature/epic-4a-worm` off master.

1. `chore(tuning): extend Tuning interface for worm + team sections`
2. `feat(worm): pure aim angle helpers + Vitest tests`
3. `feat(worm): pure fall damage calc + Vitest tests`
4. `feat(worm): pure spawn point scanner + Vitest tests`
5. `feat(worm): Team class`
6. `feat(worm): Worm class (planck body + foot sensor + walk/jump/aim)`
7. `feat(input): InputController with Tab cycling + keyboard dispatch`
8. `feat(worm): fall damage + foot contact via planck contact listeners`
9. `feat(scenes): GameScene spawns teams, wires input, health HUD + tuning panel`
10. `chore: delete ported reference/ files (Worm, WormManager, Team, Player, WormAnimationManger, Controls)`
11. `docs: epic 4a plan + ROADMAP update`

(11 commits; 1 and 2-4 could batch but kept split for git history readability.)

## Verification (before pushing)

1. `npm run typecheck` exit 0
2. `npm run lint` exit 0
3. `npm run test:run` — all new tests pass (adds ~15-20 tests on top of existing 11)
4. `npm run build` produces dist/
5. `npm run dev` at http://localhost:5173:
   - 4 colored worm rectangles on terrain (2 red, 2 blue, alternating X positions)
   - Active worm is visually distinct (brighter outline or indicator above)
   - Arrow keys: walk the active worm; it walks along slopes, stays upright
   - Space: worm jumps; lands without stumbling
   - Backspace: backflip (jumps opposite of facing)
   - Up/Down: aim line rotates, clamped to horizontal-to-straight-up and horizontal-to-straight-down
   - Tab: cycles active worm (Red-1 → Red-2 → Blue-1 → Blue-2 → Red-1)
   - Click somewhere: terrain still cuts a circle (Epic 3 behavior intact)
   - Cut under a worm: worm falls; on landing, HP drops; worm flashes red; HUD above worm updates
   - Kill a worm to 0 HP: worm becomes inactive; Tab skips it
6. Backtick opens dat.gui with "Worm" folder containing walkSpeedMps, aimSpeedRadPerSec, etc.

## Auto-merge policy

**DO NOT auto-merge.** Game-logic PR; hold for review per CLAUDE.md. Scott reviews the demo manually.

Label: `needs-review`

## PR body template

```
## Summary

Closes issue #4 **partially**. First game-entity PR. Implements core worm movement on top of Epic 3 terrain per ADR-001.

**This PR (Epic 4a):**
- Worm entity (planck dynamic body + foot sensor + Phaser Graphics placeholder)
- Walk/jump/backflip/aim
- Foot sensor + contact listeners via planck's event-based API
- Fall damage on high-impulse landings
- Health HUD above each worm; red flash on damage
- Team class (id/name/color); 2 teams x 2 worms demo spawn
- InputController (arrow keys + WASD + Space + Tab to cycle)
- All constants in src/tuning.ts; dat.gui Worm folder for live tweaking

**Deferred to Epic 4b (separate PR):**
- Ninja Rope (distance joint chain; ~375 LOC in reference)
- JetPack (impulse + fuel)

Splitting reduces review surface and isolates rope-tuning risk.

## Algorithm corrections vs reference
- **Walk: velocity-based** not teleport. Reference used `body.SetPosition(currentPos + speed, ...)` every frame — works but unphysical. We set `linearVelocity.x` and let friction handle slopes.
- **Contact listener: event-based** (planck 1.5 uses `world.on("begin-contact", ...)` not the classic Box2D callback object).
- **Fall damage: post-solve event** reads `impulse.normalImpulses[0]`, applies via `fallDamageFromImpulse()` (pure, unit-tested).
- **No WormAnimationManager yet** — no sprite frames, so state machine deferred until Epic 11 (real art). Damage flash is a simple Phaser tween.
- **Flatter ownership**: GameScene -> Teams -> Worms, no Player intermediate. Player abstraction lands in Epic 5 (turns) where it's actually needed.

## Tests
- ~15 new Vitest tests for pure modules (aim clamp/step, fall damage, spawn scan)
- 11 existing terrain algorithm tests still pass

## Deleted reference files (port-then-delete convention)
- reference/src/Worm.ts, WormManager.ts, Team.ts, Player.ts, WormAnimationManger.ts, system/Controls.ts
- KEPT (Epic 4b): reference/src/weapons/NinjaRope.ts, JetPack.ts, BaseWeapon.ts

## Test plan
- [x] typecheck + lint + build + test:run pass
- [x] Dev server: 4 worms, Tab cycles, arrow keys walk, space jumps, terrain interacts (click still cuts)
- [x] Cut terrain under a worm -> fall damage; HP updates, red flash
- [ ] CI passes
- [ ] **Human review of feel** (Scott runs dev server)

Closes #4 partially (4a only); 4b tracked as follow-up.
```

## Things Sonnet MUST verify before coding

1. Run `npm install` in the worktree (planck, phaser, etc. already in package.json from Epic 3).
2. Confirm `world.on("begin-contact", ...)` is the correct planck 1.5 syntax (see `node_modules/planck/dist/planck.d.ts`). If the class World doesn't have `.on`, check for `setContactListener` alternative.
3. Confirm `Body.getUserData` / `setUserData` exist — we use these to identify worm bodies in contact events.
4. Confirm `Fixture.isSensor()` — we use this to filter contact events to foot sensors.
5. Confirm `contact.getManifold().normalImpulses` or similar path for post-solve impulse data. The original reference used `impulse.normalImpulses[0]` as a callback parameter. Verify exact shape in planck 1.5.

If any API diverges, STOP and surface. Do not `@ts-ignore`.

## Risks / gotchas

- **Foot sensor coverage**: if the sensor box is too small, worm sits on a slope edge and `canJump` is false. Tune sensor width to ~60% of worm radius.
- **Slope walking**: pure velocity-based walk with `fixedRotation: true` works on gentle slopes but may not climb steep ones. If demo shows worms stuck on slopes > 45°, adjust friction or add small upward velocity on walk.
- **Spawn point collisions**: if two spawn points land at the same X (narrow terrain), worms overlap and bounce. Spread spawn slots more aggressively or fallback to random y offsets.
- **Tab cycling on dead worms**: ensure `cycleActive()` skips dead worms cleanly (not infinite loop if all dead).
- **Damage timing**: reference applies damage only when world is stationary ("all physics settled"). For 4a simplicity, apply on every landing. If it feels weird, port the reference's gating.
- **Contact listener setup order**: register `world.on(...)` handlers AFTER PhysicsSystem exists but BEFORE any worm is created (otherwise initial contacts miss). Do in GameScene.create() right after PhysicsSystem construction.

## Epic 4b preview (not this PR)

- Ninja Rope: raycast from worm toward aim direction, place static anchor body at hit, build chain of dynamic bodies connected by distance joints (frequency 10 Hz intermediates, 25 Hz final to worm). Arrow up retracts, arrow down extends. Detach on second fire.
- JetPack: apply impulse upward (and sideways if walk keys held) while fuel remains; fuel drains at `0.09/frame`. Toggle via dedicated key. Visual flame particles.

Timing: start Epic 4b immediately after 4a lands. Same worktree pattern.
