import { describe, expect, it } from "vitest";
import { tuning } from "../../tuning";
import type { PassContext } from "../pass";
import { getTheme } from "../themes";
import { HEIGHTMAP_UNINIT } from "../world";
import { createWorld } from "../world";
import type { World } from "../world";
import { resetPass } from "./reset";

function makeCtx(world: World): PassContext {
  return {
    world,
    rng: () => 0.5,
    passIndex: 0,
    tuning,
    resolveParam: (_, fb) => fb,
  };
}

describe("resetPass", () => {
  it("Reset on a fresh World is a no-op (state-equivalent)", () => {
    const world = createWorld(42, 10, 5, "default");

    // Capture initial state
    const initialHeightmap = new Int32Array(world.heightmap);
    const initialMask = new Uint8Array(world.mask);
    const initialMaterialMap = new Uint8Array(world.materialMap);
    const initialTheme = world.theme;
    const initialSpawnLeft = world.spawnList.left.length;
    const initialSpawnRight = world.spawnList.right.length;
    const initialCaveAmbient = world.caveAmbient.length;
    const initialSurfaceDressing = world.surfaceDressing.length;

    resetPass.run(makeCtx(world));

    // All heightmap columns should still be HEIGHTMAP_UNINIT
    for (let i = 0; i < world.heightmap.length; i++) {
      expect(world.heightmap[i]).toBe(HEIGHTMAP_UNINIT);
      expect(world.heightmap[i]).toBe(initialHeightmap[i]);
    }

    // Mask and materialMap should be all zeros
    for (let i = 0; i < world.mask.length; i++) {
      expect(world.mask[i]).toBe(initialMask[i]);
    }
    for (let i = 0; i < world.materialMap.length; i++) {
      expect(world.materialMap[i]).toBe(initialMaterialMap[i]);
    }

    expect(world.theme).toBe(initialTheme);
    expect(world.spawnList.left.length).toBe(initialSpawnLeft);
    expect(world.spawnList.right.length).toBe(initialSpawnRight);
    expect(world.caveAmbient.length).toBe(initialCaveAmbient);
    expect(world.surfaceDressing.length).toBe(initialSurfaceDressing);
  });

  it("Reset after manual mutation restores defaults", () => {
    const world = createWorld(42, 10, 5, "default");

    // Mutate every field
    world.heightmap[0] = 5;
    world.mask[0] = 1;
    world.materialMap[0] = 2;
    world.theme = getTheme("snow");
    world.spawnList.left.push({ xPx: 10, yPx: 20 });
    world.spawnList.right.push({ xPx: 50, yPx: 20 });
    world.caveAmbient.push({ xPx: 5, yPx: 5, type: "drip" });
    world.surfaceDressing.push({ xPx: 3, yPx: 3, sprite: "rock" });

    // Confirm mutations took effect
    expect(world.heightmap[0]).toBe(5);
    expect(world.mask[0]).toBe(1);
    expect(world.materialMap[0]).toBe(2);
    expect(world.theme).not.toBeNull();
    expect(world.spawnList.left.length).toBe(1);
    expect(world.spawnList.right.length).toBe(1);
    expect(world.caveAmbient.length).toBe(1);
    expect(world.surfaceDressing.length).toBe(1);

    resetPass.run(makeCtx(world));

    // All mutations should be reverted
    for (let i = 0; i < world.heightmap.length; i++) {
      expect(world.heightmap[i]).toBe(HEIGHTMAP_UNINIT);
    }
    for (let i = 0; i < world.mask.length; i++) {
      expect(world.mask[i]).toBe(0);
    }
    for (let i = 0; i < world.materialMap.length; i++) {
      expect(world.materialMap[i]).toBe(0);
    }
    expect(world.theme).toBeNull();
    expect(world.spawnList.left.length).toBe(0);
    expect(world.spawnList.right.length).toBe(0);
    expect(world.caveAmbient.length).toBe(0);
    expect(world.surfaceDressing.length).toBe(0);
  });
});
