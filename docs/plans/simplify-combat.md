# Plan: simplify combat - bazooka only + drill as utility

## Scope

Cut the combat surface to one weapon (bazooka) and three utilities (rope, jetpack, drill). Drill stops being a weapon; it becomes an instant-blast utility on the same top-left button row as rope and jetpack.

Rationale: refocus on map size + terrain variety. Worms move, position, and shoot at each other. Fancy weapon variety is deferred until the world layer (M6) is stable.

## Non-goals

- Deleting other weapon source files (`shotgun.ts`, `dynamite.ts`, `fire.ts`, `handgrenade.ts`, `holygrenade.ts`, `minigun.ts`). They stay unregistered for re-introduction in #16/#17 once the world layer settles.
- Networked drill in this PR. Drill is offline-only; the networked `executeDrill` no-ops with a console warn and a follow-up issue tracks the worker work.
- Bazooka physics changes.

## Decisions (from chat)

- Bazooka is the only registered weapon. Auto-selected at turn start (already happens via `getByKey(1)`).
- Drill ammo: infinite.
- Drill: free action. No turn end on fire. Cooldown gates spam.
- Drill flow: tap D button -> drag-to-aim -> release fires -> auto-disarm. Cuts a rotated rectangle of terrain.

## Touch-first design

Mobile-web landscape is primary (per repo CLAUDE.md). All controls work touch-first.

**Top-left button row** (`src/ui/TouchControls.ts`): three buttons stacked left-to-right at y=60.

| Button | Color | x position |
|--------|-------|------------|
| R (rope) | blue (`0x2266cc` / `0x88aaff`) | `60` |
| J (jetpack) | orange (`0xcc6600` / `0xff9933`) | `60 + radius*2 + 10` |
| D (drill) | green (`0x22aa55` / `0x66dd99`) | `60 + (radius*2 + 10)*2` |

Button radius from `tuning.touch.buttonRadiusPx` (44px). All buttons meet WCAG 44px tap target.

**Drill flow on touch**:

1. Tap D -> drill armed. Button alpha goes to `tuning.touch.buttonPressedAlpha`.
2. Existing aim-and-drag gesture activates from the worm.
3. Release fires the drill rect cut and auto-disarms.
4. Tap D again while armed: cancels (disarm without firing).
5. Cooldown: `tuning.drill.cooldownMs` (default 800ms) gates next fire.

**Keyboard** (desktop secondary):

- `D` toggles drill arm/disarm.
- `F` (or release drag) fires while drill is armed.
- Remove `1`-`7` weapon-select keys (only one weapon now).

## File-by-file changes

### Registry simplification

**`src/weapons/registry.ts`**: array becomes `[bazooka]`.

```ts
import { bazooka } from "./bazooka";
import type { WeaponConfig } from "./types";

const REGISTRY: WeaponConfig[] = [bazooka];

export function allWeapons(): WeaponConfig[] {
  return REGISTRY;
}

export function getByKey(n: number): WeaponConfig | undefined {
  return REGISTRY.find((w) => w.selectKey === n);
}

export function getById(id: string): WeaponConfig | undefined {
  return REGISTRY.find((w) => w.id === id);
}

export function defaultAmmoForMatch(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const w of REGISTRY) {
    out[w.id] = w.ammoPerMatch;
  }
  return out;
}
```

Drop the imports for `drill`, `dynamite`, `handGrenade`, `holyGrenade`, `minigun`, `shotgun`. Source files stay; just unregistered.

### Remove WeaponRadial

Delete:

- `src/ui/WeaponRadial.ts`
- `src/ui/WeaponRadial.test.ts`

In `src/scenes/GameScene.ts`:

- Remove `import { WeaponRadial } from "../ui/WeaponRadial";` (line 30)
- Remove `private weaponRadial!: WeaponRadial;` field (line 84)
- Remove `this.weaponRadial = new WeaponRadial({...})` block (around line 372)
- Remove any `weaponRadial.update()` call in `update()`
- Remove any `weaponRadial.hitsRadial(p)` gating in pointer handlers; that gate is no longer needed once the trigger is gone

### Drill utility class

**`src/utilities/Drill.ts`** (new):

