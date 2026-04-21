import { xorshift } from "../xorshift";
import type { MapGenerator } from "../types";

export const caveGenerator: MapGenerator = (ctx, width, height, opts) => {
  const rng = xorshift(opts.seed);
  ctx.fillStyle = "#5a4a3c";

  // Floor with bumps
  ctx.beginPath();
  ctx.moveTo(0, height);
  for (let x = 0; x <= width; x += 4) {
    const y = height * 0.82 + Math.sin(x * 0.02 + rng() * 0.3) * 22;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(width, height);
  ctx.closePath();
  ctx.fill();

  // Ceiling with stalactites
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(width, 0);
  for (let x = width; x >= 0; x -= 4) {
    const y = height * 0.15 + Math.sin(x * 0.04) * 25 + Math.sin(x * 0.12) * 15;
    ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();

  // A couple of mid-cave pillars
  ctx.fillRect(width * 0.3 - 8, height * 0.3, 16, height * 0.5);
  ctx.fillRect(width * 0.7 - 8, height * 0.35, 16, height * 0.45);
};
