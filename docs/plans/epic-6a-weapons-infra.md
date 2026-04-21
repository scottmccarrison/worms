# Epic 6a: Weapon infrastructure + 3 reference weapons

## Context

Parent issue: #6 (Port weapon system, 8 weapons + Bazooka). This PR is 6a: the infrastructure + one weapon per archetype to prove the pipeline end-to-end. 6b lands the remaining weapons as pure data-file additions.

Until now, worms can only kill each other via fall damage (Epic 4) and the "click to cut terrain" dev affordance (Epic 3). Epic 5 added turn flow but there is no way to end a turn by firing. Epic 6a wires the missing piece: three weapons covering the three archetypes in the reference code.

- **Hitscan**: Shotgun. Raycast, stop at first hit, explosion at hit point. 2 shots per turn then end.
- **Throwable**: HandGrenade. Arcing projectile, fuse, bounce, explosion on detonation.
- **Projectile**: Bazooka. Direct projectile, no fuse, detonate on terrain/worm contact. No wind for MVP.

These three exercise every subsystem Epic 6b will reuse: projectile physics bodies, contact-based detonation, fuse timers, hitscan raycasts, explosion (terrain cut + radial damage + impulse), weapon select UI, ammo tracking, turn-end on fire, self-damage detection.

## Strategy

- **One worktree (`~/worms-ws2`), one PR, one Sonnet agent**. Same shape as Epic 4a/5. Not splitting 6a internally since the pieces are tightly coupled.
- **Data-driven weapons** per CLAUDE.md drop-in philosophy. Each weapon is a config object + (for projectiles) a short behavior override. A new weapon in 6b = one `src/weapons/<name>.ts` file plus adding it to the manager registry. No touching engine code.
- **Placeholder primitives for MVP**. Projectiles are colored Phaser Graphics circles; weapon icons are colored squares with a letter label. Real sprites land in Epic 11. Zero asset debt.
- **No retreat timer**. Firing immediately transitions turnActive -> turnEnding. Retreat timer is a post-MVP enhancement issue filed during this epic.
- **Self-damage via projectile ownership**. Every projectile/shot carries the firer Worm. On impact, the explosion damage function takes the firer as an argument; if the active worm takes any damage from their own shot, `TurnManager.reportSelfDamage()` is called (no-op in 6a since the turn is already ending; wired for future retreat timer).
- **Explosion as a pure function** over world + terrain, not a class. Keeps the call site obvious: `explode({ world, terrain, centerPx, terrainRadiusPx, damageRadiusPx, maxDamage, impulseMag, firedBy })`. Pure-function shape also makes Vitest unit tests trivial.
- **Touch-first**: bottom weapon drawer with 3 tappable icons (one per weapon in 6a). Tap to select. Drag from active worm anywhere on screen to aim + power (direction = vector from worm, length = power up to cap). Release to fire. Keyboard is additive: 1/2/3 select, F fires at current aim/power, Up/Down aim, Left/Right adjust power.
- **Invoke `/frontend-design` for the weapon drawer + aim reticle HUD** per CLAUDE.md (UI-touching epic).
- **Port-then-delete**: remove the 12 ported reference files in this PR (the 3 archetype bases + Shotgun + HandGrenade + Bazooka code inside ProjectileWeapon.ts get replaced; plus the 6 weapon files we defer to 6b stay in reference/ until 6b ports them).

## Scope (strict)

**In scope:**
- Weapon registry + data shape (`src/weapons/types.ts`, `src/weapons/registry.ts`)
- Three weapon configs: Bazooka, Shotgun, HandGrenade
- Projectile system: dynamic body spawn, contact-based detonation, fuse timer, auto-destroy
- Hitscan: planck raycast helper
- Explosion function: terrain cut + AABB damage query + radial impulse + firer tracking
- WeaponManager class (per-worm ammo, select state)
- Weapon select UI (keyboard 1/2/3 + F, touch drawer bottom of screen)
- Aim HUD: reticle at aim angle + power meter overlay
- InputController hook: F or touch-release fires current weapon
- Turn-end on fire via `TurnManager.endTurnByPlayer()`
- Self-damage reporting hook (wired, no-op behavior for now)
- Vitest: 6 unit tests covering explosion math, ammo decrement, hitscan raycast wrapper, projectile fuse
- dat.gui tuning for new weapon + explosion knobs
- Delete reference/src/weapons/{Shotgun.ts, HandGrenade.ts, ProjectileWeapon.ts (Bazooka lives inside), RayWeapon.ts, ThrowableWeapon.ts, ForceIndicator.ts, WeaponManager.ts}

