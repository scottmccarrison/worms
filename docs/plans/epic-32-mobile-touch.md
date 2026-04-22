# Epic 32 - Mobile touch controls (ski-style half-screen walk)

Closes #32. Replaces the near-empty current touch overlay (just rope + jetpack buttons, both broken in networked mode per #65) with a zero-chrome gesture-driven control scheme. Primary movement uses half-screen tap-hold; aim is gesture-based from the worm; only utility controls use persistent buttons.

## Scope

### In scope
- Tap-hold on screen halves (not on worm, not on a button) walks left / right continuously.
- Double-tap (on walk side) jumps.
- Long-press (400ms threshold, on walk side) backflips.
- Drag from worm (within 40px radius) = existing aim-and-fire, unchanged behavior.
- Rope + jetpack buttons persistent but small + top-right corner. Hidden entirely in networked mode (no-op per #65; hide instead of show).
- D-pad (left / right thrust buttons) shows only when rope OR jetpack is active, overlays bottom-center-ish. Replaces half-screen tap while active since tap-walk doesn't make sense when swinging / flying.
- Subtle halo around the active worm during your turn - tells the user "touch here to aim".
- Spectators (not your turn) get none of the above - all touches no-op.
- Networked mode: same gestures, route through SimAdapter (already routes to server).
- Offline mode: same gestures, route through SimAdapter (drives local planck as before).

### Out of scope (tracked)
- Weapon radial wheel - wait until we have >3 weapons (currently 3). Current bottom drawer stays.
- Haptic feedback - nice polish, file follow-up if Scott wants it.
- Visual affordances for swipe-up hint / "tap here to jump" hint - ship minimal, iterate.
- Tutorial overlay - user learns by playing.

## Gesture spec

Source of truth lives in `src/input/touchGestures.ts` (new).

```
Touch down:
  if (pointer on active worm AND my turn): AIM_MODE
  elif (my turn AND active worm AND rope/jetpack NOT active):
    WALK_MODE(side = (x < screenW/2 ? "left" : "right"))
    Start watching for: double-tap (<250ms interval), long-press (>=400ms).
  else: IGNORED (spectator / utility active / no turn)

While touching (pointermove):
  AIM_MODE: existing drag-to-aim math (unchanged).
  WALK_MODE: while held, sim.walk(side). Continue until release or gesture upgrade.

Touch release (pointerup):
  AIM_MODE: existing fire-on-release logic.
  WALK_MODE:
    if gesture was long-press: sim.backflip(); sim.walk(0)
    elif was second of a double-tap within 250ms: sim.jump(); sim.walk(0)
    else: sim.walk(0)  // stop walking
```

Thresholds (in `tuning.ts`):
- `tuning.touch.wormHitRadiusPx: 40` - "on worm" hit test.
- `tuning.touch.doubleTapMaxMs: 250`.
- `tuning.touch.longPressMs: 400`.

## Files changed

### `src/input/touchGestures.ts` - NEW
Pure gesture state machine. No Phaser deps. Unit-testable.

```ts
export type GestureOutcome =
  | { kind: "walk"; dir: -1 | 1 }
  | { kind: "walk_release" }
  | { kind: "jump" }
  | { kind: "backflip" }
  | { kind: "aim_start"; xPx: number; yPx: number }
  | { kind: "aim_move"; xPx: number; yPx: number }
  | { kind: "aim_end" }
  | { kind: "ignored" };

export interface GestureInput {
  downXPx: number;
  downYPx: number;
  nowMs: number;
  screenWidth: number;
  wormXPx: number | null;
  wormYPx: number | null;
  myTurn: boolean;
  utilityActive: boolean;  // rope or jetpack engaged
  wormHitRadiusPx: number;
}

// processDown / processMove / processUp return GestureOutcome[] arrays so
// callers can dispatch to sim.walk, sim.jump, etc in order.
```

### `src/scenes/GameScene.ts` - MODIFIED
Current pointer handling does drag-to-aim + fire. Add:
- Track per-pointer gesture state.
- On pointerdown: call `processDown`, dispatch outcomes to `this.sim.walk/jump/backflip` or start aim.
- On pointermove: if AIM_MODE, existing aim logic; else ignore.
- On pointerup: close gesture, dispatch walk_release / jump / backflip.
- Worm halo: during my turn, draw a 40px low-alpha ring around the active worm. Reuse the existing yellow-active-worm highlight (already there at full turn); just ensure its radius matches the hit radius.

### `src/ui/TouchControls.ts` - MODIFIED
Two phases:
1. In networked mode: hide rope + jetpack buttons entirely (they're no-ops per #65).
2. In offline mode: shrink rope + jetpack buttons, move to top-right corner (out of the walk/aim area). Activation toggles still work.
3. NEW: when a utility (rope or jet) is active, mount a `UtilityDPad` overlay (4 arrows or 2: left + right + up-thrust). Existing `jetPackUtility.setHorizontalInput(hDir)` / `setVerticalInput(up)` + ropeUtility length adjust wired through.

Practically: a new `private utilityDPad: UtilityDPad | null = null` field, created on rope/jetpack activate, destroyed on deactivate.

### `src/ui/UtilityDPad.ts` - NEW
Four buttons: `◄ ►` always visible + `▲` (up thrust for jetpack, retract rope) + `▼` (extend rope, only for rope). Semi-transparent, bottom-center, auto-hides when utility deactivates.

Inputs route to the same adapter methods that R/J keyboard used to drive.

### `src/tuning.ts` - MODIFIED
Add `touch.wormHitRadiusPx`, `touch.doubleTapMaxMs`, `touch.longPressMs`. Update `tuning` interface type.

### Tests
- `src/input/touchGestures.test.ts` - NEW. Pure unit tests for the state machine. Covers:
  - Tap-hold left side -> walk_left + walk_release.
  - Tap-hold right side -> walk_right + walk_release.
  - Tap on worm -> aim_start + aim_end (no walk).
  - Double-tap left -> jump (no walk_release burst).
  - Long-press -> backflip.
  - Spectator mode (not my turn) -> ignored.
  - Utility active -> ignored (d-pad takes over).

## Workstream

Single branch, single PR, no parallelism needed. Estimate ~1 hour.

**Branch**: `feature/epic-32-mobile-touch`.

Commits:
1. `feat(input): touchGestures state machine + unit tests`
2. `feat(tuning): mobile touch thresholds`
3. `feat(scene): wire GameScene pointer events to gesture state`
4. `feat(ui): UtilityDPad overlay for rope + jetpack`
5. `chore(ui): hide rope/jetpack buttons in networked mode`
6. `docs(touch): README note on mobile controls`

Every commit footer:
```
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

## Acceptance

- `npm run typecheck`, `npm test`, `npm run lint`, `npm run build` all green.
- Manual check on desktop via DevTools touch emulation: tap half-screen walks, double-tap jumps, drag from worm fires.
- Mobile playtest after deploy: actually move a worm for the first time on mobile.

## Risk notes

- **Multi-touch race**: thumb on left walking + other finger on worm aiming. Current spec handles this: different pointer ids, different gesture states. TouchControls / pointer events already track per-pointer id.
- **Tap-through on the weapon drawer**: drawer buttons already consume their pointerdowns (existing behavior); as long as we check `button hit?` before running gesture logic, we're fine.
- **False positives from accidental touches**: small dead-zone on every touch (e.g. 5px movement before committing to walk/aim) so a slight finger slip doesn't walk + flicker.

## Follow-ups not in this PR
- Haptic feedback on walk start / jump / fire.
- Weapon radial (#TBD when >3 weapons).
- Onboarding tutorial overlay.
- Dynamic d-pad position based on left/right-handedness (saved preference).
