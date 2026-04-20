# Epic 3: Port destructible terrain to Phaser 3 + planck.js

## Context

Port the `reference/src/environment/Terrain.ts` (Box2D-Web pixel-mask RLE approach, 2013, 292 LOC) to a modern stack per [ADR-001](/home/scott/worms/docs/decisions/001-framework-pivot.md): Phaser 3 for scene/input/rendering, planck.js for physics, dat.gui for live tuning. Closes [issue #3](https://github.com/scottmccarrison/worms/issues/3).

**End state**: `npm run dev` opens a Phaser Scene showing procedurally-generated wavy terrain. Clicking cuts a circular crater. A debug overlay renders planck fixture outlines over the terrain, updating in real time. Backtick (`` ` ``) toggles a dat.gui panel that live-tweaks gravity, explosion radius, and tuning constants. Vitest runs against the pure scanning algorithm.

## Strategy

- **Keep the algorithm** from the reference: horizontal RLE at 5-pixel row intervals -> one static box body per run of opaque pixels. Already stress-tested in the prior Epic 3 plan attempt.
- **Apply bug fixes** from that prior review: strict `<` bounds, `rowY`-tagged destruction via WeakMap, dirty-Y-band `getImageData`, collect-then-destroy iteration safety.
- **Wrap the algorithm** as a regular `Terrain` class (not a Phaser GameObject subclass) that owns an HTMLCanvasElement registered with Phaser's TextureManager as a `CanvasTexture`, renders via a `Phaser.GameObjects.Sprite` backed by that texture, calls `texture.refresh()` after cuts. Simpler than subclassing GameObject; Phaser handles all rendering automatically.
- **PhysicsSystem** wraps the planck World and runs a fixed-timestep accumulator (1/60) driven by `Scene.update(time, delta)`.
- **DebugDraw** is a function (not a class): takes scene + world + Graphics object, clears + redraws fixture outlines each frame. Called from `Scene.update`.
- **Single worktree** — tightly coupled files; parallel split adds merge pain.
- **Port-then-delete** `reference/src/environment/Terrain.ts` in the same PR.

## Stack decisions

| Layer | Choice | Version strategy |
|---|---|---|
| Game framework | **Phaser 3.60.x** | See "Review with user" below — Phaser 4 is now released, worth a call before we commit |
| Physics | **planck** 1.5.x | Pure-JS Box2D port |
| Live tuning | **dat.gui** 0.7.x | Dev-only; tree-shaken from prod via `import.meta.env.DEV` |
| Tests | **vitest** (latest) | Node environment; tests pure algorithm |
| Type defs | **@types/dat.gui** | dat.gui has no bundled types |

All exact versions pinned at install time via `npm view <pkg> version` before commit 1 runs. Agent does NOT trust plan-time version numbers.

## File plan

```
src/
  physics/
    scale.ts                PX_PER_M=30, toMeters, toPixels
    PhysicsSystem.ts        Wraps planck.World; fixed-timestep step(delta)
  terrain/
    terrainAlgorithm.ts     Pure scanMaskForBoxes + types
    terrainAlgorithm.test.ts Vitest tests
    Terrain.ts              Class: CanvasTexture + Sprite + body set + cut batching
  rendering/
    debugDraw.ts            Function: iterates world bodies, strokes fixtures
  scenes/
    GameScene.ts            Phaser.Scene subclass: the demo
  debug/
    tuningPanel.ts          dat.gui wiring; dev-only
  tuning.ts                 All tunable constants
  main.ts                   Phaser.Game bootstrap

vitest.config.ts            New at root
index.html                  Swap canvas -> div container for Phaser mount
package.json                Add phaser, planck, dat.gui, @types/dat.gui, vitest
.github/workflows/ci.yml    Append `npm run test:run`
docs/ROADMAP.md             Epic 3 row: Done + PR + plan link; session log
docs/plans/epic-3-terrain.md Copy of this plan file

reference/src/environment/Terrain.ts  DELETE (port-then-delete)
```

## Critical corrections carried over from prior review

1. **Destroy bodies by `rowY` tag, not center-in-region.** A wide run's body center can sit outside a cut; bodies whose run row falls in the cut band get destroyed regardless of X.
2. **Affected X range = full width** (0 to width) per the reference — simpler and correct. Only Y is banded.
3. **Iteration safety**: `world.destroyBody` is NOT safe mid-iteration. Collect victim bodies into a local array first.
4. **Loop bounds**: strict `<` on width and height; reference's `<=` overreads buffer.
5. **Limit `getImageData` to dirty Y-band**, not full mask — ~10x smaller copy per cut.
6. **Coordinate system**: canvas y-down + planck gravity `(0, 10)` + no flip. Internally consistent.
7. **Fixed timestep**: `world.step(1/60, 8, 3)` with accumulator. Never feed raw `delta`.
8. **Scale utils in `src/physics/`** (not `src/terrain/`) — Epics 4-6 will share them.
9. **Plain `document.createElement("canvas")`** for the mask (reference pattern). Not OffscreenCanvas.
10. **No type casts**: accept `HTMLCanvasElement` directly where needed.
11. **Pointer coords via `pointer.x, pointer.y`** from Phaser's input system — Phaser already accounts for CSS scaling. No manual `getBoundingClientRect` math.
12. **Planck API verification at install time**: read `node_modules/planck/dist/planck.d.ts` and confirm exact method casing. Planck 1.x uses camelCase. Stop and surface the diff if anything drifts.

## Exact contracts

### `src/physics/scale.ts`
```ts
export const PX_PER_M = 30;
export const M_PER_PX = 1 / PX_PER_M;

export function toMeters(px: number): number { return px * M_PER_PX; }
export function toPixels(m: number): number { return m * PX_PER_M; }
```

### `src/physics/PhysicsSystem.ts`
```ts
import { World, type Vec2Value } from "planck";

export interface PhysicsSystemInit {
  gravity?: Vec2Value;  // meters/s^2; default { x: 0, y: 10 } (y-down)
  timestep?: number;    // seconds; default 1/60
  velocityIter?: number;  // default 8
  positionIter?: number;  // default 3
}

export class PhysicsSystem {
  readonly world: World;
  private readonly timestep: number;
  private readonly velocityIter: number;
  private readonly positionIter: number;
  private accumulator = 0;

  constructor(init: PhysicsSystemInit = {}) {
    this.world = new World({ gravity: init.gravity ?? { x: 0, y: 10 } });
    this.timestep = init.timestep ?? 1 / 60;
    this.velocityIter = init.velocityIter ?? 8;
    this.positionIter = init.positionIter ?? 3;
  }

  /** Advance simulation. dtMs is Phaser's delta in milliseconds. */
  step(dtMs: number): void {
    const dt = Math.min(dtMs / 1000, 0.25);  // cap spiral
    this.accumulator += dt;
    while (this.accumulator >= this.timestep) {
      this.world.step(this.timestep, this.velocityIter, this.positionIter);
      this.accumulator -= this.timestep;
    }
  }
}
```

### `src/terrain/terrainAlgorithm.ts`
Same contract as the prior Epic 3 plan. Copied here for completeness:

```ts
export interface BoxSpec {
  readonly cxPx: number;
  readonly cyPx: number;
  readonly wPx: number;
  readonly hPx: number;
}
export interface ScanRegion {
  readonly xMin: number;
  readonly xMax: number;
  readonly yMin: number;
  readonly yMax: number;
}

export const TERRAIN_ROW_HEIGHT = 5;
export const ALPHA_SOLID = 255;
export const MIN_RUN_PX = 2;

export function scanMaskForBoxes(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  region?: ScanRegion | null,
  rowHeight?: number,
  minRunPx?: number,
): BoxSpec[];
```

Implementation rules (for the agent):
- Strict `<` bounds on width and height
- Snap `yMin` DOWN to rowHeight; snap `yMax` UP; clamp to `[0, height)`
- Flush open run at row-end
- Pure; no side effects

### `src/terrain/Terrain.ts` (revised for Phaser)
```ts
import type { Scene } from "phaser";
import { Body, Box } from "planck";
import { scanMaskForBoxes, TERRAIN_ROW_HEIGHT } from "./terrainAlgorithm";
import { toMeters } from "../physics/scale";
import type { PhysicsSystem } from "../physics/PhysicsSystem";

interface TerrainBodyMeta {
  readonly kind: "terrain";
  readonly rowY: number;
}

export interface TerrainInit {
  scene: Scene;
  physics: PhysicsSystem;
  widthPx: number;
  heightPx: number;
  /** Pre-drawn mask; Terrain copies it into its internal buffer. */
  sourceMask: HTMLCanvasElement;
  textureKey?: string;   // default "terrain"
  rowHeight?: number;    // default 5
}

export class Terrain {
  readonly textureKey: string;
  readonly sprite: Phaser.GameObjects.Sprite;

  private readonly scene: Scene;
  private readonly physics: PhysicsSystem;
  private readonly buffer: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly rowHeight: number;
  private readonly bodyMeta: WeakMap<Body, TerrainBodyMeta> = new WeakMap();
  private readonly terrainBodies: Set<Body> = new Set();
  private pending: Array<{ x: number; y: number; r: number }> = [];

  constructor(init: TerrainInit);

  /** Queue a circular cut. Applied in next flushPendingCuts(). */
  cutCircle(xPx: number, yPx: number, rPx: number): void;

  /** Erase queued circles, destroy bodies in affected Y-band, rebuild, refresh texture. */
  flushPendingCuts(): void;

  /** For debug/test. */
  bodyCount(): number;
}
```

Constructor flow:
1. Store init props; create internal `buffer` canvas; copy `sourceMask` into it.
2. Register canvas with Phaser: `scene.textures.addCanvas(textureKey, buffer)`.
3. Create sprite positioned at (widthPx/2, heightPx/2) using the texture.
4. Initial body build via `buildBodiesInRegion({xMin:0, xMax:width, yMin:0, yMax:height})`.

flushPendingCuts sequence (matches prior plan exactly):
1. If pending empty, return.
2. Compute union Y-band; snap to rowHeight grid.
3. Erase pixels via `destination-out` composite; restore composite.
4. Collect terrain bodies with `rowY` in `[yMin - rowHeight, yMax + rowHeight]`.
5. For each victim: `physics.world.destroyBody(b)`; `bodyMeta.delete(b)`; `terrainBodies.delete(b)`.
6. `ctx.getImageData(0, yMin, widthPx, yMax - yMin)` → `scanMaskForBoxes(...)` (no region).
7. Translate emitted `cyPx` by `+yMin`; create bodies; tag; add to Set.
8. `scene.textures.get(textureKey).refresh()` — pushes the mutated canvas to GPU (critical for WebGL mode).
9. Clear pending queue.

Body creation:
```ts
const body = this.physics.world.createBody({
  type: "static",
  position: { x: toMeters(box.cxPx), y: toMeters(box.cyPx) },
});
body.createFixture({
  shape: new Box(toMeters(box.wPx / 2), toMeters(box.hPx / 2)),
  density: 1,
  friction: 1,
});
this.bodyMeta.set(body, { kind: "terrain", rowY: box.cyPx });
this.terrainBodies.add(body);
```

### `src/rendering/debugDraw.ts`
```ts
import type { World } from "planck";
import { toPixels } from "../physics/scale";

export function drawDebug(
  graphics: Phaser.GameObjects.Graphics,
  world: World,
  color: number = 0x00ff96,
  alpha: number = 0.5,
): void;
```

Agent implements: `graphics.clear(); graphics.lineStyle(1, color, alpha);` then walk `world.getBodyList() / body.getNext()`; for each fixture: `fixture.getShape()` cast to PolygonShape; call `shape.getVertices()` (camelCase in planck 1.x; verify via .d.ts); transform via `body.getWorldPoint(v)` for world coords; convert to pixels; `graphics.beginPath(); graphics.moveTo(...); graphics.lineTo(...)*; graphics.closePath(); graphics.strokePath();`.

### `src/scenes/GameScene.ts`
```ts
import Phaser from "phaser";
import { PhysicsSystem } from "../physics/PhysicsSystem";
import { Terrain } from "../terrain/Terrain";
import { drawDebug } from "../rendering/debugDraw";
import { tuning } from "../tuning";
import { mountTuningPanel } from "../debug/tuningPanel";

export class GameScene extends Phaser.Scene {
  private physics!: PhysicsSystem;
  private terrain!: Terrain;
  private debug!: Phaser.GameObjects.Graphics;
  private hud!: Phaser.GameObjects.Text;

  constructor() { super("GameScene"); }

  create(): void {
    // Procedural placeholder mask
    const mask = this.buildPlaceholderMask(this.scale.width, this.scale.height);

    this.physics = new PhysicsSystem({ gravity: { x: 0, y: tuning.world.gravityY } });
    this.terrain = new Terrain({
      scene: this,
      physics: this.physics,
      widthPx: this.scale.width,
      heightPx: this.scale.height,
      sourceMask: mask,
    });

    this.debug = this.add.graphics();
    this.debug.setDepth(10);

    this.hud = this.add.text(12, 12, "", {
      font: "14px system-ui",
      color: "#e0e0e0",
    }).setDepth(20);

    this.input.on("pointerdown", (p: Phaser.Input.Pointer) => {
      this.terrain.cutCircle(p.x, p.y, tuning.weapons.testCutRadiusPx);
    });

    mountTuningPanel(() => {
      // Apply on-change: update world gravity if it changed
      this.physics.world.setGravity({ x: 0, y: tuning.world.gravityY });
    });
  }

  update(_time: number, deltaMs: number): void {
    this.physics.step(deltaMs);
    this.terrain.flushPendingCuts();
    drawDebug(this.debug, this.physics.world);
    this.hud.setText(`click to cut - bodies: ${this.terrain.bodyCount()}`);
  }

  private buildPlaceholderMask(width: number, height: number): HTMLCanvasElement {
    const c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    const g = c.getContext("2d");
    if (!g) throw new Error("mask ctx");
    g.fillStyle = "#4a7d3c";
    g.beginPath();
    g.moveTo(0, height);
    for (let x = 0; x <= width; x += 4) {
      const y = height / 2 + Math.sin(x * 0.01) * 60 + Math.sin(x * 0.03) * 30;
      g.lineTo(x, y);
    }
    g.lineTo(width, height);
    g.closePath();
    g.fill();
    return c;
  }
}
```

### `src/tuning.ts`
```ts
export const tuning = {
  world: {
    gravityY: 10,    // m/s^2; positive = down in canvas coords
  },
  weapons: {
    testCutRadiusPx: 40,
  },
  terrain: {
    rowHeight: 5,
  },
} as const satisfies Record<string, Record<string, number>>;
```
(Expanded in future epics; `as const satisfies` pattern so TypeScript treats values as exact literals AND validates shape.)

Actually — `as const satisfies Record<...>` is nuanced; let the agent use `as const` only for simplicity. Skip the `satisfies`.

### `src/debug/tuningPanel.ts`
```ts
import { GUI } from "dat.gui";
import { tuning } from "../tuning";

export function mountTuningPanel(onChange?: () => void): GUI | null {
  if (!import.meta.env.DEV) return null;

  const gui = new GUI({ width: 300, autoPlace: true });
  (gui as unknown as { closed: boolean }).closed = true;

  const world = gui.addFolder("World");
  world.add(tuning.world, "gravityY", 0, 30, 0.1).name("Gravity Y").onChange(() => onChange?.());

  const weapons = gui.addFolder("Weapons");
  weapons.add(tuning.weapons, "testCutRadiusPx", 10, 150, 1).name("Cut radius (px)");

  window.addEventListener("keydown", (e) => {
    if (e.key === "`") {
      const g = gui as unknown as { closed: boolean };
      g.closed = !g.closed;
    }
  });

  return gui;
}
```

Note: `tuning` is `as const` so TypeScript will complain about mutating `tuning.world.gravityY` via dat.gui. Agent should either drop the `as const` on `tuning` (just use `export const tuning: Tuning = ...` with a separate interface) OR use a small helper that clones and re-assigns.

**Simpler approach — drop `as const`**: just type the tuning export with a concrete interface and let values be mutable. This is the standard dat.gui pattern.

```ts
interface Tuning {
  world: { gravityY: number };
  weapons: { testCutRadiusPx: number };
  terrain: { rowHeight: number };
}

export const tuning: Tuning = {
  world: { gravityY: 10 },
  weapons: { testCutRadiusPx: 40 },
  terrain: { rowHeight: 5 },
};
```

Use this version; skip `as const`.

### `src/main.ts` (replaces existing)
```ts
import Phaser from "phaser";
import { GameScene } from "./scenes/GameScene";

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: 1280,
  height: 720,
  parent: "game-container",
  backgroundColor: "#0b0b0f",
  physics: { default: false },  // disable Arcade/Matter
  scene: [GameScene],
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
};

new Phaser.Game(config);
```

### `index.html` — swap canvas element for div
```html
<body>
  <div id="game-container"></div>
  <script type="module" src="/src/main.ts"></script>
</body>
```
(Plus minor CSS update: `#game-container` centered, dark bg remains.)

### `src/terrain/terrainAlgorithm.test.ts`
Same scope as prior plan — tests cover empty mask, full mask, hole in middle, single-pixel runs skipped, region scan, region out-of-bounds, height-not-divisible-by-rowHeight, right-edge run flush. Helper `makeMask(width, height, predicate)`.

### `vitest.config.ts`
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
```

### `package.json` additions
- Deps: `phaser` (latest 3.x), `planck` (latest 1.x)
- Dev deps: `dat.gui` + `@types/dat.gui`, `vitest`
- Scripts: `"test": "vitest"`, `"test:run": "vitest run"`
- Pin exact versions via `npm view` at install time

### `.github/workflows/ci.yml`
Append `- run: npm run test:run` after `- run: npm run build`.

## Commit chain (single branch)

Worktree: `/home/scott/worms-ws1`, branch `feature/epic-3-terrain-phaser` (off master).

1. `chore: add phaser, planck, vitest, dat.gui` — package.json + package-lock.json + vitest.config.ts
2. `feat(physics): scale utilities + PhysicsSystem with fixed timestep` — src/physics/*
3. `feat(terrain): pure scanning algorithm + Vitest tests` — src/terrain/terrainAlgorithm.ts + test. Tests pass before commit.
4. `feat(terrain): Terrain class (CanvasTexture + Sprite + cut batching)` — src/terrain/Terrain.ts + src/tuning.ts
5. `feat(rendering): planck debug draw helper` — src/rendering/debugDraw.ts
6. `feat(scenes): GameScene with terrain demo + dat.gui tuning panel` — src/scenes/GameScene.ts + src/debug/tuningPanel.ts + src/main.ts (rewritten) + index.html (div container)
7. `chore: delete ported reference/src/environment/Terrain.ts`
8. `ci: run vitest in workflow` — .github/workflows/ci.yml
9. `docs: epic 3 plan + ROADMAP update` — docs/plans/epic-3-terrain.md + docs/ROADMAP.md

## Verification (before pushing)

1. `npm install` generates lockfile
2. `npm run typecheck` exit 0
3. `npm run lint` exit 0 (warnings OK)
4. `npm run test:run` all tests pass
5. `npm run build` produces dist/
6. `npm run dev` + manual smoke test:
   - Green wavy terrain visible
   - Thin green collision outlines along terrain surface
   - HUD shows "click to cut - bodies: N"
   - Click -> crater appears -> outlines update
   - Backtick -> dat.gui panel appears with Gravity Y + Cut radius sliders
   - Slide Gravity Y to 0 -> nothing visually changes yet (no dynamic bodies) but gravity callback fires without errors
   - Slide Cut radius -> next click uses the new radius
7. No console errors

## Auto-merge policy

**DO NOT auto-merge.** Per CLAUDE.md: "Hold for review: anything touching game logic once it exists." This PR introduces game logic for the first time. Flow:
- Push branch, open PR against master
- CI runs + must pass
- Scott reviews the dev-server demo manually
- Scott merges

Label: `needs-review`

## PR body template

```
## Summary

Closes #3. First game-logic PR. Ports the 2013 destructible terrain algorithm to Phaser 3 + planck.js per ADR-001.

- `src/physics/scale.ts` + `PhysicsSystem.ts` - 30 px/m scale + fixed-timestep planck World wrapper
- `src/terrain/terrainAlgorithm.ts` - pure `scanMaskForBoxes()`; 100% unit-tested
- `src/terrain/Terrain.ts` - stateful class: mask canvas registered as Phaser CanvasTexture, Sprite renders it, planck body set + rowY-tagged WeakMap + cut batching + rebuild
- `src/rendering/debugDraw.ts` - iterate planck world, stroke fixture outlines via Phaser Graphics
- `src/scenes/GameScene.ts` - Phaser Scene: procedural wavy terrain + click-to-cut + tuning panel
- `src/tuning.ts` + `src/debug/tuningPanel.ts` - all tunables in one module + dat.gui live-tweak overlay (dev only)

Algorithm: horizontal RLE at 5-pixel row intervals; each opaque run becomes one static box body. Cuts batch-erase via `destination-out`, destroy all terrain bodies in the affected Y-band, rebuild from remaining pixels.

## Corrections vs reference
- Body destruction by `rowY` tag via WeakMap (not center-in-region)
- `yPos < height` bounds (reference overreads buffer)
- `getImageData` limited to dirty Y-band
- Fixed-timestep accumulator driven by Phaser Scene.update

## Bundled scope
- Vitest setup (partial #15)
- CI test step (extends #14)
- `reference/src/environment/Terrain.ts` deleted (port-then-delete)
- `index.html` canvas -> div (Phaser mounts its own canvas)

## Test plan
- [x] `npm run typecheck && npm run lint && npm run build && npm run test:run` pass
- [x] Dev server: procedural terrain + click cuts craters + debug overlay updates + dat.gui works
- [ ] CI passes
- [ ] Human review of demo feel

Closes #3
```

## Things Sonnet MUST verify before coding

1. Run `npm view phaser version`, `npm view planck version`, `npm view vitest version`, `npm view dat.gui version`. Pin exact in `package.json`.
2. **Confirm Phaser 3 choice** (see "Review with user" below). If plan approved as-is, use Phaser 3.60.x. If Scott changes to Phaser 4, revise this plan; don't silently adopt Phaser 4.
3. After `npm install`, read `node_modules/planck/dist/planck.d.ts` — confirm: `World.createBody`, `body.createFixture`, `new Box(hx, hy)`, `world.getBodyList`, `body.getNext`, `body.getFixtureList`, `fixture.getShape`, `PolygonShape.getVertices`, `body.getWorldPoint`, `world.destroyBody`, `world.setGravity`. STOP if any differs; do not `@ts-ignore`.
4. After install, read `node_modules/phaser/types/phaser.d.ts` — confirm Scene's `update(time, delta)` signature, `scene.textures.addCanvas(key, canvas)`, `scene.textures.get(key).refresh()`, `scene.add.graphics()`, `scene.input.on("pointerdown", ...)`, `Phaser.Types.Core.GameConfig` shape.
5. Confirm `import Phaser from "phaser"` works with our `verbatimModuleSyntax: true` tsconfig. If TS complains about default import, use `import * as Phaser from "phaser"` instead.
6. Confirm `dat.gui` imports: `import { GUI } from "dat.gui"`. If types are stubborn, `@types/dat.gui` is the supplement.

## Risks / gotchas

- **Phaser 3 default import + `verbatimModuleSyntax`**: may require namespace import form. Agent to verify and adjust.
- **CanvasTexture refresh cost**: at 1280x720, a per-cut refresh pushes ~3.7MB to GPU. Should be <5ms. If stutter observed, limit refresh to dirty-rect (Phaser supports `refresh(x, y, w, h)` on some versions).
- **dat.gui mutating `tuning`**: we're dropping `as const` for that reason. Values are mutable at runtime; no TS complaints.
- **Bundle size**: ~180KB gzipped post-Phaser+planck+dat.gui. Acceptable per ADR-001.
- **HMR with Phaser**: Vite HMR may reset game state. Acceptable for dev; in practice we just full-reload when iterating on game code.

## Review with user (non-blocking, but worth asking)

### 1. Phaser 3 vs Phaser 4

**Finding**: Phaser 4.0.0 was released April 2026 (after my knowledge cutoff; confirmed via `npm view` during recon). The pivot args assumed Phaser 4 was alpha and mandated Phaser 3.x.

**Options**:
- **Stick with Phaser 3.60.x** (what the plan says). Community docs/plugins all target 3.x. Safest.
- **Adopt Phaser 4.0.x**. Better tree-shaking per community reports. Newer architecture. But ~1 month of community maturity; custom GameObject/texture API may differ slightly; you'd want to budget re-verification time.

**My recommendation**: ship Phaser 3.60 in this PR (low risk, proven), revisit Phaser 4 as a dedicated enhancement issue once we're further along. If you want to go Phaser 4 now, say so and I'll revise.

### 2. CanvasTexture vs subclass GameObject

**Plan as written**: Terrain is a plain class that owns an HTMLCanvas registered with Phaser's TextureManager as a CanvasTexture, displayed via a regular Sprite. Simpler.

**Alternative**: subclass `Phaser.GameObjects.GameObject` and hook lifecycle. More "idiomatic Phaser" in a sense. More code.

**My recommendation**: plan as written (plain class + Sprite). Idiomatic enough, less surface area.

### 3. `mountTuningPanel` onChange callback pattern

**Plan as written**: pass a single `onChange` callback that fires after any tuning value changes. Callback updates world gravity.

**Alternative**: per-control `.onChange(callback)` so gravity change only triggers gravity update, etc.

**My recommendation**: plan as written (single callback). Only one tunable affects running state (gravity); others are read on next use. Simple.

---

Once approved, /build will: create worktree, spawn one Sonnet agent to implement all 9 commits, Haiku verifies the diff, /bugcheck runs on the integration branch, then I open the PR (without auto-merge) and you review the demo manually before merging.
