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
