import type { MapGenerator } from "../types";
import { xorshift } from "../xorshift";

export const islandGenerator: MapGenerator = (ctx, width, height, opts) => {
  const rng = xorshift(opts.seed);
  ctx.fillStyle = "#7a5a3c";
  const centerX = width / 2;
  const topY = height * 0.55;
  const bottomY = height * 0.8;
  const halfWidth = width * 0.35;

  ctx.beginPath();
  // Start at left edge of island
  ctx.moveTo(centerX - halfWidth, height);
  ctx.lineTo(centerX - halfWidth, bottomY);
  // Flat-ish top with small bumps
  for (let x = centerX - halfWidth; x <= centerX + halfWidth; x += 4) {
    const bump = Math.sin((x - centerX) * 0.02) * 12 + rng() * 4;
    ctx.lineTo(x, topY + bump);
  }
  // Right side + floor
  ctx.lineTo(centerX + halfWidth + 20, bottomY);
  ctx.lineTo(centerX + halfWidth + 20, height);
  ctx.closePath();
  ctx.fill();

  // Small floating chunks on either side for rope targets
  ctx.beginPath();
  ctx.ellipse(width * 0.12, height * 0.35, 40, 18, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.ellipse(width * 0.88, height * 0.4, 50, 20, 0, 0, Math.PI * 2);
  ctx.fill();
};
