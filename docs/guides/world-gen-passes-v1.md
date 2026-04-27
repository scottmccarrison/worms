# World-gen v1 Pass List

This is the v1 instantiation of the world-gen design captured in `world-gen-design.md`. Fourteen named passes, ordered, slotted into the categories that doc established. Revised after pre-implementation validation (worms#163).

Read this side by side with the design doc. The design doc says *what kind* of passes we have and why; this doc says *which specific passes* fill each category and why each sits where it does in the order.

This doc honors all consensus from Sections 1-9 of the design doc:
- Flat ordered named list (Section 2)
- Categories are pedagogical, not architectural (Section 3)
- Order encodes a hand-tuned causal graph (Section 4)
- Single shared mutable canvas, communication via state only (Section 5)
- Conditionality lives inside each pass via substrate check (Section 6)
- Three-rule determinism (Section 7)
- Structural-playability validation (Section 8)

## Cross-cutting conventions

Two conventions apply to every pass and need to be stated up front.

**Per-pass RNG subseed.** Each pass gets its own RNG instance seeded from `(worldSeed, passIndex)`. Passes do not share an RNG cursor. This means inserting, removing, or reordering passes in the future does not change the RNG output of unaffected passes - same seed produces the same world even when the pipeline grows. Implementation: a small helper, `rngForPass(worldSeed, passIndex)`, returns a fresh xorshift seeded with a hash of those two inputs. Every pass that needs randomness calls this helper exactly once at its entry point.

**Void columns via sentinel heightmap value.** A column whose `surfaceY >= worldHeight` is treated as "no solid in this column" - it is the sky-only / void case used by canyon-style themes. The mask rasterizer (PaintSubstrateMask) handles this for free because its inner loop runs zero iterations when `surfaceY` is past the bottom. Three downstream passes need a one-line check (`if surfaceY >= worldHeight: skip column`): CarveCaves (no caves to dig), DistributeSpawnPoints (no spawn anchor), and the validation tail. No magic numbers, no parallel structures.

## Theme schema (pinned for v1)

The design doc deliberately avoided pinning the world-state shape. Theme is the exception: enough passes condition on it that an explicit schema is required to keep conditionality declarative rather than `theme.tag === "canyon"` string-matching everywhere.

A `Theme` for v1 carries:

- `tag`: identifying string ("snow", "canyon", "jungle", "plateau", "volcanic", etc.). Used for telemetry and the lobby seed feature, not for gating logic.
- `flags`: a fixed set of booleans that gate behavior. v1 set: `wantsPeaks`, `wantsCaves`, `noFloor`, `wantsSurfaceCrust`, `wantsCaveAmbient`. Passes read flags, not the tag.
- `params`: numeric overrides per pass (e.g., `caveCellSize`, `mountainAmplitude`, `crustDepth`). A theme may set any subset; unset fields fall back to global tuning defaults.
- `palette`: color metadata for the renderer. Read post-pipeline at render time, not by gen passes.

This schema is what every theme-conditional pass reads against. Adding a new flag means: (1) extend the schema, (2) themes that want the new behavior set it. No pass-skipping, no theme-tag string matching.

---

## The pipeline at a glance

| # | Pass | Category | Reads | Writes |
|---|------|----------|-------|--------|
| 1 | Reset | Substrate | seed | Cleared world state, RNG-helper primed |
| 2 | DefineTheme | Substrate | map config | theme (tag, flags, params, palette) |
| 3 | GenerateHeightmap | Substrate | theme.flags.wantsPeaks, theme.params, RNG | Heightmap (per-column surface Y) |
| 4 | ApplyThemeHeightmapMods | Substrate | heightmap, theme | Theme-shaped heightmap (may set surfaceY >= height for void columns) |
| 5 | PaintSubstrateMask | Substrate | heightmap | Solid/air pixel mask |
| 6 | PaintMaterialBands | Material differentiation | mask, heightmap, theme.params | Material map (dirt/rock/stone per pixel) |
| 7 | CarveCaves | Carving | mask, heightmap, theme.flags.wantsCaves, theme.params, RNG | Mask + material map updated for carved pixels |
| 8 | FinalizeMask | Carving | mask, theme | Mask with mask-hygiene fixes applied |
| 9 | PaintSurfaceCrust | Material differentiation | mask, material map, heightmap, theme.flags.wantsSurfaceCrust, theme.params | Material map (top crust) |
| 10 | PlaceCaveAmbient | Dressing | mask, theme.flags.wantsCaveAmbient, theme.params, RNG | Cave ambient metadata |
| 11 | PlaceSurfaceDressing | Dressing | mask, heightmap, material map, theme, RNG | Surface dressing layer |
| 12 | DistributeSpawnPoints | Spawn-point distribution | mask, heightmap, theme | Team-paired spawn list (left/right balanced) |
| 13 | ValidateSpawnCoherence | Validation | spawn list, mask | Adjusted/filtered spawn list |
| 14 | FinalCleanup | Validation | entire world | Final consistency patches |

**14 passes total.** Down from the original 16 because (a) AddMountainOctave folded into GenerateHeightmap as its third octave, and (b) PlaceParallaxBackdrop cut as a renderer concern, not a gen concern.

---

## Per-pass detail

### Substrate (passes 1-5)

These passes establish the canvas. After substrate is done, we have a heightmap (with sentinel-value support for void columns), a substrate mask, and theme metadata - the gross shape of the world.

#### 1. Reset

Clears the world state struct, primes the per-pass RNG helper with the world seed. Idempotent. Every pipeline starts here.

**Reads:** seed (input).
**Writes:** empty world state, RNG-helper ready.

#### 2. DefineTheme

Reads the theme tag from map config (selected in the lobby), writes the full theme struct to world state per the schema above. Every subsequent theme-conditional pass reads its theme decisions from here.

**Reads:** map config.
**Writes:** theme (tag, flags, params, palette).
**Rationale for placement:** runs second so the rest of the pipeline can condition on theme via Section 6's substrate-check pattern.

#### 3. GenerateHeightmap

Produces the per-column surface Y array using three octaves of value noise. Octaves 1 and 2 are the rolling-hills baseline (the algorithm Terraworld already uses). Octave 3 is the lower-frequency, higher-amplitude mountain peak octave; it is scaled by `theme.params.mountainAmplitude` (default tuning) and gated to zero when `theme.flags.wantsPeaks` is false. Smoothstep blending on the third octave avoids cliff artifacts.

**Reads:** theme.flags.wantsPeaks, theme.params (octave amplitudes/strides), per-pass RNG, world dimensions.
**Writes:** heightmap (Int32Array, length = world width).
**Rationale for placement:** first geometric pass. All later geometry flows from this. Folding the mountain octave in here (vs the original v1's separate AddMountainOctave) eliminates a fake dependency edge - three octaves of noise is one operation regardless of how we label it.

#### 4. ApplyThemeHeightmapMods

Theme-specific heightmap shaping. Canyon (`theme.flags.noFloor=true`) sets `surfaceY = worldHeight` for the gap columns; plateau flattens regions; volcanic adds spire shapes. Per Section 6, every pass always runs - themes without shaping requirements (default rolling hills) do nothing internally.

**Reads:** heightmap, theme.
**Writes:** theme-shaped heightmap. May set `surfaceY >= worldHeight` for void columns per the cross-cutting convention.
**Rationale for placement:** after generic heightmap shape is settled, before painting. Last chance to shape the heightmap before it becomes pixels.

#### 5. PaintSubstrateMask

Rasterizes the heightmap into the alpha mask: every pixel above the surface line is air, every pixel at or below is solid. Loop is `for x: for y in [surfaceY, height): paint solid` - which produces correct empty output for void columns naturally.

**Reads:** heightmap, world dimensions.
**Writes:** binary alpha mask.
**Rationale for placement:** last substrate pass. After this, downstream passes work in pixel space, not heightmap space.

---

### Material differentiation (passes 6 and 9)

Inject heterogeneity into the homogenous substrate. Two passes, non-adjacent in pipeline order. Pass 6 runs before carving (paints the bulk material bands); Pass 9 runs after carving and finalization (paints the surface crust on the truly-final mask). Categories are pedagogical, not pipeline-ordered, per Section 3 of the design doc.

#### 6. PaintMaterialBands

Assigns each solid pixel a material based on depth below the surface: top band is dirt, middle is rock, deep is stone. Bands have soft transitions to avoid striped artifacts (the dithering uses the per-pass RNG, not Math.random or shared cursor). Theme params can offset band depths (snow theme has shallower dirt; canyon has thicker stone).

**Reads:** mask, heightmap, theme.params (band depth offsets), per-pass RNG.
**Writes:** material map (uint8 per pixel: 0=air, 1=dirt, 2=rock, 3=stone).
**Rationale for placement:** after substrate (needs the mask) and before carving. Carving will erase pixels (and clear their material entries); doing material first keeps this pass simple - it just walks columns. The "wasted material write on pixels that get carved" cost is real but small at our world size and worth the simplicity.

#### 9. PaintSurfaceCrust

Re-paints the top 1-3 pixels of solid as a theme-specific surface material: grass for jungle, snow for snow theme, sand for desert, scorched for volcanic, eroded-rock for canyon, stone for plateau. This is the visual transition between sky and ground. Gated by `theme.flags.wantsSurfaceCrust` (default true; themes that want raw rock surfaces can opt out).

**Reads:** mask, material map, heightmap, theme.flags.wantsSurfaceCrust, theme.params.crustDepth.
**Writes:** material map (top crust pixels overwritten).
**Rationale for placement:** after FinalizeMask (Pass 8) so the mask is settled - we paint crust on the actually-final surface, not on a surface that mask hygiene might later modify. Before all dressing passes (10, 11) because they read crust material to decide where to place flora and ambient features.

---

### Carving (passes 7-8)

Subtractive operations on the substrate, plus mask-finalization. For v1 this is one carving pass plus one cleanup pass. Tunnels and overhangs deferred to future enhancements.

#### 7. CarveCaves

Cellular automata cave carving in the subsurface, using the existing `cellularAutomata.ts` algorithm. Reads `theme.params` for any per-theme overrides of `cellSizePx`, `initialFillRatio`, `iterations`, `surfaceBufferPx` (defaults from `tuning.caves`). Skips columns where `surfaceY >= worldHeight` (no solid to carve). Carved pixels become air; their material entries become 0. Gated by `theme.flags.wantsCaves` for themes that want a solid block (rare; default true).

**Reads:** mask, heightmap, theme.flags.wantsCaves, theme.params (cave overrides), per-pass RNG.
**Writes:** mask with carved-out pixels, material map cleared at carved pixels.
**Rationale for placement:** after substrate + material bands. Runs before all dressing because dressing reads the final solid silhouette.

#### 8. FinalizeMask

Scans the mask for orphaned solid pixels (small disconnected islands) and mask-hygiene issues. Removes orphaned debris. Threshold is configurable via `theme.params.maskHygieneThreshold` - canyon may want very small features preserved as gameplay flavor; snow may not. Connected-components scan is deterministic in iteration order (top-left to bottom-right, 4-neighbor) to keep the multiplayer-determinism contract from Section 7 of the design doc.

This pass was renamed from `ValidateMaskHygiene`. The rename is intentional: "validation" implies "check, do not change," but this pass mutates the mask. It is mask completion, not validation. Once it has run, the mask is final and downstream passes can read it as authoritative.

**Reads:** mask, theme.params.maskHygieneThreshold.
**Writes:** mask with orphaned-island fixes applied.
**Rationale for placement:** immediately after CarveCaves, before any dressing or spawn placement. Dressing places metadata that points at mask features - if hygiene ran after dressing, removed features would leave orphaned dressing references. Spawn placement reads mask to find ground - if hygiene ran after spawns, validated spawns could be invalidated by post-validation mask changes. Earlier is correct.

---

### Dressing (passes 10-11)

Theme-aware decoration. None of these passes affect the physics-mask; they all write decoration metadata that the renderer consumes. Dressing is where the world stops being a generic procgen mask and starts feeling like a place. Two passes for v1 (down from four in the original draft, since `PaintSurfaceCrust` recategorized to Material Differentiation and `PlaceParallaxBackdrop` cut as renderer-not-gen).

#### 10. PlaceCaveAmbient

Theme-aware ambient features inside cave cavities: moss patches in jungle, glow-spots in volcanic, frost crystals in snow, dust motes in canyon. Decoration-only; does not affect the mask. Themes without cave ambient (`theme.flags.wantsCaveAmbient` false) do nothing internally per Section 6.

**Reads:** mask, theme.flags.wantsCaveAmbient, theme.params (ambient density), per-pass RNG.
**Writes:** cave ambient metadata (positions + types).
**Rationale for placement:** after FinalizeMask (caves must be final) and before parallax-rendering pickup at scene init.

#### 11. PlaceSurfaceDressing

Theme-aware surface decoration: grass tufts and small plants for jungle, snow drifts and pine cones for snow, cacti and skulls for canyon, ash piles for volcanic, etc. Reads the surface heightmap and the crust material to know where to place. Probabilistic, density-tuned per theme.

**Reads:** mask, heightmap, material map, theme, per-pass RNG.
**Writes:** surface dressing layer (positions + sprite refs).
**Rationale for placement:** after surface crust (needs to know what kind of surface to dress) and after FinalizeMask (so we do not dress over orphaned features that hygiene removed).

---

### Spawn-point distribution (pass 12)

Find places where worms can safely start, paired into team-balanced groups. Single late pass because spawn placement reads the entire settled world.

#### 12. DistributeSpawnPoints

Walks the surface heightmap, samples candidate spawn positions at theme-appropriate spacing (`theme.params.spawnDensity`), filters for "open air above, solid ground below, not inside an undercut, not too close to other spawns, not on a void column (`surfaceY >= worldHeight`)." Then pairs spawns into team-balanced groups: half on the left half of the world, half on the right, sorted left-to-right within each side. The output is a structured list, not just a flat array, so callers can ask for "give me team A's spawns" without re-sorting.

**Reads:** mask, heightmap, theme (for density and team-count rules).
**Writes:** team-paired spawn list (left-side spawns, right-side spawns).
**Rationale for placement:** must run after every world-shaping pass. Surface dressing has already been placed but it is metadata-only and does not affect physics, so spawn placement is not blocked by it.

---

### Validation / cleanup (passes 13-14)

Conservative janitorial. Per Section 8 of the design doc: structural playability, not goal-oriented. The cleanup tail patches local inconsistencies; it does not verify gameplay.

#### 13. ValidateSpawnCoherence

Confirms each spawn point has open air above and solid ground below. Removes spawns that became invalid after FinalizeMask (rare, but possible if mask hygiene cascaded into surface terrain). If too few spawns remain per team (below `theme.params.minSpawnsPerTeam`), this pass logs a warning - the world is technically gen-complete but gameplay-deficient. The match host can choose to regenerate with a different seed.

**Reads:** spawn list, mask.
**Writes:** filtered spawn list (or unchanged).
**Rationale for placement:** after spawn distribution (its dependency) and FinalizeMask (mask is settled), before final cleanup.

#### 14. FinalCleanup

Per Section 8 and the bible: the only pass licensed to read the entire world and patch any remaining inconsistency. Per-theme invariants get checked here (e.g., canyon-theme central gap is intact, plateau-theme floor is contiguous if it has one). This is the catch-all; specific checks emerge from implementation experience.

**Reads:** entire world state.
**Writes:** any final patches needed.
**Rationale for placement:** last. Same reason as Terraria. Nothing runs after.

---

## Open questions / future enhancements

These are decisions deferred or flagged for future iteration. They are not v1 work.

1. **SmoothMaskEdges (Terraria's `Smooth World` analog).** Coverage gap analysis flagged this as missing. Cellular automata is itself a smoothing process and produces reasonable output at our cell sizes; we have no current evidence we need a separate smoothing pass. **If implementation reveals visibly jagged cave edges, append a `SmoothMaskEdges` pass between `CarveCaves` and `FinalizeMask`.** Per Section 2 growth model, this is a one-pass append.
2. **Substrate-region reconciliation (Terraria's `Beaches` analog).** If `ApplyThemeHeightmapMods` produces visible seams between theme-shaped regions and the rolling-hills baseline (e.g., canyon edge meeting the heightmap at an awkward slope), a reconciliation pass is needed. Flag for impl-time monitoring rather than pre-add.
3. **`PlaceSurfaceDressing` split-trigger.** When this pass exceeds 4 theme branches or ~200 lines, split into per-theme passes (`PlaceSurfaceDressingSnow`, `PlaceSurfaceDressingCanyon`, etc.) so each branch lives in isolation. Pre-empts the Terraria-evolution arc where one mega-decoration pass becomes a maintenance burden.
4. **Theme depth for snow / jungle.** Both produce mostly-default worlds with thin theme paint (snow has a crust + frost crystals; jungle is the default mental model with green palette). Acceptable for v1 because new theme behavior arrives via additive growth. If playtesting shows themes feel interchangeable, deepen them by adding theme-specific passes (e.g., `GenerateGlacialShelves` for snow, `GenerateJungleCanopy` for jungle).
5. **Crust spreading (Terraria's `Spreading Grass` analog).** Our `PaintSurfaceCrust` is one-shot. Terraria runs both `Grass` and `Spreading Grass` so vegetation creeps across surfaces over multiple iterations. Worms-scale probably does not need this; flag in case post-implementation review surfaces ugly crust transitions.
6. **CarveTunnels.** Long-distance horizontal carving connecting cave systems. Future enhancement; matches Terraria's `Tunnels` pass.
7. **Structural drops.** Spelunky-style template carves (bunkers, fortifications, ruined buildings). Future enhancement; would introduce a StructureMap-equivalent cooperative coordination registry per Section 5 of the design doc.
8. **Per-region biomes.** Sub-region differentiation inside a single map. Future enhancement; for now we use per-map theme.
9. **In-gen hydrology.** Water is currently a runtime concern (rising waterline at sudden death). If we ever want pooled water at gen time, that is a hydrology category we have not pre-designed. Current verdict: out for v1, possibly forever.
10. **Determinism receipt.** A hash of the final mask + spawn list, computed by FinalCleanup or as a successor pass, would let server and client confirm they produced byte-identical worlds for the same seed. Useful for multiplayer bug repro and lockstep recovery. Not in v1; flag if multiplayer determinism issues surface.

## What is NOT in v1, for transparency

- AddMountainOctave as a separate pass (folded into GenerateHeightmap).
- PlaceParallaxBackdrop (cut as renderer concern, not gen concern).
- SmoothMaskEdges (deferred until evidence requires).
- CarveTunnels, CarveOverhangs (deferred).
- Multi-tile structural drops (deferred).
- Per-region biomes (deferred; theme is per-map).
- In-gen hydrology (out, possibly forever).
- Spawn-clustering by team beyond left/right pairing (deferred until team modes need it).
- Soft-locked path validation (out per Section 8 of the design doc).
- Determinism receipt hash (deferred).
