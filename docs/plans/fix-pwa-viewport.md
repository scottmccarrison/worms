# Fix: PWA viewport blown up on iOS (showstopper for playtesting)

**Status:** Draft. Awaiting user approval.

## Problem

After today's deploy (PR #174 + #175), users on the iOS PWA see the game canvas oversized. They can click "Create Room" but cannot reach the "Start Game" button at the bottom of the screen. No pinch-zoom is available in PWA mode.

## Root cause

Commit `27ebde7` (PR #155, "fix: turn camera UX") changed `src/main.ts` from `Phaser.Scale.FIT` (fixed 1280×720 logical, autoCentered) to `Phaser.Scale.RESIZE` (canvas matches viewport pixels). The change was made to eliminate pillarbox bars on wide phones (issue #132), which was a cosmetic concern.

Side effect: under RESIZE, the canvas dimensions match the device pixel size. UI elements positioned at logical pixel coordinates (e.g., Start Game button at y=620) now position relative to viewport pixels. On small mobile viewports, the UI extends beyond the visible area.

The change has been on master for weeks but only just shipped to production today, exposing the regression to PWA users for the first time.

## Decision

**Revert to `Scale.FIT` at 1280×720 logical.** Re-introduces pillarbox on wide phones (#132 reopens) but guarantees:

- All UI fits within the logical 1280×720 canvas (verified per-scene by recon).
- Buttons are tappable on any device with at least a 16:9 viewport.
- Coordinate math in lobby + HUD becomes deterministic again - all `this.scale.width` reads return 1280, exactly matching the design intent.

The wide-phone pillarbox is an acceptable cosmetic regression. The proper long-term fix (per-scene viewport-adaptive UI) is tracked separately as issue #156 and should not block this hotfix.

## Architectural decision (5-question discipline)

### Decision: Revert to `Scale.FIT` 1280×720 (vs. patch RESIZE-mode UI)

| Question | Answer |
|---|---|
| Bible cite | `~/CLAUDE.md` worms-section already documents the original intent: "Phaser `Scale.FIT` at 1280x720 logical, scales to any viewport. Already working; verified via letterboxing in narrow browsers." The current code drift is what regressed. |
| Consensus cite | All UI placement code (LobbyScene cx-centered layout, HUD positions, Start Game at y=620) was authored against the FIT contract. PR #155 changed the runtime contract without updating the UI placement code. |
| Prior art | Phaser official docs recommend FIT for fixed-aspect-ratio games (https://newdocs.phaser.io/docs/3.55.2/Phaser.Scale.ScaleManager). Phaser community examples for "mobile landscape locked" use FIT + autoCenter. |
| Simplest sufficient | A 5-line revert in `src/main.ts` restores correctness for the 95% case (16:9 mobile + desktop). Pillarbox on wide phones is cosmetic. |
| Bite | #132 reopens (pillarbox on iPhone Pro / Pro Max). Acceptable until a proper relayout-aware fix lands as part of #156. |

**Decision: revert.** The proper fix is per-scene relayout, but it's significant scope (HUD classes, lobby views, turn-transition zoom). Hotfix first, polish later.

## Workstream

Single file change. No parallelism opportunity.

### `src/main.ts`

**Before** (current):
```typescript
const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: "game-container",
  backgroundColor: "#0b0b0f",
  scene: [BootScene, LobbyScene, GameScene],
  scale: {
    mode: Phaser.Scale.RESIZE,
    width: window.innerWidth,
    height: window.innerHeight,
  },
  dom: {
    createContainer: true,
  },
};
```

**After:**
```typescript
const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: 1280,
  height: 720,
  parent: "game-container",
  backgroundColor: "#0b0b0f",
  scene: [BootScene, LobbyScene, GameScene],
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  dom: {
    createContainer: true,
  },
};
```

The `refreshScale` listener block (lines 23-38) stays — `game.scale.refresh()` is a no-op under FIT in steady state but is cheap and harmless to call on orientation change.

## Acceptance criteria

1. `npx tsc --noEmit` clean.
2. `npx biome check src` clean.
3. `npx vitest run` passes (no test asserts on Phaser scale mode that I'm aware of, but verify).
4. Manual: in Chrome DevTools mobile emulation (iPhone Pro landscape, ~932×430 with safe-area insets), the lobby renders fully. Start Game button is visible and tappable.
5. Manual: in Chrome DevTools desktop (1920×1080), the lobby renders fully (with pillarbox bars on left/right per the FIT contract).
6. Manual after deploy: Scott confirms on actual iOS PWA that the lobby is reachable and a game can be started.

## Test plan

- [ ] tsc clean
- [ ] biome clean
- [ ] vitest full suite passes
- [ ] DevTools mobile-landscape emulation: lobby usable, Start Game tappable
- [ ] DevTools desktop: lobby renders with expected pillarbox (acceptable per #132)
- [ ] Deploy to mccarrison.me/worms
- [ ] User confirms on iOS PWA

## Related issues

- **#132** (pillarbox on wide phones): will reopen after this lands. Track as the proper-fix follow-up.
- **#156** (HUD components don't relayout on scale.resize events): this hotfix doesn't address #156 but also doesn't conflict with it. #156 becomes the canonical track for "make the game RESIZE-friendly so wide-phone pillarbox can be eliminated permanently."
- **CLAUDE.md** (worms section): already documents `Scale.FIT at 1280x720 logical` as the design. Update to reflect drift / re-alignment if needed - but the doc is currently consistent with the post-revert state.

## Out of scope (deferred)

- Proper per-scene relayout to support wide-phone full-screen rendering (#156 territory).
- Updating tests to assert FIT mode is set (low value; the scale mode is config, not behavior).
- Reverting the `Math.max` change in `TurnTransition.computeFitZoom` - it works under either mode, just produces different zoom amounts. Leave alone.
- Reverting the `simAdapter` injection into TurnTransition - that's a real fix from #143 (turn camera target accuracy) and unrelated to viewport sizing.

## How to execute

This is a 5-line change. Three execution paths in order of speed:

**Fastest** (recommended): direct branch + commit + PR + auto-merge + deploy. ~10 minutes total.

**Standard `/build`**: full worktree + Sonnet agent + Haiku verify + bugcheck. Overkill for 5 lines.

**Recommended steps:**
1. Create branch `fix/pwa-viewport-fit-mode` from master.
2. Apply the single-file change.
3. Run tsc + biome + vitest locally.
4. Open PR, auto-merge after CI green.
5. `npm run deploy`.
6. User confirms on iOS PWA.
7. Reopen #132 with a comment linking this fix and noting the trade-off.
