import type { MapGenerator } from "../types";

export const spireGenerator: MapGenerator = (ctx, _width, _height, _opts) => {
  ctx.fillStyle = "#3c5a6a";

  // Floor: x=0..1280, y=660..720 (60px thick)
  ctx.fillRect(0, 660, 1280, 60);

  // Central spire: x=510..770, y=120..660
  ctx.fillRect(510, 120, 260, 540);

  // Left ledge on spire: x=470..510, y=290..310 (juts left)
  ctx.fillRect(470, 290, 40, 20);

  // Right ledge on spire: x=770..810, y=440..460 (juts right)
  ctx.fillRect(770, 440, 40, 20);
};
