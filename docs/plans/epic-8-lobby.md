# Epic 8 - Lobby + Room Codes

Closes #8. Defers #9 (authoritative netcode) and #10 (reconnection) to their own epics. Per [ADR-001](../decisions/001-framework-pivot.md) Colyseus is the framework; this epic establishes the client/server connection, the lobby UI, and the room-code handshake - enough to make "friend texts a link, you click, you see each other, you pick a map and start" work end to end. Game state remains client-local this epic; every player launches their own single-device game when "Start" is pressed. Netcode follows in Epic 9.

## Scope

### In scope
- Server Colyseus state schema for lobby (`LobbyPlayer`, `LobbyState`).
- Server room-code generation (4 letters A-Z, no I/O, collision-retry).
- Server matchmaking: `createRoom(nickname, color)` returns code; `joinByCode(code, nickname, color)` routes to existing room.
- Server messages: `set_nickname`, `set_color`, `set_ready`, `select_map`, `start_game`, `kick` (host-only).
- Server lifecycle: host assignment (first joiner), promote on host leave, dispose empty rooms after 5 min idle.
- Client Colyseus dep (`colyseus.js`) + net client factory.
- Client `LobbyScene` Phaser scene with two views: Home (nickname + Create / Join) and Room (player list, color swatch, ready toggle, map picker, Start [host only], Leave).
- Client URL deep link: `?room=WAVE` auto-joins room, prompts for nickname first.
- Client scene flow: `BootScene -> LobbyScene -> GameScene` (Phaser scene array).
- GameScene `init({ mapId, teams, room? })` handoff - room reference passed through so future epics can drop state-sync code in; not used this epic.
- Single-player path preserved: a dev-only `?offline=1` flag skips LobbyScene and goes straight to GameScene with the current default teams, matching Epic 7 behavior.
- Tests: room-code generator (alphabet, length, collision retry), LobbyState schema mutations, LobbyScene routing (home -> room -> game), URL param parsing.
- Docs: plan (this file), ROADMAP table row flipped to "Done / PR TBD", CLAUDE.md + README blurb on running server (`cd server && npm run dev`) alongside client (`npm run dev`).

