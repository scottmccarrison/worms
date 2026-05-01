import { beforeEach, describe, expect, it } from "vitest";
import type { Team } from "../worm/Team";
import { WeaponManager } from "./WeaponManager";
import { allWeapons, defaultAmmoForMatch } from "./registry";

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
    // shotgun/handgrenade are unregistered (simplify-combat); ammoFor returns 0 for unknown ids
    expect(manager.ammoFor("shotgun")).toBe(0);
    expect(manager.ammoFor("handgrenade")).toBe(0);
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
    // Only bazooka is registered after simplify-combat; selection stays on bazooka
    const result = manager.select("bazooka");
    expect(result).toBe(true);
    expect(manager.getSelected().id).toBe("bazooka");
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

  it("selectByKey selects by numeric key (bazooka is key=1, others unregistered)", () => {
    const result = manager.selectByKey(1);
    expect(result).toBe(true);
    expect(manager.getSelected().id).toBe("bazooka");
    // Key 3 (handgrenade) is unregistered; selectByKey returns false
    const missingResult = manager.selectByKey(3);
    expect(missingResult).toBe(false);
  });
});

describe("weapon registry", () => {
  it("has exactly 1 weapon registered (simplify-combat: bazooka only)", () => {
    expect(allWeapons().length).toBe(1);
  });

  it("all selectKeys are unique", () => {
    const keys = allWeapons().map((w) => w.selectKey);
    const unique = new Set(keys);
    expect(unique.size).toBe(keys.length);
  });

  it("only bazooka (key=1) is registered", () => {
    const keys = allWeapons()
      .map((w) => w.selectKey)
      .sort((a, b) => a - b);
    expect(keys).toEqual([1]);
  });

  it("all weapon ids are unique", () => {
    const ids = allWeapons().map((w) => w.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });
});
