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
  rope.add(tuning.rope, "maxReachM", 5, 60, 1).name("Max reach (m)");
  rope.add(tuning.rope, "minLengthM", 0.2, 5, 0.1).name("Min length (m)");
  rope.add(tuning.rope, "adjustStepM", 0.1, 2, 0.05).name("Adjust step (m)");
  rope.add(tuning.rope, "adjustCooldownMs", 20, 500, 10).name("Adjust cooldown (ms)");
  rope.add(tuning.rope, "jointFreqHz", 1, 30, 0.5).name("Joint freq (Hz)");
  rope.add(tuning.rope, "dampingRatio", 0, 5, 0.05).name("Damping ratio");

  const jet = gui.addFolder("JetPack");
  jet.add(tuning.jetpack, "fuelCapacity", 10, 500, 10).name("Fuel capacity");
  jet.add(tuning.jetpack, "fuelPerSecond", 1, 100, 1).name("Fuel per second");
  jet.add(tuning.jetpack, "upwardForce", 0, 50, 0.5).name("Upward force");
  jet.add(tuning.jetpack, "sideForce", 0, 30, 0.5).name("Side force");

  // Note: touch tuning values are read at button construction time;
  // changing them via the panel won't resize/re-alpha existing buttons.
  const touch = gui.addFolder("Touch");
  touch.add(tuning.touch, "buttonRadiusPx", 10, 80, 1).name("Button radius (px)");
  touch.add(tuning.touch, "buttonIdleAlpha", 0, 1, 0.05).name("Idle alpha");
  touch.add(tuning.touch, "buttonPressedAlpha", 0, 1, 0.05).name("Pressed alpha");

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