**Out of scope (explicit):**
- HolyGrenade, Dynamite, Minigun, Drill, LandMine, Blowtorch (all 6b or post-MVP)
- Retreat timer (file post-MVP enhancement issue)
- Wind mechanic (post-MVP; enhancement #19 already filed)
- Real weapon sprites/icons/audio (Epic 11/12)
- Recoil / firer knockback (post-MVP polish)
- Weapon charge states via xstate (overkill for 3 weapons; lift to xstate in 6b if complexity warrants)
- Mobile orientation splash (already handled upstream)

## Critical decisions

1. **Weapon config shape is the product's spine**. Everything data-driven hangs off it. Settled shape:

   ```typescript
   export type WeaponArchetype = "hitscan" | "projectile" | "throwable";

   export interface WeaponConfig {
     id: string;                     // "bazooka"
     name: string;                   // "Bazooka"
     archetype: WeaponArchetype;
     ammoPerMatch: number;           // -1 = infinite
     selectKey: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
     iconColor: number;              // placeholder color for UI icon
     iconLabel: string;              // placeholder letter/abbrev
     projectileColor?: number;       // for projectile/throwable: in-world graphic color
     projectileRadiusPx?: number;    // projectile body size
     fuseMs?: number;                // throwable only
     restitution?: number;           // throwable only (bounce)
     shotsPerActivation?: number;    // hitscan only (Shotgun=2, Minigun set by 6b)
     powerCapMps?: number;           // projectile/throwable muzzle velocity at full power
     explosion: {
       terrainRadiusPx: number;
       damageRadiusPx: number;
       maxDamage: number;
       impulseMag: number;
     };
   }
   ```

   Unique behavior (e.g., homing missiles in 6b+) goes in an optional `behavior?: (ctx) => void` hook. Not used in 6a.

2. **Projectile lifetime is managed by a `ProjectileManager`**, not by each weapon. The manager owns the list of in-flight projectiles, ticks their fuses, handles contacts via its own shared beginContact listener, and defers `world.destroyBody()` to after the physics step. This keeps the "contact handler mutating world" footgun in exactly one place.

3. **One shared `explode()` function** takes (world, terrain, centerMeters, config, firedBy). It (a) calls `terrain.cutCircle` for terrain damage, (b) runs a `world.queryAABB` over the damage radius, and for each dynamic body whose center is inside the radius applies `takeDamage(falloff * maxDamage)` + `applyLinearImpulse`. Firer is passed through so we can track self-damage.

4. **Hitscan fires immediately, no pre-fire delay**. No pump animation (sprite pass, Epic 11). Shotgun fires shot 1 on F; if the player taps F again within the turn, shot 2 fires. Turn ends after shot 2 (per reference: shotsPerActivation=2). Any weapon with `shotsPerActivation > 1` keeps the turn alive until the shot count is reached, then ends.

5. **Throwable fuse starts on spawn (throw), not on arm**. Classic behavior mimicked; simpler than cookable grenades.

6. **Power/aim**: active worm has an aim angle (already exists, Epic 4) and a new `aimPower01: number` (0..1) that the active weapon consumes on fire. Keyboard: Left/Right adjust power in 0.05 increments while F is NOT JustDown. Touch: drag from active worm; vector length (capped at 200px) maps to power; release = fire.

7. **Ammo lives on a per-team WeaponManager**, not per-worm or per-weapon. Reference had it per-team; keeps it simple for multiplayer. Both teams start with `ammoPerMatch` of each weapon. Infinite weapons (Shotgun set to -1 for playtest simplicity, revisit in 6b) never decrement.

8. **Fire lockout during non-turnActive**. `InputController.inputAllowed` already gates this. No extra state needed.

9. **Weapon drawer touch button hit-testing**. Follows the TurnHUD/TouchControls pattern: drawer exposes `hitsIcon(pointer): boolean`; GameScene `pointerdown` chain checks `turnHUD.hitsButton(p) || touchControls.hitsButton(p) || weaponDrawer.hitsIcon(p)` before doing the test cut.

10. **Drag-to-aim works from anywhere on the canvas, not just from the worm sprite**. Reason: worms are 12px radius; fat-finger tolerance is zero. Drag starts anywhere that isn't a HUD button, vector is computed relative to the active worm's world position.

11. **Drag cancel**: if drag distance < 8px at release, treat as tap (no fire, no aim change). If drag started on a HUD button, the HUD owns the gesture and the aim system ignores it.

12. **Dev escape hatch**: the "click to cut terrain" affordance stays for now. Moved from `pointerdown` to Shift+click so it doesn't fight the drag-to-aim gesture. Will be removed in Epic 7 (real maps).

## File plan

### New files

```
src/weapons/
  types.ts               Archetype enum + WeaponConfig + ExplosionConfig types
  registry.ts            Weapon registry, id -> WeaponConfig lookup
  bazooka.ts             WeaponConfig for Bazooka
  shotgun.ts             WeaponConfig for Shotgun
  handgrenade.ts         WeaponConfig for HandGrenade
  WeaponManager.ts       Per-team ammo + selected weapon state
  ProjectileManager.ts   Owns in-flight projectiles, tick fuses, handle contact, defer destroy
  explode.ts             Pure explode() function (terrain cut + AABB damage + impulse)
  hitscan.ts             raycastFirstHit() planck wrapper
  fire.ts                fire() dispatches on archetype, returns FireResult { turnEndsImmediately: bool, shotsRemaining: number }
  explode.test.ts        Vitest: falloff math, self-damage flag, terrain cut called
  hitscan.test.ts        Vitest: raycast returns closest hit, handles no-hit

src/ui/
  WeaponDrawer.ts        Bottom-of-screen weapon icon row, tap to select, current-weapon highlight
  AimHUD.ts              Reticle + power meter (Phaser Graphics), follows active worm

docs/plans/
  epic-6a-weapons-infra.md  (this file)

docs/guides/
  adding-a-weapon.md     Drop-in guide promised by CLAUDE.md (currently missing)
```

### Modified files

```
src/tuning.ts            Add tuning.weapons.{defaultPowerStepsPerSec, dragMaxLengthPx, dragDeadZonePx}; explosion defaults
src/worm/Worm.ts         Add `aimPower01: number = 0.5` + setAimPower(), nudgeAimPower(delta)
src/input/InputController.ts  Bind keys 1/2/3 (select), F (fire), Left/Right (power) in normal state
src/ui/TouchControls.ts  No layout change; expose `hitsButton(p)` is already there
src/scenes/GameScene.ts  Instantiate ProjectileManager, WeaponManager (one per team), WeaponDrawer, AimHUD; wire into update loop; add pointerdown drag-to-aim state machine; gate pointer chain
src/debug/tuningPanel.ts  Add Weapons folder for tweakables
```

### Deletions (port-then-delete)

```
reference/src/weapons/Shotgun.ts
reference/src/weapons/HandGrenade.ts
reference/src/weapons/ProjectileWeapon.ts           # Bazzoka class lives here; ported to bazooka.ts
reference/src/weapons/RayWeapon.ts
reference/src/weapons/ThrowableWeapon.ts
reference/src/weapons/ForceIndicator.ts             # replaced by AimHUD power meter
reference/src/weapons/WeaponManager.ts              # ported to src/weapons/WeaponManager.ts
```

HolyGrenade, Dynamite, Minigun, Drill, LandMine, Blowtorch files stay in `reference/` for 6b.

## Detailed specs

### `src/weapons/types.ts`

```typescript
export type WeaponArchetype = "hitscan" | "projectile" | "throwable";

export interface ExplosionConfig {
  terrainRadiusPx: number;
  damageRadiusPx: number;
  maxDamage: number;
  impulseMag: number;
}

export interface WeaponConfig {
  id: string;
  name: string;
  archetype: WeaponArchetype;
  ammoPerMatch: number; // -1 infinite
  selectKey: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  iconColor: number;
  iconLabel: string;
  projectileColor?: number;
  projectileRadiusPx?: number;
  fuseMs?: number;
  restitution?: number;
  shotsPerActivation?: number;
  powerCapMps?: number;
  explosion: ExplosionConfig;
}

export interface FireContext {
  world: import("planck").World;
  terrain: import("../terrain/Terrain").Terrain;
  firer: import("../worm/Worm").Worm;
  aimRadians: number;
  aimPower01: number; // 0..1
  projectileManager: import("./ProjectileManager").ProjectileManager;
}

export interface FireResult {
  turnEndsImmediately: boolean;
  shotsRemaining: number;
}
```

### `src/weapons/bazooka.ts`

```typescript
import type { WeaponConfig } from "./types";

export const bazooka: WeaponConfig = {
  id: "bazooka",
  name: "Bazooka",
  archetype: "projectile",
  ammoPerMatch: -1, // infinite for 6a playtest
  selectKey: 1,
  iconColor: 0x8b5a2b,
  iconLabel: "B",
  projectileColor: 0xcc9966,
  projectileRadiusPx: 5,
  powerCapMps: 20,
  explosion: {
    terrainRadiusPx: 45,
    damageRadiusPx: 60,
    maxDamage: 50,
    impulseMag: 60,
  },
};
```

### `src/weapons/shotgun.ts`

```typescript
import type { WeaponConfig } from "./types";

export const shotgun: WeaponConfig = {
  id: "shotgun",
  name: "Shotgun",
  archetype: "hitscan",
  ammoPerMatch: -1,
  selectKey: 2,
  iconColor: 0x444444,
  iconLabel: "S",
  shotsPerActivation: 2,
  explosion: {
    terrainRadiusPx: 20,
    damageRadiusPx: 30,
    maxDamage: 25,
    impulseMag: 30,
  },
};
```

### `src/weapons/handgrenade.ts`

```typescript
import type { WeaponConfig } from "./types";

export const handGrenade: WeaponConfig = {
  id: "handgrenade",
  name: "Grenade",
  archetype: "throwable",
  ammoPerMatch: -1,
  selectKey: 3,
  iconColor: 0x3a5f2e,
  iconLabel: "G",
  projectileColor: 0x8fbf6b,
  projectileRadiusPx: 6,
  fuseMs: 3000,
  restitution: 0.55,
  powerCapMps: 14,
  explosion: {
    terrainRadiusPx: 40,
    damageRadiusPx: 60,
    maxDamage: 45,
    impulseMag: 55,
  },
};
```

### `src/weapons/registry.ts`

Thin module exporting the registry + helpers. One `WeaponConfig[]` with all 3 configs in select-key order; `getByKey(n)` / `getById(s)` lookups; `allWeapons()` for iteration.

### `src/weapons/explode.ts`

```typescript
import type { World } from "planck";
import type { Terrain } from "../terrain/Terrain";
import type { Worm } from "../worm/Worm";
import type { ExplosionConfig } from "./types";
import { toMeters } from "../physics/scale";

export interface ExplodeParams {
  world: World;
  terrain: Terrain;
  centerPx: { x: number; y: number };
  config: ExplosionConfig;
  firedBy: Worm | null; // null = environmental (e.g. future landmine)
}

export interface ExplodeResult {
  damagedWorms: { worm: Worm; amount: number }[];
  selfDamageTaken: number;
}

export function explode(p: ExplodeParams): ExplodeResult { ... }
```

Algorithm:
1. `terrain.cutCircle(centerPx.x, centerPx.y, config.terrainRadiusPx)`
2. Build AABB around centerMeters with half-size = `toMeters(damageRadiusPx)`
3. `world.queryAABB(aabb, fixture => {...})` - for each fixture whose body has `userData.kind === "worm"`:
   - Distance from body center to explosion center (meters)
   - If distance > damageRadius: return true (skip)
   - Falloff: `amount = maxDamage * max(0, 1 - distance / damageRadius)`
   - `worm.takeDamage(round(amount))`
   - Impulse direction = unit vector from center to worm; `body.applyLinearImpulse({x: dx*impulseMag, y: dy*impulseMag}, body.getPosition())`
   - If `worm === firedBy`: accumulate `selfDamageTaken += amount`
   - Push to `damagedWorms` list
4. Return result

### `src/weapons/hitscan.ts`

```typescript
export interface RaycastHit {
  fixture: import("planck").Fixture;
  pointPx: { x: number; y: number };
  normal: { x: number; y: number };
}

export function raycastFirstHit(
  world: import("planck").World,
  fromPx: { x: number; y: number },
  toPx: { x: number; y: number },
): RaycastHit | null {
  let closest: RaycastHit | null = null;
  let closestFrac = 1;
  world.rayCast(
    { x: toMeters(fromPx.x), y: toMeters(fromPx.y) },
    { x: toMeters(toPx.x),   y: toMeters(toPx.y) },
    (fixture, point, normal, fraction) => {
      if (fraction < closestFrac) {
        closestFrac = fraction;
        closest = {
          fixture,
          pointPx: { x: toPixels(point.x), y: toPixels(point.y) },
          normal: { x: normal.x, y: normal.y },
        };
      }
      return fraction; // clip and keep searching for closer
    },
  );
  return closest;
}
```

Exclude firer's own body from the first hit (otherwise a shotgun at aim=0 hits the firer's own foot sensor). Achieved by filtering `fixture.getBody() === firerBody` inside the callback and returning `-1` to skip it.

