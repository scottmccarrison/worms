import * as dat from "dat.gui";
import { tuning } from "../tuning";

export function mountTuningPanel(onChange?: () => void): dat.GUI | null {
  if (!import.meta.env.DEV) return null;

  const gui = new dat.GUI({ width: 300, autoPlace: true });
  gui.close();

  const world = gui.addFolder("World");
  world
    .add(tuning.world, "gravityY", 0, 30, 0.1)
    .name("Gravity Y")
    .onChange(() => onChange?.());

  const weapons = gui.addFolder("Weapons");
  weapons.add(tuning.weapons, "testCutRadiusPx", 10, 150, 1).name("Cut radius (px)");

  window.addEventListener("keydown", (e) => {
    if (e.key === "`") {
      if (gui.closed) {
        gui.open();
      } else {
        gui.close();
      }
    }
  });

  return gui;
}
