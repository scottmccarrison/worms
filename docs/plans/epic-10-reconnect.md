# Epic 10 - Reconnection + Disconnect Handling

Closes #10. Wraps the Colyseus `allowReconnection` API around the existing lobby + turn arbiter so a dropped TCP / page reload / flaky wifi hiccup no longer kills a match. Adds a 60s grace window per player, explicit "disconnected" UI, turn-timer pause when the active owner drops, and team forfeit on grace expiry. Host migration in the lobby-phase is re-verified to still work (Epic 8 behavior).

## Scope

### In scope
- Server `LobbyPlayer` schema gains `disconnected: boolean` + `disconnectGraceEndsAt: number` (ms epoch).
- Server `onLeave` rewritten around Colyseus' `allowReconnection(client, 60)` pattern. During the grace window, the player's slot is reserved and `disconnected=true` propagates via schema replication. Leave is only "final" after grace expires or the client leaves via consented leave (tab close / `leave()` call).
- `DISCONNECT_GRACE_MS = 60_000` constant in `server/src/state/constants.ts`.
- Turn arbiter freezes the active-team turn timer while the owner is disconnected. Resumes with remaining time on reconnect. If grace expires mid-turn, team auto-forfeits (all team worms marked dead via synthetic snapshot, advanceTurn runs).
- Non-active owner disconnect during game phase: turn continues as normal for whoever is currently active; if the disconnected owner's next turn comes up while they're still gone, that team is auto-skipped (existing arbiter skip logic + disconnected flag as an additional skip predicate).
- Client caches `room.reconnectionToken` in `localStorage` keyed by room code. On cold boot (page reload, tab crash), `BootScene` looks up the cached token and attempts `client.reconnect(token)` BEFORE falling back to the normal join / home flow.
- LobbyScene: shows "(disconnected)" suffix next to disconnected players; if WE lose connection, shows a "Reconnecting..." overlay with an auto-retry backoff (1s, 2s, 4s, ~30s cap).
- GameScene: HUD shows "(disconnected, 47s)" on the active-team banner when the active owner is gone; local "Reconnecting..." overlay reuses the LobbyScene pattern; turn-timer UI freezes naturally since it reads `turnEndsAt` from server state and server freezes it.
- Host migration in lobby phase is preserved: if host disconnects AND grace expires (or consented leave), earliest-joined remaining player is promoted. Existing behavior; Epic 10 just adds the grace window so the host can come back.
- Tests: server - LobbyPlayer disconnected flag roundtrip, onLeave grace window + reconnect, active-owner disconnect pauses turn, grace expiry forfeits team, host disconnect + reconnect preserves isHost. Client - networkBridge already tested; add tests for the token-persistence helper and LobbyScene's reconnecting view model.

### Out of scope (tracked separately)
- "I closed the tab two hours ago, let me rejoin my old game" - reconnectionToken is only useful within `DISCONNECT_GRACE_MS`. A cold recovery UX that tries a stale token and shows a useful error is optional polish; deferring.
- Multi-device move (start game on phone, finish on laptop) - would need a server-side playerId tied to a signed cookie; explicit non-goal for a casual friends-game.
- Persisting match state (worms positions, health) to disk so server crashes don't drop the game - huge scope; matches ADR-001's "ephemeral games" decision.
- Exponential-backoff retry limits beyond ~30s - if grace expired, the retry fails and the client falls back to the home screen with an error toast. That's correct; retrying forever doesn't help.
- Surface LatencyMonitor or ping indicators - nice-to-have; file a follow-up if users want it.

## Architecture

### State schema additions

```ts
// server/src/state/LobbyState.ts
export class LobbyPlayer extends Schema {
  // ...existing fields
  @type("boolean") disconnected = false;
  @type("number") disconnectGraceEndsAt = 0; // Date.now() + DISCONNECT_GRACE_MS; 0 means not disconnected
}
```

No new fields on `LobbyState` itself - the per-player flag is sufficient.