### `src/weapons/ProjectileManager.ts`

Owns the in-flight projectile list. One contact listener, one per-frame tick.

```typescript
interface ActiveProjectile {
  body: Body;
  graphic: Phaser.GameObjects.Graphics;
  spawnedAt: number;           // ms
  fuseMs: number | null;       // null = contact-only
  weapon: WeaponConfig;
  firer: Worm;
  detonated: boolean;          // guard against double-detonate
}

class ProjectileManager {
  spawn(args: { weapon, firer, originPx, velocityMps, fuseMs }): void;
  update(deltaMs: number): void;   // tick fuses; sync graphic to body
  // internal: onContactBegin -> queue detonation; flushed in update()
}
```

`update` order in GameScene: `physicsSystem.step` -> `terrain.flushPendingCuts` -> `projectileManager.update` -> apply damage -> turnManager.update -> input -> etc. The detonation flush happens AFTER physics step (safe to `destroyBody`) and BEFORE damage-apply (so damage hits this same frame).

### `src/weapons/fire.ts`

```typescript
export function fire(weapon: WeaponConfig, ctx: FireContext, ammoCountBefore: number): FireResult {
  switch (weapon.archetype) {
    case "hitscan": return fireHitscan(weapon, ctx);
    case "projectile": return fireProjectile(weapon, ctx);
    case "throwable": return fireThrowable(weapon, ctx);
  }
}
```

