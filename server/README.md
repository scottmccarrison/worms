# worms server (Colyseus)

Authoritative multiplayer server for the worms web game. Manages rooms (4-letter join codes), turn state, physics simulation, state sync.

## Status

**Scaffold only.** This directory was set up in PR (the pivot PR) per [ADR-001](../docs/decisions/001-framework-pivot.md). Full implementation lands in:

- **Epic 8** - lobby + 4-letter room codes + join/leave flow
- **Epic 9** - authoritative game loop + Colyseus schema for shared state
- **Epic 10** - reconnection + disconnect handling

Current state: one `GameRoom` class that logs join/leave events. Does nothing game-specific.

## Run locally

```sh
cd server
npm install
npm run dev
```

Server listens on `:2567` by default (override with `PORT`).

From the client (when Epic 8 lands), connect to `ws://localhost:2567`.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | tsx watch mode; auto-restarts on file changes |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled server |
| `npm run typecheck` | `tsc --noEmit` |

## Structure

```
server/
  src/
    index.ts           entry: HTTP server + Colyseus + transport
    rooms/
      GameRoom.ts      Room class (one instance per game)
    state/             Colyseus schema (added Epic 9)
    simulation/        physics + turn logic (added Epic 9)
```

## Deploy (future, Epic 13)

Options, decided per cost/latency needs at Epic 13 time:

1. **Co-locate on brain's EC2** (100.105.131.123). nginx proxies `/worms/ws` to the Colyseus port. Same TLS cert as brain. No new infra.
2. **Fly.io app**. Regional game servers, anycast routing, better latency for non-US players. Costs ~$5-10/mo for a hobby tier.

Colyseus itself is stateless per Room; horizontal scaling is possible via the presence adapter (Redis). For MVP, single-instance on brain's EC2 is fine.

## References

- [Colyseus docs](https://docs.colyseus.io/)
- [Colyseus GitHub](https://github.com/colyseus/colyseus)
- [ADR-001](../docs/decisions/001-framework-pivot.md) - framework pivot rationale