```ts
import type { Worm } from "../worm/Worm";

export interface DrillCallbacks {
  onFire: (worm: Worm, angleRad: number, nowMs: number) => void;
}

export class Drill {
  private armed = false;
  private lastFiredAtMs = -Infinity;

  constructor(
    private readonly worm: Worm,
    private readonly callbacks: DrillCallbacks,
  ) {}

  arm(): void {
    this.armed = true;
  }

  disarm(): void {
    this.armed = false;
  }

  isArmed(): boolean {
    return this.armed;
  }

  isOnCooldown(nowMs: number, cooldownMs: number): boolean {
    return nowMs - this.lastFiredAtMs < cooldownMs;
  }

  /** Fire the drill at angleRad (radians). Records timestamp + auto-disarms. */
  fire(angleRad: number, nowMs: number): void {
    this.callbacks.onFire(this.worm, angleRad, nowMs);
    this.lastFiredAtMs = nowMs;
    this.armed = false;
  }

  /** Called at turn-start to clear lingering state from prior owner. */
  resetForNewTurn(): void {
    this.armed = false;
    // lastFiredAtMs stays - prevents drill spam across rapid turn rotations
  }
}
```

**`src/utilities/Drill.test.ts`** (new): cover arm/disarm/isArmed, fire calls callback with correct args, fire clears armed, cooldown gate works, resetForNewTurn clears armed.

### Tuning

**`src/tuning.ts`**: add a top-level `drill` block (sibling of `rope` and `jetpack`).

In the `Tuning` interface (around line 41):

```ts
drill: {
  /** Length of the drill rect cut, pixels. */
  lengthPx: number;
  /** Width of the drill rect cut perpendicular to aim, pixels. */
  widthPx: number;
  /** Cooldown between drill fires, ms. */
  cooldownMs: number;
};
```

In the default `tuning` value (around line 209):

```ts
drill: {
  lengthPx: 120,
  widthPx: 24,
  cooldownMs: 800,
},
```

Tune via dat.gui later; these are reasonable starting numbers (~2x bazooka explosion radius long, ~1x wide).

### Terrain rect cut

**`src/terrain/Terrain.ts`** (alongside `cutCircle`): add `cutRect`.

```ts
/**
 * Cut a rotated rectangle out of terrain. Origin is the bottom-center of the
 * rect (where the worm stands). Length extends in `angleRad` direction;
 * width is perpendicular, centered on the aim line.
 *
 * Material hardness gating applies same as cutCircle (#186).
 * Marks bodies for rebuild in the affected AABB.
 */
cutRect(
  originX: number,
  originY: number,
  lengthPx: number,
  widthPx: number,
  angleRad: number,
): void {
  const dx = Math.cos(angleRad);
  const dy = Math.sin(angleRad);
  const px = -dy;
  const py = dx;
  const halfW = widthPx / 2;

  // Compute pixel-space AABB of the rotated rect (4 corners)
  const corners = [
    [0, -halfW],
    [lengthPx, -halfW],
    [lengthPx, halfW],
    [0, halfW],
  ].map(([t, s]) => [
    originX + t * dx + s * px,
    originY + t * dy + s * py,
  ]);
  const minX = Math.floor(Math.min(...corners.map((c) => c[0])));
  const maxX = Math.ceil(Math.max(...corners.map((c) => c[0])));
  const minY = Math.floor(Math.min(...corners.map((c) => c[1])));
  const maxY = Math.ceil(Math.max(...corners.map((c) => c[1])));

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      // Project (x,y) into rect-local coords
      const lx = x - originX;
      const ly = y - originY;
      const t = lx * dx + ly * dy;
      const s = lx * px + ly * py;
      if (t < 0 || t > lengthPx) continue;
      if (s < -halfW || s > halfW) continue;
      // Apply material hardness gate (same helper as cutCircle uses)
      this.tryClearPixel(x, y);
    }
  }

  this.markChunksDirtyInAABB(minX, minY, maxX, maxY);
}
```

If `tryClearPixel` and `markChunksDirtyInAABB` aren't existing helpers, factor them out of `cutCircle` first (small refactor). Otherwise reuse the same per-pixel logic `cutCircle` uses.

