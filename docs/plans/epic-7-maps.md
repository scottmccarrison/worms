# Epic 7: Map loading + starter maps

## Context

Parent issue: #7. Until now there is one hardcoded placeholder map (wavy hills + rocky ceiling) baked into `GameScene.buildPlaceholderMask`. Epic 7 replaces it with a real map system: a config shape, a registry, and 3-4 starter maps that can be swapped without redeploying.

`docs/guides/adding-a-map.md` already exists (from the earlier alignment docs pass) and documents two paths: hand-authored PNG masks and procedural generators. This epic implements the loader + registry + the generator path. PNG-path support stays stubbed but not validated with a real asset until Epic 11 (sprites + art pass).

Lobby-side map picker is deferred to Epic 8 (Colyseus integration), which is when the selection decision actually needs to cross a network boundary. For Epic 7 we ship a dev affordance: keyboard `M` cycles through registered maps by restarting the scene with new map data.

## Strategy

- **Procedural generators for MVP**, not hand-drawn PNGs. Reasons: (a) no art assets exist yet; committing PNGs would be throwaway work we'd redo in Epic 11, (b) generators give us variety from a small amount of code, (c) the existing `buildPlaceholderMask` is already a procedural generator - we're formalizing the pattern, not inventing it.
- **One worktree (`~/worms-ws3`), one Sonnet agent, one PR**. Same shape as Epic 5 / 6a. Scope is smaller than 6a.
- **Zero changes to Terrain or findSpawnPoints**. Both consume a canvas / image data today; they work unchanged. Epic 7 is purely the layer that PRODUCES a mask, not the layer that CONSUMES it.
- **Match existing adding-a-map.md schema**: `id`, `name`, `description`, `spawnPoints`, `maxWorms`, plus new `generator` field for procedural maps. PNG fields (`mask`, `background`, `theme`) stay in the type signature, but the 6a-style drop-in story is: add one generator file + one registry entry.
- **Port-then-delete**: remove `reference/src/environment/Maps.ts` in this PR. Its hardcoded map dictionary is replaced by our registry.
- **Dev-only cycling**: press `M` to cycle through registered maps, restarting the scene with the new map. Removed in Epic 8 (lobby owns selection). Also exposed in dat.gui for test tweaking.

## Scope (strict)

**In scope:**
- `MapConfig` + `MapGenerator` types
- Map registry with 3-4 starter maps
- `loadMap(id)`: returns `{ mask: HTMLCanvasElement, spawnPoints?: SurfacePoint[], config: MapConfig }`
- 3 procedural generators: `flat`, `hills`, `island` (+ optional 4th: `cave`)
- GameScene refactor: consume `MapConfig` via scene-restart data, remove `buildPlaceholderMask`
- Dev affordance: `M` keyboard + dat.gui dropdown to cycle maps
- `findSpawnPoints` fallback when map config has no predefined points
- Vitest unit tests for each generator (mask is non-empty, spawn points are on terrain surface)
- Delete `reference/src/environment/Maps.ts`
- Update ROADMAP

**Out of scope:**
- PNG path (declared in types but unused; Epic 11)
- Lobby-side map picker (Epic 8)
- Map-specific gravity / wind / water (post-MVP enhancements)
- Background parallax art (Epic 11)
- Themes (Epic 11)
- Map editor / authoring tools (post-MVP)
- Larger canvases + camera panning (the adding-a-map guide suggests 1920x1080; we stay at 1280x720 until Epic 11 brings a real pan-camera view)

## Critical decisions

