# World-gen PR 5: Dressing Passes (PlaceCaveAmbient + PlaceSurfaceDressing)

**Position:** PR 5 of ~6-8 in the world-gen v1 roadmap. Tracks worms#150.

**Status:** Approved. Ready for `/build`.

## Multi-PR roadmap context

Already shipped on master:
- PR 1 (worms#167): foundation - Pipeline, World struct (Uint8Array mask + materialMap), Pass interface, RNG helper, theme schema, tuning extensions
- PR 2 (worms#168): substrate passes - Reset, DefineTheme, GenerateHeightmap, ApplyThemeHeightmapMods, PaintSubstrateMask
- PR 3 (worms#169): carving passes (CarveCaves, FinalizeMask) + terraworldV1 generator + paintMaskToContext
- PR 4 (worms#170): material passes (PaintMaterialBands, PaintSurfaceCrust) + materials-aware paintWorldToContext + prePainted flag

PR 5 (this plan) adds passes 10-11 of 14: PlaceCaveAmbient and PlaceSurfaceDressing. After this, terraworldV1 will run 11 of 14 v1 passes. PR 6 covers spawn distribution + validation tail.

## What PR 5 delivers

1. **PlaceCaveAmbient pass** (pass 10): writes to `world.caveAmbient: AmbientFeature[]`. Theme-gated by `theme.flags.wantsCaveAmbient`. Type per theme: "frost" (snow), "moss" (jungle), "glow" (volcanic). Other themes never reach the pass body.
2. **PlaceSurfaceDressing pass** (pass 11): writes to `world.surfaceDressing: DressingFeature[]`. Theme-gated by NEW flag `theme.flags.wantsSurfaceDressing`. Sprite per theme: "grass_tuft" (default, jungle), "cactus" (canyon), "snow_drift" (snow), "ash_pile" (volcanic). Plateau opts out.
3. **paintDecorationToContext helper**: procedural canvas drawing for the two feature arrays.
4. **Integration**: terraworldV1 appends both passes; calls paintDecorationToContext after paintWorldToContext.

## Architectural decisions (5-question discipline applied)

### Decision 1: Density convention - attempt-count, not spacing

| Question | Answer |
|---|---|
| Bible cite | Silent. |
| Consensus cite | None. |
| Prior art | Terraria: `attempts = worldArea * 6E-05` for vanilla decoration passes (https://github.com/tModLoader/tModLoader/blob/master/ExampleMod/ExampleWorld.cs). Each attempt picks uniform random (x, y) and tries to place; no-ops on invalid placement. Phaser dungeon tutorials use per-room probability. Sebastian Lague has no decoration system. |
| Simplest sufficient | Attempt-count style matches the convergent shipped pattern. |
| Bite | Random clustering means uneven decoration; some columns/regions get nothing. Acceptable; Terraria has the same property. Per-theme tunable. |

**Decision: attempt-count style.**
- PlaceCaveAmbient attempts = `max(8, floor(widthPx * heightPx * caveAmbientAttemptFactor))`. Default factor 0.00015 (Terraria's 6E-05 baseline scaled 2.5x for our higher no-op rate; many random points won't land in cave interior).
- PlaceSurfaceDressing attempts = `max(4, floor(widthPx / surfaceDressingSpacingPx))`. Default spacing 40 (per-width since surface is 1D, not 2D area).

### Decision 2: Vocabulary - keep strings

| Question | Answer |
|---|---|
| Bible cite | Silent. |
| Consensus cite | PR 1 foundation pinned `AmbientFeature.type: string` and `DressingFeature.sprite: string`. |
| Prior art | Terraria uses integer enums (TileID.Sunflower=27). Noita uses strings at XML authoring boundary, u32 at runtime. Falling-sand engines use TypeID u32. String-only is less common but fine at our scale. |
| Simplest sufficient | We have 7 strings total (3 ambient types + 4 sprite types). Integer enum gains nothing at this scale. |
| Bite | If we add a sprite atlas pipeline later, we'd want integer ids. The string-to-integer migration is mechanical (one helper module). Easy fix. |

**Decision: keep strings.** Painter silently skips unknown strings (Terraria's PlaceTile no-op-on-invalid pattern).

### Decision 3: Data shape - separate arrays (deviation documented)

| Question | Answer |
|---|---|
| Bible cite | Silent. |
| Consensus cite | PR 1 foundation pinned `world.caveAmbient: AmbientFeature[]` and `world.surfaceDressing: DressingFeature[]`. |
| Prior art | Convergent: shipped games write decoration into the substrate grid (Terraria tile id, Noita cell type, Phaser tilemap layer). No surveyed reference uses a separate feature list. |
| Simplest sufficient | For our case (1-2 px decoration on a small feature count), arrays work. Materials grid integration would expand the palette per type; not better at our scale. |
| Bite | Decoration drawing is a separate render step (paintDecorationToContext after paintWorldToContext). Two function calls instead of one. Networking would have to ship two arrays in addition to the mask if we want decoration to sync (already a known-deferred concern from PR 4). |

**Decision: separate arrays, as PR 1 committed.** Documenting the deviation in the PR body.

## Workstreams

Three parallel Sonnet agents. Each owns disjoint files for clean merge.

### WS-A: PlaceCaveAmbient pass

**Worktree:** `/home/scott/worms-pr5-ws-a`
**Branch:** `feature/worldgen-pass-place-cave-ambient`
**Setup:**
```bash
git -C /home/scott/worms-pr5-ws-a checkout -b feature/worldgen-pass-place-cave-ambient
test -d /home/scott/worms-pr5-ws-a/node_modules || ln -s /home/scott/worms/node_modules /home/scott/worms-pr5-ws-a/node_modules
```

**Files (2 new):**
- `src/maps/passes/placeCaveAmbient.ts`
- `src/maps/passes/placeCaveAmbient.test.ts`

**`src/maps/passes/placeCaveAmbient.ts`:**

```typescript
import type { Pass } from "../pass";
import { rngInt } from "../rng";
import { MASK_AIR } from "../world";

const AMBIENT_TYPE_BY_THEME: Record<string, string> = {
  snow: "frost",
  jungle: "moss",
  volcanic: "glow",
};

/**
 * Places ambient decoration features inside cave cavities. Theme-gated by
 * theme.flags.wantsCaveAmbient. Type per theme: "frost" (snow), "moss"
 * (jungle), "glow" (volcanic). Other themes return early.
 *
 * Uses Terraria's attempt-count density convention: attempts scale with
 * world area (widthPx * heightPx * factor). Each attempt picks uniform
 * random (x, y) and validates; invalid attempts no-op. Many attempts will
 * not land in cave interior; that is expected and matches shipped procgen.
 *
 * RNG: 2 calls per attempt (rngInt for x and y).
 */
export const placeCaveAmbientPass: Pass = {
  name: "PlaceCaveAmbient",
  run: ({ world, rng, tuning, resolveParam }) => {
    if (!world.theme) {
      throw new Error(
        "PlaceCaveAmbient: world.theme is null; DefineTheme must run first",
      );
    }
    if (!world.theme.flags.wantsCaveAmbient) return;
    const type = AMBIENT_TYPE_BY_THEME[world.theme.tag];
    if (!type) return;

    const { widthPx, heightPx, mask, heightmap } = world;
    const factor = resolveParam(
      "caveAmbientAttemptFactor",
      tuning.worldgen.caveAmbient.attemptFactor,
    );
    if (factor <= 0) return;
    const attempts = Math.max(8, Math.floor(widthPx * heightPx * factor));

    for (let i = 0; i < attempts; i++) {
      const cx = rngInt(rng, widthPx);
      const cy = rngInt(rng, heightPx);
      const surfY = heightmap[cx];
      if (surfY === undefined || surfY >= heightPx) continue;
      if (cy <= surfY) continue;
      if (mask[cy * widthPx + cx] !== MASK_AIR) continue;
      world.caveAmbient.push({ xPx: cx, yPx: cy, type });
    }
  },
};
```

**`src/maps/passes/placeCaveAmbient.test.ts`:**

Use vitest. Test setup helper builds a World with theme and pre-populated heightmap + mask (simulating post-CarveCaves state). Tests:

1. `wantsCaveAmbient=false` (default theme) returns early; world.caveAmbient remains empty.
2. Snow theme on a world with a carved cave produces frost-typed features inside the cave.
3. All produced features satisfy: `mask[yPx*widthPx+xPx] === MASK_AIR && yPx > heightmap[xPx]`.
4. Determinism: same seed produces same caveAmbient list (deep-equal).
5. Theme.params.caveAmbientAttemptFactor override changes the produced count.
6. Throws on null theme.

**Cross-workstream constraint:** None. This file imports only from existing modules (pass, rng, world).

**Acceptance:** tsc clean, biome clean, tests pass.

**Commit:**
```bash
git -C /home/scott/worms-pr5-ws-a add src/maps/passes/placeCaveAmbient.ts src/maps/passes/placeCaveAmbient.test.ts
git -C /home/scott/worms-pr5-ws-a commit -m "feat(worldgen): PlaceCaveAmbient pass

Places ambient decoration features inside cave cavities via Terraria's
attempt-count convention: attempts = worldArea * factor (default 0.00015).
Each attempt picks uniform random (x, y) and validates that the position is
in cave interior (below surface, mask = AIR). Theme-gated by
theme.flags.wantsCaveAmbient with theme-keyed type strings (frost/moss/glow).

Part of PR 5 of the world-gen v1 pipeline. Tracks worms#150."
git -C /home/scott/worms-pr5-ws-a push -u origin feature/worldgen-pass-place-cave-ambient
```

### WS-B: PlaceSurfaceDressing pass + theme schema extension

**Worktree:** `/home/scott/worms-pr5-ws-b`
**Branch:** `feature/worldgen-pass-place-surface-dressing`

**Files (4):**
- `src/maps/themes.ts` (modify) - add `wantsSurfaceDressing: boolean` to ThemeFlags interface; update all 6 themes
- `src/maps/themes.test.ts` (modify if it tests flag presence)
- `src/maps/passes/placeSurfaceDressing.ts` (new)
- `src/maps/passes/placeSurfaceDressing.test.ts` (new)

**Theme flag values to add:**
- default: `wantsSurfaceDressing: true`
- canyon: `wantsSurfaceDressing: true`
- snow: `wantsSurfaceDressing: true`
- jungle: `wantsSurfaceDressing: true`
- plateau: `wantsSurfaceDressing: false`
- volcanic: `wantsSurfaceDressing: true`

**`src/maps/passes/placeSurfaceDressing.ts`:**

```typescript
import type { Pass } from "../pass";
import { rngInt } from "../rng";

const DRESSING_SPRITE_BY_THEME: Record<string, string> = {
  default: "grass_tuft",
  canyon: "cactus",
  snow: "snow_drift",
  jungle: "grass_tuft",
  volcanic: "ash_pile",
};

/**
 * Places surface dressing features at uniform random columns along the
 * surface. Theme-gated by theme.flags.wantsSurfaceDressing. Sprite per theme.
 *
 * Terraria-style: attempt count = floor(widthPx / spacingPx), uniform
 * random x per attempt. Invalid columns (void, missing surface) no-op.
 *
 * RNG: 1 call per attempt.
 */
export const placeSurfaceDressingPass: Pass = {
  name: "PlaceSurfaceDressing",
  run: ({ world, rng, tuning, resolveParam }) => {
    if (!world.theme) {
      throw new Error(
        "PlaceSurfaceDressing: world.theme is null; DefineTheme must run first",
      );
    }
    if (!world.theme.flags.wantsSurfaceDressing) return;
    const sprite = DRESSING_SPRITE_BY_THEME[world.theme.tag];
    if (!sprite) return;

    const { widthPx, heightPx, heightmap } = world;
    const spacingPx = resolveParam(
      "surfaceDressingSpacingPx",
      tuning.worldgen.surfaceDressing.spacingPx,
    );
    if (spacingPx <= 0) return;
    const attempts = Math.max(4, Math.floor(widthPx / spacingPx));

    for (let i = 0; i < attempts; i++) {
      const cx = rngInt(rng, widthPx);
      const surfY = heightmap[cx];
      if (surfY === undefined || surfY < 0 || surfY >= heightPx) continue;
      const yPx = surfY - 1;
      if (yPx < 0) continue;
      world.surfaceDressing.push({ xPx: cx, yPx, sprite });
    }
  },
};
```

**ThemeFlags extension:**

```typescript
export interface ThemeFlags {
  wantsPeaks: boolean;
  wantsCaves: boolean;
  noFloor: boolean;
  wantsSurfaceCrust: boolean;
  wantsCaveAmbient: boolean;
  wantsSurfaceDressing: boolean; // NEW
}
```

Update each theme to include the new flag with the values above.

**Tests for placeSurfaceDressing.test.ts:**

1. Plateau theme (`wantsSurfaceDressing=false`) returns early; world.surfaceDressing remains empty.
2. Default theme produces grass_tuft features.
3. All produced features have `yPx === heightmap[xPx] - 1` and `heightmap[xPx]` is a valid surface (not void).
4. Determinism.
5. Theme.params.surfaceDressingSpacingPx override changes the produced count.
6. Throws on null theme.

**Tests for themes.test.ts:** verify all 6 themes have `wantsSurfaceDressing` as a boolean.

**Cross-workstream constraint:** None. Self-contained.

**Acceptance:** tsc clean, biome clean, tests pass.

**Commit:**
```bash
git -C /home/scott/worms-pr5-ws-b add src/maps/themes.ts src/maps/themes.test.ts src/maps/passes/placeSurfaceDressing.ts src/maps/passes/placeSurfaceDressing.test.ts
git -C /home/scott/worms-pr5-ws-b commit -m "feat(worldgen): PlaceSurfaceDressing pass + wantsSurfaceDressing flag

Adds wantsSurfaceDressing to ThemeFlags. Plateau opts out (raw rock surface);
all other themes have it true.

Pass uses Terraria-style attempt-count density: attempts = widthPx / spacingPx
(default 40), uniform random column per attempt. Sprite per theme: grass_tuft
(default, jungle), cactus (canyon), snow_drift (snow), ash_pile (volcanic).

Part of PR 5 of the world-gen v1 pipeline. Tracks worms#150."
git -C /home/scott/worms-pr5-ws-b push -u origin feature/worldgen-pass-place-surface-dressing
```

### WS-C: paintDecorationToContext helper

**Worktree:** `/home/scott/worms-pr5-ws-c`
**Branch:** `feature/worldgen-paint-decoration-helper`

**Files (2 new):**
- `src/maps/generators/paintDecorationToContext.ts`
- `src/maps/generators/paintDecorationToContext.test.ts`

**`src/maps/generators/paintDecorationToContext.ts`:**

```typescript
import type { AmbientFeature, DressingFeature } from "../world";

const AMBIENT_COLORS: Record<string, string> = {
  moss: "#2a5a1a",
  frost: "#caf0ff",
  glow: "#ff7a00",
};

const DRESSING_COLORS: Record<string, string> = {
  grass_tuft: "#3a8a3a",
  cactus: "#4a7a3a",
  snow_drift: "#f5f7fa",
  ash_pile: "#1a1a1a",
};

/**
 * Renders cave ambient and surface dressing features onto a canvas via
 * procedural shapes. Runs after paintWorldToContext (which paints the
 * substrate + materials). Out-of-bounds features are clipped by the canvas.
 *
 * Cave ambient: 2x2 filled square at (xPx, yPx). Color from AMBIENT_COLORS
 * keyed by feature.type.
 *
 * Surface dressing: 2x3 filled rect anchored at (xPx, yPx) extending
 * upward (y - 2 to y + 1) so the dressing sits ON the surface. Color from
 * DRESSING_COLORS keyed by feature.sprite.
 *
 * Unknown type or sprite strings are silently skipped (Terraria
 * PlaceTile no-op-on-invalid convention).
 */
export function paintDecorationToContext(
  ctx: CanvasRenderingContext2D,
  ambient: readonly AmbientFeature[],
  dressing: readonly DressingFeature[],
): void {
  for (const f of ambient) {
    const color = AMBIENT_COLORS[f.type];
    if (!color) continue;
    ctx.fillStyle = color;
    ctx.fillRect(f.xPx, f.yPx, 2, 2);
  }
  for (const f of dressing) {
    const color = DRESSING_COLORS[f.sprite];
    if (!color) continue;
    ctx.fillStyle = color;
    ctx.fillRect(f.xPx, f.yPx - 2, 2, 3);
  }
}
```

**Tests (use `canvas` npm package, consistent with paintWorldToContext.test.ts):**

1. Single ambient feature paints the expected color at (xPx, yPx) over a 2x2 area.
2. Single dressing feature paints the expected color at (xPx, yPx-2) over a 2x3 area.
3. Unknown ambient type silently skipped; canvas unchanged in that region.
4. Unknown dressing sprite silently skipped.
5. Empty arrays no-op (no canvas changes).
6. Mixed valid + invalid entries: valid ones paint, invalid skipped.

**Cross-workstream constraint:** None. Imports only AmbientFeature and DressingFeature types from world.ts (existing).

**Acceptance:** tsc clean, biome clean, tests pass.

**Commit:**
```bash
git -C /home/scott/worms-pr5-ws-c add src/maps/generators/paintDecorationToContext.ts src/maps/generators/paintDecorationToContext.test.ts
git -C /home/scott/worms-pr5-ws-c commit -m "feat(worldgen): paintDecorationToContext helper

Procedural canvas drawing for cave ambient + surface dressing features.
Maps type/sprite strings to small filled rect shapes via lookup tables.
Unknown strings silently skip (Terraria no-op-on-invalid convention).

Cave ambient: 2x2 filled squares.
Surface dressing: 2x3 filled rects anchored above the surface.

Future PR can swap to a sprite atlas without changing the pass interfaces.

Part of PR 5 of the world-gen v1 pipeline. Tracks worms#150."
git -C /home/scott/worms-pr5-ws-c push -u origin feature/worldgen-paint-decoration-helper
```

## Integration phase (Opus during /build Phase 3)

After WS-A, WS-B, WS-C merge into `integrate/worldgen-dressing`, Opus directly modifies on the integration branch:

### 1. `src/tuning.ts`

Add to the `worldgen` section type and value:

**Type addition:**
```typescript
worldgen: {
  // ... existing fields ...
  caveAmbient: {
    /** Attempt count = floor(widthPx * heightPx * factor). 0.00015 derives
     *  from Terraria's 6E-05 baseline scaled 2.5x to compensate for higher
     *  no-op rate (random points often miss carved cave interior). */
    attemptFactor: number;
  };
  surfaceDressing: {
    /** Attempt count = floor(widthPx / spacingPx). Per-width because
     *  surface is a 1D feature, not 2D area. */
    spacingPx: number;
  };
}
```

**Value addition:**
```typescript
caveAmbient: {
  attemptFactor: 0.00015,
},
surfaceDressing: {
  spacingPx: 40,
},
```

### 2. `src/maps/themes.ts`

Add to `ThemeParams`:
```typescript
caveAmbientAttemptFactor?: number;
surfaceDressingSpacingPx?: number;
```

### 3. `src/maps/generators/terraworldV1.ts`

Append the two new passes to PASSES (now 11 of 14). Updated array:

```typescript
import { placeCaveAmbientPass } from "../passes/placeCaveAmbient";
import { placeSurfaceDressingPass } from "../passes/placeSurfaceDressing";
import { paintDecorationToContext } from "./paintDecorationToContext";

const PASSES = [
  resetPass,
  defineThemePass,
  generateHeightmapPass,
  applyThemeHeightmapModsPass,
  paintSubstrateMaskPass,
  paintMaterialBandsPass,
  carveCavesPass,
  finalizeMaskPass,
  paintSurfaceCrustPass,
  placeCaveAmbientPass,        // NEW pass 10
  placeSurfaceDressingPass,    // NEW pass 11
];
```

Update the generator's body to call paintDecorationToContext after paintWorldToContext:

```typescript
export const terraworldV1Generator: MapGenerator = (ctx, widthPx, heightPx, opts) => {
  const themeTag = (opts.themeTag as string | undefined) ?? "default";
  const world = createWorld(opts.seed, widthPx, heightPx, themeTag);
  new Pipeline(PASSES).run(world);
  if (!world.theme) {
    throw new Error("terraworldV1: theme is null after pipeline run; DefineTheme should have populated it");
  }
  paintWorldToContext(ctx, world.mask, world.materialMap, world.theme.palette, widthPx, heightPx);
  paintDecorationToContext(ctx, world.caveAmbient, world.surfaceDressing);
};
```

### 4. `src/maps/generators/terraworldV1.integration.test.ts`

Add two assertions:

1. Snow theme produces caveAmbient features with type "frost" inside cave cavities. Verify by running the generator on a snow world and checking that there exists at least one pixel matching the AMBIENT_COLORS["frost"] color value (`#caf0ff`) inside what would be a cave region.
2. Default theme produces surfaceDressing features with sprite "grass_tuft". Verify by running the generator on a default world and checking that at least one pixel matches DRESSING_COLORS["grass_tuft"] (`#3a8a3a`) just above a surface line.

(Direct color comparison via `ctx.getImageData`; document that we are sampling for known palette colors as proof that the decoration painter ran.)

## Bugcheck Phase 3 expectations

Apply 5 lenses:
1. Algorithm correctness (attempt math, validation predicates, theme-keyed lookups)
2. Determinism (rngInt usage, no Math.random anywhere)
3. Cross-pass interactions (decoration passes run AFTER FinalizeMask and PaintSurfaceCrust; reads heightmap and mask which are settled)
4. Edge cases (tiny worlds, empty themes, missing types in lookup, attemptFactor=0, spacingPx=0)
5. Renderer integration (paintDecorationToContext runs after paintWorldToContext; no conflicts on alpha; bounds clipping by canvas; networked path will lose decoration like materials in PR 4)

Known issues to expect (acknowledge in PR body, not blockers):
- Same Medium as PR 4: networked v1 maps lose decoration because the wire protocol is alpha-only.
- Random clustering: some columns get no surface dressing, some get multiple. Acceptable per Terraria pattern.

## PR body template

```
## Summary

PR 5 of the world-gen v1 pipeline. Adds the 2 dressing passes and a
procedural canvas painter for the resulting feature arrays. terraworldV1
now runs 11 of 14 v1 passes.

Tracks worms#150.

## Workstreams

- WS-A: PlaceCaveAmbient pass (Terraria-style attempt-count density)
- WS-B: PlaceSurfaceDressing pass + wantsSurfaceDressing flag
- WS-C: paintDecorationToContext helper (procedural shapes)

## Integration

- tuning.ts: caveAmbient.attemptFactor (0.00015), surfaceDressing.spacingPx (40)
- ThemeParams: caveAmbientAttemptFactor, surfaceDressingSpacingPx (per-theme overrides)
- terraworldV1.ts: appends 2 passes, calls paintDecorationToContext after paintWorldToContext
- Integration test: assert frost ambient color (snow) and grass_tuft dressing color (default) appear

## Process appendix discipline

Three architectural decisions documented with the 5-question framework:
- Density convention (attempt-count, grounded in Terraria's 6E-05 baseline)
- Vocabulary (strings; Terraria/Noita use integers but our scale doesn't justify)
- Data shape (separate arrays; documented deviation from in-grid prior art)

## Known issue (Medium): networked decoration loss

Same as PR 4: networked v1 clients lose materials and decoration because the
wire protocol is alpha-only. Geometry (mask) syncs identically; only the
visual layer differs between host and clients. Future fix is to encode
materials + decoration in the wire protocol or have clients re-run gen
from the seed.

## Test plan

- [x] No em dashes
- [x] All tests pass (~410+ expected after PR 5)
- [x] tsc clean
- [x] biome clean
- [x] Bugcheck Phase 3 complete
- [ ] Manual review
```

## Out of scope (deferred)

- Sprite atlas pipeline (would convert string vocab to integer ids)
- Poisson-disc decoration spacing for more even distribution
- Networked decoration sync
- DistributeSpawnPoints + ValidateSpawnCoherence + FinalCleanup (PR 6)

## How to execute

1. `/clear` (this plan and the memory carry the plan forward)
2. `/build` (executes the plan; reads `docs/plans/worldgen-pr5-dressing.md` for context)
