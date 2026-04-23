import { describe, expect, it, vi } from "vitest";
import { tuning } from "../tuning";
import { CameraFollower } from "./CameraFollower";

function makeMocks() {
  const startFollowCalls: Array<{ target: object }> = [];

  const camera = {
    startFollow: vi.fn((target: object) => {
      startFollowCalls.push({ target });
    }),
    stopFollow: vi.fn(),
  };

  const scene = {
    cameras: { main: camera },
  };

  function makeFollower(now?: () => number) {
    return new CameraFollower({ scene: scene as never, now });
  }

  function makeGfx(label: string) {
    return { __label: label } as unknown as import("phaser").GameObjects.GameObject;
  }

  return { scene, camera, startFollowCalls, makeFollower, makeGfx };
}

const wormLerp = tuning.camera.wormLerp;
const projLerp = tuning.camera.projectileLerp;
const lingerMs = tuning.camera.postImpactLingerMs;

describe("CameraFollower", () => {
  it("update([]) with active worm set follows worm; subsequent empty updates do not re-call startFollow", () => {
    const { camera, makeFollower, makeGfx } = makeMocks();
    const follower = makeFollower();
    const worm = makeGfx("worm");

    follower.setActiveWormTarget(worm);
    expect(camera.startFollow).toHaveBeenCalledTimes(1);
    expect(camera.startFollow).toHaveBeenCalledWith(worm, true, wormLerp, wormLerp);

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
    expect(camera.startFollow).toHaveBeenCalledWith(projGfx, true, projLerp, projLerp);
  });

  it("after following p1, update([]) enters linger then returns camera to active worm after delay", () => {
    let fakeNow = 1000;
    const { camera, makeFollower, makeGfx } = makeMocks();
    const follower = makeFollower(() => fakeNow);
    const worm = makeGfx("worm");
    const projGfx = makeGfx("proj");

    follower.setActiveWormTarget(worm);
    follower.update([{ id: "p1", gfx: projGfx }]);
    camera.startFollow.mockClear();

    // Projectile despawns - should enter linger, not immediately follow worm.
    follower.update([]);
    expect(camera.stopFollow).toHaveBeenCalledTimes(1);
    expect(camera.startFollow).toHaveBeenCalledTimes(0);

    // Still within linger window - camera frozen, nothing happens.
    fakeNow += lingerMs - 100;
    follower.update([]);
    expect(camera.startFollow).toHaveBeenCalledTimes(0);

    // Linger elapsed - should return to worm.
    fakeNow += 200;
    follower.update([]);
    expect(camera.startFollow).toHaveBeenCalledTimes(1);
    expect(camera.startFollow).toHaveBeenCalledWith(worm, true, wormLerp, wormLerp);
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
    expect(camera.startFollow).toHaveBeenCalledWith(worm, true, wormLerp, wormLerp);
  });

  it("multi-projectile: follows first; when first despawns with second still alive, enters linger not worm", () => {
    let fakeNow = 1000;
    const { camera, makeFollower, makeGfx } = makeMocks();
    const follower = makeFollower(() => fakeNow);
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
    expect(camera.startFollow).toHaveBeenCalledWith(proj1, true, projLerp, projLerp);
    camera.startFollow.mockClear();

    // p1 despawns, p2 still alive - should enter linger (camera frozen), NOT jump to worm.
    follower.update([{ id: "p2", gfx: proj2 }]);
    expect(camera.stopFollow).toHaveBeenCalledTimes(1);
    expect(camera.startFollow).toHaveBeenCalledTimes(0);

    // Linger elapses with p2 still present - new projectile acquired (p2 is the only live one).
    fakeNow += lingerMs + 100;
    follower.update([{ id: "p2", gfx: proj2 }]);
    // Per spec: linger clears and falls through to "acquire first projectile", so p2 is followed.
    expect(camera.startFollow).toHaveBeenCalledWith(proj2, true, projLerp, projLerp);
    camera.startFollow.mockClear();

    // Now p2 also despawns - enters linger again.
    follower.update([]);
    expect(camera.startFollow).toHaveBeenCalledTimes(0);

    // Linger elapses with no projectiles - return to worm.
    fakeNow += lingerMs + 100;
    follower.update([]);
    expect(camera.startFollow).toHaveBeenCalledTimes(1);
    expect(camera.startFollow).toHaveBeenCalledWith(worm, true, wormLerp, wormLerp);
  });

  it("linger holds camera after projectile despawn, then returns to worm", () => {
    let fakeNow = 5000;
    const { camera, makeFollower, makeGfx } = makeMocks();
    const follower = makeFollower(() => fakeNow);
    const worm = makeGfx("worm");
    const projGfx = makeGfx("proj");

    follower.setActiveWormTarget(worm);
    follower.update([{ id: "p1", gfx: projGfx }]);
    camera.startFollow.mockClear();

    // Projectile despawns - camera should freeze, not return to worm yet.
    follower.update([]);
    expect(camera.stopFollow).toHaveBeenCalledTimes(1);
    expect(camera.startFollow).toHaveBeenCalledTimes(0);

    // Still lingering - worm not yet followed.
    fakeNow += lingerMs - 1;
    follower.update([]);
    expect(camera.startFollow).toHaveBeenCalledTimes(0);

    // Linger complete - worm should be followed.
    fakeNow += 100;
    follower.update([]);
    expect(camera.startFollow).toHaveBeenCalledTimes(1);
    expect(camera.startFollow).toHaveBeenCalledWith(worm, true, wormLerp, wormLerp);
  });

  it("new projectile during linger cancels linger and follows new projectile", () => {
    let fakeNow = 5000;
    const { camera, makeFollower, makeGfx } = makeMocks();
    const follower = makeFollower(() => fakeNow);
    const worm = makeGfx("worm");
    const proj1Gfx = makeGfx("proj1");
    const proj2Gfx = makeGfx("proj2");

    follower.setActiveWormTarget(worm);
    // Follow p1.
    follower.update([{ id: "p1", gfx: proj1Gfx }]);
    // p1 despawns - enter linger.
    follower.update([]);
    camera.startFollow.mockClear();

    // Before linger elapses, p2 appears - should interrupt linger and follow p2.
    fakeNow += lingerMs - 100;
    follower.update([{ id: "p2", gfx: proj2Gfx }]);

    expect(camera.startFollow).toHaveBeenCalledTimes(1);
    expect(camera.startFollow).toHaveBeenCalledWith(proj2Gfx, true, projLerp, projLerp);
    // Worm should never have been re-followed.
    const wormCalls = (camera.startFollow.mock.calls as Array<unknown[]>).filter(
      (c) => c[0] === worm,
    );
    expect(wormCalls).toHaveLength(0);
  });

  it("suspend during linger clears linger; resume follows worm", () => {
    let fakeNow = 5000;
    const { camera, makeFollower, makeGfx } = makeMocks();
    const follower = makeFollower(() => fakeNow);
    const worm = makeGfx("worm");
    const projGfx = makeGfx("proj");

    follower.setActiveWormTarget(worm);
    follower.update([{ id: "p1", gfx: projGfx }]);
    // p1 despawns - enter linger.
    follower.update([]);
    camera.startFollow.mockClear();

    // Suspend during linger.
    follower.setSuspended(true);

    // Advance past linger time; update should be a no-op.
    fakeNow += lingerMs + 500;
    follower.update([]);
    expect(camera.startFollow).toHaveBeenCalledTimes(0);

    // Resume - should follow worm.
    follower.setSuspended(false);
    expect(camera.startFollow).toHaveBeenCalledTimes(1);
    expect(camera.startFollow).toHaveBeenCalledWith(worm, true, wormLerp, wormLerp);
  });

  it("worm follow uses wormLerp, projectile follow uses projectileLerp", () => {
    let fakeNow = 0;
    const { camera, makeFollower, makeGfx } = makeMocks();
    const follower = makeFollower(() => fakeNow);
    const worm = makeGfx("worm");
    const projGfx = makeGfx("proj");

    follower.setActiveWormTarget(worm);
    camera.startFollow.mockClear();

    // Follow projectile - should use projectileLerp.
    follower.update([{ id: "p1", gfx: projGfx }]);
    expect(camera.startFollow).toHaveBeenCalledTimes(1);
    expect(camera.startFollow).toHaveBeenCalledWith(projGfx, true, projLerp, projLerp);
    camera.startFollow.mockClear();

    // Despawn + linger + elapse - should use wormLerp.
    follower.update([]);
    fakeNow += lingerMs + 100;
    follower.update([]);
    expect(camera.startFollow).toHaveBeenCalledTimes(1);
    expect(camera.startFollow).toHaveBeenCalledWith(worm, true, wormLerp, wormLerp);
  });
});
