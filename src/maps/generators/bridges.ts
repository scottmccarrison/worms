import type { MapGenerator } from "../types";
import { xorshift } from "../xorshift";

export const bridgesGenerator: MapGenerator = (ctx, width, height, opts) => {
  const rng = xorshift(opts.seed);
  ctx.fillStyle = "#4a6a3c";

  // Proportional landmark positions (designed for 1280x720 baseline).
  const leftEdge = Math.floor(width * 0.3125); // ~400 at 1280
  const rightEdge = Math.floor(width * 0.6875); // ~880 at 1280
  const plateauY = Math.floor(height * 0.694); // ~500 at 720
  const bridgeY = Math.floor(height * 0.681); // ~490 at 720

  // Left plateau: x=0..leftEdge, y=plateauY..height
  ctx.beginPath();
  ctx.moveTo(0, height);
  ctx.lineTo(0, plateauY);
  for (let x = 0; x <= leftEdge; x += 50) {
    const bump = rng() * 10 - 5;
    ctx.lineTo(x, plateauY + bump);
  }
  ctx.lineTo(leftEdge, plateauY);
  ctx.lineTo(leftEdge, height);
  ctx.closePath();
  ctx.fill();

  // Right plateau: x=rightEdge..width, y=plateauY..height
  ctx.beginPath();
  ctx.moveTo(rightEdge, height);
  ctx.lineTo(rightEdge, plateauY);
  for (let x = rightEdge; x <= width; x += 50) {
    const bump = rng() * 10 - 5;
    ctx.lineTo(x, plateauY + bump);
  }
  ctx.lineTo(width, plateauY);
  ctx.lineTo(width, height);
  ctx.closePath();
  ctx.fill();

  // Central bridge (40px thick)
  ctx.fillRect(leftEdge, bridgeY, rightEdge - leftEdge, 40);

  // Left step
  ctx.fillRect(leftEdge - 60, plateauY - 60, 60, 60);

  // Right step
  ctx.fillRect(rightEdge, plateauY - 60, 60, 60);
};