1. **Map size stays at viewport size for 6a**. 1280x720. Expanding to 1920x1080 requires camera pan logic that isn't plumbed in yet (the Phaser camera is already a Camera2D with `startFollow`-ready methods, but current maps don't scroll, and starting to scroll without a "follow active worm" pass would be disorienting). File follow-camera as a separate enhancement (#40 in this PR).
2. **Generators are pure functions** `(canvas, options) => void` that draw into a 2D context. They don't allocate the canvas; they accept one. Makes unit testing trivial (pass in a jsdom canvas stub, assert that `fillStyle` was called, etc).
3. **Spawn points**: if `config.spawnPoints` is defined, use them verbatim. Otherwise fall back to `findSpawnPoints(maskImageData, totalWorms)`. Procedural maps can emit predefined points from the generator when they want tight control (e.g., the `island` generator should place worms on the island, not off the edge).
4. **Seeded randomness**: each generator accepts an optional `seed: number`. Default seed is a timestamp for variety per load; tests use a fixed seed. Use a simple xorshift32 for the seeded RNG (don't pull in a library; 10 lines of code).
5. **Scene restart for map switch**: Phaser's `scene.restart(data)` is the blessed path. Pass `{ mapId }` in the data, read it in `init(data)` hook. Avoids the full reload path and keeps HMR fast.
6. **`M` key cycles maps on press**, but only when input is allowed (avoid restart while a projectile is in flight mid-turn). Gated by `turnManager.isInputAllowed()`. If disallowed, queue the cycle for after the turn? No - simpler: just ignore. Player can press it again between turns.
7. **Initial map**: first load uses `registry.firstId()` (i.e. the first registered map, probably `flat`). Override via `?map=<id>` URL param for easy sharing of seeds during playtest.
8. **Generator list**: `flat` (open field for testing weapons), `hills` (varied terrain, the current placeholder's spirit), `island` (bounded arena, forces engagement). Optional 4th `cave` (overhead ceiling + floor, rope-friendly).
9. **Background color**: generators draw terrain; the Phaser scene's `backgroundColor` (currently `#0b0b0f`) stays in place as the sky. Each map can optionally override via `config.backgroundColor` but it's not required for any of the 3 starter maps.

## File plan

### New files

```
src/maps/
  types.ts                   MapConfig, MapGenerator, LoadedMap, SpawnPoint
  registry.ts                MAPS registry, getById, firstId, allIds
  loadMap.ts                 loadMap(id, scene): returns LoadedMap. Builds canvas, invokes generator, resolves spawn points
  xorshift.ts                10-line seeded RNG (xorshift32)
  xorshift.test.ts           Vitest: same seed -> same sequence, default seed differs
  generators/
    flat.ts                  Flat ground at y=0.7, slight wavy bias
    hills.ts                 Sine hills + rocky ceiling (ports the current placeholder; makes it a real registered map)
    island.ts                Elevated platform in the middle, ocean-edge gaps on both sides
    cave.ts                  (optional 4th) Ceiling + floor with stalactites, good for rope play
  generators.test.ts         Vitest: each generator produces a canvas with >0 opaque pixels and spawn points (if any) land on terrain

docs/plans/
  epic-7-maps.md             (this file)
```

### Modified files

```
src/scenes/GameScene.ts      Remove buildPlaceholderMask. Read mapId from init(data). Call loadMap(). Replace spawn logic to use map config's points or fallback.
src/main.ts                  Parse ?map=<id> query param; pass as initial scene data via Phaser config's `scene: [GameScene]` with data. OR set default in GameScene.init.
src/input/InputController.ts Add key `M` with callback to cycle maps (wired in GameScene via init prop)
src/tuning.ts                Add tuning.maps.defaultId (for dat.gui override)
src/debug/tuningPanel.ts     Add Maps folder with dropdown of registered map ids
docs/ROADMAP.md              Epic 7 -> Done (or Partial if camera-pan enhancement is broken out)
```

### Deletions

```
reference/src/environment/Maps.ts    Hardcoded map dictionary, replaced by src/maps/registry.ts
```

## Detailed specs

### `src/maps/types.ts`

```typescript
import type { SurfacePoint } from "../worm/spawnPoints";

export interface MapConfig {
  id: string;
  name: string;
  description: string;
  /** Preferred worm count for this map layout. findSpawnPoints honors this. */
  maxWorms: number;
  /** Explicit spawn points; if omitted, falls back to findSpawnPoints scan. */
  spawnPoints?: SurfacePoint[];
  /** Procedural generator id + its options. */
  generator: {
    id: string;
    seed?: number;
    options?: Record<string, number | string | boolean>;
  };
  /** Optional solid sky color override. Defaults to Phaser scene backgroundColor. */
  backgroundColor?: string;
}

export type MapGenerator = (
  ctx: CanvasRenderingContext2D,
  widthPx: number,
  heightPx: number,
  opts: { seed: number } & Record<string, number | string | boolean>,
) => void;

export interface LoadedMap {
  config: MapConfig;
  mask: HTMLCanvasElement;
  spawnPoints: SurfacePoint[];
}
```

### `src/maps/xorshift.ts`

```typescript
/** Seeded uint32 xorshift. Cheap, deterministic, good enough for map gen. */
export function xorshift(seed: number): () => number {
  let s = seed >>> 0;
  if (s === 0) s = 0xdeadbeef;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0xffffffff; // 0..1
  };
}
```

### `src/maps/generators/hills.ts`

Ports `buildPlaceholderMask` into a registered generator. Kept behaviorally identical so playtest feel is continuous with Epic 6a.

```typescript
export const hillsGenerator: MapGenerator = (ctx, width, height, opts) => {
  const rng = xorshift(opts.seed);
  // Ground
  ctx.fillStyle = "#4a7d3c";
  ctx.beginPath();
  ctx.moveTo(0, height);
  for (let x = 0; x <= width; x += 4) {
    const phase1 = rng() * Math.PI * 2; // different each seed
    const y = height / 2 + Math.sin(x * 0.01 + phase1) * 60 + Math.sin(x * 0.03) * 30;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(width, height);
  ctx.closePath();
  ctx.fill();

  // Ceiling
  ctx.fillStyle = "#3d5d2f";
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(width, 0);
  for (let x = width; x >= 0; x -= 4) {
    const y = 40 + Math.sin(x * 0.015) * 18 + Math.sin(x * 0.04) * 10;
    ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
};
```

Exception: the `rng()` is called once to offset the hills by a seeded phase shift. Deterministic under a fixed seed; varies by default when seed comes from `Date.now()`.

### `src/maps/generators/flat.ts`

```typescript
export const flatGenerator: MapGenerator = (ctx, width, height, opts) => {
  const rng = xorshift(opts.seed);
  ctx.fillStyle = "#5a7a3c";
  const groundY = height * 0.7;
  ctx.beginPath();
  ctx.moveTo(0, height);
  for (let x = 0; x <= width; x += 4) {
    const y = groundY + rng() * 4 - 2; // tiny roughness for fall damage tests
    ctx.lineTo(x, y);
  }
  ctx.lineTo(width, height);
  ctx.closePath();
  ctx.fill();
};
```

No ceiling. Flat map is for weapon testing without terrain interfering.

### `src/maps/generators/island.ts`

```typescript
export const islandGenerator: MapGenerator = (ctx, width, height, opts) => {
  const rng = xorshift(opts.seed);
  ctx.fillStyle = "#7a5a3c";
  const centerX = width / 2;
  const topY = height * 0.55;
  const bottomY = height * 0.8;
  const halfWidth = width * 0.35;

  ctx.beginPath();
  // Flat-ish top with small bumps
  for (let x = centerX - halfWidth; x <= centerX + halfWidth; x += 4) {
    const bump = Math.sin((x - centerX) * 0.02) * 12 + rng() * 4;
    ctx.lineTo(x, topY + bump);
  }
  // Sloped sides + floor
  ctx.lineTo(centerX + halfWidth + 20, bottomY);
  ctx.lineTo(centerX - halfWidth - 20, bottomY);
  ctx.closePath();
  ctx.fill();

  // Small floating chunks on either side for rope targets
  ctx.beginPath();
  ctx.ellipse(width * 0.12, height * 0.35, 40, 18, 0, 0, Math.PI * 2);
  ctx.ellipse(width * 0.88, height * 0.4, 50, 20, 0, 0, Math.PI * 2);
  ctx.fill();
};
```

Island exports predefined `spawnPoints` in its registry entry so worms always land on the island, not on floating chunks or the void.

### `src/maps/generators/cave.ts` (optional 4th map)

```typescript
export const caveGenerator: MapGenerator = (ctx, width, height, opts) => {
  const rng = xorshift(opts.seed);
  ctx.fillStyle = "#5a4a3c";

  // Floor with bumps
  ctx.beginPath();
  ctx.moveTo(0, height);
  for (let x = 0; x <= width; x += 4) {
    const y = height * 0.82 + Math.sin(x * 0.02 + rng() * 0.3) * 22;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(width, height);
  ctx.closePath();
  ctx.fill();

  // Ceiling with stalactites
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(width, 0);
  for (let x = width; x >= 0; x -= 4) {
    const y = height * 0.15 + Math.sin(x * 0.04) * 25 + Math.sin(x * 0.12) * 15;
    ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();

  // A couple of mid-cave pillars
  ctx.fillRect(width * 0.3 - 8, height * 0.3, 16, height * 0.5);
  ctx.fillRect(width * 0.7 - 8, height * 0.35, 16, height * 0.45);
};
```

Only included if time permits; not critical.

### `src/maps/registry.ts`

```typescript
import { flatGenerator } from "./generators/flat";
import { hillsGenerator } from "./generators/hills";
import { islandGenerator } from "./generators/island";
// import { caveGenerator } from "./generators/cave"; // optional
import type { MapConfig, MapGenerator } from "./types";

type RegistryEntry = { config: MapConfig; generator: MapGenerator };

export const MAPS: Record<string, RegistryEntry> = {
  flat: {
    config: {
      id: "flat",
      name: "Open Field",
      description: "Wide flat terrain. Good for weapon testing.",
      maxWorms: 4,
      generator: { id: "flat", seed: 0 }, // 0 triggers Date.now() default
    },
    generator: flatGenerator,
  },
  hills: {
    config: {
      id: "hills",
      name: "Rolling Hills",
      description: "Sine-wave hills with a rocky ceiling for rope play.",
      maxWorms: 4,
      generator: { id: "hills", seed: 0 },
    },
    generator: hillsGenerator,
  },
  island: {
    config: {
      id: "island",
      name: "Island Arena",
      description: "Elevated platform with void on both sides. Tight engagement.",
      maxWorms: 4,
      spawnPoints: [
        { xPx: 384, yPx: 380 },
        { xPx: 896, yPx: 380 },
        { xPx: 512, yPx: 380 },
        { xPx: 768, yPx: 380 },
      ],
      generator: { id: "island", seed: 0 },
    },
    generator: islandGenerator,
  },
};

export function allIds(): string[] {
  return Object.keys(MAPS);
}

export function getById(id: string): RegistryEntry | null {
  return MAPS[id] ?? null;
}

export function firstId(): string {
  return allIds()[0] ?? "";
}

export function nextId(current: string): string {
  const ids = allIds();
  const i = ids.indexOf(current);
  return ids[(i + 1) % ids.length] ?? firstId();
}
```

### `src/maps/loadMap.ts`

```typescript
export function loadMap(
  id: string,
  widthPx: number,
  heightPx: number,
): LoadedMap {
  const entry = getById(id);
  if (!entry) throw new Error(`Unknown map id: ${id}`);

  const canvas = document.createElement("canvas");
  canvas.width = widthPx;
  canvas.height = heightPx;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("loadMap: 2D context unavailable");

  const seed = entry.config.generator.seed || Date.now();
  entry.generator(ctx, widthPx, heightPx, { ...entry.config.generator.options, seed });

  // Spawn points: use predefined if present, else scan the mask
  let spawnPoints: SurfacePoint[];
  if (entry.config.spawnPoints?.length) {
    spawnPoints = entry.config.spawnPoints;
  } else {
    const imgData = ctx.getImageData(0, 0, widthPx, heightPx);
    spawnPoints = findSpawnPoints(imgData.data, widthPx, heightPx, entry.config.maxWorms);
  }

  return { config: entry.config, mask: canvas, spawnPoints };
}
```

### `src/scenes/GameScene.ts` modifications

Add `init(data)` hook at the top of the class:

```typescript
private mapId: string = firstId();

init(data?: { mapId?: string }): void {
  const candidate = data?.mapId ?? this.readMapQueryParam() ?? tuning.maps.defaultId ?? firstId();
  this.mapId = getById(candidate) ? candidate : firstId();
}

private readMapQueryParam(): string | null {
  const url = new URL(window.location.href);
  return url.searchParams.get("map");
}
```

In `create()`, replace:

```typescript
const mask = this.buildPlaceholderMask(this.scale.width, this.scale.height);
// ...
const spawnPts = findSpawnPoints(...);
```

With:

```typescript
const loaded = loadMap(this.mapId, this.scale.width, this.scale.height);
// ...
const spawnPts = loaded.spawnPoints;
// Terrain construction unchanged; consumes loaded.mask
```

Remove `buildPlaceholderMask` (entire method + its caller reference).

Add an `onCycleMap` callback wired to InputController's new `M` binding:

```typescript
onCycleMap: () => {
  if (!this.turnManager.isInputAllowed()) return;
  const nextMap = nextId(this.mapId);
  this.scene.restart({ mapId: nextMap });
};
```

### `src/input/InputController.ts` modifications

Add `onCycleMap: () => void` to the init prop. Bind `M`:

```typescript
this.keyM = kb.addKey(Phaser.Input.Keyboard.KeyCodes.M);
// In update() normal-state branch:
if (Phaser.Input.Keyboard.JustDown(this.keyM)) {
  this.onCycleMap();
}
```

Place the check before weapon-select keys so map cycling takes priority (intentional: M is a dev affordance, should feel snappy).

### `src/tuning.ts`

```typescript
maps: {
  defaultId: "hills", // registry lookup; falls back to firstId() if invalid
},
```

### `src/debug/tuningPanel.ts`

Add:

```typescript
const mapsFolder = gui.addFolder("Maps");
mapsFolder.add(tuning.maps, "defaultId", allIds()).name("Default Map")
  .onChange((id: string) => {
    // Restart scene with new map
    const scene = <find GameScene>;
    scene.scene.restart({ mapId: id });
  });
```

Wiring the scene reference into the tuning panel is a small plumbing thing; if it gets ugly, expose a global `window.__worms_cycleMap = (id) => ...` as a dev helper and skip the dat.gui entry. dat.gui is nice-to-have, keyboard `M` is the blocking requirement.

## Tests (Vitest)

Create `src/maps/xorshift.test.ts`:
- Same seed -> identical sequence over 10 calls
- Different seeds -> different sequences
- Seed 0 gets replaced with the deadbeef default

Create `src/maps/generators.test.ts`:
- For each generator (flat, hills, island):
  - Create an in-memory 1280x720 canvas, invoke generator, read ImageData
  - Assert >0 opaque pixels (some terrain drew)
  - Assert <all-pixels-opaque (there is sky somewhere)
  - For island with predefined spawn points: assert each spawnPoint.yPx hits terrain within +-8px

Create `src/maps/loadMap.test.ts`:
- `loadMap("hills", 1280, 720)` returns a LoadedMap with non-empty spawnPoints
- `loadMap("island", ...)` returns the predefined points verbatim
- `loadMap("nonexistent", ...)` throws

jsdom provides a basic canvas; `canvas` npm package is not needed unless we want to render full pixels. For the tests above, jsdom's stub CanvasRenderingContext2D (paths + fills are no-ops in jsdom) is insufficient. Workaround: use a lightweight 2D context polyfill (node-canvas) added as a dev dep, OR mock the generator to record call counts instead of pixel output. Pick one during build.

**Recommendation**: add `canvas` as a devDependency. It's the standard node-canvas, works with jsdom, gives us real pixel data for tests. ~20MB install but acceptable.

If node-canvas proves painful on install, fallback to testing generators at a behavioral level (verify expected `fillStyle` / `fillRect` calls were made) using vi.spyOn.

**Target: 65 -> 78+ tests on green.**

## Touch-first design

N/A for gameplay, but two polish items for mobile:

- Map cycle key `M` has no touch equivalent in Epic 7. Acceptable since map selection is dev-only until Epic 8 lands the lobby.
- Map generator output must be visually legible on small screens. Tested by rendering each map and eyeballing on Chrome DevTools iPhone 12 landscape. No specific pixel adjustments expected; Phaser Scale.FIT handles it.

## Acceptance criteria

**Automated (CI):**
- [ ] `tsc --noEmit && vite build` clean
- [ ] Vitest: >= 78 tests pass (65 existing + >= 13 new)
- [ ] Biome clean

**Manual (desktop Chrome):**
- [ ] Load page at `/` - default map (hills) renders the same as Epic 6a placeholder
- [ ] Load page at `/?map=flat` - flat map renders (open field, short grass)
- [ ] Load page at `/?map=island` - island map renders (center platform, void edges)
- [ ] Press `M` during your turn - scene restarts with next map in registry
- [ ] Press `M` rapidly during a cinematic pause (between turns) - cycling works, no crashes
- [ ] Weapon fire + turn flow + HUD + drawer all work identically on every map
- [ ] Island map: worms spawn only on the central platform, not on the floating chunks (predefined spawn points honored)
- [ ] Hills map: worms spawn on the rolling terrain (findSpawnPoints fallback)

**Manual (Chrome DevTools iPhone 12 landscape):**
- [ ] Each map is visually clear, no tiny-text clipping
- [ ] Touch gestures (drag-to-aim, drawer taps) work on all 3 maps

## Risks

- **node-canvas install**: can be flaky on some Linux setups (requires cairo headers). If it fails in CI, fall back to spy-based tests. Not a blocker for shipping.
- **Scene restart drops HMR state**: when pressing M, the whole scene rebuilds. Any mid-match state (team health, turn count) resets. This is expected but worth noting. Future: "next match" button triggers same path.
- **Query param spoofing**: `?map=../../etc/passwd` - loadMap throws on unknown id (early validation). No file-system reads happen. Safe.
- **Seed = 0 collision**: 0 triggers our Date.now() fallback. If a user explicitly wants seed 0 (e.g. determinism), they can't. Workaround: use `seed: 1` or any other fixed value. Documented in comments.

## Skills to invoke

- None. Epic 7 is pure logic + minor dev UX. No UI polish required beyond what `buildPlaceholderMask` already did.

## Follow-ups (file as issues during build)

- Larger-than-viewport maps + follow-camera (enhancement #TBD, referenced in Critical Decision #1)
- PNG map path - pick it up in Epic 11 once we have real art
- Themes (dirt color / rock color / sky gradient) - Epic 11
- Map-specific gravity / wind / water - post-MVP enhancements
- dat.gui wiring of map selector (nice-to-have if the keyboard cycle is awkward during testing)

## Commit plan

1. `feat(maps): types + xorshift rng + tests`
2. `feat(maps): flat generator + tests`
3. `feat(maps): hills generator (ports placeholder) + tests`
4. `feat(maps): island generator + predefined spawn points + tests`
5. `feat(maps): registry + loadMap + tests`
6. `feat(scene): consume MapConfig via init(data); remove buildPlaceholderMask`
7. `feat(input): M key cycles maps; URL ?map= param`
8. `chore(tuning): add maps.defaultId + tuning panel entry`
9. `chore: delete reference/src/environment/Maps.ts`
10. `docs: Epic 7 plan + ROADMAP update`

Optional 11th commit: `feat(maps): cave generator` if time permits.

Expected diff: ~600-900 LOC added, ~100 LOC deleted (placeholder mask + reference Maps.ts).
