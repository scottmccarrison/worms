import type { MapGenerator } from "../types";
import { xorshift } from "../xorshift";

export const plateauGenerator: MapGenerator = (ctx, _width, _height, opts) => {
  const rng = xorshift(opts.seed);
  ctx.fillStyle = "#5a4a2c";

  // Left low ground: x=0..320, y=530..720
  ctx.fillRect(0, 530, 320, 190);

  // Right low ground: x=960..1280, y=530..720
  ctx.fillRect(960, 530, 320, 190);

  // Central plateau: x=320..960, y=300..720
  ctx.fillRect(320, 300, 640, 420);

  // Left ramp polygon (sloped): (260, 530) -> (320, 300) -> (320, 530) close
  ctx.beginPath();
  ctx.moveTo(260, 530);
  ctx.lineTo(320, 300);
  ctx.lineTo(320, 530);
  ctx.closePath();
  ctx.fill();

  // Right ramp polygon (sloped): (1020, 530) -> (960, 300) -> (960, 530) close
  ctx.beginPath();
  ctx.moveTo(1020, 530);
  ctx.lineTo(960, 300);
  ctx.lineTo(960, 530);
  ctx.closePath();
  ctx.fill();

  // Plateau top peaks: 3 peaks centered at x=420, x=640, x=860
  // Each 60px wide, height seeded between 40 and 80px, pointing up from y=300
  const peakCenters = [420, 640, 860];
  for (const cx of peakCenters) {
    const peakHeight = 40 + Math.floor(rng() * 41); // 40..80
    const peakTop = 300 - peakHeight;
    ctx.beginPath();
    ctx.moveTo(cx - 30, 300);
    ctx.lineTo(cx, peakTop);
    ctx.lineTo(cx + 30, 300);
    ctx.closePath();
    ctx.fill();
  }
};
