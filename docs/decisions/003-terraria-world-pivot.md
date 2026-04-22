# ADR-003: Worms-in-Terraria-world direction

## Status
Accepted (2026-04-22).

## Context

The game shipped its classic-Worms mechanical core (turn arbiter, teams, 9 weapons, wind, water, fall damage, retreat window) on a single-screen 1280x720 canvas with procgen geometric terrain. Playtest feedback, summarized bluntly, was "these maps are small and boring."

We considered three directions:

1. **Commission hand-drawn pixel-art maps** (Armageddon-style). Unblocks "feels like a real game" but depends on an artist we don't have. Every new map is a commissioning expense.
2. **Full Terraria-with-combat pivot.** Real-time exploration + building + combat. Different game entirely. Would delete the turn arbiter, fire gating, retreat window, all the Worms-specific scaffolding that already works.
3. **Worms-in-Terraria-world.** Keep the turn-based Worms gameplay loop exactly as-is. Drop it inside a procedurally generated Terraria-style side-scrolling world. The world is the new visual + gen layer; the game that happens inside it is unchanged.

Option 3 is the chosen direction. It's the smallest product pivot of the three (the gameplay stays identical) but the biggest visual and scale upgrade (procgen tile-based world vs flat geometric arena).

The critical technical insight: our pixel-mask physics model is _better_ suited to option 3 than to option 2. Worms-style pixel-perfect crater destruction is exactly what the per-pixel alpha mask gives us. Terraria-style tile destruction would have required swapping the physics model; we don't do that. Tile rendering is purely a visual composite over the alpha mask.

## Decision

Pivot the world layer from "single-screen geometric arena" to "side-scrolling procedurally generated tile-based world." Gameplay layer unchanged.

### What changes

- **World size**: 1280x720 -> ~2560-3200 x 1024-1280. Camera follows the active worm; zoomed-out overview between turns.
- **Terrain rendering**: flat `ctx.fillStyle` color -> tile-texture composite. The alpha channel still defines collision; the RGB is now a repeating biome tile texture (CC0 packs from Kenney et al.), not a flat color.
- **World generation**: geometric `ctx.fillRect` + polygon paths -> layered procgen. Heightmap surface -> stratified subsurface (grass/dirt/stone/deep-stone) -> cellular-automata caves -> decoration stamps (trees, grass tufts, rocks).
- **Biomes**: per-map tile palette + generator parameter preset (e.g. forest, desert, cavern, snow). Each biome swaps the tile set + tweaks surface/cave density; the gen engine is shared.
- **Backdrop**: sky gradient + distant silhouette parallax layer. Scrolls with camera at reduced rate.
- **Asset sourcing**: CC0 tile packs (Kenney Platformer Art + Platformer Tiles, etc.) instead of custom commissioning for terrain. Custom sprites still needed for worms + weapons + explosion VFX.

### What does NOT change

- Turn arbiter: keep. 45s turns, retreat window, pause/resume, game-over detection.
- Teams + worms + 9 weapons + firing pipeline: keep.
- Per-pixel alpha-mask physics: keep. Destruction is still Worms-style pixel-perfect craters (the tile texture simply stops being visible where alpha=0).
- planck.js rigid bodies for worms and projectiles: keep.
- Server-authoritative sim, Cloudflare DO netcode, reconnection, resume tokens: keep.
- Wind, water, fall damage, retreat window, nickname persistence: keep.
- `host-provides-mask` wire pattern: keep; payload grows ~3x with world area but stays under a few MB at start_game.

## Consequences

### Gained
- **Visual leap**: tile-textured terrain with biome variety reads as a distinct, intentional setting rather than a prototype backdrop.
- **Procgen = infinite map variety**: seeds produce new worlds; no artist bottleneck for map count.
- **Scroll + scale** = more interesting combat scenarios (caves for cover, high ground, flanking). Classic Worms arena tactics benefit from larger space.
- **Cheap asset sourcing**: Kenney and other CC0 tile sets are abundant and drop-in compatible. No commissioning required to look reasonable.
- **Additive, not rewriting**: every existing system keeps working. Risk is bounded.

### Lost / deferred
- "Real arena maps" epic (#41, merged in PR #94) becomes a fallback/test asset. Fine to keep as-is; procgen replaces it for production maps.
- "Sprites + audio" asset inventory (#84) narrows: map art is no longer a commissioned-art line item (tile packs cover it). Worm / weapon / VFX / UI sprites are still needed.
- Payload: the alpha-mask wire broadcast grows from ~900KB base64 -> ~2.5MB for a 2560x1024 world. Acceptable on mobile at game start (one-shot, not per-tick).

### Phased delivery

- **Phase 1**: world size + scrolling camera + tile-atlas loader + single-biome tile-texture fill + basic heightmap surface gen. Proves the pattern. Already a 10x visual improvement over current geometric maps.
- **Phase 2**: cave carving (cellular automata or noise) + decoration stamps (trees, rocks) + 3-4 biome presets + parallax backdrop.
- **Phase 3**: polish - biome-specific ambient (particles, lighting tint), ore/crystal decorations, optional weather (rain, snow).

Each phase is shippable on its own. Phase 1 alone justifies the pivot; phases 2-3 build character.

## Reversal notes

Unlike ADR-002 (Cloudflare Workers), this ADR is not a tech pivot - it's a content architecture pivot. Reversing it would mean going back to flat-color geometric arenas, which is easy (the existing `src/maps/generators/` files all still work). The one committed change is the wider world + scrolling camera; those are settable constants.
