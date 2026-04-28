import type { Pass } from "../pass";
import { MASK_AIR, MASK_SOLID } from "../world";

/**
 * Connected-components scan that removes orphaned solid components below a
 * pixel-count threshold. The post-CarveCaves cleanup pass.
 *
 * Algorithm: BFS with a number[] queue + head pointer (queue[qHead++] for O(1)
 * "shift"; queue.shift() is O(n) in JS). 4-connectivity per the convergent
 * shipped pattern (Sebastian Lague's cave-gen reference + scikit-image's
 * remove_small_objects default).
 *
 * Threshold: theme.params.maskHygieneThresholdPx ?? tuning.worldgen.hygiene.thresholdPx.
 * Default 1024 px is approximately 1.8 CA cells at default cellSizePx=24,
 * sized to remove single-cell orphans while preserving any 2+ cell features.
 *
 * Memory profile: visited Uint8Array (1 byte per pixel, capped at world size).
 * The BFS queue is a number[] that grows to peak frontier (~O(perimeter), not
 * O(area)). Per-component componentPixels[] is bounded at threshold entries
 * (early-aborts when component is large enough to keep, freeing the array).
 *
 * Determinism: top-left to bottom-right scan order, fixed neighbor ordering.
 * No RNG used.
 *
 * Throws if world.theme is null (FinalizeMask depends on theme.params resolution).
 */
export const finalizeMaskPass: Pass = {
  name: "FinalizeMask",
  run: ({ world, tuning, resolveParam }) => {
    if (!world.theme) {
      throw new Error("FinalizeMask: world.theme is null; DefineTheme must run first");
    }

    const { widthPx, heightPx, mask } = world;
    const threshold = resolveParam("maskHygieneThresholdPx", tuning.worldgen.hygiene.thresholdPx);
    if (threshold <= 0) return;

    const visited = new Uint8Array(widthPx * heightPx);

    for (let startY = 0; startY < heightPx; startY++) {
      for (let startX = 0; startX < widthPx; startX++) {
        const startIdx = startY * widthPx + startX;
        if (visited[startIdx]) continue;
        if (mask[startIdx] !== MASK_SOLID) {
          visited[startIdx] = 1;
          continue;
        }

        // BFS for the connected solid component starting at (startX, startY).
        // Mark visited at push time (standard BFS optimization to avoid
        // duplicate work). 4-connectivity.
        const queue: number[] = [startIdx];
        let qHead = 0;
        const componentPixels: number[] = [];
        let aborted = false;
        visited[startIdx] = 1;

        while (qHead < queue.length) {
          const idx = queue[qHead++] as number;

          if (!aborted) {
            componentPixels.push(idx);
            if (componentPixels.length >= threshold) {
              aborted = true;
              componentPixels.length = 0;
            }
          }

          const cx = idx % widthPx;
          const cy = (idx - cx) / widthPx;

          if (cx > 0) {
            const n = idx - 1;
            if (!visited[n] && mask[n] === MASK_SOLID) {
              visited[n] = 1;
              queue.push(n);
            }
          }
          if (cx < widthPx - 1) {
            const n = idx + 1;
            if (!visited[n] && mask[n] === MASK_SOLID) {
              visited[n] = 1;
              queue.push(n);
            }
          }
          if (cy > 0) {
            const n = idx - widthPx;
            if (!visited[n] && mask[n] === MASK_SOLID) {
              visited[n] = 1;
              queue.push(n);
            }
          }
          if (cy < heightPx - 1) {
            const n = idx + widthPx;
            if (!visited[n] && mask[n] === MASK_SOLID) {
              visited[n] = 1;
              queue.push(n);
            }
          }
        }

        if (!aborted) {
          for (const p of componentPixels) mask[p] = MASK_AIR;
        }
      }
    }
  },
};