Projectile spawn:
- spawn position = worm center + (cos(aim) * (r + projectileR + 2), sin(aim) * (r + projectileR + 2))
- velocity = (cos(aim) * power * powerCap, sin(aim) * power * powerCap)
- `projectileManager.spawn({ ..., fuseMs: null })` for Bazooka (contact detonate)
- For HandGrenade: same but `fuseMs: weapon.fuseMs!` and restitution on body fixture

Hitscan:
- Endpoint = origin + unit(aim) * 2000px (off-screen)
- `raycastFirstHit(world, originPx, endPx, excludeBody=firer.body)`
- If hit: `explode({ centerPx: hit.pointPx, config: weapon.explosion, firedBy: firer })`
- If no hit: no-op
- Return `{ turnEndsImmediately: (shotsFired >= weapon.shotsPerActivation!), shotsRemaining: weapon.shotsPerActivation! - shotsFired }`

### `src/weapons/WeaponManager.ts`

```typescript
class WeaponManager {
  constructor(team: Team, initialAmmo: Record<string, number>) {}
  getSelected(): WeaponConfig;
  select(id: string): void;
  ammoFor(id: string): number; // -1 infinite
  consumeOne(id: string): void;
  shotsFiredThisActivation: number; // resets on turn end
  resetActivation(): void;           // called on turn start by GameScene
}
```

