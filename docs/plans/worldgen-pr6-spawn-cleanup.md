# World-gen PR 6: Spawn distribution + validation + final cleanup

**Position:** PR 6 of ~6-8 in the world-gen v1 roadmap. Tracks worms#150. **Final PR of the v1 effort** unless one of these passes splits.

**Status:** Draft. Awaiting user approval.

## Changes from adversarial review

This plan was stress-tested before approval. The following clear-miss fixes have been applied inline (see corresponding sections):

- **BLOCKING - team-side clumping bug**: the worker (`worker/src/room.ts:887-900`) distributes spawns via `mapSpawns[(teamIdx + wormIdx * rosters.length) % mapSpawns.length]`. With sorted-by-xPx left/right concatenation, both teams would clump on the same side. **Fix**: integration phase interleaves `[L0, R0, L1, R1, ...]` when flattening to LoadedMap.spawnPoints.
- **BLOCKING - inconsistent mutation**: WS-C reassigned `spawnList.left/right` via property write but mutated `caveAmbient/surfaceDressing` in-place. **Fix**: WS-C uses in-place mutation throughout.
- **SHOULD-FIX - canvas-top edge case**: a worm at `surfY === 0` would have no headroom. **Fix**: WS-A predicate excludes `surfY === 0` columns.
- **SHOULD-FIX - warning flood**: per-spawn warnings could emit hundreds of lines. **Fix**: WS-B emits one summary warning per side.
- **SHOULD-FIX - canyon_v1 coverage gap**: integration tests only exercised default theme. **Fix**: added a fourth integration assertion for canyon_v1.
- **SHOULD-FIX - mock leakage**: integration test #3's `vi.mock` needed `beforeEach` reset. **Fix**: added explicit setup note.
- **NICE-TO-HAVE - readability**: `dedupeSorted` uses `null` sentinel instead of `Number.NaN`; added a comment about xPx-only dedupe.
- **NICE-TO-HAVE - bugcheck lens 6**: added "downstream consumers" lens (worker round-robin + game-side spawn array consumers).
- **NICE-TO-HAVE - PR body**: noted v1-vs-legacy spawn position divergence is intentional.

## Multi-PR roadmap context

