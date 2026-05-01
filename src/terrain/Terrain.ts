import type { Scene } from "phaser";
import { Box } from "planck";
import type { Body } from "planck";
import { gateCutByMaterial } from "../maps/world";
import type { PhysicsSystem } from "../physics/PhysicsSystem";
import { toMeters } from "../physics/scale";
import { applyStratumPaint } from "./stratumPaint";
import { TERRAIN_ROW_HEIGHT, scanMaskForBoxes } from "./terrainAlgorithm";

interface TerrainBodyMeta {
  readonly kind: "terrain";
  readonly rowY: number;
}

export interface TerrainInit {
  scene: Scene;
  physics: PhysicsSystem;
  widthPx: number;
  heightPx: number;
  /** Pre-drawn mask; Terrain copies it into its internal buffer. */
  sourceMask: HTMLCanvasElement;
  textureKey?: string; // default "terrain"
  rowHeight?: number; // default 5
  /**
   * When true, the source mask already has final RGB colors (e.g. produced
   * by a v1 pipeline generator using paintWorldToContext). Skip
   * applyStratumPaint so material colors survive. Default false: legacy
   * generators rely on stratumPaint.
   */
  prePainted?: boolean;
  /** Per-pixel material codes. When provided, cuts gate hard materials by radius. */
  materialMap?: Uint8Array;
  /** Material hardness thresholds (mirrors src/tuning.ts worldgen.materialHardness). */
  hardness?: { rockMinRadiusPx: number; stoneMinRadiusPx: number };
}

export class Terrain {
  readonly textureKey: string;
  readonly sprite: Phaser.GameObjects.Sprite;

  private readonly scene: Scene;
  private readonly physics: PhysicsSystem;
  private readonly buffer: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly widthPx: number;
  private readonly heightPx: number;
  private readonly rowHeight: number;
  private readonly materialMap: Uint8Array | null;
  private readonly hardness: { rockMinRadiusPx: number; stoneMinRadiusPx: number };
  private readonly bodyMeta: WeakMap<Body, TerrainBodyMeta> = new WeakMap();
  private readonly terrainBodies: Set<Body> = new Set();
  private readonly canvasTexture: Phaser.Textures.CanvasTexture;
  private pending: Array<{ x: number; y: number; r: number }> = [];
  /**
   * Turn-scoped cut log. Appended on every `cutCircle`, consumed by
   * `consumeTurnCuts()` at turn end so the active client can ship the
   * full list in `turn_snapshot`. Reset on every consume. Entries carry
   * a monotonic `seq` for idempotent replay on spectator clients.
   */
  private turnCuts: Array<{ x: number; y: number; r: number; seq: number }> = [];
  private turnCutSeq = 0;

  constructor(init: TerrainInit) {
    this.scene = init.scene;
    this.physics = init.physics;
    this.widthPx = init.widthPx;
    this.heightPx = init.heightPx;
    this.textureKey = init.textureKey ?? "terrain";
    this.rowHeight = init.rowHeight ?? TERRAIN_ROW_HEIGHT;
    this.materialMap = init.materialMap ?? null;
    this.hardness = init.hardness ?? { rockMinRadiusPx: 30, stoneMinRadiusPx: 60 };
    if (this.materialMap !== null && this.materialMap.length !== this.widthPx * this.heightPx) {
      throw new Error(
        `Terrain: materialMap length ${this.materialMap.length} does not match ${this.widthPx}x${this.heightPx}`,
      );
    }

    // Create internal canvas buffer and copy source mask into it
    this.buffer = document.createElement("canvas");
    this.buffer.width = this.widthPx;
    this.buffer.height = this.heightPx;
    const ctx = this.buffer.getContext("2d");
    if (!ctx) throw new Error("Terrain: could not get 2D context");
    this.ctx = ctx;
    this.ctx.drawImage(init.sourceMask, 0, 0);

    // Depth-stratum paint: grass/dirt/stone over the mask alpha. Matches
    // the networked TerrainRenderer so offline + networked look identical
    // regardless of whether the generator painted its own RGB. Skipped
    // when the source mask is already RGB-painted by a v1 pipeline
    // generator (init.prePainted = true).
    if (!init.prePainted) {
      applyStratumPaint(this.ctx, this.widthPx, this.heightPx);
    }

    // Register canvas with Phaser TextureManager. A previous Terrain
    // instance in the same scene session leaves its texture registered;
    // addCanvas returns null on duplicate keys, so remove first.
    if (this.scene.textures.exists(this.textureKey)) {
      this.scene.textures.remove(this.textureKey);
    }
    const canvasTexture = this.scene.textures.addCanvas(this.textureKey, this.buffer);
    if (!canvasTexture) throw new Error(`Terrain: addCanvas failed for key "${this.textureKey}"`);
    this.canvasTexture = canvasTexture;

    // Create sprite positioned at center of terrain
    this.sprite = this.scene.add.sprite(this.widthPx / 2, this.heightPx / 2, this.textureKey);

    // Initial body build across full terrain
    this.buildBodiesInRegion(0, this.heightPx);
  }

