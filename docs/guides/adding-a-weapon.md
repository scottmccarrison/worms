# Adding a weapon (Epic 6b+ drop-in guide)

Adding a new weapon requires exactly two steps: a config file + a registry entry. No engine changes.
Updated for the Epic 6a data-driven weapon stack (placeholder graphics; real sprites in Epic 11).

## Step 1: Create `src/weapons/<name>.ts`

Export a `WeaponConfig` object. Pick the archetype that matches the behavior:

| Archetype | Detonates | Example |
|-----------|-----------|---------|
| `hitscan` | Immediately at ray hit point | Shotgun, Minigun |
| `projectile` | On terrain/worm contact | Bazooka |
| `throwable` | After fuse timer (bounces first) | HandGrenade |

```typescript
// src/weapons/minigun.ts
import type { WeaponConfig } from "./types";

export const minigun: WeaponConfig = {
  id: "minigun",
  name: "Minigun",
  archetype: "hitscan",
  ammoPerMatch: -1,          // -1 = infinite
  selectKey: 4,              // keyboard slot (1-9); must be unique
  iconColor: 0x888888,       // placeholder icon fill color (hex)
  iconLabel: "M",            // placeholder icon letter (1-2 chars)
  shotsPerActivation: 10,    // hitscan: fires N times before turn ends
  explosion: {
    terrainRadiusPx: 10,     // crater radius in pixels
    damageRadiusPx: 20,      // damage falloff radius in pixels
    maxDamage: 8,            // HP at direct hit (falls off to 0 at radius)
    impulseMag: 10,          // knockback strength
  },
};
```

**Throwable example** (fuse + bounce):

```typescript
export const holyGrenade: WeaponConfig = {
  id: "holygrenade",
  name: "Holy Hand Grenade",
  archetype: "throwable",
  ammoPerMatch: 1,
  selectKey: 5,
  iconColor: 0xffd700,
  iconLabel: "HG",
  projectileColor: 0xffd700,  // in-world circle color (placeholder)
  projectileRadiusPx: 7,
  fuseMs: 3000,               // detonates 3 seconds after throw
  restitution: 0.5,           // bounciness (0 = dead stop, 1 = perfect bounce)
  powerCapMps: 14,            // max muzzle velocity at full drag power
  explosion: {
    terrainRadiusPx: 75,
    damageRadiusPx: 100,
    maxDamage: 75,
    impulseMag: 90,
  },
};
```

**Projectile example** (contact detonation):

```typescript
export const bazooka: WeaponConfig = {
  id: "bazooka",
  name: "Bazooka",
  archetype: "projectile",
  ammoPerMatch: -1,
  selectKey: 1,
  iconColor: 0x8b5a2b,
  iconLabel: "B",
  projectileColor: 0xcc9966,
  projectileRadiusPx: 5,
  powerCapMps: 20,
  explosion: { terrainRadiusPx: 45, damageRadiusPx: 60, maxDamage: 50, impulseMag: 60 },
};
```

## Step 2: Add it to `src/weapons/registry.ts`

```typescript
import { minigun } from "./minigun";  // add import

const REGISTRY: WeaponConfig[] = [bazooka, shotgun, handGrenade, minigun]; // add to array
```

That's all. The registry drives:
- The weapon drawer (icon slot appears automatically)
- `getByKey(n)` / `getById(id)` lookups used by InputController
- `defaultAmmoForMatch()` used by WeaponManager at game start

## Step 3: Tune in dat.gui

Run `npm run dev`, launch a game, press backtick to open dat.gui. Sliders for the weapon's explosion numbers appear under the Weapons folder. Drag until it feels right, then commit the final values back to the config file.

## Unique behavior

For weapons that don't fit the three archetypes (homing missile, drill tunneling), add an optional `behavior?: (ctx: FireContext) => FireResult` hook to `WeaponConfig`. Leave it undefined for standard archetypes - `fire()` ignores it. Keep unique logic under 30 lines; if it needs more, split into a helper module.

## Checklist

- [ ] Config file at `src/weapons/<name>.ts`
- [ ] Imported and added to `REGISTRY` in `src/weapons/registry.ts`
- [ ] `selectKey` is unique (no conflict with existing slots 1/2/3)
- [ ] `tsc --noEmit` clean
- [ ] `vitest run` green
- [ ] Explosion radius + damage tuned in dat.gui and committed
- [ ] Reference file deleted if porting from `reference/src/weapons/`
- [ ] `NOTICE.md` updated if source asset is CC-BY
