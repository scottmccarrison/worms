import type { MapGenerator } from "../types";
import { xorshift } from "../xorshift";

export const hillsGenerator: MapGenerator = (ctx, width, height, opts) => {
  const rng = xorshift(opts.seed);
  // Ground: wavy hills with a seeded phase offset
  const phase1 = rng() * Math.PI * 2; // different each seed
  ctx.fillStyle = "#4a7d3c";
  ctx.beginPath();
  ctx.moveTo(0, height);
  for (let x = 0; x <= width; x += 4) {
    const y = height / 2 + Math.sin(x * 0.01 + phase1) * 60 + Math.sin(x * 0.03) * 30;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(width, height);
  ctx.closePath();
  ctx.fill();

  // Ceiling: rough rocky strip at the top for rope grappling
  ctx.fillStyle = "#3d5d2f";
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(width, 0);
  for (let x = width; x >= 0; x -= 4) {
    const y = 40 + Math.sin(x * 0.015) * 18 + Math.sin(x * 0.04) * 10;
    ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
};
