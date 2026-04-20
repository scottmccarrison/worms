import type { World } from "planck";
import { toPixels } from "../physics/scale";

/**
 * Iterate every planck body/fixture and stroke polygon outlines via Phaser Graphics.
 * Called from Scene.update each frame; clears and redraws each time.
 *
 * Uses planck 1.5's public PolygonShape API (getVertexCount + getVertex).
 */
export function drawDebug(
  graphics: Phaser.GameObjects.Graphics,
  world: World,
  color = 0x00ff96,
  alpha = 0.5,
): void {
  graphics.clear();
  graphics.lineStyle(1, color, alpha);

  let body = world.getBodyList();
  while (body !== null) {
    let fixture = body.getFixtureList();
    while (fixture !== null) {
      const shape = fixture.getShape();
      if (shape.getType() === "polygon") {
        // PolygonShape exposes getVertexCount + getVertex(i) in planck 1.5
        const poly = shape as unknown as {
          getVertexCount(): number;
          getVertex(index: number): { x: number; y: number };
        };
        const count = poly.getVertexCount();
        if (count > 0) {
          const first = body.getWorldPoint(poly.getVertex(0));
          graphics.beginPath();
          graphics.moveTo(toPixels(first.x), toPixels(first.y));
          for (let i = 1; i < count; i++) {
            const pt = body.getWorldPoint(poly.getVertex(i));
            graphics.lineTo(toPixels(pt.x), toPixels(pt.y));
          }
          graphics.closePath();
          graphics.strokePath();
        }
      }
      fixture = fixture.getNext();
    }
    body = body.getNext();
  }
}
