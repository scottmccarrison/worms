import { beforeEach, describe, expect, it } from "vitest";
import type { Team } from "../worm/Team";
import { WeaponManager } from "./WeaponManager";
import { defaultAmmoForMatch } from "./registry";

// Minimal Team stub
function makeTeam(id: string): Team {
  return {
    id,
    name: id,
    color: 0xff0000,
    worms: [],
    addWorm: () => {},
    isEliminated: () => false,
  } as unknown as Team;
}

describe("WeaponManager", () => {
  let manager: WeaponManager;
  const team = makeTeam("red");

  beforeEach(() => {
    manager = new WeaponManager(team, defaultAmmoForMatch());
  });

  it("fresh manager defaults to bazooka (key=1)", () => {
    expect(manager.getSelected().id).toBe("bazooka");
  });

  it("ammoFor returns -1 for infinite weapons", () => {
    expect(manager.ammoFor("bazooka")).toBe(-1);
    expect(manager.ammoFor("shotgun")).toBe(-1);
    expect(manager.ammoFor("handgrenade")).toBe(-1);
  });

  it("consumeOne leaves -1 as -1 for infinite weapons", () => {
    manager.consumeOne("bazooka");
    expect(manager.ammoFor("bazooka")).toBe(-1);
  });

  it("consumeOne decrements finite weapons", () => {
    // Manually create a manager with finite ammo
    const finiteManager = new WeaponManager(team, {
      bazooka: 3,
      shotgun: 2,
      handgrenade: 1,
    });
    finiteManager.consumeOne("bazooka");
    expect(finiteManager.ammoFor("bazooka")).toBe(2);
    finiteManager.consumeOne("bazooka");
    finiteManager.consumeOne("bazooka");
    expect(finiteManager.ammoFor("bazooka")).toBe(0);
    // Cannot go below 0
    finiteManager.consumeOne("bazooka");
    expect(finiteManager.ammoFor("bazooka")).toBe(0);
  });

  it("select succeeds when ammo > 0 or infinite", () => {
    const result = manager.select("shotgun");
    expect(result).toBe(true);
    expect(manager.getSelected().id).toBe("shotgun");
  });

  it("select fails when ammo is 0", () => {
    const zeroManager = new WeaponManager(team, { bazooka: -1, shotgun: 0, handgrenade: -1 });
    const result = zeroManager.select("shotgun");
    expect(result).toBe(false);
    expect(zeroManager.getSelected().id).toBe("bazooka");
  });

  it("resetActivation clears shotsFiredThisActivation", () => {
    manager.shotsFiredThisActivation = 5;
    manager.resetActivation();
    expect(manager.shotsFiredThisActivation).toBe(0);
  });

  it("selectByKey selects by numeric key", () => {
    const result = manager.selectByKey(3);
    expect(result).toBe(true);
    expect(manager.getSelected().id).toBe("handgrenade");
  });
});
