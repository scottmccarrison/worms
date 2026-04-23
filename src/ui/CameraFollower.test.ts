import { describe, expect, it, vi } from "vitest";
import { CameraFollower } from "./CameraFollower";

function makeMocks() {
  const startFollowCalls: Array<{ target: object }> = [];

  const camera = {
    startFollow: vi.fn((target: object) => {
      startFollowCalls.push({ target });
    }),
  };

  const scene = {
    cameras: { main: camera },
  };

  function makeFollower() {
    return new CameraFollower({ scene: scene as never });
  }

  function makeGfx(label: string) {
    return { __label: label } as unknown as import("phaser").GameObjects.GameObject;
  }

  return { scene, camera, startFollowCalls, makeFollower, makeGfx };
}

describe("CameraFollower", () => {
  it("update([]) with active worm set follows worm; subsequent empty updates do not re-call startFollow", () => {
    const { camera, makeFollower, makeGfx } = makeMocks();
    const follower = makeFollower();
    const worm = makeGfx("worm");

    follower.setActiveWormTarget(worm);
    expect(camera.startFollow).toHaveBeenCalledTimes(1);
    expect(camera.startFollow).toHaveBeenCalledWith(worm, true, 0.08, 0.08);

    // Further empty updates should not call startFollow again (no target change).
    follower.update([]);
    follower.update([]);
    expect(camera.startFollow).toHaveBeenCalledTimes(1);
  });

  it("update with a projectile entry starts following that projectile", () => {
    const { camera, makeFollower, makeGfx } = makeMocks();
    const follower = makeFollower();
    const worm = makeGfx("worm");
    const projGfx = makeGfx("proj");

    follower.setActiveWormTarget(worm);
    camera.startFollow.mockClear();

    follower.update([{ id: "p1", gfx: projGfx }]);

    expect(camera.startFollow).toHaveBeenCalledTimes(1);
    expect(camera.startFollow).toHaveBeenCalledWith(projGfx, true, 0.08, 0.08);
  });

  it("after following p1, update([]) returns camera to active worm", () => {
    const { camera, makeFollower, makeGfx } = makeMocks();
    const follower = makeFollower();
    const worm = makeGfx("worm");
    const projGfx = makeGfx("proj");

    follower.setActiveWormTarget(worm);
    follower.update([{ id: "p1", gfx: projGfx }]);
    camera.startFollow.mockClear();

    // Projectile despawns.
    follower.update([]);

    expect(camera.startFollow).toHaveBeenCalledTimes(1);
    expect(camera.startFollow).toHaveBeenCalledWith(worm, true, 0.08, 0.08);
  });

  it("setSuspended(true) makes update() a no-op; setSuspended(false) restores worm follow", () => {
    const { camera, makeFollower, makeGfx } = makeMocks();
    const follower = makeFollower();
    const worm = makeGfx("worm");
    const projGfx = makeGfx("proj");

    follower.setActiveWormTarget(worm);
    camera.startFollow.mockClear();

    follower.setSuspended(true);

    // update() with a projectile while suspended should be a no-op.
    follower.update([{ id: "p1", gfx: projGfx }]);
    expect(camera.startFollow).toHaveBeenCalledTimes(0);

    follower.update([{ id: "p1", gfx: projGfx }]);
    expect(camera.startFollow).toHaveBeenCalledTimes(0);

    // Resuming should return to the active worm.
    follower.setSuspended(false);
    expect(camera.startFollow).toHaveBeenCalledTimes(1);
    expect(camera.startFollow).toHaveBeenCalledWith(worm, true, 0.08, 0.08);
  });

  it("multi-projectile: follows first; when first despawns with second still alive, returns to worm not second", () => {
    const { camera, makeFollower, makeGfx } = makeMocks();
    const follower = makeFollower();
    const worm = makeGfx("worm");
    const proj1 = makeGfx("proj1");
    const proj2 = makeGfx("proj2");

    follower.setActiveWormTarget(worm);
    camera.startFollow.mockClear();

    // Both projectiles appear; follower should lock onto first (p1).
    follower.update([
      { id: "p1", gfx: proj1 },
      { id: "p2", gfx: proj2 },
    ]);
    expect(camera.startFollow).toHaveBeenCalledTimes(1);
    expect(camera.startFollow).toHaveBeenCalledWith(proj1, true, 0.08, 0.08);
    camera.startFollow.mockClear();

    // p1 despawns, p2 still alive - should return to worm, NOT hop to p2.
    follower.update([{ id: "p2", gfx: proj2 }]);
    expect(camera.startFollow).toHaveBeenCalledTimes(1);
    expect(camera.startFollow).toHaveBeenCalledWith(worm, true, 0.08, 0.08);
  });
});
