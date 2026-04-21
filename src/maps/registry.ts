import { caveGenerator } from "./generators/cave";
import { flatGenerator } from "./generators/flat";
import { hillsGenerator } from "./generators/hills";
import { islandGenerator } from "./generators/island";
import type { MapConfig, MapGenerator } from "./types";

type RegistryEntry = { config: MapConfig; generator: MapGenerator };

export const MAPS: Record<string, RegistryEntry> = {
  flat: {
    config: {
      id: "flat",
      name: "Open Field",
      description: "Wide flat terrain. Good for weapon testing.",
      maxWorms: 4,
      generator: { id: "flat", seed: 0 }, // 0 triggers Date.now() default
    },
    generator: flatGenerator,
  },
  hills: {
    config: {
      id: "hills",
      name: "Rolling Hills",
      description: "Sine-wave hills with a rocky ceiling for rope play.",
      maxWorms: 4,
      generator: { id: "hills", seed: 0 },
    },
    generator: hillsGenerator,
  },
  island: {
    config: {
      id: "island",
      name: "Island Arena",
      description: "Elevated platform with void on both sides. Tight engagement.",
      maxWorms: 4,
      spawnPoints: [
        { xPx: 384, yPx: 380 },
        { xPx: 896, yPx: 380 },
        { xPx: 512, yPx: 380 },
        { xPx: 768, yPx: 380 },
      ],
      generator: { id: "island", seed: 0 },
    },
    generator: islandGenerator,
  },
  cave: {
    config: {
      id: "cave",
      name: "Cave System",
      description: "Ceiling with stalactites + bumpy floor. Great for rope play.",
      maxWorms: 4,
      generator: { id: "cave", seed: 0 },
    },
    generator: caveGenerator,
  },
};

export function allIds(): string[] {
  return Object.keys(MAPS);
}

export function getById(id: string): RegistryEntry | null {
  return MAPS[id] ?? null;
}

export function firstId(): string {
  return allIds()[0] ?? "";
}

export function nextId(current: string): string {
  const ids = allIds();
  const i = ids.indexOf(current);
  return ids[(i + 1) % ids.length] ?? firstId();
}
