interface Tuning {
  world: { gravityY: number };
  weapons: { testCutRadiusPx: number };
  terrain: { rowHeight: number };
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
  };
}

export const tuning: Tuning = {
  world: { gravityY: 10 },
  weapons: { testCutRadiusPx: 40 },
  terrain: { rowHeight: 5 },
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
  },
};
