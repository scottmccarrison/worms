interface Tuning {
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
  };
  touch: {
    buttonRadiusPx: number;
    buttonIdleAlpha: number;
    buttonPressedAlpha: number;
    /** Radius around the active worm (in pixels) where a pointerdown is
     * treated as aim-intent instead of walk-intent. */
    wormHitRadiusPx: number;
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
  wind: {
    forceNewtonsPerUnit: number;
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
    fuelCapacity: 100,
    fuelPerSecond: 30,
    upwardForce: 15,
    sideForce: 8,
  },
  touch: {
    buttonRadiusPx: 28,
    buttonIdleAlpha: 0.55,
    buttonPressedAlpha: 1.0,
    wormHitRadiusPx: 40,
    doubleTapMaxMs: 250,
    longPressMs: 400,
  },
  maps: {
    defaultId: "hills", // registry lookup; falls back to firstId() if invalid
  },
  wind: { forceNewtonsPerUnit: 2 },
};
