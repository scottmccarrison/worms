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
import { gateCutByMaterial } from "../maps/world";
import { applyStratumPaint } from "./stratumPaint";

export interface TerrainRendererInit {
  scene: Scene;
  widthPx: number;
  heightPx: number;
  /** Pre-drawn source mask; copied into the internal buffer on construction. */
  sourceMask: HTMLCanvasElement;
  textureKey?: string;
  /**
   * When true, the source mask already has final RGB colors (e.g. produced
   * by a v1 pipeline generator using paintWorldToContext). The renderer
   * skips applyStratumPaint so material colors survive. Default false:
   * legacy generators leave RGB unpainted and rely on stratumPaint.
   */
  prePainted?: boolean;
  /** Per-pixel material codes. When provided, cutCircle gates hard materials by radius. */
  materialMap?: Uint8Array;
  /** Material hardness thresholds (mirrors src/tuning.ts worldgen.materialHardness). */
  hardness?: { rockMinRadiusPx: number; stoneMinRadiusPx: number };
}

export class TerrainRenderer {
  readonly textureKey: string;
  readonly sprite: Phaser.GameObjects.Sprite;

  private readonly buffer: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly widthPx: number;
  private readonly heightPx: number;
  private readonly materialMap: Uint8Array | null;
  private readonly hardness: { rockMinRadiusPx: number; stoneMinRadiusPx: number };
  private readonly canvasTexture: Phaser.Textures.CanvasTexture;

  /** Seen terrain_cut seqs for idempotent replay. */
  private readonly seenSeqs = new Set<number>();

  constructor(init: TerrainRendererInit) {
    this.widthPx = init.widthPx;
    this.heightPx = init.heightPx;
    this.textureKey = init.textureKey ?? "terrain";
    this.materialMap = init.materialMap ?? null;
    this.hardness = init.hardness ?? { rockMinRadiusPx: 30, stoneMinRadiusPx: 60 };
    if (this.materialMap !== null && this.materialMap.length !== this.widthPx * this.heightPx) {
      throw new Error(
        `TerrainRenderer: materialMap length ${this.materialMap.length} does not match ${this.widthPx}x${this.heightPx}`,
      );
    }

    this.buffer = document.createElement("canvas");
    this.buffer.width = this.widthPx;
    this.buffer.height = this.heightPx;
    const ctx = this.buffer.getContext("2d");
    if (!ctx) throw new Error("TerrainRenderer: could not get 2D context");
    this.ctx = ctx;
    this.ctx.drawImage(init.sourceMask, 0, 0);

    if (!init.prePainted) {
      applyStratumPaint(this.ctx, this.widthPx, this.heightPx);
    }

    // A previous TerrainRenderer instance in the same scene session (e.g.
    // game 1 -> return to lobby -> game 2) leaves its canvas texture
    // registered in Phaser's TextureManager. addCanvas returns null on
    // duplicate keys, so remove any stale registration first.
    if (init.scene.textures.exists(this.textureKey)) {
      init.scene.textures.remove(this.textureKey);
    }
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
   *
   * When materialMap is present, uses per-pixel material gating so hard
   * materials (ROCK, STONE) survive cuts below their configured radius thresholds.
   * Without materialMap, falls back to the bulk destination-out path.
   */
  cutCircle(xPx: number, yPx: number, rPx: number, seq?: number): void {
    if (seq !== undefined) {
      if (this.seenSeqs.has(seq)) return;
      this.seenSeqs.add(seq);
    }
    if (this.materialMap === null) {
      const prev = this.ctx.globalCompositeOperation;
      this.ctx.globalCompositeOperation = "destination-out";
      this.ctx.beginPath();
      this.ctx.arc(xPx, yPx, rPx, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.globalCompositeOperation = prev;
    } else {
      this.applyMaterialAwareCut(xPx, yPx, rPx);
    }
    this.canvasTexture.refresh();
  }

  private applyMaterialAwareCut(xPx: number, yPx: number, rPx: number): void {
    if (this.materialMap === null) return;
    const x0 = Math.max(0, Math.floor(xPx - rPx));
    const x1 = Math.min(this.widthPx, Math.ceil(xPx + rPx));
    const y0 = Math.max(0, Math.floor(yPx - rPx));
    const y1 = Math.min(this.heightPx, Math.ceil(yPx + rPx));
    const w = x1 - x0;
    const h = y1 - y0;
    if (w <= 0 || h <= 0) return;

    const imageData = this.ctx.getImageData(x0, y0, w, h);
    const data = imageData.data;
    const r2 = rPx * rPx;

    for (let py = 0; py < h; py++) {
      const worldY = y0 + py;
      for (let px = 0; px < w; px++) {
        const worldX = x0 + px;
        const dx = worldX + 0.5 - xPx;
        const dy = worldY + 0.5 - yPx;
        if (dx * dx + dy * dy > r2) continue;
        const material = this.materialMap[worldY * this.widthPx + worldX];
        if (!gateCutByMaterial(material, rPx, this.hardness)) continue;
        data[(py * w + px) * 4 + 3] = 0;
      }
    }
    this.ctx.putImageData(imageData, x0, y0);
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
