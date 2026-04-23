import { bridgesGenerator } from "./generators/bridges";
import { canyonBiomeGenerator } from "./generators/canyonBiome";
import { canyonLegacyGenerator } from "./generators/canyonLegacy";
import { caveGenerator } from "./generators/cave";
import { flatGenerator } from "./generators/flat";
import { hillsGenerator } from "./generators/hills";
import { islandGenerator } from "./generators/island";
import { plateauGenerator } from "./generators/plateau";
import { spireGenerator } from "./generators/spire";
import { terraworldGenerator } from "./generators/terraworld";
import type { MapConfig, MapGenerator } from "./types";

type RegistryEntry = { config: MapConfig; generator: MapGenerator };

// Keep in sync with MAP_WHITELIST in worker/src/room.ts
export const MAPS: Record<string, RegistryEntry> = {
  flat: {
    config: {
      id: "flat",
      name: "Open Field",
      description: "Wide flat terrain. Good for weapon testing.",
      maxWorms: 4,
      generator: { id: "flat", seed: 0 }, // 0 triggers Date.now() default
      visibleInLobby: false,
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
      visibleInLobby: false,
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
      visibleInLobby: false,
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
      visibleInLobby: false,
    },
    generator: caveGenerator,
  },
  bridges: {
    config: {
      id: "bridges",
      name: "Bridges",
      description: "Two plateaus connected by a narrow central bridge.",
      maxWorms: 4,
      generator: { id: "bridges", seed: 0 },
      visibleInLobby: false,
    },
    generator: bridgesGenerator,
  },
  spire: {
    config: {
      id: "spire",
      name: "Spire",
      description: "A tall central spire rising from a continuous floor.",
      maxWorms: 4,
      generator: { id: "spire", seed: 0 },
      visibleInLobby: false,
    },
    generator: spireGenerator,
  },
  canyon: {
    config: {
      id: "canyon",
      name: "Canyon",
      description: "Procedural canyon with randomized cliffs.",
      maxWorms: 4,
      generator: { id: "canyon", seed: 0 },
      visibleInLobby: false,
    },
    generator: canyonBiomeGenerator,
  },
  canyon_legacy: {
    config: {
      id: "canyon_legacy",
      name: "Canyon (legacy)",
      description: "Original handcrafted canyon. Kept for regression testing.",
      maxWorms: 4,
      generator: { id: "canyon_legacy", seed: 0 },
    },
    generator: canyonLegacyGenerator,
  },
  plateau: {
    config: {
      id: "plateau",
      name: "Plateau",
      description: "A raised central plateau with stepped slopes on each side.",
      maxWorms: 4,
      generator: { id: "plateau", seed: 0 },
      visibleInLobby: false,
    },
    generator: plateauGenerator,
  },
  terraworld: {
    config: {
      id: "terraworld",
      name: "Terraworld",
      description: "Procedural heightmap surface with grass, dirt, and stone strata.",
      maxWorms: 4,
      generator: { id: "terraworld", seed: 0 },
    },
    generator: terraworldGenerator,
  },
};

export function allIds(): string[] {
  return Object.keys(MAPS);
}

export function getById(id: string): RegistryEntry | null {
  // Use Object.hasOwn to avoid prototype-pollution: MAPS["constructor"] etc. would be
  // truthy via bracket access even though they are not registered map entries.
  return Object.hasOwn(MAPS, id) ? (MAPS[id] ?? null) : null;
}

export function firstId(): string {
  return allIds()[0] ?? "";
}

export function nextId(current: string): string {
  const ids = allIds();
  const i = ids.indexOf(current);
  return ids[(i + 1) % ids.length] ?? firstId();
}

/**
 * Map ids visible in the multiplayer lobby's map cycle. Excludes
 * entries where `config.visibleInLobby === false`. Undefined treated
 * as visible so new maps default to showing in the picker.
 */
export function lobbyIds(): string[] {
  return allIds().filter((id) => MAPS[id]?.config.visibleInLobby !== false);
}