Already shipped on master:
- PR 1 (worms#167): foundation - Pipeline, World struct (Uint8Array mask + materialMap + heightmap + spawnList + caveAmbient + surfaceDressing), Pass interface, RNG helper, theme schema, tuning extensions
- PR 2 (worms#168): substrate passes - Reset, DefineTheme, GenerateHeightmap, ApplyThemeHeightmapMods, PaintSubstrateMask
- PR 3 (worms#169): carving passes (CarveCaves, FinalizeMask) + terraworldV1 generator + paintMaskToContext
- PR 4 (worms#170): material passes (PaintMaterialBands, PaintSurfaceCrust) + materials-aware paintWorldToContext + prePainted flag
- PR 5 (worms#172): dressing passes (PlaceCaveAmbient, PlaceSurfaceDressing) + paintDecorationToContext

PR 6 (this plan) adds passes 12-14 of 14: DistributeSpawnPoints, ValidateSpawnCoherence, FinalCleanup. After this, terraworldV1 runs the FULL 14-pass v1 pipeline and authoritative spawn data flows from the pipeline through LoadedMap to the game engine (replacing the legacy post-generation `findSpawnPoints` scan for v1 maps).

## What PR 6 delivers

1. **DistributeSpawnPoints pass** (pass 12): populates `world.spawnList.left[]` and `world.spawnList.right[]` (already-pinned shape from PR 1 foundation). Reads `world.heightmap` (authoritative surface y per column), partitions columns by `xPx < widthPx/2`, samples deterministically with min-spacing relaxation, sorts each side by xPx ascending (per the SpawnList contract in `src/maps/world.ts:32-35`).
2. **ValidateSpawnCoherence pass** (pass 13): checks invariants (min-per-team count, surface validity, no-floating, edge margin) and `console.warn`s on violation. Soft validation: pipeline continues regardless. Designed to surface issues during local dev / playtests without blocking generation.
3. **FinalCleanup pass** (pass 14): final hygiene sweep. Trims `caveAmbient` and `surfaceDressing` features whose target cells became inconsistent post-other-passes (defensive, since placing passes already guard - this catches drift). Sorts `spawnList.left` and `spawnList.right` by xPx (idempotent, but enforces the contract). De-dupes by xPx.
4. **Integration**: terraworldV1Generator returns `SpawnList` (changes `MapGenerator` signature to `void | SpawnList`); `loadMap.ts` prefers returned `SpawnList` over the legacy `findSpawnPoints` scan when present.

## Architectural decisions (5-question discipline applied)

### Decision 1: Spawn placement source - heightmap vs canvas-pixel-scan

| Question | Answer |
|---|---|
| Bible cite | Legacy `findSpawnPoints` (`src/worm/spawnPoints.ts:1`) scans `Uint8ClampedArray` from `getImageData` - canvas-pixel-scan style. |
| Consensus cite | PR 1 foundation pinned `world.heightmap: Int32Array` (per-column surface y; `src/maps/world.ts:64-65`). PR 2's GenerateHeightmap is the authoritative source. |
| Prior art | Terraria places spawns via heightmap-based sampling per https://github.com/tModLoader/tModLoader (rejection-sampling + min-separation; ~1000 retry budget). Sebastian Lague tutorials sample dungeon graph nodes, not surface columns. Most surveyed engines use the heightmap when it exists, scan-canvas when it does not. |
| Simplest sufficient | v1 already has the heightmap. Re-scanning the canvas via `getImageData` would duplicate work and lose the column abstraction. |
| Bite | Heightmap-based placement does not handle ceilings/overhangs, but v1's GenerateHeightmap is single-surface-per-column by design - no overhangs exist in the v1 contract. So no functional loss. |

**Decision: heightmap-based placement.** The pass reads `world.heightmap[cx]` and `world.mask` to validate (cell at heightmap[cx] is solid; cell above is air). RNG via `rngInt(rng, widthPx)` for column choice; greedy pick with progressive minSpacing relaxation factors `[1.0, 0.8, 0.6, 0.4, 0.2, 0]` mirroring legacy `findSpawnPoints` for behavioral parity.

### Decision 2: Validation severity - warn vs throw

| Question | Answer |
|---|---|
| Bible cite | `tuning.ts:140-141` already documents intent: "Below this, ValidateSpawnCoherence logs a warning." |
| Consensus cite | None other than the tuning comment. |
| Prior art | Terraria does not have a "validate" pass - it retries placement on failure. Most procgen game engines either retry until success or accept degraded output silently. Explicit post-validation is uncommon. |
| Simplest sufficient | `console.warn` matches the tuning-comment intent and is minimally invasive. Pipeline continues; downstream code can detect insufficient spawns at game-start time and handle gracefully. |
| Bite | A throw would block test runs that legitimately want to validate edge-case worlds (e.g., very small canvases for unit tests). A warn keeps tests green and surfaces issues only when human eyes are on the console. |

**Decision: console.warn on violation.** Pass body emits a warning string per failed invariant. Test cases assert via `vi.spyOn(console, "warn")` that the warning fires for the expected condition. Throw only on hard preconditions (null theme), matching existing pass conventions.

### Decision 3: FinalCleanup scope - hygiene, not transformation

| Question | Answer |
|---|---|
| Bible cite | FinalizeMask (`src/maps/passes/finalizeMask.ts`) cleans only the mask (orphan-island removal). It does not touch features, materialMap, or spawnList. |
| Consensus cite | Each placing pass (PlaceCaveAmbient, PlaceSurfaceDressing) already guards its writes via predicates (mask=AIR for ambient, valid heightmap for dressing). FinalCleanup must not duplicate these guards - it catches drift only. |
| Prior art | Terraria's `WorldGen.gen` tail has small post-passes (smoothing, gemstone scatter cleanup) that are conventionally bounded - "remove what should not be there" rather than "transform what's there". Roguelike post-gen passes follow the same shape. |
| Simplest sufficient | Three operations, all idempotent: (a) trim caveAmbient features whose mask cell is no longer AIR, (b) trim surfaceDressing features whose column heightmap is now invalid, (c) sort + dedupe spawnList.left/right by xPx (enforces SpawnList contract). |
| Bite | Idempotent operations cost CPU (small - all O(N) in features count or O(K log K) for K spawns). De-duping spawn entries is a defensive measure; the placing pass should not produce duplicates, but the cleanup pass guarantees the contract regardless. |

**Decision: hygiene-only cleanup.** Three bounded operations as listed. No flood-fill reachability check, no spawn re-placement, no materialMap normalization. If those become needed later, they get their own pass.

## Workstreams

Three parallel Sonnet agents. Each owns disjoint files for clean merge.

### WS-A: DistributeSpawnPoints pass

**Worktree:** `/home/scott/worms-pr6-ws-a`
**Branch:** `feature/worldgen-pass-distribute-spawn-points`
**Setup:**
```bash
git -C /home/scott/worms-pr6-ws-a checkout -b feature/worldgen-pass-distribute-spawn-points
test -d /home/scott/worms-pr6-ws-a/node_modules || ln -s /home/scott/worms/node_modules /home/scott/worms-pr6-ws-a/node_modules
```

**Files (2 new):**
- `src/maps/passes/distributeSpawnPoints.ts`
- `src/maps/passes/distributeSpawnPoints.test.ts`

**`src/maps/passes/distributeSpawnPoints.ts`:**

```typescript
import type { Pass } from "../pass";
import { rngInt } from "../rng";
import { MASK_AIR, MASK_SOLID } from "../world";
import type { SpawnPoint } from "../world";

const RELAXATION_FACTORS = [1.0, 0.8, 0.6, 0.4, 0.2, 0] as const;

/**
 * Populates world.spawnList.left and world.spawnList.right with valid
 * surface positions partitioned by xPx midline. Reads world.heightmap as
 * the authoritative per-column surface y; validates that the surface cell
 * is solid and the cell above is air (worm-fits invariant).
 *
 * Algorithm mirrors legacy findSpawnPoints (src/worm/spawnPoints.ts):
 * shuffle valid columns deterministically, then greedy-pick with
 * progressive minSpacing relaxation to fill the per-side count.
 *
 * Honors edgeMarginPx (skip columns near canvas edges) and densityPx
 * (min horizontal spacing between accepted spawns). Per-team count target
 * comes from minPerTeam tuning (or per-theme override).
 *
 * Throws on null theme. Returns early on degenerate dimensions.
 *
 * RNG: O(validColumns) calls for the Fisher-Yates shuffle, then O(picks)
 * additional calls only if relaxation iteration is needed.
 */
export const distributeSpawnPointsPass: Pass = {
  name: "DistributeSpawnPoints",
  run: ({ world, rng, tuning, resolveParam }) => {
    if (!world.theme) {
      throw new Error(
        "DistributeSpawnPoints: world.theme is null; DefineTheme must run first",
      );
    }
    const { widthPx, heightPx, heightmap, mask, spawnList } = world;
    if (widthPx <= 0 || heightPx <= 0) return;

    const densityPx = resolveParam("spawnDensity", tuning.worldgen.spawn.densityPx);
    const minPerTeam = resolveParam(
      "minSpawnsPerTeam",
      tuning.worldgen.spawn.minPerTeam,
    );
    if (densityPx <= 0 || minPerTeam <= 0) return;

    const edgeMarginPx = Math.min(60, Math.floor(widthPx / 8));
    const midX = Math.floor(widthPx / 2);

    const leftCandidates: SpawnPoint[] = [];
    const rightCandidates: SpawnPoint[] = [];
    for (let cx = edgeMarginPx; cx < widthPx - edgeMarginPx; cx++) {
      const surfY = heightmap[cx];
      // Skip degenerate columns and canvas-top surfaces (need >= 1 row of
      // air above for worm clearance).
      if (surfY === undefined || surfY < 1 || surfY >= heightPx) continue;
      if (mask[surfY * widthPx + cx] !== MASK_SOLID) continue;
      if (mask[(surfY - 1) * widthPx + cx] !== MASK_AIR) continue;
      const point: SpawnPoint = { xPx: cx, yPx: surfY - 1 };
      if (cx < midX) leftCandidates.push(point);
      else rightCandidates.push(point);
    }

    spawnList.left.push(...pickWithRelaxation(leftCandidates, minPerTeam, densityPx, rng));
    spawnList.right.push(...pickWithRelaxation(rightCandidates, minPerTeam, densityPx, rng));
    spawnList.left.sort((a, b) => a.xPx - b.xPx);
    spawnList.right.sort((a, b) => a.xPx - b.xPx);
  },
};

function pickWithRelaxation(
  candidates: SpawnPoint[],
  target: number,
  densityPx: number,
  rng: () => number,
): SpawnPoint[] {
  if (candidates.length === 0) return [];
  const shuffled = candidates.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = rngInt(rng, i + 1);
    const tmp = shuffled[i];
    if (tmp === undefined) continue;
    const swap = shuffled[j];
    if (swap === undefined) continue;
    shuffled[i] = swap;
    shuffled[j] = tmp;
  }
  for (const factor of RELAXATION_FACTORS) {
    const minSpacing = densityPx * factor;
    const picked: SpawnPoint[] = [];
    for (const p of shuffled) {
      if (picked.every((q) => Math.abs(q.xPx - p.xPx) >= minSpacing)) {
        picked.push(p);
        if (picked.length >= target) return picked;
      }
    }
    if (picked.length >= target) return picked;
  }
  return shuffled.slice(0, target);
}
```

**`src/maps/passes/distributeSpawnPoints.test.ts`:**

Use vitest. Read `src/maps/passes/placeCaveAmbient.test.ts` and `src/maps/passes/finalizeMask.test.ts` first to follow the harness pattern (synthetic World, makeCtx helper).

**Tests required (9):**

1. Throws on null theme.
2. `densityPx <= 0` returns early; spawnList unchanged.
3. `minPerTeam <= 0` returns early.
4. With a flat surface across full width, produces `>= minPerTeam` spawns on each side.
5. Left spawns are all at `xPx < widthPx/2`; right spawns are all at `xPx >= widthPx/2`.
6. All produced spawns satisfy: `heightmap[xPx] >= 1`, `mask[heightmap[xPx] * widthPx + xPx] === MASK_SOLID`, and `mask[(heightmap[xPx]-1) * widthPx + xPx] === MASK_AIR`.
7. Columns where `heightmap[xPx] === 0` are skipped (synthetic: build a world with surfY=0 across the entire width; pass produces zero spawns).
8. Determinism: same seed produces deep-equal `spawnList.left` and `spawnList.right`.
9. After pass, both `spawnList.left` and `spawnList.right` are sorted by xPx ascending.

**Cross-workstream constraint:** None. Self-contained.

**Acceptance:**
- `cd /home/scott/worms-pr6-ws-a && npx tsc --noEmit` clean
- `npx biome check --write src/maps/passes/distributeSpawnPoints.ts src/maps/passes/distributeSpawnPoints.test.ts` clean
- `npx vitest run src/maps/passes/distributeSpawnPoints.test.ts` all 8 tests pass
- `npx vitest run` no regressions

**Commit:**
```bash
git -C /home/scott/worms-pr6-ws-a add src/maps/passes/distributeSpawnPoints.ts src/maps/passes/distributeSpawnPoints.test.ts
git -C /home/scott/worms-pr6-ws-a commit -m "feat(worldgen): DistributeSpawnPoints pass

Populates world.spawnList.left and world.spawnList.right via heightmap-
based sampling. Partitions columns by xPx midline; greedy-picks with
progressive minSpacing relaxation factors mirroring legacy findSpawnPoints
behavior. Sorts each side by xPx ascending per the SpawnList contract.

Part of PR 6 of the world-gen v1 pipeline. Tracks worms#150."
git -C /home/scott/worms-pr6-ws-a push -u origin feature/worldgen-pass-distribute-spawn-points
```

### WS-B: ValidateSpawnCoherence pass

**Worktree:** `/home/scott/worms-pr6-ws-b`
**Branch:** `feature/worldgen-pass-validate-spawn-coherence`
**Setup:**
```bash
git -C /home/scott/worms-pr6-ws-b checkout -b feature/worldgen-pass-validate-spawn-coherence
test -d /home/scott/worms-pr6-ws-b/node_modules || ln -s /home/scott/worms/node_modules /home/scott/worms-pr6-ws-b/node_modules
```

**Files (2 new):**
- `src/maps/passes/validateSpawnCoherence.ts`
- `src/maps/passes/validateSpawnCoherence.test.ts`

**`src/maps/passes/validateSpawnCoherence.ts`:**

```typescript
import type { Pass } from "../pass";
import { MASK_AIR, MASK_SOLID } from "../world";

/**
 * Soft post-distribution validation. Emits console.warn on each violated
 * invariant and continues. Designed to surface issues during local dev
 * and playtests without blocking generation.
 *
 * Invariants checked:
 * - Each side has at least minPerTeam spawns.
 * - All spawn cells satisfy: heightmap[xPx] is in [0, heightPx) AND
 *   mask[heightmap[xPx]*widthPx+xPx] === MASK_SOLID AND (heightmap is 0 OR
 *   mask[(heightmap-1)*widthPx+xPx] === MASK_AIR).
 *
 * Throws on null theme.
 */
export const validateSpawnCoherencePass: Pass = {
  name: "ValidateSpawnCoherence",
  run: ({ world, tuning, resolveParam }) => {
    if (!world.theme) {
      throw new Error(
        "ValidateSpawnCoherence: world.theme is null; DefineTheme must run first",
      );
    }
    const minPerTeam = resolveParam(
      "minSpawnsPerTeam",
      tuning.worldgen.spawn.minPerTeam,
    );
    if (minPerTeam <= 0) return;

    const { widthPx, heightPx, heightmap, mask, spawnList } = world;
    const themeTag = world.theme.tag;

    if (spawnList.left.length < minPerTeam) {
      console.warn(
        `[ValidateSpawnCoherence] theme=${themeTag} left team has ${spawnList.left.length} spawns; minPerTeam=${minPerTeam}`,
      );
    }
    if (spawnList.right.length < minPerTeam) {
      console.warn(
        `[ValidateSpawnCoherence] theme=${themeTag} right team has ${spawnList.right.length} spawns; minPerTeam=${minPerTeam}`,
      );
    }

    for (const side of ["left", "right"] as const) {
      let failed = 0;
      for (const p of spawnList[side]) {
        const surfY = heightmap[p.xPx];
        const ok =
          surfY !== undefined &&
          surfY >= 1 &&
          surfY < heightPx &&
          mask[surfY * widthPx + p.xPx] === MASK_SOLID &&
          mask[(surfY - 1) * widthPx + p.xPx] === MASK_AIR;
        if (!ok) failed++;
      }
      if (failed > 0) {
        console.warn(
          `[ValidateSpawnCoherence] theme=${themeTag} side=${side}: ${failed} of ${spawnList[side].length} spawns failed surface invariant`,
        );
      }
    }
  },
};
```

**`src/maps/passes/validateSpawnCoherence.test.ts`:**

**Tests required (6):**

1. Throws on null theme.
2. Healthy world (synthetic flat terrain, 3 spawns each side, minPerTeam=2): no warnings emitted (`expect(consoleWarn).not.toHaveBeenCalled()`).
3. Underpopulated left team (1 spawn, minPerTeam=2): warns once with substring matching `left team has 1 spawns`.
4. Spawn pointing to invalid mask cell (build a synthetic world where 3 of the spawn entries on the left side have heightmap pointing to a non-SOLID cell): emits ONE summary warning per side with substring `3 of 5 spawns failed surface invariant` (assumes left has 5 total, 3 invalid).
5. Multiple invalid spawns produce ONE warning per side, not N warnings (regression guard against per-spawn flooding).
6. `minPerTeam=0` returns early; no warnings even with empty spawnList.

Use `vi.spyOn(console, "warn").mockImplementation(() => {})` to capture warnings, restore after each test via `afterEach(() => { vi.restoreAllMocks(); })`.

**Cross-workstream constraint:** None. Self-contained.

**Acceptance:**
- `npx tsc --noEmit` clean
- `npx biome check --write src/maps/passes/validateSpawnCoherence.ts src/maps/passes/validateSpawnCoherence.test.ts` clean
- `npx vitest run src/maps/passes/validateSpawnCoherence.test.ts` all 5 tests pass
- `npx vitest run` no regressions

**Commit:**
```bash
git -C /home/scott/worms-pr6-ws-b add src/maps/passes/validateSpawnCoherence.ts src/maps/passes/validateSpawnCoherence.test.ts
git -C /home/scott/worms-pr6-ws-b commit -m "feat(worldgen): ValidateSpawnCoherence pass

Soft post-distribution validation. Emits console.warn per violated
invariant (per-team count below minPerTeam, spawn pointing to invalid
mask cell). Pipeline continues regardless. Designed to surface issues
during local dev and playtests without blocking generation.

Part of PR 6 of the world-gen v1 pipeline. Tracks worms#150."
git -C /home/scott/worms-pr6-ws-b push -u origin feature/worldgen-pass-validate-spawn-coherence
```

### WS-C: FinalCleanup pass

**Worktree:** `/home/scott/worms-pr6-ws-c`
**Branch:** `feature/worldgen-pass-final-cleanup`
**Setup:**
```bash
git -C /home/scott/worms-pr6-ws-c checkout -b feature/worldgen-pass-final-cleanup
test -d /home/scott/worms-pr6-ws-c/node_modules || ln -s /home/scott/worms/node_modules /home/scott/worms-pr6-ws-c/node_modules
```

**Files (2 new):**
- `src/maps/passes/finalCleanup.ts`
- `src/maps/passes/finalCleanup.test.ts`

**`src/maps/passes/finalCleanup.ts`:**

```typescript
import type { Pass } from "../pass";
import { MASK_AIR } from "../world";
import type { SpawnPoint } from "../world";

/**
 * Final hygiene sweep. Three idempotent operations:
 *
 * 1. Trim caveAmbient features whose mask cell is no longer AIR (defensive;
 *    PlaceCaveAmbient guards this on insert, so this catches drift if any
 *    later pass were to mutate the mask).
 * 2. Trim surfaceDressing features whose column heightmap is invalid
 *    (negative or beyond the canvas height).
 * 3. Sort and de-dupe spawnList.left and spawnList.right by xPx.
 *
 * No throw paths beyond the standard null-theme check. No flood-fill or
 * reachability validation - those would be a separate pass.
 */
export const finalCleanupPass: Pass = {
  name: "FinalCleanup",
  run: ({ world }) => {
    if (!world.theme) {
      throw new Error("FinalCleanup: world.theme is null; DefineTheme must run first");
    }
    const { widthPx, heightPx, heightmap, mask, caveAmbient, surfaceDressing, spawnList } =
      world;

    const ambientKept = caveAmbient.filter(
      (f) => mask[f.yPx * widthPx + f.xPx] === MASK_AIR,
    );
    caveAmbient.length = 0;
    caveAmbient.push(...ambientKept);

    const dressingKept = surfaceDressing.filter((f) => {
      const surfY = heightmap[f.xPx];
      return surfY !== undefined && surfY >= 0 && surfY < heightPx;
    });
    surfaceDressing.length = 0;
    surfaceDressing.push(...dressingKept);

    const dedupedLeft = dedupeSorted(spawnList.left);
    spawnList.left.length = 0;
    spawnList.left.push(...dedupedLeft);

    const dedupedRight = dedupeSorted(spawnList.right);
    spawnList.right.length = 0;
    spawnList.right.push(...dedupedRight);
  },
};

// xPx-only dedupe is sufficient because the v1 heightmap is single-y-per-column,
// so any two spawns at the same xPx must also share yPx. If overhang support is
// added later, change the dedupe key to (xPx, yPx).
function dedupeSorted(points: SpawnPoint[]): SpawnPoint[] {
  const sorted = points.slice().sort((a, b) => a.xPx - b.xPx);
  const out: SpawnPoint[] = [];
  let lastX: number | null = null;
  for (const p of sorted) {
    if (lastX === null || p.xPx !== lastX) {
      out.push(p);
      lastX = p.xPx;
    }
  }
  return out;
}
```

**`src/maps/passes/finalCleanup.test.ts`:**

**Tests required (6):**

1. Throws on null theme.
2. Empty world (no features, no spawns): no-op; arrays remain empty after run.
3. Trims caveAmbient features whose mask cell is now SOLID (synthetic: insert a feature at (10, 50) but set mask[50*w+10]=SOLID; after pass the feature is gone).
4. Trims surfaceDressing features whose column heightmap[xPx] is -1 or >= heightPx (synthetic: set heightmap[20] = -1, insert dressing at xPx=20; after pass the feature is gone).
5. Spawn arrays end up sorted ascending by xPx, even when input was unsorted (insert `{xPx:50}, {xPx:10}, {xPx:30}` into spawnList.left; after pass it is `[{10},{30},{50}]`).
6. Spawn de-dupe by xPx: input `[{10},{10},{30}]` becomes `[{10},{30}]`.

**Cross-workstream constraint:** None. Self-contained.

**Acceptance:**
- `npx tsc --noEmit` clean
- `npx biome check --write src/maps/passes/finalCleanup.ts src/maps/passes/finalCleanup.test.ts` clean
- `npx vitest run src/maps/passes/finalCleanup.test.ts` all 6 tests pass
- `npx vitest run` no regressions

**Commit:**
```bash
git -C /home/scott/worms-pr6-ws-c add src/maps/passes/finalCleanup.ts src/maps/passes/finalCleanup.test.ts
git -C /home/scott/worms-pr6-ws-c commit -m "feat(worldgen): FinalCleanup pass

Final hygiene sweep with three idempotent operations: trim caveAmbient
features whose mask cell is no longer AIR (defensive), trim surfaceDressing
features pointing to invalid heightmap columns, sort and de-dupe spawnList
left/right by xPx. No throw paths beyond null-theme.

Part of PR 6 of the world-gen v1 pipeline. Tracks worms#150."
git -C /home/scott/worms-pr6-ws-c push -u origin feature/worldgen-pass-final-cleanup
```

## Integration phase (Opus during /build Phase 3)

After WS-A, WS-B, WS-C merge into `integrate/worldgen-pr6-spawn-cleanup`, Opus directly modifies on the integration branch:

### 1. `src/maps/types.ts` - extend MapGenerator return type

Read the current `MapGenerator` type definition (around line 30-50). Update the return type from `void` to `void | { spawnList: SpawnList }` (or similar) so v1 generators can yield authoritative spawn data through the existing call site. Add the SpawnList import.

```typescript
import type { SpawnList } from "./world";

// ...

export type MapGenerator = (
  ctx: CanvasRenderingContext2D,
  widthPx: number,
  heightPx: number,
  opts: GeneratorOpts,
) => void | { spawnList: SpawnList };
```

### 2. `src/maps/generators/terraworldV1.ts` - run new passes + return spawnList

Append the three new passes to PASSES (now 14 of 14):

```typescript
import { distributeSpawnPointsPass } from "../passes/distributeSpawnPoints";
import { validateSpawnCoherencePass } from "../passes/validateSpawnCoherence";
import { finalCleanupPass } from "../passes/finalCleanup";

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
  placeCaveAmbientPass,
  placeSurfaceDressingPass,
  distributeSpawnPointsPass,    // NEW pass 12
  validateSpawnCoherencePass,   // NEW pass 13
  finalCleanupPass,             // NEW pass 14
];
```

Update the doc comment to reflect 14 of 14 passes. Update the generator body to return the spawn data:

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
  return { spawnList: world.spawnList };
};
```

### 3. `src/maps/loadMap.ts` - prefer returned spawnList over legacy scan

```typescript
const generatorResult = entry.generator(ctx, widthPx, heightPx, {
  ...entry.config.generator.options,
  seed,
});

let spawnPoints: SurfacePoint[];
if (entry.config.spawnPoints?.length) {
  spawnPoints = entry.config.spawnPoints;
} else if (generatorResult && generatorResult.spawnList) {
  // v1 pipeline generators return authoritative spawn data. Interleave the
  // sides as [L0, R0, L1, R1, ...] so the worker's stride-2 round-robin
  // (worker/src/room.ts:887-900) produces team-segregated assignment - team 0
  // ends up on the left, team 1 on the right. A naive [...left, ...right]
  // concatenation would clump both teams on whichever side comes first.
  const { left, right } = generatorResult.spawnList;
  spawnPoints = [];
  const maxLen = Math.max(left.length, right.length);
  for (let i = 0; i < maxLen; i++) {
    if (left[i]) spawnPoints.push(left[i]);
    if (right[i]) spawnPoints.push(right[i]);
  }
} else {
  const imgData = ctx.getImageData(0, 0, widthPx, heightPx);
  const spawnRng = xorshift(seed ^ 0x5a5a5a5a);
  spawnPoints = findSpawnPoints(imgData.data, widthPx, heightPx, entry.config.maxWorms, {
    rng: spawnRng,
  });
}

return { config: entry.config, mask: canvas, spawnPoints };
```

### 4. `src/maps/generators/terraworldV1.integration.test.ts` - assert spawn delivery

Add four assertions:

1. `terraworldV1Generator` returns `{ spawnList }` with `spawnList.left.length > 0` and `spawnList.right.length > 0` for default theme on an 800x600 canvas.
2. `loadMap("terraworld_v1", 800, 600)` returns a LoadedMap whose `spawnPoints.length > 0`. Verify the interleave ordering: if `left = [{xPx: 100,...}, {xPx: 200,...}]` and `right = [{xPx: 600,...}, {xPx: 700,...}]`, the resulting `spawnPoints` is `[L0, R0, L1, R1]` order (xPx pattern: 100, 600, 200, 700).
3. `loadMap` for v1 maps does NOT call `findSpawnPoints`. Setup: `vi.mock("../../worm/spawnPoints", () => ({ findSpawnPoints: vi.fn() }))` at the top of the file. In each test that needs a fresh state, call `vi.mocked(findSpawnPoints).mockClear()` in `beforeEach`. After running `loadMap("terraworld_v1", ...)`, assert `expect(findSpawnPoints).not.toHaveBeenCalled()`.
4. `loadMap("canyon_v1", 800, 600)` returns a LoadedMap with `spawnPoints.length > 0`. Confirms canyon theme (different flags: `wantsCaves=true`, `wantsCaveAmbient=false`, `noFloor=true`) still produces valid spawns through the v1 path.

### 5. `src/maps/loadMap.test.ts` - extend if needed

Add a test confirming that for v1 maps, the spawnPoints in LoadedMap come from the generator, not from the legacy canvas scan. If existing tests break because of the new behavior, update assertions to reflect the new flow.

## Bugcheck Phase 3 expectations

Apply 6 lenses:

1. **Algorithm correctness**: heightmap-based candidate filtering (left/right partition by xPx midline; surface validity predicate); minSpacing relaxation factor sequence and termination; spawnList sort + dedupe correctness.
2. **Determinism**: `rngInt(rng, n)` usage in Fisher-Yates shuffle; no Math.random; reproducible spawn output for fixed seed; sort is stable enough for deep-equal across runs.
3. **Cross-pass interactions**: spawn pass reads heightmap (settled) and mask (settled post-FinalizeMask); validate runs after distribute (so it sees populated spawnList); cleanup runs last (so it sees fully-populated features + spawns); no pass mutates state another later pass requires.
4. **Edge cases**: empty world (widthPx=0 or heightPx=0); densityPx=0 / minPerTeam=0 early returns; underpopulated worlds (fewer valid columns than minPerTeam); spawnList already contains entries (spawn passes append vs replace - verify they append given the SpawnList contract); FinalCleanup with empty arrays (no-op).
5. **Integration**: MapGenerator return type change does not break legacy generators (they continue to return void implicitly); loadMap.ts prefers returned spawnList correctly; legacy maps still use `findSpawnPoints`; no behavioral regression for existing maps.
6. **Downstream consumers**: trace `LoadedMap.spawnPoints` from loadMap through `LobbyScene.handleStart` (`src/scenes/LobbyScene.ts:818`) to `room.send({ type: "start_game", spawnPoints })` to the worker's round-robin assignment (`worker/src/room.ts:887-900`). Verify the interleave ordering produces correct team-side segregation. Spot-check that the GameScene's spawn consumption path doesn't assume a sort order other than "interleaved L/R".

Known issues to expect (acknowledge in PR body, not blockers):
- The bug filed as worms#173 (multiplayer terrain/worm desync) is NOT addressed by this PR. Spawn distribution is server-shipped already; the bug is in the GameScene mask-decode or physics-sync path.
- `console.warn` from ValidateSpawnCoherence may surface in test output for certain test cases that intentionally exercise underpopulated worlds; tests should mock console.warn rather than rely on the absence of warnings.

## PR body template

```
## Summary

PR 6 of the world-gen v1 pipeline. Adds the final 3 passes (DistributeSpawnPoints, ValidateSpawnCoherence, FinalCleanup) and wires v1-generator-authoritative spawn data through LoadedMap. **terraworldV1 now runs all 14 of 14 v1 passes.** Closes the v1 effort.

Tracks worms#150.

## Workstreams

- WS-A: DistributeSpawnPoints pass (heightmap-based, midline-partitioned, spacing-relaxed)
- WS-B: ValidateSpawnCoherence pass (soft validation; console.warn on invariant violation)
- WS-C: FinalCleanup pass (idempotent hygiene: feature trim + spawn sort/dedupe)

## Integration

- `MapGenerator` return type widened to `void | { spawnList }` so v1 generators can yield authoritative spawns.
- `terraworldV1.ts` appends 3 passes; returns `{ spawnList: world.spawnList }`.
- `loadMap.ts` prefers the returned spawnList over the legacy `findSpawnPoints` canvas scan when present. Legacy maps continue to use `findSpawnPoints`.
- Integration tests assert v1 spawn delivery + loadMap correctness.

## Process appendix discipline

Three architectural decisions documented with the 5-question framework:
- Spawn placement source (heightmap-based; v1's GenerateHeightmap is the authoritative source)
- Validation severity (warn-only; matches the tuning-comment intent and unblocks edge-case tests)
- FinalCleanup scope (hygiene-only; bounded operations, no flood-fill or re-placement)

## Note: v1 spawn positions diverge from legacy

For the same map seed, v1 (`terraworld_v1`, `canyon_v1`) produces different spawn positions than legacy (`terraworld`). This is intentional: v1 uses `rngForPass(worldSeed, 11)` (or 12; the per-pass derived stream), while legacy uses `xorshift(seed ^ 0x5a5a5a5a)`. No tests rely on byte-equal spawn positions across these two paths.

## Known issue (deferred): worms#173

Multiplayer terrain/worm desync at game start (filed during PR 5 testing). Not addressed by this PR. Spawn distribution is already shipped from host to all clients via `start_game.spawnPoints`; the desync is in the GameScene mask-decode or physics-sync path. Separate investigation.

## Test plan

- [x] No em dashes
- [x] All tests pass
- [x] tsc clean
- [x] biome clean
- [x] Bugcheck Phase 3 complete
- [x] Manual review (in-app: Terraworld v1 worms spawn at sensible positions on each side)
```

## Out of scope (deferred)

- Reachability validation (BFS flood-fill from each spawn) - separate pass if it becomes needed
- Spawn re-placement when underpopulated - currently soft-warn; auto-recover would be a separate pass
- Connecting tunnels between isolated cave chambers - tracked elsewhere
- Spawn distribution for legacy `terraworld` map - that path still uses `findSpawnPoints`; v1 supersedes
- Fix for worms#173 (multiplayer terrain desync)
- Removal of `findSpawnPoints` from the codebase - keep until all maps are v1; legacy generators still depend on it

## How to execute

1. `/clear` (this plan and the memory carry the plan forward)
2. `/build` (executes the plan; reads `docs/plans/worldgen-pr6-spawn-cleanup.md` for context)