### Server onLeave rewrite

Key idea: `await allowReconnection(client, 60)` inside `onLeave` blocks until the client reconnects OR the grace expires. The Colyseus runtime holds the sessionId + state during the wait, so a reconnect appears to the room as a seamless re-join (no new `onJoin` is fired for the reconnect; the existing state + listeners all remain valid on both sides).

```ts
async onLeave(client: Client, consented: boolean): Promise<void> {
  const wasHost = this.state.hostSessionId === client.sessionId;
  const player = this.state.players.get(client.sessionId);

  // Consented leave: tab close / explicit `leave()` call. Skip grace.
  if (consented) {
    this.handleFinalLeave(client, player, wasHost);
    return;
  }

  // Flag the disconnect so other clients can render it. Notify arbiter
  // if this is the active owner so the turn timer pauses.
  if (player) {
    player.disconnected = true;
    player.disconnectGraceEndsAt = Date.now() + DISCONNECT_GRACE_MS;
    if (this.state.phase === "playing" && this.arbiter) {
      this.arbiter.onOwnerDisconnected(client.sessionId);
    }
  }

  try {
    await this.allowReconnection(client, 60); // seconds
    // Success: client reconnected.
    if (player) {
      player.disconnected = false;
      player.disconnectGraceEndsAt = 0;
      if (this.state.phase === "playing" && this.arbiter) {
        this.arbiter.onOwnerReconnected(client.sessionId);
      }
    }
    console.log(`${client.sessionId} reconnected to ${this.roomId}`);
  } catch {
    // Grace expired (or room was disposed). Finalize the leave.
    this.handleFinalLeave(client, player, wasHost);
  }
}

private handleFinalLeave(
  client: Client,
  player: LobbyPlayer | undefined,
  wasHost: boolean,
): void {
  const wasActiveOwner =
    this.state.phase === "playing" &&
    player?.ownerOfTeamId === this.state.currentTeamId &&
    this.state.currentTeamId !== "";

  this.state.players.delete(client.sessionId);

  // Post-lobby: let the arbiter know so it can forfeit the team.
  if (this.state.phase === "playing" && this.arbiter && player?.ownerOfTeamId) {
    this.arbiter.onTeamForfeit(player.ownerOfTeamId);
    if (wasActiveOwner) {
      this.arbiter.forceAdvance();
    }
  }

  // Host promotion (unchanged from Epic 8).
  if (wasHost && this.state.players.size > 0) {
    // ...existing earliest-joined promotion
  } else if (this.state.players.size === 0) {
    this.state.hostSessionId = "";
    this.scheduleDisposeIfEmpty();
  }

  console.log(`${client.sessionId} left ${this.roomId} (finalLeave, wasHost=${wasHost})`);
}
```

### TurnArbiter additions

New methods:
- `onOwnerDisconnected(sessionId)`: if this sessionId owns the current team, stop the turn timer. Concretely: store the remaining time (`turnEndsAt - Date.now()`), set `turnEndsAt` to a sentinel (e.g. `Number.MAX_SAFE_INTEGER`) so the client HUD stops counting down, and set a `pausedRemainingMs` field. Skip force-advance checks while paused.
- `onOwnerReconnected(sessionId)`: if this sessionId owns the current team AND we're paused, resume by setting `turnEndsAt = Date.now() + pausedRemainingMs` and clearing the paused flag.
- `onTeamForfeit(teamId)`: mark all worms in the team as dead in the alive tally. If this brings the game to one remaining team, `declareGameOver`. Otherwise emit a synthetic `turn_resolved` that includes zero'd-hp snapshots for the forfeited team so all clients render them as dead; advanceTurn runs next.

Update `advanceTurn` to treat `disconnected === true` owners as "not a valid next team" (same as empty ownerSessionId) while still inside the grace window. This way a non-active player's disconnect skips their upcoming turn until they either return or are fully forfeit.

### Client reconnection flow

**Token persistence (`src/net/clientStorage.ts` - NEW):**

