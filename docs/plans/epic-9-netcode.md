# Epic 9 - Server-as-Turn-Arbiter Netcode (Option C)

Closes #9 with a deliberately narrow interpretation: server arbitrates turn ownership, relays the active player's inputs to spectators, and accepts an authoritative snapshot at turn end. No server-side planck sim, no per-frame reconciliation. Each client keeps running its own full simulation; physics drift within a turn is absorbed by the end-of-turn snapshot.

This choice explicitly revisits one axis of [ADR-001](../decisions/001-framework-pivot.md): the product shape ("friends text a link, tap to play") does not justify the engineering cost of authoritative server physics. Upgrading to a server-side planck sim remains a later epic if competitive play ever becomes a requirement.

## Scope

### In scope
- Team-to-sessionId ownership established in `game_started` (team index i -> player i by lobby join order; extra teams unowned).
- Server-side game-phase state on the existing room: `currentTeamId`, `currentWormId`, `turnSeq`, `turnEndsAt` (ms epoch).
- Server `TurnArbiter` class running off Colyseus' `setSimulationInterval` (20Hz). Tracks the active turn, fires timeouts, advances to next owned team when the active player ends the turn, declares game over when all-but-one teams have no alive worms (per a compact tally server keeps).
- Message relay (client -> server -> all other clients):
  - `input_walk { dir: -1|0|1, seq }`
  - `input_jump { seq }`
  - `input_backflip { seq }`
  - `input_aim_angle { angleRad, seq }` (sent on change, not per frame)
  - `input_aim_power { power: 0..1, seq }`
  - `input_select_weapon { weaponId, seq }`
  - `input_fire { seq }` (no payload beyond seq; fire uses current aim state of active worm)
  - `input_end_turn { seq }`
- Turn-end reconciliation: active player's client sends `turn_snapshot { worms: WormSnapshot[], terrainCuts: CircleCut[], nextTeamId }` when its local TurnManager transitions out of `turnActive`. Server validates, broadcasts to all clients as `turn_resolved`. All clients snap to these positions / apply cuts / set next turn.
- Client GameScene behavior split:
  - Offline path (`room === undefined`, same as `?offline=1`): unchanged from Epic 8. Local TurnManager drives turns, InputController always enabled when active worm present.
  - Networked path (`room` present): TurnManager's turn-advance signal comes from `turn_resolved` messages, not local settle detection. InputController gated to only run when local sessionId == active team's owner. Remote inputs drive the active worm's existing Worm methods.