  /** Queue a circular cut. Applied in next flushPendingCuts(). */
  cutCircle(xPx: number, yPx: number, rPx: number): void {
    this.pending.push({ x: xPx, y: yPx, r: rPx });
    this.turnCutSeq += 1;
    this.turnCuts.push({ x: xPx, y: yPx, r: rPx, seq: this.turnCutSeq });
  }

  /**
   * Consume and return the cuts made since the last call. Used by the
   * active client at turn end to ship the authoritative cut log in
   * `turn_snapshot`. Spectator clients apply the returned list on
   * `turn_resolved` to reconcile per-client sim drift.
   */
  consumeTurnCuts(): Array<{ x: number; y: number; r: number; seq: number }> {
    const out = this.turnCuts;
    this.turnCuts = [];
    return out;
  }

  /**
   * Cut a rotated rectangle out of terrain. Origin is the bottom-center of the
   * rect (where the worm stands). Length extends in `angleRad` direction;
   * width is perpendicular, centered on the aim line.
   *
   * Material hardness gating applies same as cutCircle.
   * Immediately erases pixels, destroys affected bodies, rebuilds, and refreshes texture.
   */
  cutRect(
    originX: number,
    originY: number,
    lengthPx: number,
    widthPx: number,
    angleRad: number,
  ): void {
    const dx = Math.cos(angleRad);
    const dy = Math.sin(angleRad);
    const perpX = -dy;
    const perpY = dx;
    const halfW = widthPx / 2;

    // Compute pixel-space AABB of the rotated rect (4 corners)
    const corners = [
      [0, -halfW],
      [lengthPx, -halfW],
      [lengthPx, halfW],
      [0, halfW],
    ].map(([t, s]) => [
      originX + (t ?? 0) * dx + (s ?? 0) * perpX,
      originY + (t ?? 0) * dy + (s ?? 0) * perpY,
    ]);
    const rawMinX = Math.floor(Math.min(...corners.map((c) => c[0] ?? 0)));
    const rawMaxX = Math.ceil(Math.max(...corners.map((c) => c[0] ?? 0)));
    const rawMinY = Math.floor(Math.min(...corners.map((c) => c[1] ?? 0)));
    const rawMaxY = Math.ceil(Math.max(...corners.map((c) => c[1] ?? 0)));

    // Clamp to canvas bounds for pixel operations
    const x0 = Math.max(0, rawMinX);
    const x1 = Math.min(this.widthPx, rawMaxX);
    const y0 = Math.max(0, rawMinY);
    const y1 = Math.min(this.heightPx, rawMaxY);
    const w = x1 - x0;
    const h = y1 - y0;
    if (w <= 0 || h <= 0) return;

    // Erase pixels: per-pixel rect-inclusion test (same for both paths)
    const imageData = this.ctx.getImageData(x0, y0, w, h);
    const data = imageData.data;
    for (let row = 0; row < h; row++) {
      const worldY = y0 + row;
      for (let col = 0; col < w; col++) {
        const worldX = x0 + col;
        const lx = worldX - originX;
        const ly = worldY - originY;
        const t = lx * dx + ly * dy;
        const s = lx * perpX + ly * perpY;
        if (t < 0 || t > lengthPx) continue;
        if (s < -halfW || s > halfW) continue;
        if (this.materialMap !== null) {
          // Material hardness gate: drill represents itself as a length-scaled
          // tool, not a small-radius blast. Use lengthPx so drill cuts through
          // rock (rockMinRadiusPx ~30) and stone (stoneMinRadiusPx ~60). Using
          // halfW (typically 12) here would silently no-op on stone/rock.
          const material = this.materialMap[worldY * this.widthPx + worldX];
          if (!gateCutByMaterial(material, lengthPx, this.hardness)) continue;
        }
        data[(row * w + col) * 4 + 3] = 0;
      }
    }
    this.ctx.putImageData(imageData, x0, y0);

    // Rebuild bodies in the affected Y-band (same logic as flushPendingCuts)
    const yMin = Math.max(0, Math.floor(rawMinY / this.rowHeight) * this.rowHeight);
    const yMax = Math.min(this.heightPx, Math.ceil(rawMaxY / this.rowHeight) * this.rowHeight);

    const victims: Body[] = [];
    for (const body of this.terrainBodies) {
      const meta = this.bodyMeta.get(body);
      if (meta && meta.rowY >= yMin - this.rowHeight && meta.rowY <= yMax + this.rowHeight) {
        victims.push(body);
      }
    }
    for (const body of victims) {
      this.physics.world.destroyBody(body);
      this.bodyMeta.delete(body);
      this.terrainBodies.delete(body);
    }

    const rebuildData = this.ctx.getImageData(0, yMin, this.widthPx, yMax - yMin);
    const boxes = scanMaskForBoxes(
      rebuildData.data,
      this.widthPx,
      yMax - yMin,
      null,
      this.rowHeight,
    );
    for (const box of boxes) {
      this.createBody(box.cxPx, box.cyPx + yMin, box.wPx, box.hPx);
    }

    this.canvasTexture.refresh();
  }