```ts
const KEY = "worms.roomTokens.v1";

interface StoredToken { code: string; roomId: string; token: string; ts: number; }

export function saveRoomToken(code: string, roomId: string, token: string): void {
  const all = readAll();
  all[code.toUpperCase()] = { code, roomId, token, ts: Date.now() };
  // Prune entries older than 10 min so we don't try stale tokens.
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [k, v] of Object.entries(all)) if (v.ts < cutoff) delete all[k];
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* private mode, ignore */ }
}

export function readRoomToken(code: string): StoredToken | null {
  const all = readAll();
  const t = all[code.toUpperCase()];
  if (!t) return null;
  if (Date.now() - t.ts > 10 * 60 * 1000) return null;
  return t;
}

export function clearRoomToken(code: string): void {
  const all = readAll();
  delete all[code.toUpperCase()];
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch {}
}

function readAll(): Record<string, StoredToken> {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "{}"); } catch { return {}; }
}
```

**BootScene flow:**

```ts
async create() {
  const params = parseUrlParams(window.location.search);
  if (params.offline) {
    this.scene.start("GameScene", { mapId: params.mapId });
    return;
  }
  const client = createNetClient();

  // If we have a URL room code AND a cached token, try reconnection first.
  if (params.autoJoinCode) {
    const stored = readRoomToken(params.autoJoinCode);
    if (stored) {
      try {
        const room = await client.reconnect(stored.roomId, stored.token);
        // Success: jump straight into LobbyScene with the live room.
        saveRoomToken(params.autoJoinCode, room.roomId, room.reconnectionToken);
        this.scene.start("LobbyScene", { netClient: client, room });
        return;
      } catch {
        // Stale or invalid; fall through to normal flow.
        clearRoomToken(params.autoJoinCode);
      }
    }
  }
  this.scene.start("LobbyScene", { netClient: client, autoJoinCode: params.autoJoinCode });
}
```

**LobbyScene / GameScene: retain reconnectionToken after join.**

Wherever we currently do `const room = await client.create(...)` or `client.joinById(...)`, immediately after `saveRoomToken(code, room.roomId, room.reconnectionToken)`. Also save on every `room.state.onChange` where code or sessionId settles (to handle race: token available before state.code lands, so initial save might miss code). Simplest: call `saveRoomToken(room.state.code, ...)` once `room.state.code` is non-empty.

**Reconnecting overlay:**

Shared `ReconnectingOverlay` class in `src/ui/ReconnectingOverlay.ts`. Used by LobbyScene AND GameScene. Mounts over the current scene, shows "Reconnecting... (attempt N)". Auto-hides on success or redirects to home on final failure.

Client-side detection of disconnect:
```ts
room.onLeave((code) => {
  // code === 1000: consented / normal close. Everything else = unexpected drop.
  if (code === 1000) return;
  this.startReconnectionLoop();
});

async startReconnectionLoop() {
  const token = readRoomToken(this.code);
  if (!token) return this.scene.start("LobbyScene", { goHome: true });
  this.overlay.show();
  const backoffs = [500, 1000, 2000, 4000, 8000, 16000, 30000];
  for (const delay of backoffs) {
    await sleep(delay);
    try {
      const newRoom = await this.netClient.reconnect(token.roomId, token.token);
      this.overlay.hide();
      this.onReconnected(newRoom);
      return;
    } catch { /* keep trying */ }
  }
  // All attempts failed.
  this.overlay.showFinal("Lost connection. Returning to home.");
  await sleep(2000);
  clearRoomToken(this.code);
  this.scene.start("LobbyScene", { netClient: this.netClient });
}
```

### Disconnected indicator in lobby + game HUD

**LobbyScene (room view):** `renderModel.toViewModel` already renders player rows. Add `disconnected: boolean` to `PlayerRow`; update `renderRoom` to show `{nickname} (disconnected)` with a dimmed color (e.g. `#888`) when `disconnected === true`.

