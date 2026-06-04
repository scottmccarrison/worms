/**
 * Canonical world dimensions shared across client + server + worker.
 * Changing these requires a deploy; the wire mask length validation
 * derives from these via packedMaskByteLength().
 *
 * Width is the single biggest knob on "how much world to traverse". It is
 * kept under the ~16384px WebGL max-texture-size ceiling because the terrain
 * is one canvas-backed texture this wide (see src/terrain/Terrain.ts). Do not
 * raise WORLD_WIDTH_PX past ~16000 without tiling the terrain texture first.
 */
export const WORLD_WIDTH_PX = 15360;
export const WORLD_HEIGHT_PX = 1280;
