# Epic 4b: Ninja Rope + JetPack utilities + first touch overlay

## Context

Port the two utility movement tools (ninja rope, jetpack) from `reference/src/weapons/` to the modern Phaser + planck stack on top of Epic 4a. Introduces the **first touch-input overlay** per the mobile-first mandate (PR #35). Closes the remainder of [issue #4](https://github.com/scottmccarrison/worms/issues/4).

**End state**: With the active worm selected, press `R` (or tap rope button) to fire ninja rope at terrain in aim direction — worm swings freely. Arrow up/down (or pinch buttons) extend/retract. Press `R` again to detach. Press `J` (or hold jetpack button) to thrust upward; walk keys steer sideways; fuel drains; auto-deactivates at zero. On mobile landscape, both buttons visible bottom-right, tappable, not conflicting with canvas terrain-cut.

## Strategy

- **Drop `BaseWeapon` abstraction**. Minimal value, adds complexity. Define a local `Utility` interface in `src/utilities/types.ts` — rope and jetpack each implement it independently.
- **Port algorithm faithfully** from reference (raycast → static anchor → chain of intermediate dynamic bodies + DistanceJoints, freq 10 Hz intermediates / 25 Hz final, 0.5m spacing, max 40 segments, min 3).
- **Modern corrections over reference**:
  - Disable worm walk/jump while rope attached (reference didn't; feels better with)
  - Null-check `world.createJoint()` return (planck 1.5 can return null)
  - Fix "destory" typo → `destroy`
  - Rope auto-detaches on worm death OR worm cycle
- **Mutual exclusion**: rope + jetpack cannot both be active. Attempting to activate one when the other is active is rejected (no auto-detach). Keeps interaction simple.
- **Touch overlay**: Phaser Container with two circular buttons (rope, jetpack), bottom-right, depth 100, `setInteractive`. Terrain-cut handler does an `input.hitTest` first and skips if hitting a button.
- **No real art**. Placeholder: rope = white line; jetpack flame = small orange triangle; buttons = colored circles with letter labels.
- **Single worktree**.
- **Port-then-delete** reference/src/weapons/NinjaRope.ts, JetPack.ts, BaseWeapon.ts.

## Critical decisions from review

1. **Rope-worm state coupling**: when rope is attached, `worm.walk()`, `worm.jump()`, `worm.backflip()` no-op. `worm.aim()` still works. Gravity stays on (reference behavior — distance joints hold them up enough).
2. **JetPack-worm state coupling**: while jetpack active, walk keys set JetPack horizontal thrust direction instead of walking the worm. Jump/backflip no-op. Aim still works. This matches reference.
3. **Touch event routing**: Phaser's `setInteractive` marks the button's hit area. A global `scene.input.on("pointerdown", ...)` fires for EVERY pointerdown regardless. So the terrain-cut handler must manually check `pointer.downElement` OR check hit-test. Use: `const hit = scene.input.hitTestPointer(pointer); if (hit.length > 0) return;` — skip cut if any interactive object under pointer.
4. **Rope anchor on destroyed terrain**: the anchor is a separate static body; if terrain is cut under it, anchor persists. Visually odd but physically stable. Accept for MVP.
5. **Max segments**: cap extend at `tuning.rope.maxSegments = 40`. Attempting beyond = no-op.
6. **Raycast miss**: if no terrain hit, rope fire is a no-op (no ammo consumed either). Dev console log.

## File plan

```
src/
  utilities/
    types.ts                   Utility interface + shared types (RopeState, JetPackState)
    ropeRaycast.ts             Pure: given worm pos + aim, return first terrain hit or null
    ropeRaycast.test.ts        Vitest
    NinjaRope.ts               Class: fire, attach, chain build, extend/retract, detach, render
    JetPack.ts                 Class: toggle, thrust, fuel drain, render
  ui/
    TouchControls.ts           Container with rope + jetpack buttons; mobile-first
  worm/
    Worm.ts                    MODIFIED: add setActiveRope, setJetPackActive, isRoped, isJetPacking, setGravityScale
  input/
    InputController.ts         MODIFIED: rope/jetpack key bindings + touch overlay handlers
  scenes/
    GameScene.ts               MODIFIED: instantiate utilities per worm; wire update loop; touch overlay; terrain-cut hit-test
  tuning.ts                    MODIFIED: rope + jetpack + touch sections
  debug/
    tuningPanel.ts             MODIFIED: add Rope + JetPack folders

docs/plans/epic-4b-utilities.md  New: copy of this plan
docs/ROADMAP.md                  Update Epic 4 row to Done (PR link)

reference/src/weapons/NinjaRope.ts   DELETE
reference/src/weapons/JetPack.ts     DELETE
reference/src/weapons/BaseWeapon.ts  DELETE
```

## Exact contracts

### `src/utilities/types.ts`
```ts
import type { Worm } from "../worm/Worm";

/** Minimal shared contract. Rope and JetPack each implement independently. */
export interface Utility {
  readonly worm: Worm;
  isActive(): boolean;
  activate(): void;
  deactivate(): void;
  update(dtMs: number): void;
  /** Called when Worm is about to be destroyed. Should clean up all physics bodies/joints. */
  destroy(): void;
}
```

### `src/utilities/ropeRaycast.ts`
```ts
import type { World } from "planck";

export interface RaycastHit {
  pointMeters: { x: number; y: number };
  fraction: number;
}

/** Cast a ray from `fromMeters` toward `dir` (normalized) up to `maxDistanceMeters`. Returns first terrain-tagged hit or null. */
export function raycastFirstTerrain(
  world: World,
  fromMeters: { x: number; y: number },
  dir: { x: number; y: number },
  maxDistanceMeters: number,
): RaycastHit | null;
```

Implementation: call `world.rayCast(p1, p2, callback)` where p2 = p1 + dir * maxDistance. Callback returns `fraction` (clip) if hit has `kind === "terrain"` userData, else returns `1` (ignore, continue). Tracks closest hit, returns after raycast completes.

Testable via a mocked World (planck's ray cast API is simple enough to fake).

### `src/utilities/NinjaRope.ts`
```ts
import type { Body, Joint, World } from "planck";
import type { Worm } from "../worm/Worm";
import type { Utility } from "./types";

type RopeState = "inactive" | "attached";

export class NinjaRope implements Utility {
  readonly worm: Worm;
  private state: RopeState = "inactive";

  private anchor: Body | null = null;
  private readonly intermediates: Body[] = [];
  private readonly joints: Joint[] = [];
  private renderGfx: Phaser.GameObjects.Graphics;

  constructor(init: { scene: Phaser.Scene; world: World; worm: Worm });

  isActive(): boolean { return this.state === "attached"; }

  /** Fire rope in current aim direction. No-op if active or raycast misses. */
  activate(): void;

  /** Detach + clean up all bodies and joints. Idempotent. */
  deactivate(): void;

  /** Extend rope by one segment (up to maxSegments). */
  extend(): void;

  /** Retract rope by one segment (down to 3). */
  retract(): void;

  update(dtMs: number): void;   // redraws rope line every frame
  destroy(): void;               // same as deactivate, but also destroys graphics
}
```

Activate sequence:
1. If `state !== "inactive"`, return.
2. Compute aim direction from `worm.aimAngle` + `worm.facing`.
3. `raycastFirstTerrain(world, wormPosM, dir, maxDistance=tuning.rope.maxReachM)`; if null, return.
4. Create static anchor body at hit point; tag with userData `{ kind: "rope-anchor" }`.
5. Build chain:
   - N = floor(distance / `tuning.rope.segmentLengthM`)
   - For i in 1..N-1: create dynamic circle body at lerp(anchorPos, wormPos, i/N), tag userData `{ kind: "rope-segment" }`, add to `intermediates[]`.
   - Create DistanceJoints: anchor→intermediate[0], intermediate[i]→intermediate[i+1] (all with freq=intermediateFreqHz, damping=dampingRatio, length=0.02), intermediate[N-1]→worm.body (freq=finalJointFreqHz, damping=dampingRatio, length=segmentLengthM).
   - **Null-check each createJoint**. If any returns null, `deactivate()` and log error.
6. Set `worm.setActiveRope(this)`.
7. `state = "attached"`.

Extend: append one intermediate near worm, split last joint into two. Null-check joint creation.

Retract: remove last intermediate + 2 joints, rebuild 1 joint from penultimate to worm.

Update (per frame): `renderGfx.clear(); renderGfx.lineStyle(2, 0xffffff); renderGfx.beginPath(); moveTo anchor; for each intermediate draw line; lineTo worm; strokePath;`

Deactivate: destroy all joints, destroy all intermediates + anchor, clear arrays, `worm.setActiveRope(null)`, `state = "inactive"`.

### `src/utilities/JetPack.ts`
```ts
export class JetPack implements Utility {
  readonly worm: Worm;
  private active = false;
  private fuel: number;
  private flameGfx: Phaser.GameObjects.Graphics;
  private thrustDir: { x: number; y: number } = { x: 0, y: 0 };

  constructor(init: { scene: Phaser.Scene; worm: Worm });

  isActive(): boolean { return this.active; }

  /** Toggle. If active, deactivate; else activate (only if fuel > 0 and worm not roped). */
  activate(): void;

  deactivate(): void;

  /** Per-frame called from GameScene update. Applies impulse, drains fuel. */
  update(dtMs: number): void;

  /** Called by InputController: set horizontal thrust direction. */
  setHorizontalInput(direction: -1 | 0 | 1): void;

  /** Called by InputController: set vertical thrust active. */
  setVerticalInput(up: boolean): void;

  destroy(): void;
}
```

Activate: if `worm.isRoped()`, return (rejected). If `fuel <= 0`, return. Set `active = true`, `worm.setJetPackActive(true)`.

Update:
- If not active, return.
- Compute thrust: `{ x: thrustDir.x * tuning.jetpack.sideImpulse, y: (thrustDir.y < 0 ? tuning.jetpack.upwardImpulse : 0) * -1 }` (negative Y = up in canvas coords).
- If thrust magnitude > 0: `worm.body.applyLinearImpulse(thrust, worm.body.getPosition())`; drain fuel by `tuning.jetpack.fuelPerFrame`.
- If fuel <= 0: `deactivate()`.
- Update flame graphics position under worm + pulse animation.

Deactivate: `active = false`, `worm.setJetPackActive(false)`, hide flame graphics. Fuel does NOT reset (stays depleted; could refill on turn end later in Epic 5).

### `src/worm/Worm.ts` modifications

Add fields:
```ts
private activeRope: NinjaRope | null = null;
private jetPackActive = false;
```

Add methods:
```ts
setActiveRope(rope: NinjaRope | null): void;  // called by NinjaRope itself
setJetPackActive(active: boolean): void;      // called by JetPack itself
isRoped(): boolean;                            // activeRope !== null
isJetPacking(): boolean;                      // jetPackActive
setGravityScale(scale: number): void;          // passthrough to body.setGravityScale
```

Modify walk/jump/backflip to no-op when roped OR jetpacking:
```ts
walk(direction: -1 | 0 | 1): void {
  if (!this.isAlive) return;
  if (this.activeRope !== null) return;         // NEW
  if (this.jetPackActive) return;               // NEW (walk goes to JetPack.setHorizontalInput instead)
  // existing walk logic
}
```

Note: JetPack.setHorizontalInput is called FROM InputController when the active worm is jetpacking, intercepting walk keys. Existing walk dispatch in InputController routes to `worm.walk` OR `worm.jetPack.setHorizontalInput` based on state. See InputController section.

### `src/input/InputController.ts` modifications

Add key bindings:
```ts
private keyRope: Phaser.Input.Keyboard.Key;     // "R"
private keyJetPack: Phaser.Input.Keyboard.Key;  // "J"
```

Modify `update()` dispatch logic. After getting active worm:
```ts
if (worm.isRoped()) {
  // Horizontal input → rope extend/retract via up/down keys instead of walk
  // Walk keys: no-op (rope steering is via up/down only in reference; we match)
  if (this.keyUp.isDown || this.keyW.isDown) worm.activeRope.retract();
  if (this.keyDown.isDown || this.keyS.isDown) worm.activeRope.extend();
  // Jump/backflip/aim same as normal (aim still works)
} else if (worm.isJetPacking()) {
  const hDir = this.readHorizontalAxis();  // -1/0/1 from arrow + WASD
  worm.jetPack.setHorizontalInput(hDir);
  worm.jetPack.setVerticalInput(this.keyUp.isDown || this.keyW.isDown);
  // Walk/jump no-op handled inside Worm
} else {
  // Normal input
  worm.walk(this.readHorizontalAxis());
  // ... space jump, backspace backflip, aim, etc.
}

// Rope + JetPack activation (always available)
if (Phaser.Input.Keyboard.JustDown(this.keyRope)) {
  if (worm.isRoped()) worm.activeRope.deactivate();
  else if (!worm.isJetPacking()) worm.activeRope?.activate();  // NOTE: activeRope needs to be created first; see GameScene wiring
}
if (Phaser.Input.Keyboard.JustDown(this.keyJetPack)) {
  if (worm.isJetPacking()) worm.jetPack.deactivate();
  else if (!worm.isRoped()) worm.jetPack.activate();
}
```

Problem with the above: `activeRope?.activate()` — activeRope is nullable. We need a rope instance per worm. Two options:
- (a) Every worm has a pre-instantiated NinjaRope + JetPack; the classes manage their own inactive/active state (preferred, simpler)
- (b) Rope is created on fire, destroyed on detach — no pre-instance, but then activate() must be called on a NinjaRope we instantiate fresh

Go with (a). Every worm has `worm.ropeUtility: NinjaRope` and `worm.jetPackUtility: JetPack`, instantiated alongside the worm in GameScene.create(). Both stay `inactive` until activate() is called. So:

```ts
if (Phaser.Input.Keyboard.JustDown(this.keyRope)) {
  worm.ropeUtility.isActive() ? worm.ropeUtility.deactivate() : worm.ropeUtility.activate();
}
```

Also: `cycleActive()` should auto-detach the previous worm's rope AND deactivate its jetpack. Add this to InputController.cycleActive:
```ts
const prev = this.worms[this.activeIndex];
if (prev) {
  prev.ropeUtility.deactivate();
  prev.jetPackUtility.deactivate();
}
```

### `src/ui/TouchControls.ts`

```ts
export interface TouchControlsInit {
  scene: Phaser.Scene;
  getActiveWorm: () => Worm | null;
}

export class TouchControls {
  private container: Phaser.GameObjects.Container;
  private ropeBtn: Phaser.GameObjects.Container;
  private jetBtn: Phaser.GameObjects.Container;

  constructor(init: TouchControlsInit);

  /** Called by GameScene to know if a pointer is hitting a button. */
  hitsButton(pointer: Phaser.Input.Pointer): boolean;

  destroy(): void;
}
```

Button implementation:
- Container at fixed screen position (bottom-right: rope at (sceneWidth - 160, sceneHeight - 60), jetpack at (sceneWidth - 60, sceneHeight - 60))
- Circle graphic, radius `tuning.touch.buttonRadiusPx` (default 28), fill + stroke
- Text label "R" / "J"
- `setScrollFactor(0)` so they stay fixed regardless of camera (future-proof)
- `setDepth(100)` on top
- `setInteractive({ hitArea: new Phaser.Geom.Circle(0, 0, radius), hitAreaCallback: Phaser.Geom.Circle.Contains })`
- Rope button: listen to `pointerdown`; call `getActiveWorm()?.ropeUtility.activate()` or `.deactivate()` (toggle)
- JetPack button: listen to `pointerdown` (activate) + `pointerup` (deactivate) — HOLD style
- Visual state: alpha 0.6 idle, 1.0 pressed

hitsButton(pointer): return `container.input.hitArea contains local point` for either button. Used by GameScene to gate terrain cut.

### `src/scenes/GameScene.ts` modifications

In create():
1. After spawning worms, for each worm: `worm.ropeUtility = new NinjaRope({...})`, `worm.jetPackUtility = new JetPack({...})`. Both start inactive.
2. Instantiate `new TouchControls({ scene: this, getActiveWorm: () => this.inputController.getActiveWorm() })`.
3. Modify terrain-cut handler:
```ts
this.input.on("pointerdown", (p: Phaser.Input.Pointer) => {
  if (this.touchControls.hitsButton(p)) return;   // NEW
  this.terrain.cutCircle(p.x, p.y, tuning.weapons.testCutRadiusPx);
});
```

In update():
- After `inputController.update()`:
```ts
for (const w of this.allWorms) {
  w.ropeUtility.update(deltaMs);
  w.jetPackUtility.update(deltaMs);
}
```

### `src/tuning.ts` extensions

```ts
export interface Tuning {
  // ... existing ...
  rope: {
    maxReachM: number;              // default 15
    segmentLengthM: number;         // default 0.5
    maxSegments: number;            // default 40
    minSegments: number;            // default 3
    intermediateFreqHz: number;     // default 10
    finalJointFreqHz: number;       // default 25
    dampingRatio: number;           // default 5 (reference had 50 but that's unstable in planck 1.5; tune)
    intermediateRadiusM: number;    // default 0.15
  };
  jetpack: {
    fuelCapacity: number;           // default 100 (changed from reference's 20 for better UX)
    fuelPerFrame: number;           // default 0.5 (drains in ~3.3s at 60fps)
    upwardImpulse: number;          // default 1.5
    sideImpulse: number;            // default 0.8
  };
  touch: {
    buttonRadiusPx: number;         // default 28
    buttonIdleAlpha: number;        // default 0.55
    buttonPressedAlpha: number;     // default 1.0
  };
}
```

### `src/debug/tuningPanel.ts` extensions

Add folders:
```ts
const rope = gui.addFolder("Rope");
rope.add(tuning.rope, "maxReachM", 5, 30, 0.5);
rope.add(tuning.rope, "segmentLengthM", 0.2, 2, 0.05);
rope.add(tuning.rope, "intermediateFreqHz", 1, 30, 0.5);
rope.add(tuning.rope, "finalJointFreqHz", 1, 30, 0.5);
rope.add(tuning.rope, "dampingRatio", 0, 100, 1);

const jet = gui.addFolder("JetPack");
jet.add(tuning.jetpack, "fuelCapacity", 10, 500, 10);
jet.add(tuning.jetpack, "fuelPerFrame", 0.1, 5, 0.1);
jet.add(tuning.jetpack, "upwardImpulse", 0.5, 10, 0.1);
jet.add(tuning.jetpack, "sideImpulse", 0.1, 5, 0.1);
```

## Tests

`ropeRaycast.test.ts`:
- Direct hit: ray hits a terrain fixture — returns point at hit location
- No hit: ray over empty space — returns null
- Multiple hits: returns closest (smallest fraction)
- Non-terrain fixture (worm): ignored via userData.kind check

## Commit chain (10 commits, single branch)

Worktree: `/home/scott/worms-ws1`, branch `feature/epic-4b-utilities` off master.

1. `chore(tuning): extend Tuning for rope + jetpack + touch`
2. `feat(utility): Utility interface + pure ropeRaycast helper + tests`
3. `feat(utility): NinjaRope class (raycast + chain build + extend/retract)`
4. `feat(utility): JetPack class (impulse + fuel)`
5. `feat(worm): setActiveRope + setJetPackActive + setGravityScale + walk/jump guards`
6. `feat(input): rope/jetpack key bindings + state-dependent dispatch + auto-detach on cycle`
7. `feat(ui): TouchControls with rope + jetpack buttons (mobile-first)`
8. `feat(scenes): wire utilities per worm + touch overlay + terrain-cut hit-test gate`
9. `chore: delete ported reference/weapons/(NinjaRope|JetPack|BaseWeapon).ts`
10. `docs: epic 4b plan + ROADMAP update`

## Verification (before push)

1. `npm run typecheck` exit 0
2. `npm run lint` exit 0
3. `npm run test:run` all pass (new: 4 rope-raycast tests; total ~35)
4. `npm run build` exit 0
5. `npm run dev` at localhost:5173:
   - Existing: 4 worms on terrain, arrow walks, space jumps, Tab cycles, click cuts
   - **New — keyboard**:
     - R fires rope in active worm's aim direction → worm swings from a chain of circles → rope line visible
     - Up/Down while roped: extend/retract (segment count changes; visible in rope length)
     - R again: rope detaches cleanly (no stuck bodies)
     - J activates jetpack → worm lifts off → walk keys steer sideways → fuel indicator? (console log) → auto-deactivates at 0
     - R while J active: rejected (no effect)
     - J while R active: rejected
     - Tab with rope out: rope auto-detaches, new worm becomes active
   - **New — touch (Chrome DevTools mobile viewport)**:
     - iPhone 14 Pro preset, landscape orientation
     - Rope button + JetPack button visible bottom-right
     - Tap rope button: fires rope (toggle)
     - Hold jetpack button: thrust (release to stop)
     - Click in terrain area (not on buttons): still cuts terrain
     - Tap button area (not the button itself): doesn't cut terrain (container hit area correct)
   - **No console errors**
6. Mobile viewport screenshot shows both buttons visible + positioned correctly

## Auto-merge policy

**NO.** Game-logic + first touch input PR. Hold for review per CLAUDE.md. Label `needs-review`.

## Things Sonnet MUST verify before coding

1. `world.createJoint(joint)` returns `T | null` in planck 1.5. Null-check every createJoint call; on null, log + detach gracefully.
2. `setGravityScale` exists on planck Body (confirmed in recon — line 1727 of planck.d.ts).
3. `Phaser.Input.Keyboard.Key.R` exists (should — Phaser 3 exposes KeyCodes.R).
4. `scene.input.hitTestPointer(pointer)` or equivalent — if signature differs, use custom point-in-circle check.
5. Touch button `setInteractive` with Phaser.Geom.Circle hit area — confirm the 2nd-arg shape format.

If any API diverges, STOP and surface.

## Risks / gotchas

- **Rope anchor orphaned**: if player cuts the terrain where the rope anchored, anchor body persists. Visually odd but physically fine. Accept for MVP; fix in future enhancement.
- **Rope segment collisions**: intermediate dynamic bodies don't have collision filtering — they may collide with terrain during swing. Reference has same issue. If it causes visible glitches, add collision filter (category: "rope", mask: excludes terrain + worm). Defer unless needed.
- **Damping ratio tuning**: reference used `50.0` which is high. In planck 1.5, that may be unstable (overdamped to rigid). Plan starts at 5 and tunes via dat.gui.
- **Fuel UX**: no visible fuel bar yet; HUD text string added per worm OR global active-jetpack HUD. MVP: append "fuel: N" to HUD text if jetpacking.
- **Touch button positioning**: fixed at scene width/height. If scale mode changes (future responsive), buttons may drift. Use `this.scale.width` / `this.scale.height` on resize events. Defer resize handling — scale is fixed 1280×720.
- **Rope detach on worm death**: in `Worm.destroy()`, call `ropeUtility.destroy()` and `jetPackUtility.destroy()` first so all joints/bodies are cleaned up before the worm body goes.

## PR body template

```
## Summary

Closes #4 fully (4a shipped core; 4b ships ninja rope + jetpack utilities). Also introduces the first touch input overlay per the mobile-first mandate (PR #35).

**This PR:**
- `src/utilities/NinjaRope.ts` — raycast from worm toward aim; static anchor at terrain hit; chain of intermediate dynamic circles + planck DistanceJoints (freq 10 Hz intermediates, 25 Hz final-to-worm); extend/retract via add/remove segments; detach on second fire or cycle.
- `src/utilities/JetPack.ts` — toggle; upward + sideways impulse per frame; fuel drains; auto-deactivates at 0.
- `src/utilities/ropeRaycast.ts` — pure unit-tested helper.
- `src/ui/TouchControls.ts` — first on-screen touch overlay; rope button (tap to toggle) + jetpack button (hold to thrust); positioned bottom-right.
- `src/worm/Worm.ts` modified: setActiveRope / setJetPackActive / isRoped / isJetPacking / setGravityScale; walk/jump/backflip no-op when roped or jetpacking.
- `src/input/InputController.ts` modified: R/J key bindings; state-dependent dispatch (rope swinging uses up/down for extend/retract, jetpacking uses walk keys for steer); cycleActive auto-detaches rope + jetpack.
- `src/scenes/GameScene.ts` modified: instantiates utilities per worm, runs their update loop, adds terrain-cut hit-test gate for touch buttons.
- Tuning sections + dat.gui folders for rope + jetpack.

## Corrections vs reference
- Worm walk/jump disabled when roped (reference didn't)
- `createJoint` null-checked (planck 1.5 can return null)
- Typo "destory" → "destroy"
- Rope auto-detaches on worm cycle (reference didn't)
- Damping ratio lowered from 50 → 5 for planck 1.5 stability

## Mobile-first
Chrome DevTools iPhone 14 Pro landscape tested. Rope + JetPack buttons visible + tappable. Terrain cut still works outside button area.

## Test plan
- [x] typecheck + lint + build + tests pass (new: 4 rope-raycast tests)
- [x] Dev: rope fires + swings + extends/retracts + detaches; jetpack thrusts + drains + auto-deactivates
- [x] Mobile viewport: touch buttons work; no conflict with terrain cut
- [ ] CI passes
- [ ] Human review of feel (rope damping tuning, jetpack acceleration)

Closes #4
```