**GameScene HUD:** new small overlay on the SpectatorHUD class or a sibling "DisconnectedBanner" that reads `room.state.players` for any players with `disconnected === true`, maps to their `ownerOfTeamId`, and shows a red tag under the per-team indicator. Include a seconds countdown based on `disconnectGraceEndsAt - Date.now()` (update every 250ms; no need for 60fps).

### Host migration mid-game

Already handled: in game phase the host has no special role (Epic 9 arbiter owns turn rotation). The `hostSessionId` field is only read by LobbyScene UI; if someone is marked host but disconnected, UI shows the disconnected tag and nothing else breaks. Epic 10 doesn't touch this.

## Workstreams

### W1 - Server reconnection + arbiter turn pause (worms-ws1)
**Branch:** `feature/epic-10-server`

Files:
- `server/src/state/constants.ts` - add `DISCONNECT_GRACE_MS = 60_000`.
- `server/src/state/LobbyState.ts` - add `disconnected`, `disconnectGraceEndsAt` fields.
- `server/src/rooms/GameRoom.ts`:
  - Refactor `onLeave` to async with the `allowReconnection(client, 60)` pattern.
  - Extract `handleFinalLeave(client, player, wasHost)` helper.
  - Mark player `disconnected = true` at start, clear on successful reconnect, delete on final leave.
  - Call `arbiter.onOwnerDisconnected` / `onOwnerReconnected` / `onTeamForfeit` / `forceAdvance` at the right points.
