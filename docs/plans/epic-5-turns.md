# Epic 5: Turn-based game state + win condition

## Context

Ports the turn machine and win condition from the 2013 reference to the modern Phaser + planck stack. Until now the worms just mill about freely; Epic 5 gives the game a pulse: one team's turn at a time, a 45s timer, auto-pick-next-worm at turn end, and a banner when one team is the last standing.

This epic is **pure logic** (no netcode; Colyseus integration lands in Epic 8-10). It is the first epic to install **xstate v5** per ADR-001's "state machines when needed, Epic 5+" note. xstate wins over a hand-rolled switch here because:

1. The machine (4 states + guards + delayed transitions) is exactly what xstate is shaped for
2. When Colyseus lands, the same machine can run authoritatively on the server (identical semantics, no rewrite)
3. Stately-Studio-style diagrams + snapshot-based testability pay off for turn-by-turn bugs that would otherwise be hell to reproduce

**Scope (strict)**:
- Turn state machine: `idle` -> `turnActive` -> `turnEnding` -> `idle` -> ... until `gameOver`
- 45s turn timer driven from Phaser's `update(dtMs)` (pause-correct on tab blur)
- Team cycling + per-team worm rotation (each team turn picks the next alive worm in that team)
- Win condition checked every frame (matches reference; enables mid-turn kill to end game)
- HUD: turn timer (top-center), active team banner on turn start, end-turn button (mobile-first)
- Utilities auto-deactivated at turn end (rope + jetpack)
- Input locked during `turnEnding` + `gameOver`
- InputController.cycleActive restricted to active team's worms only

**Out of scope (explicit)**:
- Retreat timer (keyed to weapon fire; lands with Epic 6's weapons)
- Win celebration UI / match reset (shows a banner; press F5 to reload for now)
- Sudden death / water rise (post-MVP enhancement)
- Wind change per turn (post-MVP enhancement)
- Audio (Epic 12; warning beep is a console.log placeholder)
- Team health bars (Epic 11/Epic 6 HUD pass)

## Strategy

- **xstate v5** installed. One machine file, one Phaser-aware manager, one HUD class. No other structural changes.
- **Turn machine ticks from Phaser's `update(dtMs)`** via `TICK` events. xstate's `after: {}` is NOT used for the turn timer. Wall-clock timers keep running on tab blur, which breaks the pause behavior the browser gives us for free.
- **Settle detection** is velocity-based, not `body.isAwake()` based. planck's sleep has hysteresis and can lie; we measure actual linear velocity magnitude < threshold for N ms straight.
- **Active worm = active team's current worm**. Each team has a persistent `currentWormIndex` that rotates each turn (classic Worms behavior: after playing worm A1, team A's next turn is A2).
- **Win check every frame**. Reference does it; it's cheap; enables mid-turn kills to end the game immediately. If `aliveTeams.length <= 1` send `GAME_OVER`.
- **Single workstream, single Sonnet agent, single worktree, single PR**. Epic 4b followed the same shape successfully.
- **Touch-first**: end-turn button in top-right corner of HUD, 44px tap target, non-overlapping with rope/jet bottom-right. Turn timer is a big readable number top-center. Keyboard shortcut "Enter" ends turn on desktop.
- **Port-then-delete**: remove `reference/src/GameStateManager.ts`, `reference/src/gui/CountDownTimer.ts`, `reference/src/Game.ts` (whole thing; was the old entry point, long since replaced) in this PR.

## Critical decisions from review

1. **Turn granularity**: per-worm (classic Worms). Team A picks one worm A_i, plays, ends; next time team A plays, they use A_(i+1 mod |alive|). Team's `currentWormIndex` persists across team turns. Implemented by mutating `team.currentWormIndex` on turn start (skipped on the very first turn).
2. **What ends a turn in Epic 5**: (a) 45s timer expires, (b) player taps End Turn / presses Enter. Weapons are Epic 6; retreat-on-fire lands then.
3. **Settle detection**: TurnManager tracks its own `_settleHoldMs` counter outside the machine. Each frame in `turnEnding`, if all alive worms have `|v| < tuning.turn.settleVelThresholdMps`, counter accumulates; if any is moving, counter resets. When counter >= `tuning.turn.settleHoldMs`, send `SETTLED`. Machine also has a `maxSettleReached` safety guard (cap at `tuning.turn.maxSettleMs`) so a stuck physics glitch does not freeze the game.

