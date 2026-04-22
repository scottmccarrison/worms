import type { MapGenerator } from "../types";
import { xorshift } from "../xorshift";

export const canyonGenerator: MapGenerator = (ctx, _width, height, opts) => {
  const rng = xorshift(opts.seed);
  ctx.fillStyle = "#6a5a3c";

  // Left cliff: x=0..500, y=300..720
  // With seeded variation on cliff top (±10px bumps at 40px intervals)
  ctx.beginPath();
  ctx.moveTo(0, height);
  ctx.lineTo(0, 300);
  for (let x = 0; x <= 500; x += 40) {
    const bump = rng() * 20 - 10;
    ctx.lineTo(x, 300 + bump);
  }
  ctx.lineTo(500, 300);
  ctx.lineTo(500, height);
  ctx.closePath();
  ctx.fill();

  // Right cliff: x=780..1280, y=300..720
  // With seeded variation on cliff top (±10px bumps at 40px intervals)
  ctx.beginPath();
  ctx.moveTo(780, height);
  ctx.lineTo(780, 300);
  for (let x = 780; x <= 1280; x += 40) {
    const bump = rng() * 20 - 10;
    ctx.lineTo(x, 300 + bump);
  }
  ctx.lineTo(1280, 300);
  ctx.lineTo(1280, height);
  ctx.closePath();
  ctx.fill();

  // Canyon gap x=500..780 is entirely air - no geometry drawn there
};
