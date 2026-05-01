export interface Tuning {
  world: { gravityY: number };
  retreat: {
    windowMs: number;
  };
  water: {
    suddenDeathTurn: number;
    risePxPerTurn: number;
  };
  weapons: {
    testCutRadiusPx: number;
    dragMaxLengthPx: number;
    dragDeadZonePx: number;
    powerStepPerPress: number;
    ammo: { bazooka: number; shotgun: number; handgrenade: number };
  };
  terrain: { rowHeight: number };
  turn: {
    durationMs: number;
    warnThresholdMs: number;
    settleVelThresholdMps: number;
    settleHoldMs: number;
    maxSettleMs: number;
  };
  worm: {
    radiusPx: number;
    density: number;
    walkSpeedMps: number;
    aimSpeedRadPerSec: number;
    maxHealth: number;
    linearDamping: number;
    fallDamageThresholdImpulse: number;
    fallDamageCapHp: number;
  };
  team: {
    wormsPerTeam: number;
  };
  input: {
    aimCoalesceFrames: number;
  };
  rope: {
    /** Max raycast reach for rope fire (meters). */
    maxReachM: number;
    /** Minimum rope length (prevents retract-to-zero). */
    minLengthM: number;
    /** Rate of length change while extend/retract key held (meters/second). Continuous. */
    adjustRateMps: number;
    /** DistanceJoint frequency (Hz). Higher = stiffer / snappier swing. */
    jointFreqHz: number;
    /** DistanceJoint damping ratio. 0 = bouncy, 1 = critically damped. */
    dampingRatio: number;
    /** Multiplier applied to actual worm-anchor distance for initial joint length.
     * < 1 pulls worm toward anchor on fire (lifts off ground, starts swing). */
    initialLengthScale: number;
    /** Impulse applied toward anchor at fire (body-mass units, planck applyLinearImpulse). */
    fireImpulseMag: number;
  };
  jetpack: {
    fuelCapacity: number;
    fuelPerSecond: number;
    upwardForce: number;
    sideForce: number;
    joystickDeadZonePx: number;
    joystickMaxSlidePx: number;
  };
  drill: {
    /** Length of the drill rect cut, pixels. */
    lengthPx: number;
    /** Width of the drill rect cut perpendicular to aim, pixels. */
    widthPx: number;
    /** Cooldown between drill fires, ms. */
    cooldownMs: number;
    /** Max drill fires per turn. Once exhausted, button shows exhausted state. */
    usesPerTurn: number;
  };
  touch: {
    buttonRadiusPx: number;
    buttonIdleAlpha: number;
    buttonPressedAlpha: number;
    /** Alpha for buttons whose utility is exhausted (jet fuel = 0, drill used). */
    buttonExhaustedAlpha: number;
    /** Radius around the active worm (in pixels) where a pointerdown is
     * treated as aim-intent instead of walk-intent. */
    wormHitRadiusPx: number;
    /** Min distance from the click point to the worm (in pixels) required
     * for a utility-active off-worm drag to register as a jetpack thrust.
     * Must be > wormHitRadiusPx (40) so the on-worm zone resolves to AIM,
     * not thrust. */
    jetpackRadialDeadZonePx: number;
    /** Max ms between two walk-side taps for the second to count as a
     * double-tap (-> jump). */
    doubleTapMaxMs: number;
    /** Min ms a walk touch must be held (without drag) to count as a
     * long-press (-> backflip). */
    longPressMs: number;
  };
  maps: {
    /** Default map id used on first load. Must be a valid registry key. */
    defaultId: string;
  };
  caves: {
    /** Cell size in pixels; larger = broader chambers, cheaper CA. */
    cellSizePx: number;
    /** Initial probability a cell is solid before smoothing. 0.45 gives balanced cave density. */
    initialFillRatio: number;
    /** Cellular automata smoothing passes. 4 is the classic Terraria-style value. */
    iterations: number;
    /** Pixels of solid crust preserved below each column's surface. Prevents skylights. */
    surfaceBufferPx: number;
  };
  wind: {
    forceNewtonsPerUnit: number;
  };
  worldgen: {
    /** Surface heightmap baseline as fraction of world height. Matches existing terraworld baseY = height * 0.55. */
    surfaceBaselineFrac: number;
    heightmap: {
      /** Octave 1 (base): broad rolling-hills stride in pixels. Matches existing terraworld baseStride = 256. */
      baseStride: number;
      /** Octave 1 amplitude as fraction of world height. Matches existing baseAmp = height * 0.08. */
      baseAmpFrac: number;
      /** Octave 2 (detail): fine-noise stride. Matches existing detailStride = 96. */
      detailStride: number;
      /** Octave 2 amplitude as fraction of world height. Matches existing detailAmp = height * 0.02. */
      detailAmpFrac: number;
      /** Octave 3 (mountains): low-frequency peak stride. New for v1; gated by theme.flags.wantsPeaks. */
      mountainStride: number;
      /** Octave 3 amplitude as fraction of world height. */
      mountainAmpFrac: number;
      /** Smoothstep range over which the mountain octave's contribution ramps from 0 to full. Tuple [lo, hi] in [0, 1]. */
      mountainSmoothstepLo: number;
      mountainSmoothstepHi: number;
    };
    materialBands: {
      /** Pixels of dirt material below the surface crust before transitioning to rock. */
      dirtDepthPx: number;
      /** Pixels of rock below the dirt band before transitioning to stone. Beyond this is stone. */
      rockDepthPx: number;
    };
    crust: {
      /** Pixels of theme-specific surface crust material (snow, grass, sand, etc.) overwriting the top of the dirt band. */
      depthPx: number;
    };
    materialHardness: {
      /** Minimum cut radius (pixels) at or above which ROCK pixels can be removed. Below this, ROCK survives the cut. */
      rockMinRadiusPx: number;
      /** Minimum cut radius (pixels) at or above which STONE pixels can be removed. Below this, STONE survives the cut. */
      stoneMinRadiusPx: number;
    };
    hygiene: {
      /** Minimum mask-island size in pixels. Components smaller than this are
       *  removed as orphan debris by FinalizeMask. Default 1024 is approximately
       *  1.8 CA cells at default cellSizePx=24, calibrated to remove single-cell
       *  orphans while preserving 2+ cell features. Adjust if cellSizePx changes. */
      thresholdPx: number;
    };
    spawn: {
      /** Minimum spacing between spawn candidates in pixels. */
      densityPx: number;
      /** Minimum spawns per team. Below this, ValidateSpawnCoherence logs a warning. */
      minPerTeam: number;
    };
    caveAmbient: {
      /** Attempts = widthPx * heightPx * attemptFactor. Each attempt picks a
       *  random (x, y) and validates; invalid attempts no-op. Matches Terraria's
       *  attempt-count density convention. */
      attemptFactor: number;
    };
    surfaceDressing: {
      /** Average horizontal spacing between surface dressing attempts, in pixels.
       *  Attempts = floor(widthPx / spacingPx); each attempt picks a random column. */
      spacingPx: number;
    };
  };
  camera: {
    turnZoomOutMs: number;
    turnHoldMinMs: number;
    turnHoldMaxMs: number;
    turnZoomInMs: number;
    networkStabilityFrames: number;
    wormLerp: number;
    projectileLerp: number;
    postImpactLingerMs: number;
  };
  juice: {
    shakeMaxIntensity: number; // accessibility cap; bigger explosions clamp here
    shakeMinRadiusPx: number; // below this radius, no shake
    flashMaxAlpha: number;
  };
}