One instance per team. GameScene owns a `Map<Team, WeaponManager>` and reads the firing team's manager on fire.

### `src/ui/WeaponDrawer.ts`

Bottom-center horizontal row of N icons (N=3 for 6a). Each icon is a rounded Phaser.Graphics rectangle 56x56 px (44px minimum tap target + padding). Label text centered. Current selection has yellow ring + white text; others dimmed.

Public API:
```typescript
class WeaponDrawer {
  constructor({ scene, weapons, onSelect, getAmmo, getSelectedId });
  update(): void; // call per frame to refresh ammo text + selection state
  hitsIcon(p: Phaser.Input.Pointer): boolean;
  destroy(): void;
}
```

**/frontend-design invocation**: design the drawer visuals with the skill (rounded corners, subtle shadow, team-color frame on selected, smooth select-animation). Don't ship a bare rectangle row.

### `src/ui/AimHUD.ts`

Phaser.Graphics drawing (every frame via GameScene.update):
- Arrow pointing from active worm center at current aim angle, length scaled by power (min 20px, max 80px)
- Small power bar below active worm (20px wide, fills based on aimPower01)
- Yellow = live aim; white tick mark at 100% power

Hidden when input is disallowed (turn ending, game over). Hidden while rope/jetpack active (reuses existing `worm.isRoped()` check).

### `src/scenes/GameScene.ts` modifications

