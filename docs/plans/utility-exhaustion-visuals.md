# Plan: utility exhaustion visuals (jetpack fuel + drill once-per-turn)

## Scope

Add clear visual feedback when a utility is exhausted so the player knows when they cannot use it again until the next turn.

- **Jetpack**: drains fuel while active. Once empty, button shows exhausted state for the rest of the turn. Fuel refills to full at turn start.
- **Drill**: once per turn. After firing, button shows exhausted state for the rest of the turn. Resets at turn start.
- **Rope**: no exhaustion (always available).

Rationale: 45 second turns, deliberate. Worms use utilities to position, shoot, end. No mid-turn regen so timing matters.

## Decisions (from chat)

- Drill cap: 1 use per turn.
- Jetpack: fuel resets to full at the start of each turn.
- Visual style: dim alpha + grayscale tint when exhausted. Jetpack also gets a thin fuel bar at the bottom of the button while fuel is partial.

## Behavior

| Utility | Available state | Active state | Exhausted state | Reset |
|---------|-----------------|--------------|-----------------|-------|
| Rope (R) | normal alpha 0.7 | pressed alpha 1.0 | n/a | n/a |
| Jet (J) | normal alpha 0.7 + fuel bar showing remaining | pressed alpha 1.0 + bar drains | dim alpha 0.25 + gray + bar empty | fuel = capacity at turn start |
| Drill (D) | normal alpha 0.7 | pressed alpha 1.0 (armed) | dim alpha 0.25 + gray | usesThisTurn = 0 at turn start |

A utility in exhausted state cannot be activated. Tap is a no-op.

## File changes

### Tuning

`src/tuning.ts`: add `usesPerTurn` to drill block.

```ts
drill: {
  lengthPx: 120,
  widthPx: 24,
  cooldownMs: 800,
  usesPerTurn: 1,
},
```

Add to the touch block (alongside `buttonIdleAlpha`, `buttonPressedAlpha`):

```ts
buttonExhaustedAlpha: 0.25,
```

### JetPack

`src/utilities/JetPack.ts`:

- Add `resetForNewTurn()` method: `this._fuel = tuning.jetpack.fuelCapacity;` and deactivate if active.
- Add `getFuelPercent(): number` getter returning `this._fuel / tuning.jetpack.fuelCapacity` (0..1).
- Update the comment in `deactivate` (currently says "Epic 5 will reset on turn cycle") to reflect that reset is now wired.

### Drill

`src/utilities/Drill.ts`:

- Add `private usesThisTurn = 0` field.
- Add `hasUsesRemaining(maxUses: number): boolean` method: `return this.usesThisTurn < maxUses;`.
- In `fire()`, increment `this.usesThisTurn++` after the callback fires.
- In `resetForNewTurn()`: also reset `this.usesThisTurn = 0`. (Keep `lastFiredAtMs` reset behavior unchanged.)

`src/utilities/Drill.test.ts`: add tests for usesThisTurn increment, hasUsesRemaining gate, reset clears it.

### OfflineSimAdapter turn-start hook

`src/sim/OfflineSimAdapter.ts` (around line 169-178, the existing `onTurnStart`):

```ts
onTurnStart: (team, worm) => {
  this.setInputAllowed(true);
  this.getWeaponManager(team)?.resetActivation();
  worm.drillUtility?.resetForNewTurn();
  worm.jetPackUtility?.resetForNewTurn();  // NEW
  // ...
},
```

### Drill fire path (GameScene)

`src/scenes/GameScene.ts`: in both drill fire branches (touch pointerup ~line 1202, F-key ~line 350), gate on `hasUsesRemaining(tuning.drill.usesPerTurn)` instead of (or in addition to) `isOnCooldown`.

```ts
if (activeWorm?.drillUtility?.isArmed()) {
  if (!activeWorm.drillUtility.hasUsesRemaining(tuning.drill.usesPerTurn)) {
    // Already used this turn - just disarm, no fire
    activeWorm.drillUtility.disarm();
    return;
  }
  // existing fire logic
}
```

The 800ms cooldown stays as defense-in-depth but with cap=1 it never matters.

