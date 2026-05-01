/**
 * Canonical world dimensions shared across client + server + worker.
 * Changing these requires a deploy; the wire mask length validation
 * derives from these via packedMaskByteLength().
 */
export const WORLD_WIDTH_PX = 6144;
export const WORLD_HEIGHT_PX = 1280;
