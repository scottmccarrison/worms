/**
 * Server-side Terrain entity. Mirrors the authoritative state that
 * src/terrain/Terrain.ts keeps on the client, but without any Phaser
 * / canvas / DOM bits. The mask is a Uint8Array (1 byte per pixel,
 * 0 = air, non-zero = solid) and bodies are rebuilt in-place when a
 * circular cut is applied.
 *
 * The class exposes:
 *   - cutCircle(x, y, r)         queues a cut and records it in the log
 *   - rebuildBodiesInRegion(yMin, yMax)  re-scans + rebuilds bodies
 *   - consumeCutLog()            drains + returns the cut events for
 *                                broadcast to clients
 *   - bodyCount()                diagnostic / test helper
 *
 * Cuts are applied eagerly (no pending queue) because the server
 * doesn't need to coalesce paints for a GPU upload - all work is
 * CPU-side pixel writes + body rebuilds.
 */

import type { World } from "planck";
import { Box } from "planck";
import type { Body } from "planck";
import { toMeters } from "../physics/scale.js";
import { TERRAIN_ROW_HEIGHT, scanMaskForBoxes } from "../terrain/terrainAlgorithm.js";

export interface TerrainInit {
  world: World;
  widthPx: number;
  heightPx: number;
  /** Initial mask. Non-zero = solid. Copied into internal buffer. */
  mask: Uint8Array;
  rowHeight?: number;
}

export interface TerrainCut {
  x: number;
  y: number;
  r: number;
  seq: number;
  source: "explode" | "tunnel";
}

interface TerrainBodyMeta {
  readonly kind: "terrain";
  readonly rowY: number;
}

export class Terrain {
  readonly widthPx: number;
  readonly heightPx: number;
  private readonly world: World;
  private readonly mask: Uint8Array;
  private readonly rowHeight: number;
  private readonly bodyMeta: WeakMap<Body, TerrainBodyMeta> = new WeakMap();
  private readonly terrainBodies: Set<Body> = new Set();

  private cutLog: TerrainCut[] = [];
  private cutSeq = 0;

  constructor(init: TerrainInit) {
    if (init.mask.length !== init.widthPx * init.heightPx) {
      throw new Error(
        `Terrain: mask length ${init.mask.length} does not match ${init.widthPx}x${init.heightPx}`,
      );
    }
    this.world = init.world;
    this.widthPx = init.widthPx;
    this.heightPx = init.heightPx;
    this.rowHeight = init.rowHeight ?? TERRAIN_ROW_HEIGHT;

    // Copy the mask so the caller can drop its reference.
    this.mask = new Uint8Array(init.mask);

    // Initial body build across the whole map.
    this.rebuildBodiesInRegion(0, this.heightPx);
  }

  /**
   * Erase a circular patch of mask pixels, rebuild bodies in the
   * affected Y-band, and append the cut to the log so the Simulation
   * can broadcast it as an event.
   */
  cutCircle(xPx: number, yPx: number, rPx: number, source: "explode" | "tunnel"): TerrainCut {
    this.eraseCircleInMask(xPx, yPx, rPx);

    const yMin = Math.max(0, Math.floor((yPx - rPx) / this.rowHeight) * this.rowHeight);
    const yMax = Math.min(this.heightPx, Math.ceil((yPx + rPx) / this.rowHeight) * this.rowHeight);
    this.rebuildBodiesInRegion(yMin, yMax);

    this.cutSeq += 1;
    const cut: TerrainCut = { x: xPx, y: yPx, r: rPx, seq: this.cutSeq, source };
    this.cutLog.push(cut);
    return cut;
  }

  /**
   * Destroy all terrain bodies whose rowY falls in
   * [yMin - rowHeight, yMax + rowHeight] and rebuild from the current
   * mask in [yMin, yMax).
   */
  rebuildBodiesInRegion(yMin: number, yMax: number): void {
    const yLo = Math.max(0, yMin);
    const yHi = Math.min(this.heightPx, yMax);
    if (yHi <= yLo) return;

    // Collect victims in the expanded band so we catch bodies that
    // straddle the edge rows.
    const victims: Body[] = [];
    for (const body of this.terrainBodies) {
      const meta = this.bodyMeta.get(body);
      if (meta && meta.rowY >= yLo - this.rowHeight && meta.rowY <= yHi + this.rowHeight) {
        victims.push(body);
      }
    }
    for (const body of victims) {
      this.world.destroyBody(body);
      this.bodyMeta.delete(body);
      this.terrainBodies.delete(body);
    }

    const boxes = scanMaskForBoxes(
      this.mask,
      this.widthPx,
      this.heightPx,
      {
        xMin: 0,
        xMax: this.widthPx,
        yMin: yLo,
        yMax: yHi,
      },
      this.rowHeight,
    );

    for (const box of boxes) {
      this.createBody(box.cxPx, box.cyPx, box.wPx, box.hPx);
    }
  }

  /** Drain the cut log. Called once per sim tick after stepping. */
  consumeCutLog(): TerrainCut[] {
    const out = this.cutLog;
    this.cutLog = [];
    return out;
  }

  /** Test + diagnostic helper. */
  bodyCount(): number {
    return this.terrainBodies.size;
  }

  /** Direct mask reader for spawn-point scanning / tests. */
  isSolid(xPx: number, yPx: number): boolean {
    const xi = Math.floor(xPx);
    const yi = Math.floor(yPx);
    if (xi < 0 || xi >= this.widthPx || yi < 0 || yi >= this.heightPx) return false;
    return this.mask[yi * this.widthPx + xi] !== 0;
  }

  /** Diagnostic for tests: how many solid pixels remain. */
  solidPixelCount(): number {
    let n = 0;
    for (let i = 0; i < this.mask.length; i++) if (this.mask[i] !== 0) n++;
    return n;
  }

  // ---- private ----

  private eraseCircleInMask(cxPx: number, cyPx: number, rPx: number): void {
    const r2 = rPx * rPx;
    const x0 = Math.max(0, Math.floor(cxPx - rPx));
    const x1 = Math.min(this.widthPx, Math.ceil(cxPx + rPx));
    const y0 = Math.max(0, Math.floor(cyPx - rPx));
    const y1 = Math.min(this.heightPx, Math.ceil(cyPx + rPx));
    for (let y = y0; y < y1; y++) {
      const dy = y + 0.5 - cyPx;
      const dy2 = dy * dy;
      const rowOffset = y * this.widthPx;
      for (let x = x0; x < x1; x++) {
        const dx = x + 0.5 - cxPx;
        if (dx * dx + dy2 <= r2) {
          this.mask[rowOffset + x] = 0;
        }
      }
    }
  }

  private createBody(cxPx: number, cyPx: number, wPx: number, hPx: number): void {
    const body = this.world.createBody({
      type: "static",
      position: { x: toMeters(cxPx), y: toMeters(cyPx) },
    });
    body.createFixture({
      shape: new Box(toMeters(wPx / 2), toMeters(hPx / 2)),
      density: 1,
      friction: 1,
    });
    const meta: TerrainBodyMeta = { kind: "terrain", rowY: cyPx };
    this.bodyMeta.set(body, meta);
    body.setUserData(meta);
    this.terrainBodies.add(body);
  }
}
