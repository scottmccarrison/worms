import type { MapGenerator } from "../types";
import { xorshift } from "../xorshift";

export const plateauGenerator: MapGenerator = (ctx, width, height, opts) => {
  const rng = xorshift(opts.seed);
  ctx.fillStyle = "#5a4a2c";

  // Proportional positions (designed for 1280x720 baseline).
  const lowY = Math.round(height * 0.7361); // 530 at 720
  const plateauY = Math.floor(height * 0.417); // ~300 at 720
  const leftEdge = Math.floor(width * 0.25); // ~320 at 1280
  const rightEdge = Math.floor(width * 0.75); // ~960 at 1280

  // Left low ground
  ctx.fillRect(0, lowY, leftEdge, height - lowY);

  // Right low ground
  ctx.fillRect(rightEdge, lowY, width - rightEdge, height - lowY);

  // Central plateau
  ctx.fillRect(leftEdge, plateauY, rightEdge - leftEdge, height - plateauY);

  // Left ramp polygon
  const leftRampBase = Math.round(width * 0.203125); // 260 at 1280
  ctx.beginPath();
  ctx.moveTo(leftRampBase, lowY);
  ctx.lineTo(leftEdge, plateauY);
  ctx.lineTo(leftEdge, lowY);
  ctx.closePath();
  ctx.fill();

  // Right ramp polygon
  const rightRampBase = Math.round(width * 0.796875); // 1020 at 1280
  ctx.beginPath();
  ctx.moveTo(rightRampBase, lowY);
  ctx.lineTo(rightEdge, plateauY);
  ctx.lineTo(rightEdge, lowY);
  ctx.closePath();
  ctx.fill();

  // Plateau top peaks at proportional positions (420, 640, 860 at width=1280).
  const peakCenters = [
    Math.round(width * 0.328125),
    Math.round(width * 0.5),
    Math.round(width * 0.671875),
  ];
  for (const cx of peakCenters) {
    const peakHeight = 40 + Math.floor(rng() * 41); // 40..80
    const peakTop = plateauY - peakHeight;
    ctx.beginPath();
    ctx.moveTo(cx - 30, plateauY);
    ctx.lineTo(cx, peakTop);
    ctx.lineTo(cx + 30, plateauY);
    ctx.closePath();
    ctx.fill();
  }
};