### Out of scope (tracked separately)
- Authoritative server physics / state replication - Epic 9 (#9).
- Reconnection beyond Colyseus defaults - Epic 10 (#10).
- Team customization beyond color picker (worm names, hats) - #23.
- Spectator join after start - #25.
- Host kick UI wired to UI (message contract exists; button optional if time).
- Production deploy - #13.

## Architecture

### Dependency versions
- Server: `@colyseus/core` + `@colyseus/ws-transport` + `colyseus@^0.15.0` - already installed. Add `@colyseus/schema@^2.0.35` (peer of core 0.15).
- Client: add `colyseus.js@^0.15.26` to root `package.json` dependencies.
- Note: 0.15 uses the classic `room.state.players.onAdd(callback)` API (not the 0.16 `getStateCallbacks` proxy). Plan assumes 0.15.

### Message contract (authoritative list)

All messages are JSON objects. Unrecognised fields are ignored server-side. Server rejects any message from a client whose `sessionId` does not map to a LobbyPlayer in the room.

| Direction | Type | Payload | Validation |
|-----------|------|---------|------------|
| C->S | `set_nickname` | `{ nickname: string }` | trim, 1-16 chars, reject empty |
| C->S | `set_color` | `{ color: string }` | must be in `ALLOWED_COLORS` palette, not already taken |
| C->S | `set_ready` | `{ ready: boolean }` | ignored if phase != `lobby` |
| C->S | `select_map` | `{ mapId: string }` | host only; must be in map registry (server has a hard-coded whitelist mirrored from client) |
| C->S | `start_game` | `{}` | host only; >=2 players; all non-host ready; phase becomes `playing` |
| C->S | `leave` | `{}` | shortcut for clean disconnect (same as closing tab) |
| S->C | broadcast via state schema | `LobbyState` patches | 20Hz default |
| S->C | `error` | `{ code: string, message: string }` | validation failures, room-full, room-not-found |
| S->C | `game_started` | `{ mapId: string, seed: number, teams: TeamInit[] }` | sent once when host starts; clients transition LobbyScene -> GameScene |

### State schema

```ts
// server/src/state/LobbyState.ts
import { Schema, MapSchema, type } from "@colyseus/schema";

export const ALLOWED_COLORS = [
  "#ff4444", "#4488ff", "#44dd44", "#ffdd44",
  "#dd44dd", "#44dddd", "#ff8844", "#aa88ff",
] as const;

export class LobbyPlayer extends Schema {
  @type("string") sessionId = "";
  @type("string") nickname = "";
  @type("string") color = "";
  @type("boolean") ready = false;
  @type("boolean") isHost = false;
}

export class LobbyState extends Schema {
  @type("string") code = "";           // 4-letter room code
  @type("string") phase = "lobby";     // lobby | playing | ended
  @type("string") hostSessionId = "";
  @type("string") selectedMapId = "flat";
  @type({ map: LobbyPlayer }) players = new MapSchema<LobbyPlayer>();
}
```

### Room code generation

```ts
// server/src/codegen.ts
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // 23 letters: excludes I, O (ambiguous)

export function generateCode(): string {
  let out = "";
  for (let i = 0; i < 4; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return out;
}

export function generateUniqueCode(taken: Set<string>, maxAttempts = 100): string {
  for (let i = 0; i < maxAttempts; i++) {
    const c = generateCode();
    if (!taken.has(c)) return c;
  }
  throw new Error("Failed to generate unique room code");
}
```

23^4 = 279,841 codes. At 100 concurrent rooms collision probability is ~3.5e-4 per attempt; retry loop is cheap safety.

### Matchmaking

Colyseus supports filter-based matchmaking. We override the default with a custom filter so clients can request a specific `code`:

```ts
// server/src/index.ts (modified)
gameServer
  .define("game", GameRoom)
  .filterBy(["code"]);
```

Client calls:
- Create: `client.create("game", { create: true, nickname, color })` - server side `onCreate` options include `create: true` and generates a new code, stores as metadata for filterBy.
- Join: `client.joinOrCreate("game", { code, nickname, color })` - Colyseus routes to room whose metadata `code` matches; returns `RoomNotFound` if none.
- Actually: use `client.joinById` is simpler. **Decision:** use `client.consumeSeatReservation` pattern via explicit `create` vs `joinById(code)`. See implementation notes in agent briefs below.

### Client net layer

```ts
// src/net/client.ts
import { Client } from "colyseus.js";

function serverUrl(): string {
  const { protocol, hostname, port } = window.location;
  const wsProto = protocol === "https:" ? "wss" : "ws";
  // Dev: Vite on :5173, server on :2567. Prod: same origin (reverse proxy).
  const wsHost = import.meta.env.DEV ? `${hostname}:2567` : `${hostname}${port ? `:${port}` : ""}`;
  return `${wsProto}://${wsHost}`;
}

export function createNetClient(): Client {
  return new Client(serverUrl());
}
```

### Phaser scene flow

```
main.ts
  new Phaser.Game({ scene: [BootScene, LobbyScene, GameScene] })

BootScene:
  - Reads URL (?room=CODE, ?offline=1)
  - Creates a singleton NetClient
  - If ?offline=1 -> scene.start("GameScene", { mapId: readMapQueryParam() })
  - Else -> scene.start("LobbyScene", { netClient, autoJoinCode })

LobbyScene:
  - Home view: nickname input + Create / Join
  - On Create: netClient.create("game", ...) -> room
  - On Join: netClient.joinById(code, ...) OR joinOrCreate with filter
  - Room view: render from room.state (onStateChange)
  - On game_started message: scene.start("GameScene", { mapId, seed, teams, room })

GameScene (unchanged other than init signature):
  - Existing single-device behavior for Epic 8
  - room reference stashed for future epics
```

### LobbyScene UI (mobile-first)

Target 1280x720 safe area; must also work at 375x667 (iPhone SE landscape rotated = 667x375). Uses Phaser Graphics + Text, no DOM overlay (keeps us inside Phaser's Scale manager).

**Home view:**
```
         WORMS

  Nickname: [_________]
            <- text input (Phaser DOM element)

  [  Create Room  ]   [  Join Room  ]
                       Code: [_____]
```

**Room view:**
```
  Room: WAVE                          [Leave]

  Map: [< Rolling Hills >]   (host only picker, others see readonly)

  Players:
    * HostName   [red]   (host)
      Bob        [blue]  [ready]
      Sam        [green]

  [ Ready ]        [ Start Game ] (host, enabled when >=2 ready)
```

Color swatch: clickable grid of 8 colors; taken colors greyed. Text uses Phaser.GameObjects.Text (not BitmapText) for now. Map picker arrows cycle `MAPS` registry ids.

Text input: use Phaser DOM Element (`scene.add.dom`) since mobile virtual keyboards require real `<input>` focus. Gated on `scene.scale.parent` being the canvas parent. Style matches index.html `color-scheme: dark`.

## Workstreams (parallelizable after plan approval)

Three workstreams. Each lands its own branch; we merge them back to a single integration branch before opening the PR so CI runs once.

### W1 - Server (worms-ws1)
**Branch:** `feature/epic-8-server`
**Owner:** Sonnet agent A

Files:
- `server/package.json` - add `@colyseus/schema@^2.0.35` dep; bump version -> `0.1.0`.
- `server/src/state/LobbyState.ts` - new, schema per spec above.
- `server/src/codegen.ts` - new, `generateCode` + `generateUniqueCode`.
- `server/src/codegen.test.ts` - new, vitest (add vitest to server devDeps).
- `server/src/rooms/GameRoom.ts` - replace stub with full implementation:
  - `onCreate(options)`: `setState(new LobbyState())`; set `code` (use `codegen.generateUniqueCode` against `matchMaker.getAvailableRooms`); set host metadata; `setMetadata({ code })` for filter.
  - `onJoin(client, options)`: validate `nickname` + `color`; create LobbyPlayer; assign host if first; broadcast.
  - `onLeave(client, consented)`: remove player; if host left, promote next (by `joinedAt`); if empty, `disconnect()` after 5 min.
  - `onMessage` handlers per contract table above (validate everything).
  - `onDispose()`: log.
- `server/src/rooms/GameRoom.test.ts` - new, integration tests using `@colyseus/testing` (add to devDeps): join/leave/host-promotion/start-game flow.
- `server/src/index.ts` - add `.filterBy(["code"])` to `define`; wire Express for `/health` + CORS for dev origin (`http://localhost:5173`).
- `server/vitest.config.ts` - new, mirror root config.
- `server/README.md` - section on message protocol.

Branch workflow:
- Start from current `main`.
- Commits (expected ~6):
  1. `feat(server): add @colyseus/schema + LobbyState schema`
  2. `feat(server): room code generator + tests`
  3. `feat(server): GameRoom lobby implementation`
  4. `feat(server): filterBy code + express health endpoint`
  5. `test(server): GameRoom integration tests`
  6. `docs(server): message protocol + dev instructions`

Acceptance:
- `cd server && npm run typecheck` passes.
- `cd server && npm test` passes (>=8 tests).
- `cd server && npm run dev` starts cleanly on :2567.
- `curl localhost:2567/health` returns `ok`.

### W2 - Client net + LobbyScene (worms-ws2)
**Branch:** `feature/epic-8-client-lobby`
**Owner:** Sonnet agent B

Depends on W1's schema contract (specified in plan; agent does not need W1 merged).

Files:
- `package.json` (root) - add `colyseus.js@^0.15.26`.
- `src/net/client.ts` - `createNetClient()` factory.
- `src/net/types.ts` - TypeScript mirror of server schema (hand-written; Colyseus 0.15 does not require shared package).
- `src/scenes/BootScene.ts` - new; reads URL params, creates NetClient, routes.
- `src/scenes/LobbyScene.ts` - new; home + room views as spec.
- `src/scenes/LobbyScene.test.ts` - new; unit tests for URL parsing + state-to-render pure helpers. Keep Phaser-less via extracted helpers:
  - `src/scenes/lobby/urlParams.ts` - pure parser for `?room=X&offline=1`, unit-tested.
  - `src/scenes/lobby/renderModel.ts` - pure derive-view-model-from-LobbyState, unit-tested.
- `src/main.ts` - register `[BootScene, LobbyScene, GameScene]`; set `scene: [BootScene, LobbyScene, GameScene]` + `autoStart: false`; start BootScene.
- `src/scenes/GameScene.ts` - extend `init(data?: { mapId?: string; room?: Room; teams?: TeamInit[] })`; store `this.room` for future epics (unused this epic); if `teams` provided, use them instead of defaults.

Branch workflow:
- Start from current `main`.
- Commits (expected ~8):
  1. `chore: add colyseus.js dep`
  2. `feat(net): NetClient factory + types`
  3. `feat(scene): BootScene with URL routing`
  4. `feat(scene): LobbyScene home view (nickname + create/join)`
  5. `feat(scene): LobbyScene room view (players + map + ready + start)`
  6. `feat(scene): wire game_started -> GameScene handoff`
  7. `test(lobby): url params + render model`
  8. `docs: lobby UX notes in CLAUDE.md`

Acceptance:
- `npm run typecheck` passes.
- `npm test` passes (>=5 new tests).
- `npm run dev` starts; `http://localhost:5173/?offline=1` launches straight into GameScene (unchanged behavior).
- With `cd server && npm run dev` running, `http://localhost:5173/` shows LobbyScene home.

### W3 - Integration + docs (worms-ws3)
**Branch:** `feature/epic-8-integration`
**Owner:** Sonnet agent C (small, runs after W1+W2 merge to integration branch)

Files:
- `docs/ROADMAP.md` - flip row 8 to "Done / PR TBD, plan: epic-8-lobby". Keep #9/#10 as Todo.
- `docs/plans/epic-8-lobby.md` - this file (already committed).
- `CLAUDE.md` - add "Running the stack" section: `cd server && npm run dev` + `npm run dev`.
- `README.md` - one paragraph on multiplayer setup.
- Two-tab smoke test script documented (no automation; docs only).

Branch workflow:
- Start from integration branch (W1 + W2 merged).
- Commits (expected ~2):
  1. `docs(epic-8): ROADMAP + README + CLAUDE.md update`
  2. `docs(epic-8): two-tab smoke test instructions`

## Smoke test (post-merge)

1. `cd server && npm run dev` (terminal 1).
2. `npm run dev` (terminal 2).
3. Browser tab A: `http://localhost:5173/`, enter nickname "Alice", click Create Room. Verify 4-letter code shown.
4. Copy code. Browser tab B (incognito): `http://localhost:5173/?room=<code>`, enter nickname "Bob", auto-joins room.
5. In tab A (host): cycle map picker, see Bob's entry update. Click Start Game (both ready).
6. Both tabs transition to GameScene with the selected map. Single-device game plays locally in each (expected for Epic 8).
7. In tab B, close tab. In tab A, verify Bob disappears from player list (if still in lobby) or game continues (if already in game - GameScene is local-only this epic).
8. Kill server, restart, refresh both tabs - tabs fall back to home screen (no stale state).

## Bugcheck targets

- **HIGH**: server-side input validation (nickname length, color palette, mapId whitelist). Reject with `error` message, never trust client.
- **HIGH**: code collision retry loop - confirm it can run to max attempts without hanging the event loop.
- **MEDIUM**: host promotion must be deterministic (earliest `joinedAt`); cover in tests.
- **MEDIUM**: `?room=X` URL param for non-existent code should fall back to home view with error toast, not spin forever.
- **LOW**: guard against prototype-pollution in map registry lookup (already fixed in Epic 7, but server mirror must do the same).
- **LOW**: concurrent `start_game` from racing hosts (only one host exists, but message ordering) - last-write-wins is fine; document.

## Risks + mitigations

- **Colyseus 0.15 vs 0.16 API drift** - plan locks to 0.15; agent briefs explicitly forbid `getStateCallbacks`.
- **Phaser DOM text input on mobile** - fall back to native prompt() if Phaser DOM input misbehaves on iOS Safari; acceptable for MVP.
- **Coupling to Epic 9** - GameScene signature accepts `room?` now; Epic 9 replaces the single-device loop with server-driven tick without changing the scene boundary.
- **Server deploy not in scope** - dev assumes localhost; production URL env var wired but #13 handles actual deploy.

## Reference files
- `server/src/rooms/GameRoom.ts` (current stub)
- `server/src/index.ts` (current stub)
- `src/scenes/GameScene.ts` (init signature already supports data)
- `src/maps/registry.ts` (map whitelist source of truth)
- `docs/decisions/001-framework-pivot.md` (pivot rationale)
- Colyseus 0.15 docs: https://docs.colyseus.io/ (room lifecycle, schema, filterBy)

## Post-merge notes

**Mobile-first polish pass**: After the initial W1+W2+W3 landed, a follow-up W4 workstream addressed three gaps flagged from CLAUDE.md's mobile-first requirements: portrait orientation splash, Web Share API invite button, and uppercase + auto-focus on the join code input. The plan should have invoked `/frontend-design` up front for the lobby UI; future UI epics must include it as a required plan step per CLAUDE.md.
