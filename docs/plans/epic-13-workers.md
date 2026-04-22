# Epic 13 - Deploy worms to mccarrison.me/worms (Cloudflare Workers + Durable Objects)

Closes #13. Supersedes the original "Socket.IO on EC2" scope with a Workers + DO architecture that matches mini-golf and skifree-web. Colyseus deps are removed; `server/` is replaced by `worker/`.

Reference implementation: https://github.com/scottmccarrison/mini-golf/tree/main/worker.

## Scope

### In scope
- New `worker/` directory: `wrangler.toml`, `src/index.ts` (fetch handler), `src/room.ts` (DurableObject), plus ports of `codegen.ts` and `turnArbiter.ts` from `server/src/`.
- `[assets]` binding serves the Vite `dist/` as static files under `/worms/*`.
- `[path_prefix]` handling: worker strips `/worms` prefix before routing (mirror mini-golf's PATH_PREFIX pattern).
- WebSocket protocol: hand-rolled JSON messages over a single DO-hibernation-safe WebSocket per client. Full-state broadcast pattern instead of @colyseus/schema patch deltas.
- Reconnection: resume token written to DO storage on join; client caches it in localStorage, includes it on reconnect; DO matches and restores the player's sessionId + color + team.
- Turn timer: DO alarm (hibernation-safe) instead of `setSimulationInterval`.
- Vite `base: '/worms/'` so built asset URLs resolve correctly under the subpath.
- Client transport rewrite: delete `colyseus.js` dep; new `src/net/wsClient.ts` wrapper; `LobbyScene` + `GameScene` adapt to the new state-replication shape.
- `scripts/deploy.sh` at repo root: build client, `wrangler deploy` from `worker/`. Safety gate refuses non-master.
- Tests: ported critical pure-logic tests (codegen, turnArbiter, snapshot sanitize); rewritten transport tests against miniflare/unstable_dev; removed Colyseus-specific harness tests.
- `server/` directory deleted. All Colyseus npm deps removed from `package.json` + `server/package.json`.
- ROADMAP + README updated for the new deploy command.

### Out of scope (tracked separately)
- Leaderboards / D1 persistence (#TBD - follow-up if we ever add).
- Authoritative sim (#45).
- Spectator smoothing (#47).
- Preview / staging environment.
- GH Actions auto-deploy (Epic 14).
- PWA manifest (#34).

## Architecture

```
Browser -> Cloudflare edge -> Worker fetch handler
                                |
                                |-- POST /api/room        -> generate code, create DO, return {code}
                                |-- GET  /api/room/{CODE} -> upgrade WebSocket, route to DO by name=code
                                |-- any other path        -> env.ASSETS.fetch() (serves dist/)
                                     (SPA fallback via wrangler `not_found_handling:"single-page-application"`)

DO per room (sharded by code):
  - holds game state in memory (transient) + DO storage (persistent across hibernation)
  - broadcasts state changes to all attached WebSockets
  - turn timer via state.storage.setAlarm()
  - reconnection via resume token stored on attachment metadata
```

Key DO concepts used:
- **Hibernatable WebSockets** (`state.acceptWebSocket(ws, [tags])`): DO sleeps between messages. State reloaded from storage on wake.
- **WebSocket attachment** (`ws.serializeAttachment({sessionId, team, ...})`): per-connection metadata that survives hibernation.
- **Alarms** (`state.storage.setAlarm(ts)`, `alarm()` handler): hibernation-safe scheduled work (turn timer, empty-room cleanup).

## Directory layout

```
worms/
  worker/
    package.json            (wrangler devDep, no runtime deps)
    wrangler.toml           (routes, DO binding, assets binding)
    tsconfig.json           (targets Workers runtime)
    src/
      index.ts              (fetch handler: matchmake + upgrade + assets)
      room.ts               (DurableObject class)
      turnArbiter.ts        (ported pure logic from server/src/game/)
      codegen.ts            (ported pure logic from server/src/)
      messages.ts           (protocol types: ClientMsg, ServerMsg discriminated unions)
      sanitize.ts           (turn_snapshot validation, ported from server/src/rooms/GameRoom.ts)
    test/
      codegen.test.ts
      turnArbiter.test.ts
      room.test.ts          (via @cloudflare/vitest-pool-workers or unstable_dev)
  src/
    net/
      wsClient.ts           (replaces client.ts - native WebSocket wrapper)
      protocol.ts           (shared with worker/src/messages.ts - see "Shared types" below)
      types.ts              (client-facing types, re-exports from protocol.ts)
    scenes/
      LobbyScene.ts         (rewritten state listeners)
      GameScene.ts          (rewritten state listeners + input relay)
      game/
        networkBridge.ts    (mostly unchanged)
      lobby/
        renderModel.ts      (unchanged)
      BootScene.ts          (reconnect flow updated)
  scripts/
    deploy.sh               (npm run build + wrangler deploy)
  vite.config.ts            (+ base: '/worms/')
  package.json              (removes colyseus.js; adds wrangler devDep at root)
```

`server/` is deleted in the final commit.

## Shared types

We want message-type definitions shared between client and worker. Options:

- **Option 1**: `shared/protocol.ts` at repo root, both tsconfigs include it.
- **Option 2**: Source of truth in `worker/src/messages.ts`, client imports via a path alias.
- **Option 3**: Duplicate, with a contract test that compares the two.

**Plan uses Option 1**. Simplest; both sides see the same file. `worker/tsconfig.json` and root `tsconfig.json` both include `"../shared/**/*"` in their rootDirs.

## Message protocol

Hand-rolled JSON. No binary patch deltas. Messages are pure-JSON objects with a `type` discriminator.

### Room lifecycle
Client connects via `GET /api/room/{CODE}` with `Upgrade: websocket` and optional query params `?nickname=Alice&color=%23ff4444&resumeToken=...`.

### Client -> server messages (all include `{type, seq?}`)
- `set_nickname { nickname }`
- `set_color { color }`
- `set_ready { ready }`
- `select_map { mapId }` (host only)
- `start_game {}` (host only)
- `input_walk { dir }`, `input_jump`, `input_backflip`, `input_aim_angle { angleRad }`, `input_aim_power { power }`, `input_select_weapon { weaponId }`, `input_fire`, `input_end_turn`
- `turn_snapshot { worms, terrainCuts }` (active player only, on turn end)

### Server -> client messages
- `welcome { sessionId, resumeToken, state }` - sent once on connect/reconnect; state is the full LobbyState snapshot.
- `state { ...LobbyState }` - full state broadcast on any change. Size ~1-2 KB with 4 players, sent maybe 10-20 times per match. Trivial vs schema patches.
- `input_walk { ... }` etc - broadcast relay to non-senders (mirrors Epic 9).
- `turn_resolved { turnSeq, worms, terrainCuts, nextTeamId, nextWormId }` - mirrors Epic 9.
- `game_started { mapId, seed, teams }` - mirrors Epic 9.
- `game_over { winnerTeamId }`
- `error { code, message }`

The "full state broadcast on any change" (`state` message) is the big departure from Colyseus. We broadcast the entire LobbyState on any change (nickname, color, ready, disconnected, map selection, phase, turn fields). Total state is <1 KB; broadcasting it on every change is simpler than tracking field-level diffs and fits comfortably in the DO WebSocket bandwidth.

## Workstreams

### W1 - Worker + Durable Object (worms-ws1)
**Branch:** `feature/epic-13-worker`
**Agent:** general-purpose, Sonnet

Files:
- `worker/package.json` - `{"devDependencies": {"wrangler": "^3.x", "@cloudflare/workers-types": "^4.x", "typescript": "^5.x", "vitest": "^1.x"}}`.
- `worker/tsconfig.json` - `{"compilerOptions": {"target": "ES2022", "module": "ES2022", "moduleResolution": "Bundler", "types": ["@cloudflare/workers-types"], "strict": true}, "include": ["src/**/*", "../shared/**/*"]}`.
- `worker/wrangler.toml`:
  ```toml
  name = "worms-api"
  main = "src/index.ts"
  compatibility_date = "2025-01-01"

  routes = [
    { pattern = "mccarrison.me/worms", zone_name = "mccarrison.me" },
    { pattern = "mccarrison.me/worms/*", zone_name = "mccarrison.me" },
  ]

  [vars]
  PATH_PREFIX = "/worms"

  [assets]
  directory = "../dist"
  binding = "ASSETS"
  not_found_handling = "single-page-application"

  [[durable_objects.bindings]]
  name = "ROOMS"
  class_name = "Room"

  [[migrations]]
  tag = "v1"
  new_sqlite_classes = ["Room"]
  ```
- `shared/protocol.ts` - NEW. All message types (ClientMsg, ServerMsg, WormSnapshot, CircleCut, TeamInit, LobbyPlayer, LobbyState).
- `worker/src/index.ts` - fetch handler:
  - Parse URL, strip PATH_PREFIX.
  - `POST /api/room`: generate 4-letter code (using codegen.ts), ensure no collision against existing DOs, create DO by `idFromName(code)`, return `{code}` JSON.
  - `GET /api/room/{CODE}` with Upgrade: websocket -> get DO stub, forward request (DO does the upgrade).
  - All other paths -> `env.ASSETS.fetch(rewrittenRequest)` with prefix stripped.
- `worker/src/room.ts` - Room DurableObject:
  - Constructor loads state from storage (hibernation recovery).
  - `fetch(request)`: handle `/init` from Worker, then WebSocket upgrade.
  - `state.acceptWebSocket(ws, [sessionId])` pattern (hibernatable).
  - `webSocketMessage(ws, msgRaw)`: parse JSON, dispatch by type. Validate (e.g. sender must own currentTeamId for `input_*`).
  - `webSocketClose(ws, code)`: mark player disconnected, schedule alarm for grace expiry.
  - `alarm()`: check all players' grace timers; forfeit any that expired. If room is empty, schedule final cleanup.
  - Full-state broadcast helper: `broadcast(msg)` iterates `state.getWebSockets()` and sends.
  - Resume token: generated on first connect, stored on attachment + in DO storage keyed by token. On new connect with `?resumeToken=X`, look up, restore player's session.
- `worker/src/turnArbiter.ts` - ported from `server/src/game/TurnArbiter.ts`. Removed the Node-specific `setInterval`; replaced with alarm-driven ticking (DO calls `arbiter.onTick` from `alarm()`, which is scheduled every 500ms via `setAlarm(Date.now() + 500)`).
- `worker/src/codegen.ts` - copied verbatim from `server/src/codegen.ts` (pure).
- `worker/src/sanitize.ts` - ported the `sanitiseTurnSnapshot` + `normaliseNickname` from `server/src/rooms/GameRoom.ts`.
- `worker/src/messages.ts` - re-exports from `shared/protocol.ts`.
- `worker/test/codegen.test.ts`, `worker/test/turnArbiter.test.ts` - ported from server tests; replace vitest config to use worker env.
- `worker/test/room.test.ts` - NEW integration tests via `unstable_dev` or `@cloudflare/vitest-pool-workers` (decide during impl; `unstable_dev` is simpler). Covers: create room, join by code, state broadcast on ready, reconnect with token, turn snapshot -> turn_resolved, grace expiry forfeit.

Commits (9, in order):
1. `chore(worker): scaffold worker/ with wrangler.toml + tsconfig`
2. `feat(worker): shared/protocol.ts + worker/src/messages.ts`
3. `feat(worker): port codegen + sanitize as pure modules`
4. `feat(worker): port TurnArbiter (alarm-driven)`
5. `feat(worker): Room DurableObject (lobby + input relay + snapshot)`
6. `feat(worker): resume token reconnection flow`
7. `feat(worker): index.ts fetch handler (matchmake + assets)`
8. `test(worker): integration tests via unstable_dev`
9. `chore: delete server/ (Colyseus backend replaced by worker/)`

Every commit footer:
```
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

Acceptance:
- `cd worker && npm install` succeeds.
- `cd worker && npx wrangler dev --local` starts a local worker on :8787.
- `curl -X POST http://localhost:8787/api/room` returns `{"code":"XXXX"}`.
- `cd worker && npm test` passes (at least 20 tests total: codegen + turnArbiter + room).
- `cd worker && npx wrangler deploy --dry-run` succeeds.

### W2 - Client transport rewrite (worms-ws2)
**Branch:** `feature/epic-13-client`
**Agent:** general-purpose, Sonnet (parallel with W1)

Files:
- `package.json` - remove `colyseus.js` dep. Add `wrangler` as devDep at root for local dev convenience.
- `vite.config.ts` - add `base: '/worms/'`.
- `src/net/wsClient.ts` - NEW. Thin wrapper:
  ```ts
  export interface WsClient {
    createRoom(nickname: string, color: string): Promise<RoomHandle>;
    joinRoom(code: string, nickname: string, color: string, resumeToken?: string): Promise<RoomHandle>;
  }
  export interface RoomHandle {
    sessionId: string;
    state: LobbyState; // latest snapshot
    resumeToken: string;
    onStateChange(cb: (state: LobbyState) => void): () => void; // unsub
    onMessage(type: string, cb: (payload: unknown) => void): () => void;
    send(type: string, payload?: object): void;
    leave(): void;
    onClose(cb: (code: number) => void): () => void;
  }
  ```
  Internally: WebSocket to `/api/room/{CODE}` with query params, parses JSON messages, dispatches `state` updates + typed message callbacks.
- `src/net/protocol.ts` - re-exports from `../../shared/protocol.ts`.
- `src/net/types.ts` - updated: removes Colyseus Schema surface (`LobbyPlayersMap.forEach`, `listen`, etc.). Just plain JSON interfaces matching the protocol.
- `src/net/clientStorage.ts` - minor tweak: store `resumeToken` alongside the existing `code` + `roomId` + `ts` tuple. Actually, with DO the "roomId" IS the code, so storage is simpler: `{code, resumeToken, ts}`.
- `src/scenes/BootScene.ts` - reconnect flow updated: if cached resume token for URL code, call `wsClient.joinRoom(code, nick, color, resumeToken)` which returns the existing session via DO resume logic.
- `src/scenes/LobbyScene.ts` - rewrite `wireRoomStateListeners`: subscribe to `room.onStateChange(newState => { this.state = newState; this.rerender(); })` plus `room.onMessage("error", ...)` and `room.onMessage("game_started", ...)`. Drop the `players.onAdd/Remove/Change/listen` per-field plumbing (which never worked right anyway - see #54 root cause). Full-state replacement is cleaner.
- `src/scenes/GameScene.ts` - similar: `room.onStateChange` for game-phase state updates (currentTeamId, currentWormId, turnEndsAt, disconnected flags). `room.onMessage("input_walk", ...)` etc stay the same. `room.onMessage("turn_resolved", ...)` stays the same.
- `src/scenes/game/networkBridge.ts` - unchanged (it's pure helpers).
- `src/net/reconnectLoop.ts` - simplified: calls `wsClient.joinRoom(code, nick, color, resumeToken)` instead of `client.reconnect(token)`.
- `src/ui/ReconnectingOverlay.ts` - unchanged.
- Tests:
  - `src/net/clientStorage.test.ts` - minor update for new token shape.
  - `src/net/reconnectLoop.test.ts` - minor update.
  - `src/net/wsClient.test.ts` - NEW. Unit tests with a mock WebSocket.
  - `src/scenes/lobby/renderModel.test.ts` - unchanged (operates on state shape).
  - `src/scenes/game/networkBridge.test.ts` - unchanged.
  - `src/scenes/bootSceneOffline.test.ts` - update to assert no wsClient calls in offline mode.

Commits (10, in order):
1. `chore: remove colyseus.js dep`
2. `feat(net): protocol types re-exported from shared/`
3. `feat(net): WsClient wrapper with WebSocket transport`
4. `feat(net): clientStorage stores resumeToken (DO-compatible shape)`
5. `feat(scene): LobbyScene onStateChange replaces field-listeners`
6. `feat(scene): GameScene onStateChange for game-phase fields`
7. `feat(net): reconnectLoop calls WsClient.joinRoom with resumeToken`
8. `feat(scene): BootScene reconnect via WsClient`
9. `chore(vite): base: '/worms/' for subpath deploy`
10. `test: WsClient unit tests + updated clientStorage tests`

Every commit footer:
```
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

Acceptance:
- `npm install` succeeds with no colyseus.js.
- `npm run typecheck` passes.
- `npm test` passes. Baseline 152; minimum 140 expected after rewrite (some transport tests removed).
- `npm run lint` passes.
- `npm run build` succeeds with `dist/` assets referencing `/worms/` prefix.

### W3 - Build integration + deploy script (after W1 + W2 merge to integration)
**Branch:** `feature/epic-13-integrate` (Opus handles directly, small)

`server/` is already deleted in W1's final commit; W3 only cleans up top-level config.

Files:
- `scripts/deploy.sh` - NEW:
  ```bash
  #!/usr/bin/env bash
  set -euo pipefail
  cd "$(dirname "$0")/.."
  branch=$(git rev-parse --abbrev-ref HEAD)
  if [ "$branch" != "master" ]; then
    echo "ERROR: refusing to deploy from '$branch'. Switch to master."
    exit 1
  fi
  if [ -n "$(git status --porcelain)" ]; then
    echo "ERROR: uncommitted changes."
    exit 1
  fi
  echo "Building client..."
  npm run build
  echo "Deploying worker..."
  cd worker
  npx wrangler deploy
  echo
  echo "Live at https://mccarrison.me/worms/"
  ```
- `server/` directory deleted.
- Root `package.json` - remove `colyseus.js`; keep vitest, vite, phaser, planck, etc.
- Root `tsconfig.json` - ensure it doesn't include `server/`; should point only at `src/` + `shared/`.
- `biome.json` - update `files.ignore` to remove `server`.
- `.gitignore` - add `.wrangler/` if not already ignored.
- `docs/ROADMAP.md` - flip row 13 to Done.
- `README.md` - update stack section (remove Colyseus, add Cloudflare Workers + DO). Deploy section: `./scripts/deploy.sh`.
- `CLAUDE.md` - update stack section similarly; note that `worker/` is the backend.
- `docs/decisions/002-cloudflare-workers.md` - NEW ADR documenting the pivot from Colyseus to Workers + DO.

Commits (3):
1. `feat(deploy): scripts/deploy.sh via wrangler`
2. `docs: ADR-002 + ROADMAP + README + CLAUDE.md for Workers pivot`
3. `chore: final lint + typecheck cleanup`

Every commit footer:
```
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

Acceptance:
- `npm run typecheck` passes across entire repo.
- `npm run lint` passes.
- `npm test` passes.
- `npm run build` succeeds.
- `cd worker && npx wrangler deploy --dry-run` succeeds.
- `scripts/deploy.sh` executable and has the master-branch safety gate.

### W4 - Smoke test + live deploy (manual, Scott + Opus)

1. Run `./scripts/deploy.sh` from master.
2. Wrangler deploys the worker, binds routes, publishes.
3. Mobile test: phone loads `https://mccarrison.me/worms/`, laptop creates room, phone joins, full game.
4. Bug list filed as follow-up issues.

## Risks + mitigations

- **DO hibernation breaks timers**: `setInterval`/`setTimeout` DO NOT survive hibernation. Must use `state.storage.setAlarm()`. Covered in W1 by the alarm-driven TurnArbiter.
- **WebSocket hibernation protocol**: must use `state.acceptWebSocket(ws, [tags])`, NOT the legacy `addEventListener`. Old pattern keeps the DO awake; new pattern lets it sleep. Covered; mini-golf has the pattern.
- **State broadcast size**: full-state-on-every-change is ~1-2 KB per broadcast. At 10-20 broadcasts/match + 4 clients = 80-160 KB total per match. Trivial. (Colyseus' binary patches were 10-50x smaller; for our scale nobody notices.)
- **Reconnection edge cases**: DO storage-based resume tokens are strictly simpler than Colyseus' `allowReconnection` (no race between grace timer + handleFinalLeave). But need to handle the case where the DO is hibernated when the reconnect arrives - the wake-up is free via `acceptWebSocket`, but storage reads must happen before accepting the connection. Covered in the DO's constructor + fetch handler.
- **Vite base path + DOM inputs**: LobbyScene uses `scene.add.dom("input", ...)`. Check that asset URLs in those inputs (if any) resolve correctly under `/worms/`. Plan includes a manual smoke test step for this.
- **SPA fallback**: `not_found_handling: "single-page-application"` in `[assets]` - serves index.html on 404. Need to confirm this serves the correctly-base-pathed HTML, not an unprefixed one.
- **Route overlap**: patterns `mccarrison.me/worms` and `mccarrison.me/worms/*` match without capturing `/wormsdev` or similar (critical per skifree-web's comment). Plan's routes mirror mini-golf's exact pattern.
- **404 on deep links**: `/worms` bare redirect to `/worms/` is needed; mini-golf's index.ts handles this. Plan includes the same redirect.
- **Colyseus test harness removal breaks CI**: server/ tests go away entirely; worker/ tests are the replacement. CI config may need to update test paths.

## Bugcheck targets
- **HIGH**: resume token spoofing. If token is predictable, attacker could hijack a session. Generate via `crypto.getRandomValues(new Uint8Array(32))`, store hashed in DO storage.
- **HIGH**: DO state desync if hibernation + reconnect race. Resume token arrives, DO wakes, reads storage, matches - straightforward. But concurrent alarm fires that's mutating state while reconnect fetch is running: protect with in-memory critical section or accept Colyseus-style last-write-wins.
- **HIGH**: validation of input messages (same as Epic 9 bugcheck): sender must own currentTeamId; nickname sanitization; snapshot finite-number + range clamping.
- **MEDIUM**: room code collision across DOs. `idFromName(code)` is deterministic; two rooms with the same code map to the same DO. Plan calls the DO in its `fetch` handler on `POST /api/room` to check "is this room occupied?" before returning the code; if occupied, generate another.
- **MEDIUM**: assets binding + path prefix. Verify `/worms/assets/index-XYZ.js` resolves via `env.ASSETS.fetch(stripped-url)`.
- **LOW**: DO storage leaks if rooms never hibernate cleanly. DO `alarm()` should clean up after EMPTY_TTL.

## Smoke test (post-deploy)
1. Phone + laptop on different networks.
2. Laptop: load `https://mccarrison.me/worms/`, nickname Alice, Create Room.
3. Phone: scan QR / open link with code, nickname Bob, Join.
4. Both Ready on their tabs; host starts.
5. Play one turn: walk, fire bazooka, end turn.
6. Observe: does spectator see the active player's movement in real time? (Mobile can't background-throttle a focused tab, so this is the cleanest test of Epic 9's input relay.)
7. Disconnect (close tab), reconnect within 60s: resume token restores session, game continues.
8. Disconnect > 60s: team forfeits, remaining player wins.
9. Play to game_over, verify win banner.

## Plan-time skill invocation (per CLAUDE.md)
- Touch/UI changes: none new in this epic - the `mccarrison.me/worms` URL and subpath deploy don't change any game UI. `/frontend-design` not needed.
- `/review`: recommended on the integration branch before PR since this is a major architectural rewrite. Flag for Scott to run manually.
- `/security-review`: recommended before deploy. Worker + WebSocket + public URL = new attack surface. Specific concerns: resume token entropy, input validation, XSS via nickname/color.

## Reference files
- Mini-golf worker: https://github.com/scottmccarrison/mini-golf/tree/main/worker
- Skifree worker: https://github.com/scottmccarrison/skifree-web/tree/main/worker
- Existing game logic (to port): `server/src/game/TurnArbiter.ts`, `server/src/rooms/GameRoom.ts`, `server/src/codegen.ts`, `server/src/state/LobbyState.ts`.
- Cloudflare DO docs: https://developers.cloudflare.com/durable-objects/
- DO WebSocket hibernation: https://developers.cloudflare.com/durable-objects/best-practices/websockets/

## Post-merge notes
- Track actual line counts + time vs estimate. Plan estimates ~350 LOC of new transport code across W1 + W2; actual will inform future architecture pivots.
- If mobile playtest surfaces input-relay issues that Epic 9's design predicted, file as follow-ups (likely #47 territory).
- After shipping, file an issue to consider adding D1 leaderboards (following mini-golf's schema.sql pattern) if useful.