14a. **Worm rotation uses sentinel index**: `Team._currentWormIdx` defaults to `-1`. `advanceWorm()` is ALWAYS called on turnActive entry (including the very first turn). Starting from -1, `(-1 + 1) % n = 0` so it lands on worm 0. Eliminates the special-case `firstTurnInGame` flag and automatically handles the "worm 0 is dead at start" edge case by rolling forward to the first alive worm.
4. **Win condition**: checked every frame via GameScene.update -> TurnManager.update -> if `aliveTeams.length <= 1` send `GAME_OVER` with `winnerId` or `null` (tie). Runs in both `turnActive` AND `turnEnding` so a settle-phase death still ends the match.
5. **Utility auto-deactivate on turn end**: on `turnEnding` entry (observed via subscribe), scene calls `ropeUtility.deactivate()` + `jetPackUtility.deactivate()` on ALL worms (defensive; catches stragglers).
6. **InputController lockout during non-`turnActive` states**: TurnManager exposes `isInputAllowed(): boolean`. GameScene sets `inputController.setInputAllowed(allowed)` on turn start/end. InputController.update() early-returns if disallowed.
7. **Active worm switch on turn start**: TurnManager calls `inputController.setActiveWorm(worm)`. InputController stops owning the active-worm choice; the turn manager does.
8. **Mobile end-turn button** lives in the HUD layer (TurnHUD), not TouchControls. Top-right at `(width - 90, 40)` with a text label "End". setDepth(100). Separate from bottom-right rope/jet buttons to avoid thumb-conflict.
9. **Banner display**: on `turnActive` entry, pulse a large "[Team Red]'s turn" text center-screen for ~1.5s, then fade. Phaser tweens handle it.
10. **Game-over state**: banner says "[Team Red] wins!" or "Draw!" and remains. User reloads page to restart (Epic 5 does not ship match reset).
11. **Initial team order**: shuffled on game start for fairness (classic Worms). Seeded via `Math.random()` for now; Colyseus will hand out server-seeded order in Epic 8-10.
12. **No aim/jump/backflip during `turnEnding`**: all movement input ignored. Worms settle under physics alone.
13. **Worm-death mid-turn**: if the ACTIVE worm dies mid-turn, immediately send `ACTIVE_WORM_DIED` (handled inside TurnManager.update by comparing the snapshot's active worm to its isAlive).
14. **TAB within a turn**: cycles to the NEXT alive worm on the ACTIVE team only. Does not jump teams.

## File plan

```
src/
  state/
    turnMachine.ts         xstate v5 machine: types, events, states, guards, actions
    turnMachine.test.ts    Vitest: state transitions, win guard, team advance, dead-worm handling
    TurnManager.ts         Phaser-aware wrapper: owns actor + settle counter, ticks on update, bridges to game code
  ui/
    TurnHUD.ts             Phaser container: turn timer, team banner (pulse tween), end-turn button, winner banner
  worm/
    Team.ts                MODIFIED: add _currentWormIdx + getCurrentWorm() + advanceWorm()
  input/
    InputController.ts     MODIFIED: setActiveWorm(worm), setInputAllowed(bool), cycleWithinTeam, Enter binding, remove global cycleActive
  scenes/
    GameScene.ts           MODIFIED: store teams as field, instantiate TurnManager + TurnHUD, wire update order + callbacks
  tuning.ts                MODIFIED: add turn section
  debug/
    tuningPanel.ts         MODIFIED: Turn folder

docs/plans/epic-5-turns.md  NEW: copy of this plan
docs/ROADMAP.md             UPDATE: Epic 5 row -> Done with PR link

reference/src/GameStateManager.ts       DELETE
reference/src/gui/CountDownTimer.ts     DELETE
reference/src/Game.ts                   DELETE (old entry point; ~400 LOC, fully replaced by Phaser scene)

package.json                            ADD dep: "xstate": "^5.30.0"
```

**LOC estimate**: ~500 LOC new code + ~100 LOC modified. 10 new tests.

## Exact contracts

### `src/state/turnMachine.ts`

```ts
import { setup, assign } from "xstate";
import { tuning } from "../tuning";

export type TurnContext = {
  teamOrder: string[];              // ids in play order, e.g. ["red", "blue"]
  currentTeamIdx: number;           // index into teamOrder
  turnElapsedMs: number;            // how long current turn has run
  turnEndingElapsedMs: number;      // total time in turnEnding state this cycle
  winnerId: string | null;          // set on GAME_OVER; null = tie
};

export type TurnEvent =
  | { type: "START_GAME"; teamOrder: string[] }
  | { type: "TICK"; dtMs: number }
  | { type: "END_TURN" }
  | { type: "ACTIVE_WORM_DIED" }
  | { type: "SETTLED" }
  | { type: "GAME_OVER"; winnerId: string | null };

export const turnMachine = setup({
  types: {
    context: {} as TurnContext,
    events: {} as TurnEvent,
  },
  guards: {
    turnTimerExpired: ({ context, event }) =>
      event.type === "TICK" &&
      context.turnElapsedMs + event.dtMs >= tuning.turn.durationMs,
    maxSettleReached: ({ context, event }) =>
      event.type === "TICK" &&
      context.turnEndingElapsedMs + event.dtMs >= tuning.turn.maxSettleMs,
  },
  actions: {
    advanceTurnTimer: assign({
      turnElapsedMs: ({ context, event }) =>
        event.type === "TICK" ? context.turnElapsedMs + event.dtMs : context.turnElapsedMs,
    }),
    advanceTurnEnding: assign({
      turnEndingElapsedMs: ({ context, event }) =>
        event.type === "TICK" ? context.turnEndingElapsedMs + event.dtMs : context.turnEndingElapsedMs,
    }),
    resetTurnState: assign({
      turnElapsedMs: 0,
      turnEndingElapsedMs: 0,
    }),
    cycleTeam: assign({
      currentTeamIdx: ({ context }) => (context.currentTeamIdx + 1) % context.teamOrder.length,
    }),
    setWinner: assign({
      winnerId: ({ event }) => (event.type === "GAME_OVER" ? event.winnerId : null),
    }),
  },
}).createMachine({
  id: "turns",
  initial: "idle",
  context: {
    teamOrder: [],
    currentTeamIdx: 0,
    turnElapsedMs: 0,
    turnEndingElapsedMs: 0,
    winnerId: null,
  },
  states: {
    idle: {
      on: {
        START_GAME: {
          target: "turnActive",
          actions: [
            assign({
              teamOrder: ({ event }) => event.teamOrder,
              currentTeamIdx: 0,
              turnElapsedMs: 0,
              turnEndingElapsedMs: 0,
              winnerId: null,
            }),
          ],
        },
      },
    },
    turnActive: {
      entry: ["resetTurnState"],
      on: {
        TICK: [
          { guard: "turnTimerExpired", target: "turnEnding" },
          { actions: ["advanceTurnTimer"] },
        ],
        END_TURN: { target: "turnEnding" },
        ACTIVE_WORM_DIED: { target: "turnEnding" },
        GAME_OVER: { target: "gameOver", actions: ["setWinner"] },
      },
    },
    turnEnding: {
      on: {
        TICK: [
          {
            guard: "maxSettleReached",
            target: "turnActive",
            actions: ["cycleTeam"],
          },
          { actions: ["advanceTurnEnding"] },
        ],
        SETTLED: {
          target: "turnActive",
          actions: ["cycleTeam"],
        },
        GAME_OVER: { target: "gameOver", actions: ["setWinner"] },
      },
    },
    gameOver: {
      type: "final",
    },
  },
});
```

### `src/state/TurnManager.ts`

```ts
import { createActor, type Actor } from "xstate";
import type * as Phaser from "phaser";
import { turnMachine } from "./turnMachine";
import { tuning } from "../tuning";
import type { Team } from "../worm/Team";
import type { Worm } from "../worm/Worm";

export interface TurnManagerInit {
  scene: Phaser.Scene;
  teams: Team[];
  allWorms: Worm[];
  onTurnStart: (team: Team, worm: Worm) => void;
  onTurnEnd: () => void;
  onGameOver: (winner: Team | null) => void;
}

export class TurnManager {
  private readonly teams: Team[];
  private readonly allWorms: Worm[];
  private readonly actor: Actor<typeof turnMachine>;
  private readonly onTurnStart: (team: Team, worm: Worm) => void;
  private readonly onTurnEnd: () => void;
  private readonly onGameOver: (winner: Team | null) => void;

  private settleHoldMs = 0;
  private lastStateName: string = "idle";

  constructor(init: TurnManagerInit) {
    this.teams = init.teams;
    this.allWorms = init.allWorms;
    this.onTurnStart = init.onTurnStart;
    this.onTurnEnd = init.onTurnEnd;
    this.onGameOver = init.onGameOver;

    this.actor = createActor(turnMachine);
    this.actor.subscribe((snap) => this.onStateChange(String(snap.value)));
    this.actor.start();
  }

  start(): void {
    // Fisher-Yates shuffle (unbiased; the sort-random-0.5 trick is biased)
    const shuffled = [...this.teams];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    this.actor.send({ type: "START_GAME", teamOrder: shuffled.map((t) => t.id) });
  }

  update(dtMs: number): void {
    const snap = this.actor.getSnapshot();
    const stateName = String(snap.value);

    // Terminal state: stop ticking the actor (it's stopped anyway via type:"final").
    if (stateName === "gameOver" || stateName === "idle") return;

    // Win check runs in turnActive AND turnEnding.
    // Handles mutual-destruction (both teams at zero -> draw via winnerId=null).
    const aliveTeams = this.teams.filter((t) => !t.isEliminated());
    if (aliveTeams.length <= 1) {
      const winnerId = aliveTeams[0]?.id ?? null;
      this.actor.send({ type: "GAME_OVER", winnerId });
      return;
    }

    // Active worm mid-turn death
    if (stateName === "turnActive") {
      const active = this.getActiveWorm();
      if (active && !active.isAlive) {
        this.actor.send({ type: "ACTIVE_WORM_DIED" });
        return;
      }
    }

    // Settle detection while turnEnding
    if (stateName === "turnEnding") {
      const allSettled = this.allWorms.every(
        (w) => !w.isAlive || this.velocityMag(w) < tuning.turn.settleVelThresholdMps,
      );
      if (allSettled) {
        this.settleHoldMs += dtMs;
        if (this.settleHoldMs >= tuning.turn.settleHoldMs) {
          this.actor.send({ type: "SETTLED" });
          this.settleHoldMs = 0;
          return;
        }
      } else {
        this.settleHoldMs = 0;
      }
    } else {
      this.settleHoldMs = 0;
    }

    // Tick machine (drives timer + maxSettleMs safety)
    this.actor.send({ type: "TICK", dtMs });
  }

  endTurnByPlayer(): void {
    const snap = this.actor.getSnapshot();
    if (String(snap.value) !== "turnActive") return;
    this.actor.send({ type: "END_TURN" });
  }

  isInputAllowed(): boolean {
    return String(this.actor.getSnapshot().value) === "turnActive";
  }

  getActiveTeam(): Team | null {
    const snap = this.actor.getSnapshot();
    const state = String(snap.value);
    if (state === "idle" || state === "gameOver") return null;
    const id = snap.context.teamOrder[snap.context.currentTeamIdx];
    return this.teams.find((t) => t.id === id) ?? null;
  }

  getActiveWorm(): Worm | null {
    const state = String(this.actor.getSnapshot().value);
    if (state !== "turnActive") return null;
    return this.getActiveTeam()?.getCurrentWorm() ?? null;
  }

  getTurnSecondsRemaining(): number {
    const snap = this.actor.getSnapshot();
    if (String(snap.value) !== "turnActive") return 0;
    return Math.max(
      0,
      Math.ceil((tuning.turn.durationMs - snap.context.turnElapsedMs) / 1000),
    );
  }

  getStateName(): "idle" | "turnActive" | "turnEnding" | "gameOver" {
    return String(this.actor.getSnapshot().value) as
      | "idle"
      | "turnActive"
      | "turnEnding"
      | "gameOver";
  }

  destroy(): void {
    this.actor.stop();
  }

  // ---- Private ----

  private onStateChange(stateName: string): void {
    // subscribe may fire synchronously on initial attach with current state "idle";
    // lastStateName starts as "idle" to no-op that case.
    if (stateName === this.lastStateName) return;

    if (stateName === "turnActive") {
      const team = this.getActiveTeam();
      if (!team) return;

      // Team._currentWormIdx starts at -1, so the very first advanceWorm lands on worm 0.
      // On subsequent turns for this team, advanceWorm rotates to the next alive worm.
      // If all worms on this team are dead, advanceWorm returns null - but this should
      // be impossible because the update() win check fires first.
      const worm = team.advanceWorm();
      if (worm && worm.isAlive) {
        this.onTurnStart(team, worm);
      }
    } else if (stateName === "turnEnding") {
      this.onTurnEnd();
    } else if (stateName === "gameOver") {
      const snap = this.actor.getSnapshot();
      const winnerId = snap.context.winnerId;
      const winner = winnerId ? this.teams.find((t) => t.id === winnerId) ?? null : null;
      this.onGameOver(winner);
    }

    this.lastStateName = stateName;
  }

  private velocityMag(w: Worm): number {
    const v = w.body.getLinearVelocity();
    return Math.hypot(v.x, v.y);
  }
}
```

### `src/worm/Team.ts` modifications

```ts
export class Team {
  // existing fields ...

  /** Starts at -1 so the first `advanceWorm()` call lands at index 0. */
  private _currentWormIdx = -1;

  getCurrentWorm(): Worm | null {
    if (this._currentWormIdx < 0) return null;
    return this.worms[this._currentWormIdx] ?? null;
  }

  /** Rotate to the next alive worm. Works correctly starting from -1. Returns null if all dead. */
  advanceWorm(): Worm | null {
    const n = this.worms.length;
    if (n === 0) return null;
    for (let i = 1; i <= n; i++) {
      const idx = ((this._currentWormIdx + i) % n + n) % n;  // handles -1 correctly
      const w = this.worms[idx];
      if (w?.isAlive) {
        this._currentWormIdx = idx;
        return w;
      }
    }
    return null;
  }

  get currentWormIdx(): number {
    return this._currentWormIdx;
  }
}
```

Keep existing `aliveCount()`, `isEliminated()`, `addWorm()`.

### `src/input/InputController.ts` modifications

**New init type** (replaces existing):

```ts
export interface InputControllerInit {
  scene: Phaser.Scene;
  allWorms: Worm[];              // renamed from worms; all worms for cycleWithinTeam lookups
  onEndTurn: () => void;         // called on Enter keydown
}
```

**Full field diff** (remove `activeIndex`; rename `worms` -> `allWorms`; add new):

```ts
// REMOVE: private activeIndex: number;
// RENAME: private readonly worms -> private readonly allWorms
private readonly allWorms: Worm[];
private readonly onEndTurn: () => void;
private activeWorm: Worm | null = null;
private inputAllowed = false;

// ADD new key:
private readonly keyEnter: Phaser.Input.Keyboard.Key;
// All existing keys (keyLeft, keyRight, keyA, keyD, keySpace, keyBackspace, keyShift,
//  keyUp, keyDown, keyW, keyS, keyTab, keyRope, keyJetPack) stay.
```

**Constructor body** (replace `this.worms = init.worms` + `this.activeIndex = ...` block with):

```ts
constructor(init: InputControllerInit) {
  this.scene = init.scene;
  this.allWorms = init.allWorms;
  this.onEndTurn = init.onEndTurn;

  const kb = this.scene.input.keyboard;
  if (!kb) throw new Error("InputController: keyboard plugin not available");

  this.keyLeft = kb.addKey(Phaser.Input.Keyboard.KeyCodes.LEFT);
  // ... (all existing key bindings unchanged) ...
  this.keyJetPack = kb.addKey(Phaser.Input.Keyboard.KeyCodes.J);
  this.keyEnter = kb.addKey(Phaser.Input.Keyboard.KeyCodes.ENTER);

  // Prevent Tab and Enter from bubbling to the browser (form submit etc)
  this.keyTab.on("down", (evt: KeyboardEvent) => { evt.preventDefault?.(); });
  this.keyEnter.on("down", (evt: KeyboardEvent) => { evt.preventDefault?.(); });

  // NOTE: active worm is NOT initialized here; TurnManager.start() will call
  // setActiveWorm() inside its START_GAME -> turnActive transition. Until then,
  // no worm is highlighted and inputAllowed is false.
}
```

**New methods**:

```ts
setActiveWorm(worm: Worm | null): void {
  if (this.activeWorm === worm) return;  // idempotent: same worm = no-op

  // Deactivate previous utilities + highlight
  if (this.activeWorm) {
    this.activeWorm.ropeUtility?.deactivate();
    this.activeWorm.jetPackUtility?.deactivate();
    this.activeWorm.setActive(false);
  }
  this.activeWorm = worm;
  if (worm) worm.setActive(true);
}

setInputAllowed(allowed: boolean): void {
  this.inputAllowed = allowed;
}

getActiveWorm(): Worm | null {
  return this.activeWorm?.isAlive ? this.activeWorm : null;
}

/** Cycles to next alive worm on the active worm's OWN team (no jumping teams). */
cycleWithinTeam(): void {
  if (!this.activeWorm) return;
  const team = this.activeWorm.team;
  const aliveInTeam = team.worms.filter((w) => w.isAlive);
  if (aliveInTeam.length <= 1) return;
  const idx = aliveInTeam.indexOf(this.activeWorm);
  const next = aliveInTeam[(idx + 1) % aliveInTeam.length];
  if (next) this.setActiveWorm(next);
}
```

**Modified `update(dtMs)`**:

```ts
update(dtMs: number): void {
  if (!this.inputAllowed) return;

  // Enter ends turn
  if (Phaser.Input.Keyboard.JustDown(this.keyEnter)) {
    this.onEndTurn();
    return;
  }

  // Tab cycles within active team
  if (Phaser.Input.Keyboard.JustDown(this.keyTab)) {
    this.cycleWithinTeam();
    return;
  }

  const worm = this.getActiveWorm();
  if (!worm) return;

  // ... rest unchanged from Epic 4b (rope/jet toggles, state-dependent movement) ...
}
```

**Remove from the class**: `activeIndex` field, `cycleActive()` method, `findNextAliveFrom()` method, `updateActiveHighlight()` method (the last is replaced by setActiveWorm's side effects).

### `src/ui/TurnHUD.ts`

```ts
import * as Phaser from "phaser";

export interface TurnHUDInit {
  scene: Phaser.Scene;
  onEndTurnPressed: () => void;
}

export class TurnHUD {
  private readonly scene: Phaser.Scene;
  private readonly onEndTurnPressed: () => void;
  private readonly timerText: Phaser.GameObjects.Text;
  private readonly endBtn: Phaser.GameObjects.Container;
  private readonly endBtnCircle: Phaser.GameObjects.Graphics;
  private readonly endBtnLabel: Phaser.GameObjects.Text;
  private bannerText: Phaser.GameObjects.Text | null = null;
  private bannerTween: Phaser.Tweens.Tween | null = null;
  private gameOverText: Phaser.GameObjects.Text | null = null;
  private endEnabled = false;

  constructor(init: TurnHUDInit) {
    this.scene = init.scene;
    this.onEndTurnPressed = init.onEndTurnPressed;

    const W = this.scene.scale.width;

    this.timerText = this.scene.add
      .text(W / 2, 36, "", {
        fontSize: "48px",
        fontFamily: "monospace",
        color: "#ffffff",
        stroke: "#000000",
        strokeThickness: 4,
      })
      .setOrigin(0.5)
      .setDepth(100)
      .setScrollFactor(0);

    // End-turn button: Container with Graphics circle + Text.
    // Position y=60 so the 80px button (radius 40) sits fully on canvas (y=20..100).
    this.endBtn = this.scene.add.container(W - 80, 60).setDepth(100).setScrollFactor(0);
    this.endBtnCircle = this.scene.add.graphics();
    this.drawEndBtn(false);
    this.endBtnLabel = this.scene.add
      .text(0, 0, "End", {
        fontSize: "18px",
        fontFamily: "monospace",
        color: "#ffffff",
      })
      .setOrigin(0.5);
    this.endBtn.add([this.endBtnCircle, this.endBtnLabel]);

    this.endBtn.setInteractive({
      hitArea: new Phaser.Geom.Circle(0, 0, this.BTN_RADIUS),
      hitAreaCallback: Phaser.Geom.Circle.Contains,
    });
    this.endBtn.on("pointerdown", () => {
      if (this.endEnabled) this.onEndTurnPressed();
    });
  }

  private readonly BTN_RADIUS = 40;  // diameter 80 - exceeds WCAG 44 even after Scale.FIT on narrow viewports

  update(secondsRemaining: number): void {
    const warnBelowSec = Math.ceil(tuning.turn.warnThresholdMs / 1000);
    this.timerText.setText(secondsRemaining > 0 ? String(secondsRemaining) : "");
    this.timerText.setColor(
      secondsRemaining > 0 && secondsRemaining <= warnBelowSec ? "#ff4444" : "#ffffff",
    );
  }

  /** Returns true if the pointer is over the end-turn button. GameScene uses this to gate terrain cut. */
  hitsButton(pointer: Phaser.Input.Pointer): boolean {
    if (!this.endEnabled) return false;
    const local = this.endBtn.getLocalPoint(pointer.x, pointer.y);
    return Phaser.Geom.Circle.Contains(
      new Phaser.Geom.Circle(0, 0, this.BTN_RADIUS),
      local.x,
      local.y,
    );
  }

  showTurnBanner(teamName: string, teamColor: number): void {
    this.bannerTween?.stop();
    this.bannerText?.destroy();

    const W = this.scene.scale.width;
    const H = this.scene.scale.height;

    this.bannerText = this.scene.add
      .text(W / 2, H / 2, `${teamName}'s turn`, {
        fontSize: "64px",
        fontFamily: "monospace",
        color: `#${teamColor.toString(16).padStart(6, "0")}`,
        stroke: "#000000",
        strokeThickness: 6,
      })
      .setOrigin(0.5)
      .setDepth(100)
      .setScrollFactor(0)
      .setAlpha(0)
      .setScale(2);

    const t = this.bannerText;
    this.bannerTween = this.scene.tweens.add({
      targets: t,
      alpha: { from: 0, to: 1 },
      scale: { from: 2, to: 1 },
      duration: 300,
      onComplete: () => {
        this.scene.tweens.add({
          targets: t,
          alpha: 0,
          delay: 900,
          duration: 300,
          onComplete: () => {
            t.destroy();
            if (this.bannerText === t) this.bannerText = null;
          },
        });
      },
    });
  }

  showGameOver(winnerName: string | null): void {
    this.gameOverText?.destroy();
    const W = this.scene.scale.width;
    const H = this.scene.scale.height;
    const label = winnerName ? `${winnerName} wins!` : "Draw!";
    this.gameOverText = this.scene.add
      .text(W / 2, H / 2, label, {
        fontSize: "72px",
        fontFamily: "monospace",
        color: "#ffffff",
        stroke: "#000000",
        strokeThickness: 8,
      })
      .setOrigin(0.5)
      .setDepth(100)
      .setScrollFactor(0);
  }

  setEndTurnEnabled(enabled: boolean): void {
    this.endEnabled = enabled;
    this.drawEndBtn(enabled);
    this.endBtn.setAlpha(enabled ? 1 : 0.5);
  }

  destroy(): void {
    this.bannerTween?.stop();
    this.bannerText?.destroy();
    this.gameOverText?.destroy();
    this.timerText.destroy();
    this.endBtn.destroy();
  }

  private drawEndBtn(enabled: boolean): void {
    this.endBtnCircle.clear();
    this.endBtnCircle.fillStyle(enabled ? 0x333333 : 0x111111, 1);
    this.endBtnCircle.fillCircle(0, 0, this.BTN_RADIUS);
    this.endBtnCircle.lineStyle(2, 0xffffff, 1);
    this.endBtnCircle.strokeCircle(0, 0, this.BTN_RADIUS);
  }
}
```

### `src/tuning.ts` additions

Add to `Tuning` interface:

```ts
turn: {
  durationMs: number;              // default 45000
  warnThresholdMs: number;         // default 5000 - timer turns red at <= this much remaining
  settleVelThresholdMps: number;   // default 0.15
  settleHoldMs: number;            // default 500
  maxSettleMs: number;             // default 5000 - glitch safety cap
};
```

Add to `tuning` const:

```ts
turn: {
  durationMs: 45000,
  warnThresholdMs: 5000,
  settleVelThresholdMps: 0.15,
  settleHoldMs: 500,
  maxSettleMs: 5000,
},
```

Note: `retreatMs` deliberately omitted until Epic 6 wires it to weapon-fire behavior (YAGNI).

### `src/debug/tuningPanel.ts` additions

```ts
const turn = gui.addFolder("Turn");
turn.add(tuning.turn, "durationMs", 5000, 120000, 1000);
turn.add(tuning.turn, "warnThresholdMs", 0, 15000, 500);
turn.add(tuning.turn, "settleVelThresholdMps", 0.01, 2, 0.01);
turn.add(tuning.turn, "settleHoldMs", 100, 3000, 100);
turn.add(tuning.turn, "maxSettleMs", 1000, 20000, 500);
```

### `src/scenes/GameScene.ts` modifications

1. Promote teams to field: `private teams: Team[] = []`.
2. Update InputController construction to use new init:
   ```ts
   this.inputController = new InputController({
     scene: this,
     allWorms: this.allWorms,
     onEndTurn: () => this.turnManager.endTurnByPlayer(),
   });
   ```
3. After utility wiring, create TurnHUD:
   ```ts
   this.turnHUD = new TurnHUD({
     scene: this,
     onEndTurnPressed: () => this.turnManager.endTurnByPlayer(),
   });
   ```
4. Create TurnManager:
   ```ts
   this.turnManager = new TurnManager({
     scene: this,
     teams: this.teams,
     allWorms: this.allWorms,
     onTurnStart: (team, worm) => {
       this.inputController.setActiveWorm(worm);
       this.inputController.setInputAllowed(true);
       this.turnHUD.showTurnBanner(team.name, team.color);
       this.turnHUD.setEndTurnEnabled(true);
     },
     onTurnEnd: () => {
       this.inputController.setInputAllowed(false);
       this.turnHUD.setEndTurnEnabled(false);
       for (const w of this.allWorms) {
         w.ropeUtility?.deactivate();
         w.jetPackUtility?.deactivate();
       }
     },
     onGameOver: (winner) => {
       this.inputController.setInputAllowed(false);
       this.turnHUD.setEndTurnEnabled(false);
       this.turnHUD.showGameOver(winner?.name ?? null);
     },
   });
   this.turnManager.start();
   ```
5. `update(time, deltaMs)` ordering (CRITICAL). PhysicsSystem.step already takes milliseconds (see src/physics/PhysicsSystem.ts); do NOT divide by 1000:
   ```ts
   this.physicsSystem.step(deltaMs);                        // ms, matches existing contract
   for (const w of this.allWorms) w.applyPendingDamage();   // deaths apply BEFORE win check
   this.turnManager.update(deltaMs);                         // win check + settle detection
   this.inputController.update(deltaMs);                     // respects isInputAllowed (set by turn manager)
   for (const w of this.allWorms) {
     w.update(deltaMs);
     w.ropeUtility?.update(deltaMs);
     w.jetPackUtility?.update(deltaMs);
   }
   this.turnHUD.update(this.turnManager.getTurnSecondsRemaining());
   // draw debug graphics, HUD text, etc.
   ```
6. **HUD text**: keep the existing `this.hud` top-left text, but strip "active: name" + rope/jet state from it (TurnHUD owns turn-level info now). Final format: `"click to cut - bodies: N"`. Update the `this.hud.setText(...)` call in update() accordingly.
7. **Terrain-cut pointer gate**: existing handler gates via `this.touchControls.hitsButton(p)`. Extend to also skip when TurnHUD's end button is hit:
   ```ts
   this.input.on("pointerdown", (p: Phaser.Input.Pointer) => {
     if (this.touchControls.hitsButton(p)) return;
     if (this.turnHUD.hitsButton(p)) return;       // NEW
     this.terrain.cutCircle(p.x, p.y, tuning.weapons.testCutRadiusPx);
   });
   ```
8. **Scene shutdown**: extend the existing `this.events.once(Phaser.Scenes.Events.SHUTDOWN, ...)` block (currently only removes physics listeners) to also call `this.turnManager.destroy()` and `this.turnHUD.destroy()`.

## Tests

`src/state/turnMachine.test.ts` (10 vitest tests). Each test's event sequence is spelled out so Sonnet does not have to infer the setup:

1. **idle -> turnActive via START_GAME**
   - sequence: `.send({ type: "START_GAME", teamOrder: ["red","blue"] })`
   - assert: `snap.value === "turnActive"`, `snap.context.teamOrder === ["red","blue"]`, `snap.context.currentTeamIdx === 0`

2. **turnActive -> turnEnding via turn-timer expiry**
   - sequence: START_GAME -> `.send({ type: "TICK", dtMs: 45001 })`
   - assert: `snap.value === "turnEnding"`

3. **turnActive accumulates turnElapsedMs via multiple ticks**
   - sequence: START_GAME -> TICK(100) x 5
   - assert: `snap.value === "turnActive"`, `snap.context.turnElapsedMs === 500`

4. **turnActive -> turnEnding via END_TURN**
   - sequence: START_GAME -> `.send({ type: "END_TURN" })`
   - assert: `snap.value === "turnEnding"`

5. **turnActive -> turnEnding via ACTIVE_WORM_DIED**
   - sequence: START_GAME -> `.send({ type: "ACTIVE_WORM_DIED" })`
   - assert: `snap.value === "turnEnding"`

6. **turnEnding -> turnActive via SETTLED + cycleTeam**
   - sequence: START_GAME -> END_TURN -> `.send({ type: "SETTLED" })`
   - assert: `snap.value === "turnActive"`, `snap.context.currentTeamIdx === 1`

7. **turnEnding -> turnActive via maxSettleReached + cycleTeam**
   - sequence: START_GAME -> END_TURN -> `.send({ type: "TICK", dtMs: 5001 })`
   - assert: `snap.value === "turnActive"`, `snap.context.currentTeamIdx === 1`

8. **turnActive -> gameOver via GAME_OVER with winnerId**
   - sequence: START_GAME -> `.send({ type: "GAME_OVER", winnerId: "red" })`
   - assert: `snap.value === "gameOver"`, `snap.context.winnerId === "red"`

9. **turnEnding -> gameOver via GAME_OVER with null (tie)**
   - sequence: START_GAME -> END_TURN -> `.send({ type: "GAME_OVER", winnerId: null })`
   - assert: `snap.value === "gameOver"`, `snap.context.winnerId === null`

10. **cycleTeam wraps around at end of teamOrder**
    - sequence: START_GAME(["red","blue"]) -> END_TURN -> SETTLED (now idx=1) -> END_TURN -> SETTLED
    - assert: `snap.context.currentTeamIdx === 0` (wrapped)

Use `createActor(turnMachine).start()` + `.send(...)` + `.getSnapshot()` patterns.

No direct test of TurnManager (would require mocking Phaser scene + teams + worms; not worth the lift). Manual browser verification covers it.

## Commit chain (9 commits, single branch)

Worktree: `/home/scott/worms-ws1`, branch `feature/epic-5-turns` off master.

Each commit must compile (typecheck passes) and tests pass, for bisect safety. InputController's init signature change (renaming `worms` -> `allWorms`, adding `onEndTurn`) would break GameScene.ts:103 at an intermediate commit, so commits 6 and 7 are merged into commit 8 which rewrites BOTH sides of that contract in a single commit.

1. `chore(deps): add xstate ^5.30.0`
2. `chore(tuning): add turn section (duration, settle thresholds)`
3. `feat(worm): Team.currentWormIdx + getCurrentWorm + advanceWorm`
4. `feat(state): xstate turnMachine + tests`
5. `feat(state): TurnManager Phaser-aware wrapper`
6. `feat(ui): TurnHUD (timer, banner, end-turn button, game-over, hitsButton)`
7. `feat(epic-5): InputController refactor + GameScene wiring` (combined: InputController API change + TurnHUD instantiation + TurnManager instantiation + GameScene.update ordering + pointer gate + shutdown cleanup - all in one commit so bisect stays green)
8. `chore: delete ported reference/{GameStateManager.ts,gui/CountDownTimer.ts,Game.ts}`
9. `docs: epic 5 plan + ROADMAP update`

## Verification (before push)

1. `npm run typecheck` exit 0
2. `npm run lint` exit 0
3. `npm run test:run` all pass (~45 tests total: 35 existing + 10 new)
4. `npm run build` exit 0
5. `npm run dev` at localhost:5173, test on desktop:
   - **Match starts**: "[Team X]'s turn" banner pulses for ~1.5s; timer starts at 45s
   - **Input**: arrow/WASD walk, space jump, backspace backflip, R/J rope/jet work on active worm only
   - **TAB**: cycles to the OTHER worm on the active team only (not enemy worms)
   - **End turn (Enter)**: turn ends immediately, other team's banner appears, timer resets to 45s
   - **Turn timer natural expiry**: set `tuning.turn.durationMs = 5000` via dat.gui, wait 5s, turn auto-ends
   - **Settle wait**: end turn while a worm is mid-air (jetpacking); short pause until all worms stop moving, then next turn starts
   - **Mid-turn death**: drive a worm off the edge (fall damage); turn ends immediately
   - **Win**: keep killing worms on one team; when only one team has alive worms, "[Team X] wins!" banner appears; all input locked (keys + taps do nothing)
   - **dat.gui Turn folder**: sliders work, tuning numbers mutable live
   - **No console errors**
6. Chrome DevTools mobile viewport (iPhone 14 Pro landscape):
   - Turn timer visible top-center, big readable number
   - End-turn button top-right, tappable (not overlapping rope/jet bottom-right)
   - Tapping rope/jet buttons does NOT trigger end-turn
   - Terrain cut still works outside button areas

## Auto-merge policy

**NO.** Game-logic PR. Hold for review per CLAUDE.md. Label `needs-review`.

## Things Sonnet MUST verify before coding

1. `xstate@^5.30.0` installs cleanly; types resolve under TypeScript 5 strict + bundler moduleResolution. If xstate types conflict with our TSConfig, check `node_modules/xstate/package.json` `exports` field.
2. `setup().createMachine()` chained pattern works exactly as sketched. If xstate v5 API differs, consult Context7 for xstate docs before improvising.
3. `createActor().subscribe((snap) => ...)` returns a subscription; no need to hold its `.unsubscribe` unless disposing mid-game. On scene shutdown we call `actor.stop()` anyway.
4. `body.getLinearVelocity()` returns `Vec2` ({x,y}); confirm.
5. `Phaser.Input.Keyboard.KeyCodes.ENTER` exists (it does).
6. `Phaser.Geom.Circle.Contains` hit-area callback signature matches the TouchControls usage pattern at `src/ui/TouchControls.ts` (uses `{ hitArea, hitAreaCallback }` object form).
7. **PhysicsSystem.step signature**: already takes milliseconds (see `src/physics/PhysicsSystem.ts`). The existing GameScene.update passes `deltaMs` (not `deltaMs/1000`). Do NOT change this contract.
8. **InputController init signature change** breaks the existing call at `src/scenes/GameScene.ts:103`. That call site is updated in the same commit that changes the API (commit 7). Do not split.
9. **Worm.applyPendingDamage** flips `isAlive = false` when damage exceeds health. Verify by reading `src/worm/Worm.ts:178`. The win check relies on this flip landing BEFORE turnManager.update runs each frame.

If any of these diverge, STOP and surface.

## Risks / gotchas

- **xstate v5 typing is strict**: `setup({ types: { events: {} as TurnEvent }})` + `createActor(machine)` typing must line up. Sonnet: write a smoke test first, ensure it compiles.
- **Sentinel `_currentWormIdx = -1`**: eliminates the first-turn special case. The `((_currentWormIdx + i) % n + n) % n` pattern in advanceWorm handles negative-modulo correctly.
- **All worms on active team die at once**: both ACTIVE_WORM_DIED and GAME_OVER can fire same frame. TurnManager.update checks win condition first, so GAME_OVER wins. Correct.
- **Banner z-order**: setDepth(100) on HUD elements. TouchControls already uses depth 100; fine - bottom-right vs top-right, no overlap.
- **Tab + Enter preventDefault**: both explicitly preventDefault'd in InputController constructor to stop browser defaults leaking through.
- **Banner tween leak**: kill prior pulse tween before starting a new one. Handled in `showTurnBanner` contract above.
- **Active worm highlight during turnEnding**: highlight stays on the last-played worm during settle. TurnManager's `onTurnStart` flips to the new worm. If the old worm dies mid-air during turnEnding, the highlight vanishes with the sprite.
- **GameScene update order**: `applyPendingDamage -> turnManager.update -> inputController.update`. Getting this wrong hides same-frame deaths from the win check and delays game-over by one frame.
- **Physics step takes ms**: `PhysicsSystem.step(deltaMs)` - internal accumulator divides by 1000 for planck world.step(). Do NOT pass `deltaMs/1000`.
- **Dead reference imports**: deleting Game.ts is safe only if nothing in src/ imports it. `grep -r "reference/src/Game" src/` should return zero matches before deleting.
- **Delete scope**: DO NOT delete `reference/src/Worm.ts` yet; Epic 6 needs it for damage formulas.
- **xstate final state**: `gameOver` type: "final" stops the actor; subsequent sends are silent no-ops. TurnManager.update short-circuits on `gameOver` so no needless sends. Match reset is out of scope for Epic 5; when added, drop `type: "final"` and add a RESTART event.
- **velocityMag on destroyed body**: Worm.destroy() would destroy the planck body, but `applyPendingDamage` just flips isAlive=false and leaves the body. `!w.isAlive` short-circuits velocityMag in settle check. If a future epic adds destroy-on-death, add a `body.isActive()` guard.
- **Shuffle bias**: `[...arr].sort(() => Math.random() - 0.5)` is known-biased. Plan uses Fisher-Yates.
- **Mobile tap-target scaling**: 40px logical radius (80px diameter) stays >=44px device-px even at Scale.FIT narrow-phone ratios; chosen conservatively.

## PR body template

```
## Summary