- Spectator HUD: "Waiting for {nickname}..." banner at top of screen when active team is not yours. Also shown when active team has no owner (e.g., 2-player game, teams 3/4 unowned - turns for those teams are auto-skipped by the server, but the banner briefly appears during skip).
- Team-skip rule: server skips any team whose `ownerSessionId` is empty OR whose owner has disconnected. This keeps 2-player games working with the existing 4-team default or with a 2-team cap (decision below).
- Game-start team count: default to `min(players.size, 4)` teams server-side. Plan leaves a tuning knob for post-hoc (#43 or a new issue) to let host pick team count. This keeps 2-player games playable without awkward "team_3 with no owner" no-ops.

### Out of scope (tracked separately)
- Server-side planck physics / authoritative per-frame sim - #45. Only tackle if Option C hits its limits (visible drift, competitive play, cheating).
- Reconnection beyond current-turn tolerance - Epic 10 / #10.
- Host-configurable lobby knobs (team count, turn duration) - #46.
- Spectator input smoothing / remote worm interpolation - #47. Speculative; only fix if playtest shows stutter.
- Prediction + rollback - subset of #45; no separate issue.
- Anti-cheat / adversarial clients - friends playing; not a threat model.
- Weapons server-side validation - same rationale as anti-cheat; deliberate non-goal.
- Host migration beyond the lobby epic's implementation - covered by Epic 10 reconnection semantics.
- Deterministic physics across clients - explicit design choice; end-of-turn snapshot covers drift.

### Plan-time skill invocation (per CLAUDE.md)
- Mobile-first: no new touch controls introduced. Existing touch input flows unchanged. Spectator HUD is passive (no interaction) so no touch design needed. Any changes to the existing in-game touch layer are deliberately forbidden this epic.
- `/frontend-design`: the only new UI is a "Waiting for X" banner (Phaser.Text, centered top). Plan prescribes a minimal unstyled treatment; if this grows into anything interactive in a follow-up, that follow-up must invoke `/frontend-design`.
- `/review`: this PR is risky (netcode + cross-client coordination). Plan requires bugcheck + a second review pass before merge. Recommend `/review` against the integration branch before opening PR.

## Architecture

### State schema additions

Extend existing `LobbyState` rather than introducing a separate `GameState`, since the room stays the same post-`start_game`. Rationale: clients already subscribe to `room.state` from Epic 8; adding fields is cheaper than teaching the client about a schema swap.

```ts
// server/src/state/LobbyState.ts (additions, not full file)
import { Schema, MapSchema, ArraySchema, type } from "@colyseus/schema";

export class LobbyPlayer extends Schema {
  // ...existing fields
  @type("string") ownerOfTeamId = ""; // set on start_game; "" means spectator / not assigned
}

export class LobbyState extends Schema {
  // ...existing fields

  // ---- game-phase (post-start_game) ----
  @type(["string"]) teamOrder = new ArraySchema<string>(); // ["red","blue",...]; server's canonical cycle order
  @type("string") currentTeamId = "";
  @type("string") currentWormId = ""; // e.g. "red-0"; empty during game_over
  @type("number") turnSeq = 0;        // increments every turn; clients key drift reconciliation off this
  @type("number") turnEndsAt = 0;     // Date.now() + remaining ms; 0 means not counting
}
```

Authoritative worm/terrain state is NOT replicated via schema; it flows through the `turn_resolved` message. This avoids the cost of per-frame schema serialization for the whole game world.

### Message contract

All messages JSON. `seq` on inputs is a client-monotonic counter; server does not use it for ordering (UDP-style reorder doesn't apply to WebSocket) but logs it for debugging. Server drops messages where sender's sessionId != owner of `currentTeamId`.

| Direction | Type | Payload | When |
|-----------|------|---------|------|
| C->S | `input_walk` | `{dir:-1\|0\|1, seq}` | Active player pressed walk key. Only the DIRECTION transitions are sent (not per-frame polls); i.e. press -> send `{dir:-1}`, release -> send `{dir:0}`. |
| C->S | `input_jump` | `{seq}` | JustDown(SPACE) |
| C->S | `input_backflip` | `{seq}` | JustDown(SHIFT or BACKSPACE) |
| C->S | `input_aim_angle` | `{angleRad, seq}` | Aim angle changed (throttled, max 20Hz) |
| C->S | `input_aim_power` | `{power, seq}` | Power nudged with [/] |
| C->S | `input_select_weapon` | `{weaponId:"bazooka"\|"shotgun"\|"handgrenade", seq}` | 1/2/3 pressed or drawer tap |
| C->S | `input_fire` | `{seq}` | F pressed or drag-release |
| C->S | `input_end_turn` | `{seq}` | Enter pressed |
| C->S | `turn_snapshot` | `{worms: WormSnapshot[], terrainCuts: CircleCut[]}` | Active player's local TurnManager left `turnActive`. Sent once per turn by the active client. |
| S->C | `input_*` (broadcast) | Same as C->S (server re-emits to non-sender) | Server validated sender + relayed |
| S->C | `turn_resolved` | `{turnSeq, worms, terrainCuts, nextTeamId, nextWormId}` | Active client's snapshot accepted; everyone snaps |
| S->C | `game_over` | `{winnerTeamId \| null}` | Game ended |
| S->C | `error` | `{code, message}` | Existing lobby shape |

WormSnapshot and CircleCut:

```ts
interface WormSnapshot { id: string; x: number; y: number; vx: number; vy: number; hp: number; alive: boolean; }
interface CircleCut { x: number; y: number; r: number; seq: number; } // seq is terrain-cut monotonic, not input seq
```

A `turn_snapshot` larger than ~16 KB should be chunked or compressed; in practice we expect <1 KB (8 worms * ~60 bytes + a few dozen cuts * 32 bytes).

### Turn arbitration (server)

Server tracks:
- `teamOrder: string[]` - canonical cycle (shuffled once at start_game).
- `currentTeamIdx: number`.
- `turnStartedAtMs: number`.
- `turnDurationMs`: from tuning (currently 45000; Colyseus server imports from a small shared constants module to avoid drift).

Tick loop at 20Hz (Colyseus' setSimulationInterval):
- Update `turnEndsAt = turnStartedAtMs + turnDurationMs` once per turn; update state.turnEndsAt so clients can render a timer.
- If `Date.now() > turnEndsAt + SETTLE_GRACE_MS` AND active client has not sent `turn_snapshot`, force-advance: use last known worm positions + no new cuts as a synthetic snapshot, emit `turn_resolved`, advance turn. SETTLE_GRACE_MS = 6000 (covers client-side max settle time).
- `advanceTurn()`:
  - Increment currentTeamIdx, skipping teams with no owner or dead-owner, or whose owner has left.
  - If only one team has alive worms (tally tracked via `turn_snapshot.worms`), emit `game_over` with winner.
  - Otherwise pick next alive worm in that team (team's worm list + round-robin).
  - Set `currentTeamId`, `currentWormId`, `turnStartedAtMs`, `turnSeq++`.
  - Emit `turn_resolved` (with the most recent snapshot so latecomers have state; or emit it synthetically with last-known positions).

### Client behavior

`GameScene`:

```ts
// init(data) - already accepts { mapId, seed, teams, room }
// When room is present (networked):
this.isNetworked = true;
this.mySessionId = data.room.sessionId;

// After create():
data.room.state.listen("currentTeamId", (teamId) => this.onActiveTeamChanged(teamId));
data.room.state.listen("turnEndsAt", (t) => this.syncTurnTimer(t));
data.room.onMessage("input_walk", (p) => this.applyRemoteInput("walk", p));
data.room.onMessage("input_jump", () => this.applyRemoteInput("jump", {}));
// ... etc
data.room.onMessage("turn_resolved", (p) => this.applyTurnSnapshot(p));
data.room.onMessage("game_over", (p) => this.onServerGameOver(p));
```

TurnManager in networked mode:
- Does not own team rotation - server decides next team via `turn_resolved`.
- Continues to track settle state locally (so the active player's client knows when to send `turn_snapshot`).
- Emits turn-end signal as before but the client-local turn-end converts into `send("turn_snapshot", ...)` instead of directly cycling.

InputController in networked mode:
- `updateNetworkOwnership(myOwnedTeamId, currentTeamId)` sets `this.inputAllowed = myOwnedTeamId === currentTeamId`.
- Unchanged otherwise. When disabled, worms are driven by remote input replay.

Remote input replay:
- `applyRemoteInput(type, payload)` looks up the currently-active worm (identified by server's `currentWormId`) and calls the matching Worm method (walk/jump/backflip/setAimAngle/setAimPower/setFacing). For `fire`, call `GameScene.fire()` on the active worm.
- Fire-replay: the remote firing player sent us their aim angle + power + selected weapon via prior messages; when their `input_fire` arrives, we reuse that state. Ammo is decremented locally per-client (consistent since all clients see the same inputs).

Turn-end snapshot (active player only):
```ts
// In GameScene.onTurnEndingFromLocalSim():
if (this.isNetworked && this.iAmActive()) {
  const snap = buildTurnSnapshot(this.teams, this.terrain.pendingCuts);
  this.room!.send("turn_snapshot", snap);
}
```

Snapshot apply:
```ts
function applyTurnSnapshot(s: TurnResolvedMessage) {
  for (const w of s.worms) setWormState(this.allWorms, w);
  for (const c of s.terrainCuts) this.terrain.cutCircle(c.x, c.y, c.r);
  this.turnManager.adoptServerTurn(s.turnSeq, s.nextTeamId, s.nextWormId);
}
```

`setWormState` snaps position + velocity + hp. For non-active worms this is the first sync in a while; they should be at rest (physics sleep), so snapping is visually invisible.

### Spectator HUD

New scene-local overlay (existing `TurnHUD`-style object):

```ts
// src/ui/SpectatorHUD.ts - NEW
// Shows "Waiting for {nickname}..." at the top-center when:
//   - networked AND currentTeamOwnerSessionId !== mySessionId
// Hidden in offline mode or when the active team has no owner (brief, between skips).
```

## Workstreams

Two parallel Sonnet agents + one small follow-up. Parallel because the message contract is fully fixed in this plan; W1 and W2 don't need to see each other's code to agree on shapes.

### W1 - Server game-phase state + TurnArbiter (worms-ws1)
**Branch:** `feature/epic-9-server`

Files:
- `server/src/state/LobbyState.ts` - add new fields per schema section; keep existing lobby fields unchanged.
- `server/src/game/TurnArbiter.ts` - NEW. Constructor: `(room: GameRoom)`. Methods: `start(teamOrder, turnDurationMs)`, `advanceTurn()`, `onTick(dtMs)`, `onSnapshot(snap)`, `forceAdvance()` (timeout path). Tracks team alive-counts from snapshots; emits server-side callbacks back into GameRoom for broadcasts.
- `server/src/state/constants.ts` - NEW. Shared `TURN_DURATION_MS = 45000`, `SETTLE_GRACE_MS = 6000`, alphabet for codegen (eventually shared; OK to duplicate for this epic).
- `server/src/rooms/GameRoom.ts`:
  - Rewrite `start_game` handler: assign teams to sessionIds by LobbyState.players join order (track `joinedAt` for stable sort), shuffle teamOrder with server seed, populate `state.teamOrder`, instantiate `TurnArbiter`, call `arbiter.start()`, broadcast `game_started` as today (plus teams now carry `ownerSessionId`), set phase to "playing".
  - Add `input_*` handlers that validate sender sessionId == owner of `state.currentTeamId`, then `this.broadcast(type, payload, { except: client })`.
  - Add `turn_snapshot` handler that forwards to `TurnArbiter.onSnapshot`.
  - `onDispose`/`onLeave`: notify TurnArbiter so it can skip disconnected owners.
- `server/src/rooms/GameRoom.test.ts` - add tests:
  - `start_game` assigns team owners deterministically from player join order.
  - Non-active player's `input_walk` is dropped silently.
  - Active player's `input_walk` is broadcast to everyone else but not back to sender.
  - `turn_snapshot` from active player triggers `turn_resolved` broadcast.
  - Timed-out turn (no snapshot) force-advances with last known state.
- `server/src/game/TurnArbiter.test.ts` - NEW. Unit tests for advanceTurn skipping ownerless teams, win detection.

Commits (expected 6, exact messages):
1. `feat(server): extend LobbyState with game-phase fields`
2. `feat(server): TurnArbiter class + unit tests`
3. `feat(server): start_game assigns team ownership by join order`
4. `feat(server): input relay handlers validate active player`
5. `feat(server): turn_snapshot -> turn_resolved broadcast`
6. `test(server): GameRoom integration tests for turn arbiter flow`

Every commit footer:
```
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

Acceptance:
- `cd server && npm run typecheck` passes.
- `cd server && npm test` passes (>=24 total: existing 17 + 7 new; ok if more).
- `cd server && timeout 3 npm run dev` starts clean.

### W2 - Client network wiring (worms-ws2)
**Branch:** `feature/epic-9-client`

Files:
- `src/net/types.ts` - add `WormSnapshot`, `CircleCut`, `TurnResolvedMessage`, `GameOverMessage`, input message types. Update `LobbyState` interface with new game-phase fields. Update `TeamInit` with `ownerSessionId: string`.
- `src/scenes/GameScene.ts`:
  - Detect networked mode from `this.room`.
  - On turn state change (subscribed to `room.state.listen("currentTeamId")`), call `inputController.setInputAllowed(iAmActive())` and update SpectatorHUD.
  - Wire `room.onMessage` handlers for all input_* + turn_resolved + game_over.
  - Send local inputs via `room.send(...)` when active AND networked.
  - On TurnManager's turn-end event, if networked AND active, build snapshot and send; suppress TurnManager's local cycleTeam (server sends authoritative).
  - Keep offline path untouched (room undefined -> no network code runs).
- `src/scenes/game/networkBridge.ts` - NEW. Pure module `applyRemoteInput(worm: Worm, type: string, payload: any)`, `buildTurnSnapshot(teams: Team[], cuts: CircleCut[]): TurnSnapshotMessage`, `setWormFromSnapshot(worm: Worm, snap: WormSnapshot)`. Unit-testable without Phaser or planck.
- `src/scenes/game/networkBridge.test.ts` - NEW. Tests: applyRemoteInput maps each input type to the right worm method (use a mock Worm); buildTurnSnapshot serializes exactly the fields we need; setWormFromSnapshot snaps position + velocity + hp.
- `src/state/TurnManager.ts`:
  - Add `adoptServerTurn(seq, teamId, wormId)` method that sets the active worm directly without running internal machine cycle.
  - Add a flag `this.externallyDriven = false` default; when true, internal TICK/SETTLED/END_TURN events do NOT trigger cycleTeam.
- `src/input/InputController.ts` - no schema change; relies on existing `setInputAllowed`.
- `src/ui/SpectatorHUD.ts` - NEW. Phaser.Text at top-center; `show(nickname)` / `hide()`. No input.
- `src/scenes/GameScene.ts` - mount SpectatorHUD in create(); toggle in onActiveTeamChanged.
- No changes to weapon code, terrain code, Worm class.

Commits (expected 8):
1. `chore(net): add game-phase + input message types`
2. `feat(net): networkBridge pure helpers + tests`
3. `feat(scene): GameScene detects networked mode; wires room listeners`
4. `feat(state): TurnManager externallyDriven mode + adoptServerTurn`
5. `feat(input): gate InputController on turn ownership in networked mode`
6. `feat(scene): forward local inputs to server + apply remote replays`
7. `feat(scene): send turn_snapshot on turn end; apply turn_resolved`
8. `feat(ui): SpectatorHUD "waiting for..." overlay`

Every commit footer:
```
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

Acceptance:
- `npm run typecheck` passes.
- `npm test` passes (117 baseline + >=6 new = >=123).
- `npm run build` succeeds.
- `npm run dev` starts cleanly.
- `/?offline=1` still works end-to-end (no network code runs).

### W3 - Docs + smoke (small, after W1+W2 merge to integration branch)
**Branch:** `feature/epic-9-docs`

Files:
- `docs/ROADMAP.md` - flip row 9 to Done, point at plan.
- `README.md` - update smoke test section with 2-tab networked play steps.
- `CLAUDE.md` - add "Game-phase state" short note so future epics know schema fields are on LobbyState not a separate GameState.

Commits (expected 2):
1. `docs(epic-9): ROADMAP + README two-tab smoke test`
2. `docs(epic-9): CLAUDE.md note on post-lobby schema shape`

## Smoke test (post-merge)

1. Two terminals: `cd server && npm run dev`, `npm run dev`.
2. Tab A (host): create room, nickname "Alice", copy code.
3. Tab B (incognito): `?room=CODE`, nickname "Bob", join.
4. Both hit Ready, Alice picks a map, Alice starts.
5. Both tabs load GameScene on the same map with same seed.
6. Alice's tab is active (team 0); SpectatorHUD shows "Waiting for Alice..." on Bob's tab.
7. Alice walks her worm right. Bob's tab renders the walk with slight lag.
8. Alice fires the bazooka. Bob sees the projectile fly, terrain cut, damage applied.
9. Alice ends turn. Server swaps to Bob (team 1). Bob's InputController unlocks. Alice's SpectatorHUD shows "Waiting for Bob...".
10. Physics drift over several turns: if a worm drifts on Bob's tab, turn_resolved snaps it back at the next turn boundary. Should not be visually jarring for resting worms.
11. Kill one team's last worm: `game_over` fires, both tabs show the existing win banner.
12. Refresh Bob's tab mid-turn: Bob falls out of the room (Epic 10 handles rejoin). For now: Alice continues solo or the server auto-ends the game when Bob's team has no owner.

## Bugcheck targets

- **HIGH**: input validation - server must reject any `input_*` or `turn_snapshot` from a client whose sessionId != owner of current team. Include test with a crafted message from the non-active client.
- **HIGH**: server timeout path when active client disconnects mid-turn. Must force-advance without the client returning.
- **HIGH**: turnSeq replay - if turn_resolved message arrives twice (network retry), applying it twice could double-apply cuts. Idempotency via turnSeq.
- **MEDIUM**: ammo divergence - all clients decrement ammo locally on `input_fire` replay. Sanity check they agree; if not, trust the active player's snapshot `hp` field but not ammo (ammo is deterministic from fire count).
- **MEDIUM**: team-skip when all remaining teams are unowned (e.g., 2-player game where both players disconnect). Server must `game_over` gracefully.
- **MEDIUM**: the `game_over` message from server vs the client's local TurnManager gameOver signal - only server-side should be trusted in networked mode; client's local detection is advisory.
- **LOW**: large turn_snapshot messages - mitigated by small game size (8 worms max, cuts per turn typically <10).

## Risks + mitigations

- **Physics drift between clients** - mitigated by end-of-turn snapshot. Within a turn, positions can diverge a few pixels; this is visually invisible for walking worms and a few pixels won't change weapon outcomes.
- **Remote input lag** - walking looks stuttery if network jitter is bad. Acceptable for this epic; fix in Epic 9b if needed (buffered playback, 100ms delay).
- **Ammo desync** - if a client drops an `input_fire` message, its ammo count drifts. Worst case shows 1 extra shot available that server won't replay. Low severity; can add snapshot to cover.
- **The "offline" path must stay alive** - regressions there break single-device dev. W2 includes explicit test that `room === undefined` bypasses all network code.

## Reference files
- `server/src/rooms/GameRoom.ts` (current stub start_game -> phase=playing, no game loop)
- `src/scenes/GameScene.ts` (has `room?: Room` hook at line 64)
- `src/state/TurnManager.ts` (timer-driven; needs externally-driven mode)
- `src/state/turnMachine.ts` (xstate; do NOT rewrite - layer on top)
- `src/worm/Worm.ts` (all mutation methods already exist; remote inputs just call them)
- `src/input/InputController.ts` (`setInputAllowed(bool)` is the gate)
- [Colyseus docs on broadcast](https://docs.colyseus.io/server/room/#broadcasting-to-all-clients)
- [Colyseus ArraySchema](https://docs.colyseus.io/state/schema/#arrayschema)

## Post-merge notes
- Skill debt from last epic: `/frontend-design` was added to CLAUDE.md as a required step. This epic's UI surface is minimal (one passive banner) - the plan consciously avoids net-new interactive UI so `/frontend-design` invocation is not needed. If a follow-up adds interactive net UI (disconnect banner, reconnect prompt), that follow-up MUST invoke it.
- `/review` recommended on integration branch before PR since this is the riskiest epic to date.
