/**
 * Epic 45 - visual-only terrain.
 *
 * A stripped-down Terrain companion that owns just the canvas mask and
 * sprite. No planck bodies, no flushPendingCuts -> rebuild cycle. Used by
 * GameScene's networked path: the server owns physics bodies; the client
 * only needs to show the mask and cut holes when `terrain_cut` events
 * arrive.
 *
 * Matches the initial-mask bootstrap + cutCircle surface of Terrain.ts
 * so the scene code paths converge on the same drawing contract.
 */

import type { Scene } from "phaser";

export interface TerrainRendererInit {
  scene: Scene;
  widthPx: number;
  heightPx: number;
  /** Pre-drawn source mask; copied into the internal buffer on construction. */
  sourceMask: HTMLCanvasElement;
  textureKey?: string;
}

export class TerrainRenderer {
  readonly textureKey: string;
  readonly sprite: Phaser.GameObjects.Sprite;

  private readonly buffer: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly widthPx: number;
  private readonly heightPx: number;
  private readonly canvasTexture: Phaser.Textures.CanvasTexture;

  /** Seen terrain_cut seqs for idempotent replay. */
  private readonly seenSeqs = new Set<number>();

  constructor(init: TerrainRendererInit) {
    this.widthPx = init.widthPx;
    this.heightPx = init.heightPx;
    this.textureKey = init.textureKey ?? "terrain";

    this.buffer = document.createElement("canvas");
    this.buffer.width = this.widthPx;
    this.buffer.height = this.heightPx;
    const ctx = this.buffer.getContext("2d");
    if (!ctx) throw new Error("TerrainRenderer: could not get 2D context");
    this.ctx = ctx;
    this.ctx.drawImage(init.sourceMask, 0, 0);

    // Stratum paint: scan each column top-down for the first solid pixel
    // (the surface), then paint each pixel's RGB by depth-from-surface.
    // Grass for the first 6px, dirt for the next 54px, stone below. Alpha
    // is preserved from the mask so destruction (destination-out) still
    // works correctly.
    const img = this.ctx.getImageData(0, 0, this.widthPx, this.heightPx);
    const data = img.data;
    for (let x = 0; x < this.widthPx; x++) {
      let surfaceY = -1;
      for (let y = 0; y < this.heightPx; y++) {
        const i = (y * this.widthPx + x) * 4;
        if (data[i + 3] === 0) continue;
        if (surfaceY === -1) surfaceY = y;
        const depth = y - surfaceY;
        let r: number;
        let g: number;
        let b: number;
        if (depth < 6) {
          r = 58;
          g = 122;
          b = 60;
        } // grass
        else if (depth < 60) {
          r = 122;
          g = 74;
          b = 44;
        } // dirt
        else {
          r = 90;
          g = 90;
          b = 90;
        } // stone
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
      }
    }
    this.ctx.putImageData(img, 0, 0);

    const canvasTexture = init.scene.textures.addCanvas(this.textureKey, this.buffer);
    if (!canvasTexture) {
      throw new Error(`TerrainRenderer: addCanvas failed for key "${this.textureKey}"`);
    }
    this.canvasTexture = canvasTexture;

    this.sprite = init.scene.add.sprite(this.widthPx / 2, this.heightPx / 2, this.textureKey);
  }

  /**
   * Cut a circular hole out of the mask and refresh the GPU texture.
   * `seq` is optional; when present we dedupe so duplicate `terrain_cut`
   * messages don't double-cut. This is the network path's equivalent of
   * Terrain.flushPendingCuts minus the body rebuild.
   */
  cutCircle(xPx: number, yPx: number, rPx: number, seq?: number): void {
    if (seq !== undefined) {
      if (this.seenSeqs.has(seq)) return;
      this.seenSeqs.add(seq);
    }
    const prev = this.ctx.globalCompositeOperation;
    this.ctx.globalCompositeOperation = "destination-out";
    this.ctx.beginPath();
    this.ctx.arc(xPx, yPx, rPx, 0, Math.PI * 2);
    this.ctx.fill();
    this.ctx.globalCompositeOperation = prev;
    this.canvasTexture.refresh();
  }

  /** For debug: snapshot current mask pixels. */
  getMaskImageData(): ImageData {
    return this.ctx.getImageData(0, 0, this.widthPx, this.heightPx);
  }

  destroy(): void {
    this.sprite.destroy();
    // canvasTexture is owned by Phaser's TextureManager; leaving it
    // registered lets the scene restart reuse the key without churn.
  }
}
