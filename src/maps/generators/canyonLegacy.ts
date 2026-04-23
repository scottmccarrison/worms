import type { MapGenerator } from "../types";
import { xorshift } from "../xorshift";

/**
 * Original handcrafted canyon map kept for regression testing.
 *
 * Two cliff masses separated by a fixed proportional gap, designed for a
 * 1280x720 baseline. This map is superseded by canyonBiomeGenerator but
 * is retained under the canyon_legacy registry key so existing tests and
 * regression suites continue to run against the original geometry.
 */
export const canyonLegacyGenerator: MapGenerator = (ctx, width, height, opts) => {
  const rng = xorshift(opts.seed);
  ctx.fillStyle = "#6a5a3c";

  // Proportional landmark positions (designed for 1280x720 baseline).
  const leftEdge = Math.floor(width * 0.3906); // ~500 at 1280
  const rightEdge = Math.floor(width * 0.6094); // ~780 at 1280
  const cliffY = Math.floor(height * 0.417); // ~300 at 720

  // Left cliff
  ctx.beginPath();
  ctx.moveTo(0, height);
  ctx.lineTo(0, cliffY);
  for (let x = 0; x <= leftEdge; x += 40) {
    const bump = rng() * 20 - 10;
    ctx.lineTo(x, cliffY + bump);
  }
  ctx.lineTo(leftEdge, cliffY);
  ctx.lineTo(leftEdge, height);
  ctx.closePath();
  ctx.fill();

  // Right cliff
  ctx.beginPath();
  ctx.moveTo(rightEdge, height);
  ctx.lineTo(rightEdge, cliffY);
  for (let x = rightEdge; x <= width; x += 40) {
    const bump = rng() * 20 - 10;
    ctx.lineTo(x, cliffY + bump);
  }
  ctx.lineTo(width, cliffY);
  ctx.lineTo(width, height);
  ctx.closePath();
  ctx.fill();

  // Canyon gap between leftEdge..rightEdge is entirely air - no geometry drawn there
};
