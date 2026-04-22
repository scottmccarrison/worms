import type { MapGenerator } from "../types";

export const spireGenerator: MapGenerator = (ctx, width, height, _opts) => {
  ctx.fillStyle = "#3c5a6a";

  // Proportional positions (designed for 1280x720 baseline).
  const floorThick = 60;
  const floorY = height - floorThick;
  const spireLeft = Math.floor(width * 0.398); // ~510 at 1280
  const spireRight = Math.floor(width * 0.602); // ~770 at 1280
  const spireTop = Math.floor(height * 0.167); // ~120 at 720

  // Floor: full width
  ctx.fillRect(0, floorY, width, floorThick);

  // Central spire
  ctx.fillRect(spireLeft, spireTop, spireRight - spireLeft, floorY - spireTop);

  // Left ledge on spire (juts left)
  ctx.fillRect(spireLeft - 40, Math.floor(height * 0.403), 40, 20);

  // Right ledge on spire (juts right)
  ctx.fillRect(spireRight, Math.floor(height * 0.611), 40, 20);
};
