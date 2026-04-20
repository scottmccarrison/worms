# Adding a map

Two paths: hand-authored PNG mask, or procedural generator. Both produce a terrain image the `Terrain` class ingests (per Epic 3).

## Path A: hand-authored mask

For distinctive, memorable maps (e.g., "Volcano Island," "Cavern").

### 1. Draw the mask

In any PNG editor: transparent = empty space, opaque = solid terrain. Recommended canvas size: 1920x1080 (larger than the viewport; the camera pans).

Color the opaque pixels however you want — the mask only cares about alpha. The visible fill color is what the player sees (dirt brown, grass green, rock gray, etc.).

Save to:

```
public/maps/<name>/
  mask.png           # the terrain shape (alpha matters)
  background.png     # optional parallax background (sky, distant hills)
  config.json        # spawn points, theme, name, description
```

### 2. Map config

`public/maps/volcano/config.json`:

```json
{
  "id": "volcano",
  "name": "Volcano Island",
  "description": "Tight arena with a central crater.",
  "mask": "mask.png",
  "background": "background.png",
  "theme": "volcanic",
  "spawnPoints": [
    { "x": 200, "y": 400 },
    { "x": 800, "y": 400 },
    { "x": 1400, "y": 350 },
    { "x": 600, "y": 600 }
  ],
  "waterLevel": 980,
  "maxWorms": 4
}
```

Spawn points are center coordinates for worm placement at round start. Each worm spawns at one point, randomized among available spots.

### 3. Register the map

`src/maps/index.ts`:

```ts
export const MAPS = {
  volcano: () => import("../../public/maps/volcano/config.json"),
  forest: () => import("../../public/maps/forest/config.json"),
  // ...
};
```

Lazy-loaded so the selector doesn't pull every map's assets at boot.

### 4. Test

```sh
npm run dev
```

Start local game -> lobby -> Map picker -> your map appears. Select, start game, verify spawn points are reachable (no worms trapped in cavities) and terrain destruction looks right.

## Path B: procedural generator

For variety without authoring dozens of maps. Hedgewars uses perlin noise + maze; we can do similar.

`src/maps/generators/perlin.ts`:

```ts
import { createNoise2D } from "simplex-noise";

export function generatePerlinMap(seed: string, options: GenOptions): MapData {
  const noise = createNoise2D(seed);
  const mask = new OffscreenCanvas(options.width, options.height);
  const ctx = mask.getContext("2d");
  // Draw terrain by sampling noise at each column, filling below threshold
  // ...
  return {
    mask,
    spawnPoints: findReachableSpawns(mask, options.players),
    theme: options.theme,
  };
}
```

Players share the seed; server authoritatively uses the seed to generate the same map on every client. No image transfer needed — just send the seed in the Colyseus Room state.

### Registering a generator

```ts
export const MAP_GENERATORS = {
  perlin: generatePerlinMap,
  maze: generateMazeMap,
  caverns: generateCavernsMap,
};
```

Lobby map-picker offers "Random (perlin)" as an entry; clicking rolls a seed.

## Theme system

Themes swap terrain visual fill + background + audio ambience without changing mask geometry. Configured per-map (`theme: "volcanic"`) or per-generator output.

`src/themes/volcanic.ts`:

```ts
export const volcanic: Theme = {
  id: "volcanic",
  terrainFill: "url(#volcanic-pattern)",
  backgroundTint: "#3a1a10",
  ambientLoop: "assets/audio/ambient/volcano.ogg",
  particleEffect: "embers",
};
```

Makes "generate 3 maps in 3 themes = 9 experiences."

## Checklist

- [ ] Mask PNG authored (or generator written)
- [ ] Spawn points placed (validate reachability)
- [ ] Config JSON written
- [ ] Registered in `src/maps/index.ts`
- [ ] Tested in dev: spawn points work, terrain destruction matches map edges cleanly
- [ ] Theme exists (or "default" assigned)
- [ ] If using CC-BY assets, NOTICE updated

Typical hand-authored map: 2-4 hours of pixel art + 15 min of config. Procedural generator: 1-2 days to write one, infinite maps from it after.