  /**
   * Erase queued circles, destroy bodies in affected Y-band, rebuild, refresh texture.
   * Follows the 9-step sequence from the plan.
   */
  flushPendingCuts(): void {
    // Step 1: If pending empty, return
    if (this.pending.length === 0) return;

    // Step 2: Compute union Y-band; snap to rowHeight grid
    let rawYMin = Number.POSITIVE_INFINITY;
    let rawYMax = Number.NEGATIVE_INFINITY;
    for (const cut of this.pending) {
      rawYMin = Math.min(rawYMin, cut.y - cut.r);
      rawYMax = Math.max(rawYMax, cut.y + cut.r);
    }
    const yMin = Math.max(0, Math.floor(rawYMin / this.rowHeight) * this.rowHeight);
    const yMax = Math.min(this.heightPx, Math.ceil(rawYMax / this.rowHeight) * this.rowHeight);

    // Step 3: Erase pixels - bulk destination-out for legacy (no materialMap),
    // or per-pixel material-aware path when materialMap is present.
    if (this.materialMap === null) {
      const prevOp = this.ctx.globalCompositeOperation;
      this.ctx.globalCompositeOperation = "destination-out";
      for (const cut of this.pending) {
        this.ctx.beginPath();
        this.ctx.arc(cut.x, cut.y, cut.r, 0, Math.PI * 2);
        this.ctx.fill();
      }
      this.ctx.globalCompositeOperation = prevOp;
    } else {
      for (const cut of this.pending) {
        this.applyMaterialAwareCut(cut);
      }
    }

    // Step 4: Collect terrain bodies with rowY in [yMin - rowHeight, yMax + rowHeight]
    const victims: Body[] = [];
    for (const body of this.terrainBodies) {
      const meta = this.bodyMeta.get(body);
      if (meta && meta.rowY >= yMin - this.rowHeight && meta.rowY <= yMax + this.rowHeight) {
        victims.push(body);
      }
    }

    // Step 5: Destroy victims (collect-then-destroy for iteration safety)
    for (const body of victims) {
      this.physics.world.destroyBody(body);
      this.bodyMeta.delete(body);
      this.terrainBodies.delete(body);
    }

    // Step 6: getImageData limited to dirty Y-band, scan for new boxes
    const imageData = this.ctx.getImageData(0, yMin, this.widthPx, yMax - yMin);
    const boxes = scanMaskForBoxes(imageData.data, this.widthPx, yMax - yMin, null, this.rowHeight);

    // Step 7: Translate emitted cyPx by +yMin; create bodies; tag; add to Set
    for (const box of boxes) {
      const adjustedBox = {
        ...box,
        cyPx: box.cyPx + yMin,
      };
      this.createBody(adjustedBox.cxPx, adjustedBox.cyPx, adjustedBox.wPx, adjustedBox.hPx);
    }

    // Step 8: Push mutated canvas to GPU (critical for WebGL mode)
    this.canvasTexture.refresh();

    // Step 9: Clear pending queue
    this.pending = [];
  }