- `server/src/game/TurnArbiter.ts`:
  - Add `pausedRemainingMs: number | null = null`.
  - Add `onOwnerDisconnected(sessionId)`, `onOwnerReconnected(sessionId)`, `onTeamForfeit(teamId)`.
  - Modify `onTick` to skip forceAdvance while paused.
  - Update `advanceTurn` to skip teams whose owner has `disconnected === true` (read from room's LobbyState).
  - Add adapter interface method `getPlayerDisconnected(sessionId): boolean`.
- `server/src/rooms/GameRoom.test.ts` - add 4+ tests:
  - Unexpected disconnect flags player and preserves slot (reconnect restores).
  - Active-owner disconnect pauses turn; reconnect resumes with remaining time.
  - Grace expiry forfeits team (all worms marked dead in the next snapshot).
  - Host disconnect + reconnect preserves `isHost` flag.
- `server/src/game/TurnArbiter.test.ts` - add unit tests for pause/resume + team forfeit.

Commits (6):
1. `feat(server): add disconnect + grace fields to LobbyPlayer schema`
2. `feat(server): onLeave wraps allowReconnection with 60s grace`
3. `feat(server): arbiter pauses turn when active owner disconnects`
4. `feat(server): arbiter forfeits team on grace expiry + next-turn skip`
5. `test(server): reconnection + forfeit integration tests`
6. `test(arbiter): unit tests for pause/resume + forfeit`

Every commit footer:
```
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

Acceptance:
- `cd server && npm run typecheck` passes.
- `cd server && npm test` passes (>=30 tests: baseline 26 + 4 new).
- `cd server && timeout 3 npm run dev` starts clean.
- `cd /home/scott/worms-ws1 && npm run lint` passes.

### W2 - Client reconnection flow + UI (worms-ws2)
**Branch:** `feature/epic-10-client`

Files:
- `src/net/clientStorage.ts` - NEW. Token persistence per the spec.
- `src/net/clientStorage.test.ts` - NEW. 5+ tests (save/read/clear/prune/localStorage-unavailable).
- `src/ui/ReconnectingOverlay.ts` - NEW. Shared overlay class (Phaser Text + Rect) with `show(attempt?)`, `hide()`, `showFinal(msg)`.
- `src/scenes/BootScene.ts` - attempt `client.reconnect(storedRoomId, storedToken)` BEFORE routing to LobbyScene when both URL code + cached token exist. On failure, clearRoomToken + fall through.
- `src/scenes/LobbyScene.ts`:
  - After `client.create` / `joinById`, save the reconnection token via `saveRoomToken(room.state.code, room.roomId, room.reconnectionToken)` once `room.state.code` is non-empty.
  - Hook `room.onLeave(code => ...)`. If `code !== 1000`, start the backoff loop and show `ReconnectingOverlay`.
  - Update `renderModel.toViewModel` + `renderRoom` to render disconnected players with a dimmed color and "(disconnected)" suffix.
  - Pass a fresh `room` to `scene.start("LobbyScene", { netClient, room })` on successful reconnect. Add an `LobbySceneData` variant `{ netClient, room }` (skip home, go straight to room view).
- `src/scenes/GameScene.ts`:
  - Hook `room.onLeave` similarly.
  - Render disconnected-owner indicator in the SpectatorHUD: when the active owner is disconnected, show "(disconnected, Ns)" with the grace countdown. Update at 250ms.
  - Do NOT mutate local sim state on reconnect; the server will catch us up via `turn_resolved` at turn boundary.
- `src/scenes/lobby/renderModel.ts` - add `disconnected: boolean` to `PlayerRow`; surface from `LobbyPlayer.disconnected`.
- `src/scenes/lobby/renderModel.test.ts` - update to cover the new field.
- `src/net/types.ts` - extend `LobbyPlayer` interface with `disconnected: boolean`, `disconnectGraceEndsAt: number`.

Commits (8):
1. `feat(net): localStorage roomToken persistence + tests`
2. `feat(net): LobbyPlayer disconnected + graceEndsAt interface fields`
3. `feat(scene): BootScene tries client.reconnect on cached token`
4. `feat(scene): LobbyScene saves reconnectionToken + renders (disconnected) suffix`
5. `feat(ui): ReconnectingOverlay (shared between Lobby + GameScene)`
6. `feat(scene): LobbyScene retry loop with backoff on unexpected drop`
7. `feat(scene): GameScene retry loop + disconnected-owner HUD indicator`
8. `test(lobby): renderModel disconnected flag propagation`

Every commit footer:
```
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

Acceptance:
- `npm run typecheck` passes.
- `npm run lint` passes (biome).
- `npm test` passes. Baseline 131; expect >=136 (5+ new).
- `npm run build` succeeds.
- `/?offline=1` still works (no reconnect code runs, no localStorage touched when room is undefined).

### W3 - Docs (after W1 + W2 integrate)
**Branch:** `feature/epic-10-docs`

Files:
- `docs/ROADMAP.md` - flip row 10 to Done, point at plan.
- `README.md` - add a short "Reconnection" paragraph near the Multiplayer smoke test, noting the 60s grace + localStorage token.
- `CLAUDE.md` - short note on the disconnect + grace mechanic (so future epics know the constant exists).

Commits (2):
1. `docs(epic-10): ROADMAP + README reconnection section`
2. `docs(epic-10): CLAUDE.md note on disconnect grace`

## Smoke test (post-merge)

Requires two browser tabs + a way to kill the server's network layer (Chrome DevTools Network -> Offline toggle).

1. Terminals 1 + 2: server + client.
2. Tab A nickname "Alice", Create Room, copy code.
3. Tab B nickname "Bob", join with code.
4. Both Ready, Alice starts.
5. It's Alice's turn. On Tab A, DevTools Network -> go Offline.
6. Expect Tab A's Reconnecting overlay to appear within ~1s. Tab B's turn HUD shows "(disconnected, 60s)" countdown and the turn timer freezes.
7. Within 60s, go Online on Tab A. Expect overlay to clear, turn resumes with remaining time intact.
8. Repeat but wait > 60s before going back online. Expect: Alice's team is forfeit (all worms die on Tab B's screen), Bob gets remaining turns and wins.
9. Repeat scenario: mid-game Alice reloads her tab. `?room=CODE` in URL triggers BootScene's reconnect path (token was cached). Alice rejoins seamlessly.
10. Host disconnect in lobby phase: Alice = host, closes tab. Within 60s reopens with `?room=CODE`; still host. After 60s (different test): Bob gets promoted to host.