Add after worm setup:
```typescript
this.projectileManager = new ProjectileManager({
  scene: this,
  world: this.physicsSystem.world,
  terrain: this.terrain,
  onDetonate: (firer, selfDamage) => {
    if (selfDamage > 0 && firer === this.inputController.getActiveWorm()) {
      this.turnManager.reportSelfDamage(selfDamage);
    }
  },
});

this.weaponManagers = new Map();
for (const team of this.teams) {
  this.weaponManagers.set(team, new WeaponManager(team, defaultAmmoForMatch()));
}

this.weaponDrawer = new WeaponDrawer({
  scene: this,
  weapons: allWeapons(),
  onSelect: (id) => this.getActiveWeaponManager()?.select(id),
  getAmmo: (id) => this.getActiveWeaponManager()?.ammoFor(id) ?? 0,
  getSelectedId: () => this.getActiveWeaponManager()?.getSelected().id ?? "",
});

this.aimHUD = new AimHUD({ scene: this, getActiveWorm: () => this.inputController.getActiveWorm() });
```

Replace pointerdown handler with drag-to-aim state machine:
```typescript
let dragStart: { x: number; y: number } | null = null;
this.input.on("pointerdown", (p) => {
  if (this.turnHUD.hitsButton(p)) return;
  if (this.touchControls.hitsButton(p)) return;
  if (this.weaponDrawer.hitsIcon(p)) return;
  if (p.event?.shiftKey) {
    this.terrain.cutCircle(p.x, p.y, tuning.weapons.testCutRadiusPx);
    return;
  }
  dragStart = { x: p.x, y: p.y };
});
this.input.on("pointermove", (p) => {
  if (!dragStart) return;
  const worm = this.inputController.getActiveWorm();
  if (!worm) return;
  // vector from worm -> current pointer, capped
  const dx = p.x - worm.xPx; const dy = p.y - worm.yPx;
  const mag = Math.hypot(dx, dy);
  const cap = tuning.weapons.dragMaxLengthPx;
  const power = Math.min(1, mag / cap);
  worm.setAimAngle(Math.atan2(dy, dx * worm.facing)); // Worm exposes xPx, yPx, setAimAngle
  worm.setAimPower(power);
});
this.input.on("pointerup", (p) => {
  if (!dragStart) return;
  const dragDist = Math.hypot(p.x - dragStart.x, p.y - dragStart.y);
  dragStart = null;
  if (dragDist < tuning.weapons.dragDeadZonePx) return; // tap, no fire
  this.tryFireActiveWeapon();
});
```

`tryFireActiveWeapon()` is a private method that: reads the active team's WeaponManager, calls `fire()` with the context, consumes ammo, and calls `turnManager.endTurnByPlayer()` if `result.turnEndsImmediately`.

### `src/input/InputController.ts` modifications

Add in `update()` normal-movement branch (inside the `else` at line 155):
```typescript
// Weapon select keys 1/2/3 (inactive during rope/jetpack for safety)
if (Phaser.Input.Keyboard.JustDown(this.key1)) this.onSelectWeapon(1);
else if (Phaser.Input.Keyboard.JustDown(this.key2)) this.onSelectWeapon(2);
else if (Phaser.Input.Keyboard.JustDown(this.key3)) this.onSelectWeapon(3);

// F fires
if (Phaser.Input.Keyboard.JustDown(this.keyFire)) {
  this.onFire();
}

// Aim power adjust (Left/Right in normal state ONLY when no walk dir)
// Walks take priority; power adjust happens if Shift held
if (this.keyShift.isDown) {
  if (this.keyLeft.isDown) worm.nudgeAimPower(-0.02);
  else if (this.keyRight.isDown) worm.nudgeAimPower(+0.02);
} else {
  worm.walk(walkDir);
}
```

Add constructor fields + options: `onSelectWeapon: (n: 1|2|3) => void`, `onFire: () => void`.

Note: Shift is currently bound to backflip. Conflict. Resolution: keep Shift = backflip when no arrow keys held; Shift + Left/Right = power adjust. Actually cleaner: rebind power adjust to `[` and `]` (common in artillery games) and keep Shift = backflip unchanged. Decided: `[` and `]`.

### `src/tuning.ts`

```typescript
weapons: {
  testCutRadiusPx: 40,
  dragMaxLengthPx: 200,          // drag distance that maps to 100% power
  dragDeadZonePx: 8,             // below this: tap, not drag
  powerStepPerPress: 0.05,       // keyboard [/] power step
  ammo: { bazooka: -1, shotgun: -1, handgrenade: -1 },  // -1 infinite
},
```