**`src/terrain/TerrainRenderer.ts`** (visual-only renderer for networked mode): add a parallel `cutRect` for visual updates. Networked drill triggers this when the worker broadcasts terrain delta. Implementation mirrors `cutCircle` in TerrainRenderer.

### SimAdapter integration

**`src/sim/SimAdapter.ts`** (interface): add method.

```ts
executeDrill(wormId: string, angleRad: number): void;
```

**`src/sim/OfflineSimAdapter.ts`**: implement.

```ts
executeDrill(wormId: string, angleRad: number): void {
  const worm = this.getWormById(wormId);
  if (!worm) return;
  const { lengthPx, widthPx } = tuning.drill;
  this.terrain.cutRect(worm.x, worm.y, lengthPx, widthPx, angleRad);
  // Optional: emit a VFX event so GameScene can play dust + screen shake
  this.events.push({ kind: "drill_fire", x: worm.x, y: worm.y, angleRad, lengthPx, widthPx });
}
```

Add `drill_fire` to the `SimEvent` union in the adapter's types module.

**`src/sim/NetworkedSimAdapter.ts`**: stub.

```ts
executeDrill(_wormId: string, _angleRad: number): void {
  // Networked drill not yet implemented. See follow-up issue.
  console.warn("[drill] networked drill not yet implemented");
}
```

### Worm wiring

**`src/worm/Worm.ts`**: add `drillUtility: Drill` field.

```ts
this.drillUtility = new Drill(this, {
  onFire: (worm, angleRad, _nowMs) => sim.executeDrill(worm.id, angleRad),
});
```

The Worm constructor already has the SimAdapter handle (see how `ropeUtility` and `jetPackUtility` get wired); reuse it.

In the networked `wormFacade` factory in `GameScene.ts` (around line 1271), expose a stub `drillUtility` analogous to `stubUtility` for `ropeUtility`. Networked mode shows the button but firing is a no-op until the worker handler ships.

### TouchControls D button

**`src/ui/TouchControls.ts`**:

Extend `TouchControlsInit`:

```ts
drillEnabled?: boolean;  // default true
```

Add the button after jet (mirror the rope/jet pattern):

```ts
if (drillEnabled) {
  const drillBtn = this._makeButton({
    fillColor: 0x22aa55,
    strokeColor: 0x66dd99,
    label: "D",
    radius,
  });
  drillBtn.setPosition(leftX + (radius * 2 + 10) * 2, 60);
  this.drillBtn = drillBtn;
  this.container.add(drillBtn);

  drillBtn.setInteractive({
    hitArea: new Phaser.Geom.Circle(0, 0, radius),
    hitAreaCallback: Phaser.Geom.Circle.Contains,
  });
  drillBtn.on("pointerdown", () => {
    const w = getActiveWorm();
    if (!w) return;
    if (w.drillUtility.isArmed()) {
      w.drillUtility.disarm();
      this._setButtonAlpha(drillBtn, false);
    } else {
      // Mutually exclusive with rope/jet
      if (w.ropeUtility.isActive()) w.ropeUtility.deactivate();
      if (w.jetPackUtility.isActive()) w.jetPackUtility.deactivate();
      w.drillUtility.arm();
      this._setButtonAlpha(drillBtn, true);
    }
  });
  drillBtn.setAlpha(tuning.touch.buttonIdleAlpha);
}
```

Update `hitsButton` to include `this.drillBtn`. Add `private drillBtn: Phaser.GameObjects.Container | null = null;` field.

In `GameScene.ts`, pass `drillEnabled: true` (default) when constructing `TouchControls`. In networked mode, also true (button shows; fire warns until worker handler lands).

### Wire drill into the fire path

Find the existing pointer-release / F-key fire path in `GameScene.ts`. Add a branch BEFORE the bazooka projectile launch:

```ts
const worm = this.getActiveWorm();
if (worm?.drillUtility.isArmed()) {
  const now = this.time.now;
  if (worm.drillUtility.isOnCooldown(now, tuning.drill.cooldownMs)) {
    return;
  }
  worm.drillUtility.fire(angleRad, now);
  this._setButtonAlpha(this.touchControls.drillBtn, false);
  // Drill is a free action - do NOT trigger end-of-turn
  return;
}

// existing bazooka fire path
```

