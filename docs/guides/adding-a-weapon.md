# Adding a weapon

Takes ~30-60 minutes once the weapon system lands in Epic 6. Assumes stack per [ADR-001](../decisions/001-framework-pivot.md): Phaser 3, planck.js, Aseprite, dat.gui.

## 1. Sprite

Author the weapon's visual in **Aseprite**. Required frames depend on the weapon:

- **Projectile weapons** (grenade, bazooka, holy grenade, cluster bomb): one static frame OR rotation frames if it spins in flight.
- **Placeable / walking weapons** (land mine, old woman, sheep, super sheep): walk/idle animations if it moves on its own.
- **Explosion / hit effect**: most weapons share the same explosion sprite sheet (`fx-explosion.png`); individual weapons only ship unique art for unique visuals.

Export from Aseprite: **File -> Export Sprite Sheet** with **Output: Array**, JSON format, one atlas per weapon.

```
public/assets/weapons/
  grenade.png       # sprite sheet
  grenade.json      # Aseprite frame data
```

## 2. Register the loader

In `src/loaders/weapons.ts` (created in Epic 6), add a line:

```ts
scene.load.atlas("grenade", "assets/weapons/grenade.png", "assets/weapons/grenade.json");
```

All weapon atlases get preloaded at game start; no runtime asset loading.

## 3. Write the weapon config

Create `src/weapons/grenade.ts`:

```ts
import type { WeaponConfig } from "./types";

export const grenade: WeaponConfig = {
  id: "grenade",
  name: "Hand Grenade",
  icon: "grenade-icon",               // atlas key for weapon-select icon
  sprite: "grenade",                   // atlas key for in-world sprite
  body: {
    shape: "circle",
    radius: 0.2,                       // meters
    density: 1.0,
    friction: 0.5,
    restitution: 0.3,                  // bouncy
  },
  launch: {
    type: "aimed-arc",                 // charge + release, affected by wind
    maxVelocity: 25,                   // m/s at full charge
  },
  fuseMs: 3000,                        // detonates 3s after launch
  explosion: {
    radius: 60,                        // px
    damage: 50,                        // hp
    knockback: 400,                    // px/s applied to nearby bodies
  },
  endsTurn: true,
  ammoDefault: 4,                      // starting ammo per worm per round
};
```

The `WeaponConfig` type (defined in `src/weapons/types.ts`) covers all fields every weapon needs. Unique behaviors (homing missile tracking, rc plane steering, portal gun) add an `onTick(body, context, dt)` function.

### Unique behavior example

```ts
export const homingMissile: WeaponConfig = {
  id: "homing-missile",
  // ... base config ...
  launch: { type: "direct", maxVelocity: 30 },
  fuseMs: 4000,
  onTick(body, ctx, dt) {
    const target = ctx.paintedTarget;
    if (!target) return;
    const toTarget = target.minus(body.getPosition()).normalize();
    body.applyForceToCenter(toTarget.mul(0.5));
  },
};
```

Keep unique logic ~10-30 lines. If a weapon needs more, question whether the abstraction is wrong.

## 4. Register in the weapon index

`src/weapons/index.ts`:

```ts
import { grenade } from "./grenade";
import { bazooka } from "./bazooka";
// ...

export const WEAPONS = {
  grenade,
  bazooka,
  // ...
} as const;

export type WeaponId = keyof typeof WEAPONS;
```

The weapon selector UI reads `WEAPONS`, no further wiring.

## 5. Test + tune in dev

```sh
npm run dev
```

Open localhost:5173, start a local game, press `` ` `` (backtick) to toggle dat.gui. The weapon's tunables (velocity, explosion radius, fuse time) appear under **Weapons -> <name>**. Drag sliders, fire the weapon, feel the change.

When happy, copy the values back into the config file and commit.

## 6. Multiplayer

If the weapon adds new schema state (e.g., placed land mines, thrown ninja ropes attached to terrain), add it to `server/src/state/GameState.ts` and the client-side schema mirror. For normal projectiles, the existing `Projectile` schema covers everything.

## Checklist

- [ ] Aseprite file + atlas exported to `public/assets/weapons/<name>/`
- [ ] Added to asset loader in `src/loaders/weapons.ts`
- [ ] Config file at `src/weapons/<name>.ts`
- [ ] Added to `WEAPONS` export in `src/weapons/index.ts`
- [ ] Tested in dev with dat.gui; final constants committed
- [ ] Icon added to weapon selector atlas
- [ ] NOTICE.md updated if source is CC-BY (attribution required)

Typical PR: 1 weapon = ~100 lines across 3-4 files + 1 sprite. Agent-executable via /execute when Epic 6 is done.
