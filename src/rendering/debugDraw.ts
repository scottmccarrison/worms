import type { Vec2Value, World } from "planck";
import { toPixels } from "../physics/scale";

/** Internal shape type that exposes the polygon vertex arrays at runtime. */
interface PolygonLike {
  m_vertices: Vec2Value[];
  m_count: number;
}

/**
 * Iterate every planck body/fixture and stroke polygon outlines via Phaser Graphics.
 * Called from Scene.update each frame; clears and redraws each time.
 *
 * API divergence from plan: planck 1.5 PolygonShape has no getVertices() or getVertex()
 * methods. Vertices are accessed via m_vertices/m_count (hidden but runtime-accessible).
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
        const poly = shape as unknown as PolygonLike;
        const count = poly.m_count;
        if (count > 0) {
          const first = body.getWorldPoint(poly.m_vertices[0] ?? { x: 0, y: 0 });
          graphics.beginPath();
          graphics.moveTo(toPixels(first.x), toPixels(first.y));
          for (let i = 1; i < count; i++) {
            const pt = body.getWorldPoint(poly.m_vertices[i] ?? { x: 0, y: 0 });
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