## Bugcheck targets

- **HIGH**: confirm `allowReconnection` does NOT re-fire `onJoin` (it shouldn't in 0.15). If it does, our existing onJoin validates nickname + assigns a color; re-assigning colors on reconnect would break. Include a test.
- **HIGH**: token theft - anyone with the reconnectionToken can pretend to be that player. Mitigation: tokens expire after grace, localStorage is per-origin, and this is a friends-game threat model. Document + accept.
- **HIGH**: double-reconnect races - if client loses + regains network twice in quick succession, two `client.reconnect` calls could be in-flight. Ensure the second one fails gracefully rather than creating a ghost session.
- **MEDIUM**: arbiter pause + forceAdvance race - if the active owner disconnects at the exact moment forceAdvance fires (turn timer expired), what wins? Plan says pause takes precedence: forceAdvance checks `pausedRemainingMs !== null` and skips.
- **MEDIUM**: grace timer drift - `disconnectGraceEndsAt` is set once at onLeave; if the server clock is wrong, clients show wrong seconds. Low priority (server clock is authoritative anyway).
- **MEDIUM**: room.state.code may be empty for a brief moment after create/join before the first state patch arrives. saveRoomToken MUST wait for non-empty code.
- **LOW**: localStorage full / blocked / private mode - saveRoomToken catches the throw; reconnect falls back to home screen, acceptable.
- **LOW**: `ReconnectingOverlay` blocks input even in offline / lobby-only cases. Make sure it's destroyed on scene shutdown so it doesn't leak across scene restarts.
- **LOW**: if a player's color was taken by someone else during their disconnect (unlikely: colors are immutable once assigned in current lobby schema), auto-assign. Current Epic 8 keeps colors stable so no change needed - confirm.

## Risks + mitigations

- **The existing integration tests poll `state.players.size` immediately after `room.leave()`** and assume the player is deleted synchronously. With the allowReconnection pattern, non-consented leaves now hold the slot for 60s. Ensure tests use `room.leave(true)` (consented) OR explicitly assert that the player shows `disconnected=true` during the grace window.
- **Colyseus `allowReconnection` can only be called ONCE per onLeave invocation**. If we await it and it succeeds, great. If we await and it throws (grace expired), we call `handleFinalLeave`. Make sure we do NOT call `handleFinalLeave` twice.
- **Turn pause when disconnect grace expires EXACTLY as the turn timer expires**: pick one winner (grace-expiry runs first, forfeits the team, advanceTurn runs; the old turn never force-advances because the team is gone). Cover in a test.
- **Host left as last player**: state.players becomes empty during the grace window but ownerSessionId is still set. Don't schedule emptyRoomDispose until grace expires. Already handled via `handleFinalLeave` calling `scheduleDisposeIfEmpty` only after the delete.

## Reference files
- `server/src/rooms/GameRoom.ts:138-179` - current onLeave (to rewrite)
- `server/src/game/TurnArbiter.ts` - add pause/resume + forfeit
- `server/src/state/LobbyState.ts` - add fields
- `src/scenes/BootScene.ts` - reconnect-on-boot flow
- `src/scenes/LobbyScene.ts` - reconnect loop + disconnected suffix
- `src/scenes/GameScene.ts` - reconnect loop + disconnected indicator
- Colyseus 0.15 docs: `allowReconnection` at https://docs.colyseus.io/server/room/#allowreconnection-client-seconds and `client.reconnect(roomId, token)` at https://docs.colyseus.io/client/client/#reconnect-roomid-string-sessionid-string

## Post-merge notes
- No new touch / UI that requires `/frontend-design` - all additions are passive overlays or text-string tweaks on existing Phaser objects.
- `/review` not required - delta is smaller than Epic 9 and the primary API (Colyseus `allowReconnection`) is well-documented.
