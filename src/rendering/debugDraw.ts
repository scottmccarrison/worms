import type { Vec2Value, World } from "planck";
import { toPixels } from "../physics/scale";

/** Runtime-accessible view of PolygonShape vertex arrays. */
interface PolygonLike {
  m_vertices: Vec2Value[];
  m_count: number;
}

/**
 * Iterate every planck body/fixture and stroke polygon outlines via Phaser Graphics.
 * Called from Scene.update each frame; clears and redraws each time.
 *
 * planck 1.5 note: PolygonShape does NOT expose a public getVertex/getVertexCount API
 * (those exist on ChainShape and DistanceProxy respectively, but not PolygonShape).
 * The @hidden m_vertices/m_count fields are the only way to access polygon geometry.
 * This is fragile across planck internal changes but works today; revisit if we ever
 * upgrade planck major versions.
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