Expose `drillBtn` on TouchControls (or add a `setDrillVisualState(active)` method) so GameScene can update its alpha after a fire.

### AimHUD power-bar hide

**`src/ui/AimHUD.ts`**: when drill is armed, render the aim arrow but skip the power bar (drill length is fixed).

Pass a callback in:

```ts
isDrillArmed: () => boolean
```

In the render path:

```ts
if (!this.isDrillArmed()) {
  this.renderPowerBar(...);
}
```

### InputController

**`src/input/InputController.ts`**:

- Remove number-key weapon-select bindings (`1`-`7`).
- Add `keydown-D`:

```ts
this.scene.input.keyboard?.on("keydown-D", () => {
  const w = this.getActiveWorm();
  if (!w) return;
  if (w.drillUtility.isArmed()) {
    w.drillUtility.disarm();
  } else {
    if (w.ropeUtility.isActive()) w.ropeUtility.deactivate();
    if (w.jetPackUtility.isActive()) w.jetPackUtility.deactivate();
    w.drillUtility.arm();
  }
});
```

- Existing F-key fire stays. The fire handler in GameScene already branches on drill-armed (above).

### Turn-start hook

**`src/state/turnMachine.ts`** (or wherever turn-start fires): when a turn starts, call `worm.drillUtility.resetForNewTurn()` for the new active worm. Same place that resets weapon ammo / aim state.

## Tests

| Test | Action |
|------|--------|
| `src/weapons/WeaponManager.test.ts` | Update assertions for single-weapon registry |
| `src/weapons/drill.test.ts` | Delete (drill no longer a weapon) |
| `src/ui/WeaponRadial.test.ts` | Delete |
| `src/utilities/Drill.test.ts` | NEW: arm/disarm/fire/cooldown/reset |
| `src/terrain/Terrain.test.ts` (if exists) | Add `cutRect` cases: aligned, rotated 45deg, partial off-map clip |

Manual mobile smoke (Chrome DevTools, iPhone 12 viewport):

1. Start offline: `npm run dev` -> `?offline=1`
2. Verify R / J / D buttons render top-left
3. Tap D -> button highlights, aim arrow shows when dragging from worm
4. Drag aim, release -> rect cut visible in terrain
5. Tap D mid-armed -> disarms cleanly
6. R + J + D mutual exclusion: arming any deactivates the others

## /bugcheck before PR

Lenses:

- API contracts: SimAdapter interface change (executeDrill added)
- State/UI: drill armed state across turn rotations, R/J/D mutual exclusion
- Edge cases: drill at world edge (rect clips), drill into bedrock (material hardness blocks), drill while jet active (mutual-ex guard), drill while rope active (same)
- Regressions: bazooka fire path still works, AimHUD still draws aim arrow

## Risks

1. **Aim system coupling**: branching the fire callback to drill-vs-bazooka may need light refactor of the existing fire handler. Plan keeps it minimal (one early-return branch).
2. **TerrainRenderer parity**: networked mode's visual-only renderer also needs `cutRect` so the worker-broadcast terrain delta lands correctly. Stubbed for offline-only PR but worth filing now to avoid drift.
3. **Disarm-on-turn-end**: easy to miss; covered by `resetForNewTurn` hook.

## Follow-up issues to file

1. **Networked drill**: client + worker handler for `drill_fire` message, authoritative rect cut, terrain delta broadcast. Reference #173.
2. **Drill VFX**: dust particles + screen shake on drill fire (currently event emitted but unhandled).
3. **TerrainRenderer.cutRect**: parity with `Terrain.cutRect` so networked mode can render server-broadcast drill cuts.

## PR checklist

- [ ] Plan committed (this file)
- [ ] Registry / radial / drill / TouchControls / SimAdapter / Terrain changes land
- [ ] `npm test` passes
- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes
- [ ] Manual mobile smoke (iPhone 12 viewport)
- [ ] /bugcheck run, findings addressed
- [ ] Follow-up issues filed (networked drill, VFX, renderer parity)
- [ ] PR labeled `needs-review` (game logic + sim contract change)
