import type { MapGenerator } from "../types";
import { xorshift } from "../xorshift";

export const flatGenerator: MapGenerator = (ctx, width, height, opts) => {
  const rng = xorshift(opts.seed);
  ctx.fillStyle = "#5a7a3c";
  const groundY = height * 0.7;
  ctx.beginPath();
  ctx.moveTo(0, height);
  for (let x = 0; x <= width; x += 4) {
    const y = groundY + rng() * 4 - 2; // tiny roughness for fall damage tests
    ctx.lineTo(x, y);
  }
  ctx.lineTo(width, height);
  ctx.closePath();
  ctx.fill();
};
