import type { Scene } from "phaser";
import { Box } from "planck";
import type { Body } from "planck";
import type { PhysicsSystem } from "../physics/PhysicsSystem";
import { toMeters } from "../physics/scale";
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
  private readonly bodyMeta: WeakMap<Body, TerrainBodyMeta> = new WeakMap();
  private readonly terrainBodies: Set<Body> = new Set();
  private readonly canvasTexture: Phaser.Textures.CanvasTexture;
  private pending: Array<{ x: number; y: number; r: number }> = [];

  constructor(init: TerrainInit) {
    this.scene = init.scene;
    this.physics = init.physics;
    this.widthPx = init.widthPx;
    this.heightPx = init.heightPx;
    this.textureKey = init.textureKey ?? "terrain";
    this.rowHeight = init.rowHeight ?? TERRAIN_ROW_HEIGHT;

    // Create internal canvas buffer and copy source mask into it
    this.buffer = document.createElement("canvas");
    this.buffer.width = this.widthPx;
    this.buffer.height = this.heightPx;
    const ctx = this.buffer.getContext("2d");
    if (!ctx) throw new Error("Terrain: could not get 2D context");
    this.ctx = ctx;
    this.ctx.drawImage(init.sourceMask, 0, 0);

    // Register canvas with Phaser TextureManager
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

    // Step 3: Erase pixels via destination-out composite; restore composite
    const prevOp = this.ctx.globalCompositeOperation;
    this.ctx.globalCompositeOperation = "destination-out";
    for (const cut of this.pending) {
      this.ctx.beginPath();
      this.ctx.arc(cut.x, cut.y, cut.r, 0, Math.PI * 2);
      this.ctx.fill();
    }
    this.ctx.globalCompositeOperation = prevOp;

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