Existing `testCutRadiusPx` preserved (Shift+click test tool).

### `src/worm/Worm.ts` additions

```typescript
aimPower01 = 0.5;

setAimAngle(rad: number): void {
  // Clamp to [-PI/2, +PI/2]; facing handled by caller
  this.aimAngle = clampAim(rad);
}

setAimPower(p: number): void {
  this.aimPower01 = Math.max(0, Math.min(1, p));
}

nudgeAimPower(delta: number): void {
  this.setAimPower(this.aimPower01 + delta);
}

// Add xPx, yPx getters (pixels; already computed during update() - cache)
get xPx(): number { return toPixels(this.body.getPosition().x); }
get yPx(): number { return toPixels(this.body.getPosition().y); }
```

Worm renders the power bar via AimHUD (external), not in Worm itself.

### `src/state/TurnManager.ts` addition

One small public method. No machine changes.

```typescript
reportSelfDamage(amount: number): void {
  // 6a: no-op placeholder. 6b+ may use for retreat-timer override.
  this.lastSelfDamageAmount = amount;
}
```

## Tests (Vitest)

Create `src/weapons/explode.test.ts`:
- `explode()` calls `terrain.cutCircle` with correct radius
- At distance 0, worm takes `maxDamage`
- At distance = damageRadius, worm takes 0
- Firer self-damage is tracked separately in result
- Out-of-radius worm is untouched

Create `src/weapons/hitscan.test.ts`:
- `raycastFirstHit` returns null when nothing between from/to
- Returns the closer of two fixtures on the ray
- Excludes firer's own body

Create `src/weapons/WeaponManager.test.ts`:
- Fresh manager has correct initial ammo
- `consumeOne` decrements finite weapons, leaves -1 as -1
- `select` only succeeds if ammo > 0 (or -1)
- `resetActivation` clears `shotsFiredThisActivation`

Create `src/weapons/fire.test.ts`:
- Hitscan with `shotsPerActivation=2` first call returns `turnEndsImmediately: false`; second returns true
- Projectile fire spawns one projectile in ProjectileManager
- Throwable spawns projectile with fuse

Both `explode.test.ts` and `fire.test.ts` use a Vitest test helper that builds a bare planck World + minimal Terrain double. Terrain double records cut-calls without rendering.

**Target: 45 -> 60+ tests on green.**

## Touch-first design

- **Primary**: drag from anywhere on canvas (not HUD) to set aim angle + power; release to fire. Gesture uses the active worm's world position as the drag origin. This mirrors classic mobile artillery games.
- **Weapon select**: bottom-center drawer with 3 icons, 56x56px each, ~8px gap. Tappable anywhere in the icon's geometric bounds. Active weapon gets a yellow ring. Ammo count shown as small white text on the icon (hidden for infinite weapons in 6a).
- **Visual feedback during drag**: AimHUD's arrow + power bar update in real-time. Strong visual signal that "this is your aim".
- **Tap deadzone**: 8px to cancel accidental micro-drags.
- **Conflicts with End Turn button (top-right)**: End button has its own hit area, evaluated first in pointerdown chain.
- **Conflicts with rope/jetpack touch buttons (bottom-right)**: same; hit area checked first.
- **Dev escape**: Shift+click = test cut. Will be removed in Epic 7.

Keyboard layer (additive):
- `1`, `2`, `3`: select weapon by slot
- `[`, `]`: power down / up in 0.05 increments (new binding, does not conflict)
- `Up`, `Down` / `W`, `S`: aim (existing)
- `Left`, `Right` / `A`, `D`: walk (existing)
- `F`: fire current weapon at current aim + power
- `Enter`: end turn (unchanged)
- `Tab`: cycle worm within team (unchanged)
- `R`, `J`: rope/jetpack toggle (unchanged)
- `Space`: jump (unchanged)
- `Shift`/`Backspace`: backflip (unchanged)

**Mobile viewport testing in Chrome DevTools**: plan doc is blocked for merge until manual verification in iPhone 12 landscape + Pixel 6 landscape emulation. Must verify: (1) drag-to-aim works smoothly, (2) drawer icons are tappable with a thumb, (3) no accidental terrain cuts when drag-aiming near the ground, (4) End Turn + Rope/Jet buttons still accessible, (5) visual frame rate is stable (>= 55fps avg).

## Skills to invoke during build

