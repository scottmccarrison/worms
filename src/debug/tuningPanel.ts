import { tuning } from "../tuning";

/**
 * Mount a dat.gui overlay for live-tweaking `tuning` in dev builds.
 * Returns void; fire-and-forget.
 *
 * Implementation note: dat.gui is imported dynamically INSIDE the DEV check
 * so Vite tree-shakes it entirely out of production bundles. A top-level
 * static `import "dat.gui"` would drag the ~80KB lib into prod even with a
 * runtime no-op.
 */
export async function mountTuningPanel(onChange?: () => void): Promise<void> {
  if (!import.meta.env.DEV) return;

  const dat = await import("dat.gui");
  const gui = new dat.GUI({ width: 300, autoPlace: true });
  gui.close();

  const world = gui.addFolder("World");
  world
    .add(tuning.world, "gravityY", 0, 30, 0.1)
    .name("Gravity Y")
    .onChange(() => onChange?.());

  const weapons = gui.addFolder("Weapons");
  weapons.add(tuning.weapons, "testCutRadiusPx", 10, 150, 1).name("Cut radius (px)");

  const worm = gui.addFolder("Worm");
  worm.add(tuning.worm, "walkSpeedMps", 0.5, 10, 0.1).name("Walk speed (m/s)");
  worm.add(tuning.worm, "aimSpeedRadPerSec", 0.5, 8, 0.1).name("Aim speed (rad/s)");
  worm.add(tuning.worm, "linearDamping", 0, 2, 0.01).name("Linear damping");
  worm.add(tuning.worm, "fallDamageThresholdImpulse", 1, 30, 0.5).name("Fall dmg threshold");
  worm.add(tuning.worm, "fallDamageCapHp", 5, 100, 1).name("Fall dmg cap (HP)");

  const rope = gui.addFolder("Rope");
  rope.add(tuning.rope, "maxReachM", 5, 30, 0.5).name("Max reach (m)");
  rope.add(tuning.rope, "segmentLengthM", 0.2, 2, 0.05).name("Segment length (m)");
  rope.add(tuning.rope, "intermediateFreqHz", 1, 30, 0.5).name("Intermediate freq (Hz)");
  rope.add(tuning.rope, "finalJointFreqHz", 1, 30, 0.5).name("Final joint freq (Hz)");
  rope.add(tuning.rope, "dampingRatio", 0, 100, 1).name("Damping ratio");

  const jet = gui.addFolder("JetPack");
  jet.add(tuning.jetpack, "fuelCapacity", 10, 500, 10).name("Fuel capacity");
  jet.add(tuning.jetpack, "fuelPerFrame", 0.1, 5, 0.1).name("Fuel per frame");
  jet.add(tuning.jetpack, "upwardImpulse", 0.5, 10, 0.1).name("Upward impulse");
  jet.add(tuning.jetpack, "sideImpulse", 0.1, 5, 0.1).name("Side impulse");

  window.addEventListener("keydown", (e) => {
    if (e.key === "`") {
      if (gui.closed) {
        gui.open();
      } else {
        gui.close();
      }
    }
  });
}