Closes #5. First real game loop: turns, win condition, HUD timer, end-turn button.

**This PR:**
- `src/state/turnMachine.ts` - xstate v5 state machine: `idle` -> `turnActive` -> `turnEnding` -> `gameOver`. Type-safe events, guards for timer + settle cap, context tracks team + turn + winner.
- `src/state/TurnManager.ts` - Phaser-aware wrapper; ticks from `update(dtMs)` (pause-correct on tab blur); runs velocity-based settle detection (not planck sleep); runs win-check every frame (mid-turn kills end game immediately).
- `src/ui/TurnHUD.ts` - turn timer top-center, end-turn button top-right (80px touch target; exceeds WCAG 44 even after Scale.FIT on narrow viewports), team banner pulse, game-over banner.
- `src/worm/Team.ts` - `currentWormIdx` + `advanceWorm()` rotates through alive worms per team turn.
- `src/input/InputController.ts` - active worm now set by TurnManager; TAB cycles within active team only; Enter ends turn; input locked outside `turnActive`.
- `src/scenes/GameScene.ts` - instantiates manager + HUD, wires callbacks, applies damage before turn update for correct win-check ordering.
- `src/tuning.ts` + dat.gui Turn folder.

**xstate v5** installed (~50KB gzipped). ADR-001 predicted this. The same machine can later run on Colyseus server authoritatively; no rewrite needed for Epic 8-10.

## Mobile-first
- End-turn button 80px diameter top-right at (W-80, 60); verified non-overlapping with rope/jet bottom-right
- Timer top-center, large 48px monospace
- Terrain-cut pointer gate extended to skip End button hits (same pattern as TouchControls)
- Tested in Chrome DevTools iPhone 14 Pro landscape

## Test plan
- [x] typecheck + lint + build + tests pass (new: 10 turnMachine tests; total ~45)
- [x] Dev: turn cycles, timer expires, end-turn button/Enter works, settle wait, mid-turn death, win condition
- [x] Mobile viewport: buttons non-conflicting, timer readable
- [ ] CI passes
- [ ] Human review of feel (turn duration, settle threshold)

Closes #5
```