  /** For debug/test. */
  bodyCount(): number {
    return this.terrainBodies.size;
  }

  /** Return a snapshot of the terrain mask pixels for spawn point scanning. */
  getMaskImageData(): ImageData {
    return this.ctx.getImageData(0, 0, this.widthPx, this.heightPx);
  }

  private applyMaterialAwareCut(cut: { x: number; y: number; r: number }): void {
    if (this.materialMap === null) return;
    const x0 = Math.max(0, Math.floor(cut.x - cut.r));
    const x1 = Math.min(this.widthPx, Math.ceil(cut.x + cut.r));
    const y0 = Math.max(0, Math.floor(cut.y - cut.r));
    const y1 = Math.min(this.heightPx, Math.ceil(cut.y + cut.r));
    const w = x1 - x0;
    const h = y1 - y0;
    if (w <= 0 || h <= 0) return;

    const imageData = this.ctx.getImageData(x0, y0, w, h);
    const data = imageData.data;
    const r2 = cut.r * cut.r;

    for (let py = 0; py < h; py++) {
      const worldY = y0 + py;
      for (let px = 0; px < w; px++) {
        const worldX = x0 + px;
        const dx = worldX + 0.5 - cut.x;
        const dy = worldY + 0.5 - cut.y;
        if (dx * dx + dy * dy > r2) continue;
        const material = this.materialMap[worldY * this.widthPx + worldX];
        if (!gateCutByMaterial(material, cut.r, this.hardness)) continue;
        data[(py * w + px) * 4 + 3] = 0;
      }
    }
    this.ctx.putImageData(imageData, x0, y0);
  }

  private buildBodiesInRegion(yStart: number, yEnd: number): void {
    const imageData = this.ctx.getImageData(0, yStart, this.widthPx, yEnd - yStart);
    const boxes = scanMaskForBoxes(
      imageData.data,
      this.widthPx,
      yEnd - yStart,
      null,
      this.rowHeight,
    );

    for (const box of boxes) {
      this.createBody(box.cxPx, box.cyPx + yStart, box.wPx, box.hPx);
    }
  }

  private createBody(cxPx: number, cyPx: number, wPx: number, hPx: number): void {
    const body = this.physics.world.createBody({
      type: "static",
      position: { x: toMeters(cxPx), y: toMeters(cyPx) },
    });
    body.createFixture({
      shape: new Box(toMeters(wPx / 2), toMeters(hPx / 2)),
      density: 1,
      friction: 1,
    });
    const meta = { kind: "terrain" as const, rowY: cyPx };
    this.bodyMeta.set(body, meta);
    body.setUserData(meta);
    this.terrainBodies.add(body);
  }
}
