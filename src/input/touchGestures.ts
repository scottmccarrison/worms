/**
 * Epic 32 - Touch gesture state machine.
 *
 * Pure logic. No Phaser deps. Consumes pointerdown / pointermove / pointerup
 * events and emits an ordered list of high-level GestureOutcome objects that
 * the caller dispatches to a SimAdapter (walk, jump, backflip) or to the
 * aim subsystem.
 *
 * Decisions live here, not in the scene:
 *  - Did this touch land on the worm? -> AIM mode.
 *  - Did it land elsewhere on my turn? -> WALK mode with a left/right side.
 *  - Did the user double-tap the same side? -> JUMP instead of walk-release.
 *  - Did the user hold past longPressMs without dragging? -> BACKFLIP.
 *  - Spectator / utility active -> IGNORED.
 *
 * The tracker is long-lived: double-tap detection needs to remember the
 * last walk release across a whole gesture. Construct one per scene via
 * `createGestureTracker()`.
 */

/**
 * High-level gestural output. Emitted in order from processDown / processUp;
 * the scene dispatches each outcome to the right sim / aim method.
 */
export type GestureOutcome =
  | { kind: "walk"; dir: -1 | 1 }
  | { kind: "walk_release" }
  | { kind: "jump" }
  | { kind: "backflip" }
  | { kind: "aim_start"; xPx: number; yPx: number }
  | { kind: "aim_move"; xPx: number; yPx: number }
  | { kind: "aim_end" }
  | { kind: "ignored" };

/**
 * Input struct for processDown. The caller supplies the raw pointer-down
 * coordinates plus the context the state machine needs to decide what
 * mode to enter. Time is injected so tests can control it.
 */
export interface GestureInput {
  downXPx: number;
  downYPx: number;
  nowMs: number;
  screenWidth: number;
  wormXPx: number | null;
  wormYPx: number | null;
  myTurn: boolean;
  utilityActive: boolean;
  wormHitRadiusPx: number;
  jetpackRadialDeadZonePx: number;
  doubleTapMaxMs: number;
  longPressMs: number;
}

/** Internal gesture modes. Mirrors the plan: idle / aim / walk. */
type Mode = "idle" | "aim" | "walk";

/**
 * Factory for a fresh tracker. Holds state across gestures (for double-tap
 * detection). One tracker per scene; destroy it on scene shutdown via GC.
 */
export function createGestureTracker(): {
  processDown(input: GestureInput): GestureOutcome[];
  processMove(xPx: number, yPx: number): GestureOutcome[];
  processUp(nowMs: number): GestureOutcome[];
} {
  let mode: Mode = "idle";
  let walkSide: -1 | 1 | 0 = 0;
  // Tracked across gestures for double-tap detection.
  let lastWalkReleaseAtMs = Number.NEGATIVE_INFINITY;
  let lastWalkReleaseSide: -1 | 1 | 0 = 0;
  // Set on processDown when this gesture is the 2nd half of a double-tap so
  // processUp knows to emit "jump" instead of "walk_release".
  let pendingDoubleTap = false;

  return {
    processDown(input: GestureInput): GestureOutcome[] {
      // If we're already mid-gesture (shouldn't happen with per-pointer-id
      // tracking at the caller, but defensive), do nothing.
      if (mode !== "idle") return [{ kind: "ignored" }];

      // Spectator / utility active / no worm -> ignored. The scene sees this
      // and doesn't set its activeGesture field, so subsequent move/up are
      // also dropped at the caller.
      if (!input.myTurn || input.wormXPx === null || input.wormYPx === null) {
        return [{ kind: "ignored" }];
      }

      // Worm hit test: on-worm touch enters AIM mode even if a utility is
      // active (so the user can re-aim while roped, matching keyboard).
      const dxW = input.downXPx - input.wormXPx;
      const dyW = input.downYPx - input.wormYPx;
      const distSq = dxW * dxW + dyW * dyW;
      const radiusSq = input.wormHitRadiusPx * input.wormHitRadiusPx;
      if (distSq <= radiusSq) {
        mode = "aim";
        return [{ kind: "aim_start", xPx: input.downXPx, yPx: input.downYPx }];
      }

      // Utility active + not on worm: jetpack is now handled by the J-button
      // virtual joystick in TouchControls. Off-worm taps while utility is
      // active fall through to walk mode so the player can still reposition.
      // utilityActive field is kept on GestureInput for compatibility (no behavior tied to it here).

      // Off-worm, my turn -> WALK mode.
      // Walk direction is relative to the active worm's position: tap left of
      // the worm walks left, tap right walks right. This reads as intuitive
      // no matter where the worm is on the map (if the worm is far-right and
      // you tap the left side of the screen, you meant "walk left toward me").
      const side: -1 | 1 = input.downXPx < input.wormXPx ? -1 : 1;
      walkSide = side;
      mode = "walk";

      // Double-tap check: was the previous walk release recent and on the
      // same side? If so, this gesture's release should become a JUMP.
      const sinceLast = input.nowMs - lastWalkReleaseAtMs;
      pendingDoubleTap = sinceLast <= input.doubleTapMaxMs && lastWalkReleaseSide === side;

      return [{ kind: "walk", dir: side }];
    },

    processMove(xPx: number, yPx: number): GestureOutcome[] {
      if (mode === "aim") {
        return [{ kind: "aim_move", xPx, yPx }];
      }
      // WALK mode ignores movement: the walk continues held until release.
      // IDLE mode shouldn't receive moves (caller gates on activeGesture).
      void xPx;
      void yPx;
      return [];
    },

    processUp(nowMs: number): GestureOutcome[] {
      const currentMode = mode;
      const side = walkSide;
      const wasDoubleTap = pendingDoubleTap;

      // Reset local state before returning (next gesture starts clean).
      mode = "idle";
      walkSide = 0;
      pendingDoubleTap = false;

      if (currentMode === "aim") {
        return [{ kind: "aim_end" }];
      }

      if (currentMode === "walk" && (side === -1 || side === 1)) {
        if (wasDoubleTap) {
          // Consume the double-tap: reset timestamps so a triple-tap
          // doesn't also fire.
          lastWalkReleaseAtMs = Number.NEGATIVE_INFINITY;
          lastWalkReleaseSide = 0;
          return [{ kind: "walk_release" }, { kind: "jump" }];
        }
        // Plain walk release. Record timestamp + side so the NEXT gesture
        // can detect a double-tap. Backflip intentionally has no touch
        // gesture (tracked in #75); keyboard Backspace still works.
        lastWalkReleaseAtMs = nowMs;
        lastWalkReleaseSide = side;
        return [{ kind: "walk_release" }];
      }

      // IDLE up (e.g. after an ignored down) - nothing to emit.
      return [];
    },
  };
}
