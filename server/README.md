# worms server (Colyseus)

Authoritative multiplayer server for the worms web game. Manages rooms (4-letter join codes), lobby state, and (from Epic 9 onward) turn state, physics simulation, state sync.

## Status

**Epic 8 complete.** Lobby + room codes + message protocol live.

- **Epic 8** (this change) - lobby state schema, 4-letter room codes, join/leave/ready/map/start flow
- **Epic 9** (next) - authoritative game loop + schema extension for shared world state
- **Epic 10** (later) - reconnection + disconnect handling past Colyseus defaults

## Run locally

```sh
cd server
npm install
npm run dev
```

Server listens on `:2567` by default (override with `PORT`).

From the client (Epic 8 wires this up in [src/net/client.ts](../src/net/client.ts)):

```ts
import { Client } from "colyseus.js";
const client = new Client("ws://localhost:2567");
```

### Health check

```sh
curl http://localhost:2567/health
# -> {"ok":true}
```

Used by reverse proxies / orchestrators (nginx, Fly, ECS) to detect liveness. CORS allows `http://localhost:5173` (Vite dev) in dev; in prod the client is same-origin.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | tsx watch mode; auto-restarts on file changes |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled server |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Run vitest (codegen + GameRoom integration tests) |

## Structure

```
server/
  src/
    index.ts              entry: HTTP + Colyseus + Express /health + CORS
    codegen.ts            4-letter room-code generator (23 letters, excludes I/O)
    codegen.test.ts
    rooms/
      GameRoom.ts         lobby room: join/leave, host promotion, start_game
      GameRoom.test.ts    integration tests via @colyseus/testing
    state/
      LobbyState.ts       Colyseus schema: LobbyPlayer, LobbyState, ALLOWED_COLORS
  vitest.config.ts        test runner config (pool:threads + singleThread for Colyseus compat)
```

## Message protocol (Epic 8)

Everything is JSON. Unknown fields are ignored by the server. A client whose `sessionId` does not map to a LobbyPlayer gets a `not_in_room` error for every message.

### Client -> Server

| Type | Payload | Validation / effect |
|------|---------|---------------------|
| `set_nickname` | `{ nickname: string }` | Trim, require 1-16 chars. Replaces nickname on the LobbyPlayer. Errors: `invalid_nickname`. |
| `set_color` | `{ color: string }` | Must be in `ALLOWED_COLORS`; if different from the current color, must not be taken by another player. Errors: `invalid_color`, `color_taken`. |
| `set_ready` | `{ ready: boolean }` | Ignored when `phase !== "lobby"`. |
| `select_map` | `{ mapId: string }` | Host only. mapId must be in the hardcoded server whitelist (`flat`, `hills`, `island`, `cave`). Errors: `not_host`, `invalid_map`. |
| `start_game` | `{}` | Host only. Requires >=2 players and every non-host player with `ready: true`. Broadcasts `game_started` and flips phase to `playing`. Errors: `not_host`, `not_enough_players`, `not_all_ready`. |
| `leave` | `{}` | Graceful disconnect. Equivalent to closing the tab. |

### Server -> Client

| Type | Payload | When |
|------|---------|------|
| _(state sync)_ | `LobbyState` patches via Colyseus schema | 20Hz default; every state mutation. |
| `error` | `{ code: string, message: string }` | Validation failures and access violations. Error codes are stable; messages are human-readable. |
| `game_started` | `{ mapId: string, seed: number, teams: TeamInit[] }` | Host triggers `start_game`. Broadcast to every connected client. `seed` is a 31-bit int for deterministic RNG. `teams` is the initial team layout (Team Red + Team Blue x 2 worms as of Epic 8; Epic 9 / #23 add real team config). |

### Matchmaking

`gameServer.define("game", GameRoom).filterBy(["code"])` routes `joinOrCreate("game", { code })` to the room whose listing has the matching `code`. On create, `GameRoom.onCreate` generates a unique 4-letter code, assigns it to `this.listing.code`, and publishes it on metadata.

Clients:
- **Host creates** - `client.create("game", { nickname, color })`. Server generates a new code; inspect `room.state.code` after join.
- **Peer joins** - `client.joinOrCreate("game", { code, nickname, color })`. Server looks up the existing room; rejects if none exists or if the room is locked / full.

### Room-code alphabet

23 letters: `ABCDEFGHJKLMNPQRSTUVWXYZ` (A-Z minus `I` and `O` to avoid read-aloud ambiguity). 23^4 = 279,841 unique codes. `generateUniqueCode` retries up to 100 times against currently-active codes queried via `matchMaker.query({ name: "game" })`.

### Room lifecycle

- First joiner becomes host. `isHost` + `hostSessionId` track this.
- On host leave, the earliest-joined remaining peer is promoted host. `joinedAt` (server wall-clock `Date.now()`) is the tiebreaker.
- On final-player leave, the room schedules a 5-minute disposal timer. Any new joiner before the timer fires cancels disposal (leaves room for Epic 10 reconnection).

## Testing

```sh
npm test
```

`codegen.test.ts` covers the code generator; `rooms/GameRoom.test.ts` covers the lobby via `@colyseus/testing`'s real-server `boot()` harness. Tests run in a single worker thread (`pool: "threads"`, `singleThread: true`, `isolate: false`) because the default child-process IPC layer cannot serialize Colyseus' msgpackr buffers.

## Deploy (future, Epic 13)

Options, decided per cost/latency needs at Epic 13 time:

1. **Co-locate on brain's EC2** (100.105.131.123). nginx proxies `/worms/ws` to the Colyseus port. Same TLS cert as brain. No new infra.
2. **Fly.io app**. Regional game servers, anycast routing, better latency for non-US players. Costs ~$5-10/mo for a hobby tier.

Colyseus itself is stateless per Room; horizontal scaling is possible via the presence adapter (Redis). For MVP, single-instance on brain's EC2 is fine.

## References

- [Colyseus 0.15 docs](https://docs.colyseus.io/)
- [Colyseus GitHub](https://github.com/colyseus/colyseus)
- [ADR-001](../docs/decisions/001-framework-pivot.md) - framework pivot rationale
- [Epic 8 plan](../docs/plans/epic-8-lobby.md) - authoritative spec for this change