export const tuning: Tuning = {
  world: { gravityY: 10 },
  retreat: { windowMs: 5000 },
  water: { suddenDeathTurn: 15, risePxPerTurn: 50 },
  weapons: {
    testCutRadiusPx: 40,
    dragMaxLengthPx: 140,
    dragDeadZonePx: 8,
    powerStepPerPress: 0.05,
    ammo: { bazooka: -1, shotgun: -1, handgrenade: -1 },
  },
  terrain: { rowHeight: 5 },
  turn: {
    durationMs: 45000,
    warnThresholdMs: 5000,
    settleVelThresholdMps: 0.15,
    settleHoldMs: 500,
    maxSettleMs: 5000,
  },
  worm: {
    radiusPx: 12,
    density: 1.0,
    walkSpeedMps: 2.5,
    aimSpeedRadPerSec: 2.0,
    maxHealth: 100,
    linearDamping: 0.1,
    fallDamageThresholdImpulse: 8,
    fallDamageCapHp: 25,
  },
  team: { wormsPerTeam: 2 },
  input: { aimCoalesceFrames: 1 },
  rope: {
    maxReachM: 40,
    minLengthM: 0.8,
    adjustRateMps: 5,
    jointFreqHz: 15,
    dampingRatio: 0.4,
    initialLengthScale: 0.9,
    fireImpulseMag: 3,
  },
  jetpack: {
    fuelCapacity: 60,
    fuelPerSecond: 30,
    upwardForce: 17,
    sideForce: 10,
    joystickDeadZonePx: 14,
    joystickMaxSlidePx: 160,
  },
  drill: {
    lengthPx: 220,
    widthPx: 48,
    cooldownMs: 800,
    usesPerTurn: 1,
  },
  touch: {
    buttonRadiusPx: 28,
    buttonIdleAlpha: 0.55,
    buttonPressedAlpha: 1.0,
    buttonExhaustedAlpha: 0.2,
    wormHitRadiusPx: 40,
    jetpackRadialDeadZonePx: 50,
    doubleTapMaxMs: 250,
    longPressMs: 400,
  },
  maps: {
    defaultId: "terraworld_v1", // registry lookup; falls back to firstId() if invalid
  },
  caves: {
    // 24 gives 2560x1024 a ~107x43 grid. Each cell is ~1 worm tall, so
    // a single void cell is a small pocket; groups of adjacent cells
    // form real chambers. Smaller values (8-16) read as pixel-dust.
    cellSizePx: 36,
    // 0.50 is the edge between "stable mostly-solid" and "collapse
    // toward void" under B5/S4. Biasing very slightly toward void
    // lets chambers coalesce while keeping the subsurface mostly
    // stone. Stabilizes around 50-55% solid cells after 4 iters.
    initialFillRatio: 0.5,
    iterations: 4,
    surfaceBufferPx: 80,
  },
  // Mirror of worker/src/sim/simulation.ts WIND_FORCE - keep in sync.
  wind: { forceNewtonsPerUnit: 0.8 },
  worldgen: {
    surfaceBaselineFrac: 0.55,
    heightmap: {
      baseStride: 256,
      baseAmpFrac: 0.08,
      detailStride: 96,
      detailAmpFrac: 0.02,
      mountainStride: 512,
      mountainAmpFrac: 0.3,
      mountainSmoothstepLo: 0.3,
      mountainSmoothstepHi: 0.7,
    },
    materialBands: {
      dirtDepthPx: 6,
      rockDepthPx: 60,
    },
    crust: {
      depthPx: 3,
    },
    materialHardness: {
      rockMinRadiusPx: 30,
      stoneMinRadiusPx: 60,
    },
    hygiene: {
      thresholdPx: 1024,
    },
    spawn: {
      densityPx: 200,
      minPerTeam: 2,
    },
    caveAmbient: {
      attemptFactor: 0.00015,
    },
    surfaceDressing: {
      spacingPx: 40,
    },
  },
  camera: {
    turnZoomOutMs: 800,
    turnHoldMinMs: 700,
    turnHoldMaxMs: 3000,
    turnZoomInMs: 500,
    networkStabilityFrames: 3,
    wormLerp: 0.08,
    projectileLerp: 0.05,
    postImpactLingerMs: 1200,
  },
  juice: {
    shakeMaxIntensity: 0.012, // accessibility cap; bigger explosions clamp here
    shakeMinRadiusPx: 15, // below this radius, no shake
    flashMaxAlpha: 0.2,
  },
};