- **/frontend-design** for `WeaponDrawer.ts` visual design + `AimHUD.ts` arrow/power-meter styling. Do not ship bare Phaser rectangles; the drawer is the most visible UI in the game.
- Everything else is pure logic + tests.

## Acceptance criteria (manual + automated)

**Automated (CI):**
- [ ] `tsc --noEmit && vite build` clean
- [ ] Vitest: >= 60 tests pass (45 existing + >= 15 new)
- [ ] Biome: clean

**Manual (desktop Chrome):**
- [ ] Press 1, 2, 3 - drawer highlights cycle across Bazooka / Shotgun / Grenade
- [ ] Aim with Up/Down - AimHUD arrow rotates
- [ ] Adjust power with `[` and `]` - power bar changes
- [ ] Press F with Bazooka selected - brown projectile flies in aim direction
- [ ] Projectile hits terrain - circular crater cut, nearby worm takes damage, flies back from impulse
- [ ] Projectile hits a worm - same but with a direct-hit sound of silence (audio in Epic 12)
- [ ] Turn ends immediately on Bazooka fire, other team's banner pulses, next worm highlighted
- [ ] Switch to Shotgun (2), fire 2 shots - first shot does NOT end turn; second DOES
- [ ] Switch to Grenade (3), fire - grenade arcs, bounces, explodes after 3s
- [ ] Self-damage: fire Bazooka at 0 power, explosion kills firer - game handles cleanly, no crash, turn ends, TurnManager.reportSelfDamage called (check via console.log in dev)
- [ ] Shift+click - test cut still works (dev escape)
- [ ] During turnEnding state - F, 1/2/3, drag-to-aim all do nothing (input locked)

**Manual (Chrome DevTools mobile landscape):**
- [ ] Drag from anywhere on canvas - aim updates, power updates
- [ ] Release - fires
- [ ] Tap drawer icon - selection changes
- [ ] Thumb can reach all HUD elements (End Turn top-right, drawer bottom-center, rope/jet bottom-right)
- [ ] No accidental terrain cuts from drag-aim gestures
- [ ] 60fps average in `about:performance` during a full turn

## Migration notes

Nothing to migrate. Epic 5 is already merged, no state shape changes. New weapon system is additive.

## Risks

- **pointerdown chain complexity**: 4 gates (TurnHUD, TouchControls, WeaponDrawer, Shift+click). High bug surface. Mitigation: each UI element owns `hitsX(p)` method; GameScene has one orderly chain. Bugcheck's State/UI lens will hammer this.
- **Contact-based detonation + same-frame damage application**: if a grenade's contact fires in the same step as a fall-damage contact, the applyPendingDamage order matters. Mitigation: ProjectileManager detonation runs in `update()` AFTER physics step and BEFORE damage-apply (same pattern as Epic 5's flush ordering).
- **Hitscan through firer's own body**: already addressed in raycastFirstHit (exclude firer body).
- **Drag-to-aim vs touch-button conflicts**: mitigated by ordered pointerdown chain. Test coverage: manual on mobile viewport.
- **Self-damage wiring is dead code in 6a**: low risk. Wired so 6b can toggle retreat timer logic without re-plumbing.

## Follow-ups (filed as issues during build)

- Retreat timer (post-MVP enhancement) - assigns 3-5s grace window between fire and actual turn end
- Weapon sprites + icons (blocks on Epic 11)
- Remove Shift+click test cut (blocks on Epic 7)
- Add Minigun/HolyGrenade/Dynamite/Drill (Epic 6b)
- LandMine + Blowtorch (lower priority; were stubbed in reference)

## Commit plan (agent-executed)

Suggested commits to keep the PR readable:

1. `chore(tuning): add weapons tuning section`
2. `feat(weapons): WeaponConfig types + registry + 3 configs`
3. `feat(weapons): explode() + hitscan() pure helpers + tests`
4. `feat(weapons): ProjectileManager + contact/fuse flow`
5. `feat(weapons): WeaponManager per-team + tests`
6. `feat(weapons): fire() dispatcher + tests`
7. `feat(worm): aim power + pixel getters`
8. `feat(ui): WeaponDrawer + AimHUD (frontend-design pass)`
9. `feat(input): weapon select + fire + power keybinds`
10. `feat(scene): wire ProjectileManager, drawer, drag-to-aim, self-damage hook`
11. `chore: delete ported reference/weapons files`
12. `docs: Epic 6a plan + adding-a-weapon guide + ROADMAP update`

Expected diff: ~1500-2000 LOC added, ~900 LOC deleted (reference files).
