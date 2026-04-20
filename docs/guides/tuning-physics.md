# Tuning physics and game feel

All game-tunable constants live in `src/tuning.ts`. A `dat.gui` debug overlay (toggled with `` ` `` backtick in dev builds) exposes them as sliders. Tune live, commit final values.

## Philosophy

- **No hardcoded magic numbers in game logic.** Every constant that might need tweaking goes in `tuning.ts` with a named export.
- **Dev-only overlay.** The tuning UI is stripped from production builds (Vite dead-code elimination via `import.meta.env.DEV`).
- **Server + client share tuning.** Authoritative physics runs on the server; client mirrors it. Tuning changes must propagate to both — shared module imported by `server/` and `src/`.

## Structure of `tuning.ts`

```ts
// src/tuning.ts
export const tuning = {
  world: {
    gravity: { x: 0, y: 10 },
    pxPerMeter: 30,
  },
  worm: {
    walkSpeed: 2.5,        // m/s
    jumpImpulse: 6,        // m/s vertical
    backflipImpulse: 8,
    maxFallDamage: 40,
    fallDamageThresholdMs: 1200,
  },
  weapons: {
    grenade: {
      fuseMs: 3000,
      explosionRadius: 60,
      explosionDamage: 50,
      knockback: 400,
    },
    bazooka: {
      velocity: 25,
      windSusceptibility: 1.0,
      explosionRadius: 55,
      explosionDamage: 60,
    },
    // ...
  },
  turn: {
    durationMs: 45000,
    retreatMs: 3000,
  },
  wind: {
    changeRange: 5,   // +/- per turn
    maxStrength: 5,
  },
} as const;
```

Everything is `as const` so TypeScript treats values as exact literals. Game code reads `tuning.weapons.grenade.fuseMs`, not magic strings.

## Using tuning in game code

```ts
import { tuning } from "./tuning";

function createGrenade(pos: Vec2) {
  return {
    body: world.createBody({
      type: "dynamic",
      position: pos,
    }),
    fuseMs: tuning.weapons.grenade.fuseMs,
    // ...
  };
}
```

## dat.gui overlay

`src/debug/tuningPanel.ts`:

```ts
import { GUI } from "dat.gui";
import { tuning } from "../tuning";

export function mountTuningPanel(): GUI | null {
  if (!import.meta.env.DEV) return null;

  const gui = new GUI({ width: 300, hideable: true });
  gui.closed = true;

  const world = gui.addFolder("World");
  world.add(tuning.world.gravity, "y", 0, 30, 0.1).name("Gravity Y");

  const weapons = gui.addFolder("Weapons");
  for (const [id, w] of Object.entries(tuning.weapons)) {
    const sub = weapons.addFolder(id);
    // auto-generate sliders per property
    for (const [k, v] of Object.entries(w)) {
      if (typeof v !== "number") continue;
      sub.add(w as Record<string, number>, k);
    }
  }

  // Hotkey
  window.addEventListener("keydown", (e) => {
    if (e.key === "`") gui.closed = !gui.closed;
  });

  return gui;
}
```

Called once in `main.ts`. Panel floats top-right; sliders write directly into `tuning` (mutable at runtime). Changes apply the next time game code reads them.

## Typical tuning workflow

1. `npm run dev`, open localhost:5173
2. Start a local game
3. Press `` ` `` (backtick): panel appears
4. Drill into `Weapons > grenade > explosionRadius`, drag slider
5. Throw grenades; watch effect
6. When satisfied, copy value back into `src/tuning.ts` literally (the panel is non-persistent)
7. Commit `tuning.ts` change

## Limitations

- **Structural changes** (adding new keys, changing shapes) need code edit + restart. The panel only tweaks numbers already in `tuning.ts`.
- **Server tuning**: when tuning affects server-side simulation (most things), you need to restart the Colyseus server after committing. The live panel only tweaks the local client, so single-player / lobby preview is the right place to tune.
- **No save/load**: panel state is ephemeral. Commit to `tuning.ts` or lose your changes on reload.

## Why dat.gui specifically

- Small (~40KB gzipped)
- Zero-config for numeric tuning
- Works with plain objects (no React/Vue)
- Industry standard in web game dev since ~2013 (Three.js examples use it)

Alternatives considered: Tweakpane (more modern, slightly larger), lil-gui (a dat.gui fork, basically identical). dat.gui is the safest default.

## Checklist for a new tunable

- [ ] Added to `src/tuning.ts` with descriptive name
- [ ] Game code reads from `tuning.*` instead of a local constant
- [ ] Panel auto-picks it up (if it's a number under a known folder)
- [ ] Committed default value is the tuned-and-happy value, not a placeholder
- [ ] If server uses this constant, `server/` also imports from the same module