### TouchControls per-frame refresh

`src/ui/TouchControls.ts`:

Add `update()` method called from `GameScene.update()`. Inspect the active worm and refresh button visuals:

```ts
update(): void {
  const w = this.getActiveWorm();
  if (!w) return;
  this._refreshJetButton(w);
  this._refreshDrillButton(w);
}
```

For jet button:

- Read `w.jetPackUtility.getFuelPercent()` (0..1).
- If active: pressed alpha (1.0) + fuel bar showing remaining.
- Else if fuel = 0: dim alpha (`buttonExhaustedAlpha`) + grayscale tint.
- Else: idle alpha (0.7) + fuel bar showing remaining.
- Draw fuel bar as a small rect at the bottom edge of the button (length = button diameter, height ~3px). Color green > 50%, yellow 20-50%, red < 20%.

For drill button:

- If `!w.drillUtility.hasUsesRemaining(tuning.drill.usesPerTurn)`: dim alpha + grayscale tint.
- Else if armed: pressed alpha.
- Else: idle alpha.

Implementation note: the button is a Phaser Container with a `Graphics` child. To gray it out, set the container's tint via `setTint(0x666666)` and clear with `clearTint()`. The fuel bar can be a separate `Graphics` child added to the jet button container, redrawn each `update()`.

Store refs to the inner gfx + (new) fuel bar gfx on the button container so `update()` can mutate them efficiently.

### GameScene.update() wiring

`src/scenes/GameScene.ts` in `update()`: call `this.touchControls?.update();` once per frame. Existing update body should already have similar refreshes (e.g. `refreshUtilityDPad`).

### Tap gating on exhausted state

In TouchControls' button `pointerdown` handlers:

- Jet handler: check `w.jetPackUtility.getFuel() > 0` before activating. Already implicit via `JetPack.activate()` early-return on `_fuel <= 0`, but visual feedback should match: when exhausted, tap does nothing visible (no "pressed" flash).
- Drill handler: check `hasUsesRemaining(tuning.drill.usesPerTurn)` before arming. If not, no-op (don't toggle).

### Tests

| File | Action |
|------|--------|
| `src/utilities/Drill.test.ts` | Add: usesThisTurn increments on fire, hasUsesRemaining gates correctly, resetForNewTurn clears |
| `src/utilities/JetPack.test.ts` (new or extend) | resetForNewTurn restores fuel to capacity |

Manual smoke test (Chrome DevTools mobile viewport):

1. Tap J. Worm rises while fuel drains. Bar shrinks. Eventually bar is empty, button gray.
2. Tap J again - no effect (exhausted).
3. Click End. Next turn for the same team's other worm: J button is full again.
4. Tap D. Aim and release. Drill fires. Button turns gray.
5. Tap D again - no effect.
6. End turn, next turn: D button is back to green.

## /bugcheck before PR

Lenses:

- State/UI: button visuals match utility state across turn rotations
- Edge cases: jet exhausted mid-thrust, drill armed but exhausted at fire time, what if user fires drill via F-key while button shows exhausted (gating must apply both paths)
- API contracts: `getFuelPercent` and `hasUsesRemaining` are pure read-only methods; safe in networked-mode facade (return safe defaults)

## Networked mode

Networked drill is offline-only per #200. The wormFacade in `GameScene.ts` (~line 1292) needs `hasUsesRemaining: () => true` to avoid breaking the button gate. Same for jet's `getFuelPercent`: facade returns 1.0 (button always shows full).

## PR checklist

- [ ] Plan committed (this file)
- [ ] JetPack.resetForNewTurn() + getFuelPercent()
- [ ] Drill usesThisTurn + hasUsesRemaining()
- [ ] OfflineSimAdapter calls both at turn start
- [ ] TouchControls.update() refreshes jet/drill visuals
- [ ] GameScene.update() calls touchControls.update()
- [ ] Drill fire paths gate on hasUsesRemaining
- [ ] Tuning has drill.usesPerTurn + touch.buttonExhaustedAlpha
- [ ] Tests pass (typecheck + lint + vitest)
- [ ] Manual mobile smoke
- [ ] PR labeled `needs-review`
