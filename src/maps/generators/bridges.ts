import type { MapGenerator } from "../types";
import { xorshift } from "../xorshift";

export const bridgesGenerator: MapGenerator = (ctx, _width, height, opts) => {
  const rng = xorshift(opts.seed);
  ctx.fillStyle = "#4a6a3c";

  // Left plateau: x=0..400, y=500..720
  // With seeded surface bumps at 50px intervals (±5px)
  ctx.beginPath();
  ctx.moveTo(0, height);
  ctx.lineTo(0, 500);
  for (let x = 0; x <= 400; x += 50) {
    const bump = rng() * 10 - 5;
    ctx.lineTo(x, 500 + bump);
  }
  ctx.lineTo(400, 500);
  ctx.lineTo(400, height);
  ctx.closePath();
  ctx.fill();

  // Right plateau: x=880..1280, y=500..720
  // With seeded surface bumps at 50px intervals (±5px)
  ctx.beginPath();
  ctx.moveTo(880, height);
  ctx.lineTo(880, 500);
  for (let x = 880; x <= 1280; x += 50) {
    const bump = rng() * 10 - 5;
    ctx.lineTo(x, 500 + bump);
  }
  ctx.lineTo(1280, 500);
  ctx.lineTo(1280, height);
  ctx.closePath();
  ctx.fill();

  // Central bridge: x=400..880, y=490..530 (40px thick, 480px long)
  ctx.fillRect(400, 490, 480, 40);

  // Left step (cover on inner edge of left plateau): x=340..400, y=440..500
  ctx.fillRect(340, 440, 60, 60);

  // Right step (cover on inner edge of right plateau): x=880..940, y=440..500
  ctx.fillRect(880, 440, 60, 60);
};
