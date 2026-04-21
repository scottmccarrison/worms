# Worms

Browser-based multiplayer Worms-style artillery game.

## Status

Modernized scaffolding. The legacy 2013 codebase is archived under
[`reference/`](reference/README.md) and is being ported module-by-module
into `src/`.

## Quick start

Requires Node 20+. The game has a client (Phaser 3 + planck.js) and a
Colyseus multiplayer server; run both for the lobby flow, or just the
client for single-device dev (`?offline=1`).

Client (terminal 1):

    npm install
    npm run dev          # Vite on http://localhost:5173

Multiplayer server (terminal 2):

    cd server
    npm install
    npm run dev          # Colyseus on ws://localhost:2567

Then open http://localhost:5173. For single-device dev that skips the
lobby entirely, use http://localhost:5173/?offline=1.

## Scripts

Client (root):

| Command             | What it does                            |
| ------------------- | --------------------------------------- |
| `npm run dev`       | Vite dev server with hot reload.        |
| `npm run build`     | Typecheck + production build to `dist/`. |
| `npm run preview`   | Serve the production build locally.     |
| `npm run typecheck` | `tsc --noEmit`.                         |
| `npm run lint`      | Biome check (lint + format).            |
| `npm run format`    | Biome format (writes changes).          |
| `npm test`          | Vitest run.                             |

Server (`server/`):

| Command             | What it does                            |
| ------------------- | --------------------------------------- |
| `npm run dev`       | Colyseus server via `tsx watch`.        |
| `npm run build`     | `tsc` to `dist/`.                       |
| `npm start`         | Run built server from `dist/`.          |
| `npm run typecheck` | `tsc --noEmit`.                         |
| `npm test`          | Vitest + `@colyseus/testing`.           |

## Stack

- TypeScript 5 (strict, bundler resolution)
- Vite 6 (dev server + bundler)
- Phaser 3 + planck.js (game + physics)
- Colyseus 0.15 (multiplayer rooms, schema, reconnection)
- xstate 5 (turn state machine)
- Biome 1.9 (lint + format)
- Vitest (unit + integration tests)

## Multiplayer smoke test

1. Start server: `cd server && npm run dev`
2. Start client: `npm run dev`
3. Tab A: http://localhost:5173/, nickname "Alice", Create Room, note the 4-letter code.
4. Tab B (incognito): http://localhost:5173/?room=CODE, nickname "Bob", Join.
5. Alice picks a map, both hit Ready, Alice clicks Start Game.
6. Both tabs transition to the same map with the same seed. Teams are
   assigned by join order (Alice = team red, Bob = team blue).
7. Alice's tab is active first; Bob's tab shows a "Waiting for Alice..."
   banner and has input locked. Alice walks, fires, ends turn.
8. Server rotates the active team; Bob's input unlocks and Alice's tab
   shows the spectator banner. Positions snap at each turn boundary.
9. Keep alternating until one team has no alive worms. Server broadcasts
   game_over; both tabs show the win banner.

Architecture note (Epic 9 Option C): the server arbitrates turn
ownership + relays the active player's inputs + accepts an authoritative
snapshot at turn end. Each client still runs its own planck sim locally;
physics drift within a turn is absorbed by the end-of-turn snapshot.
No server-side physics. See `docs/plans/epic-9-netcode.md` for the full
architecture and the `#45` issue for the upgrade path to authoritative
server physics if the Option C model ever hits its limits.

## Structure

    /src          new codebase (entry: src/main.ts)
    /public       static assets served at root
    /reference    archived original codebase (not built)
    /data         game assets (shared with reference during porting)

## Attribution

Fork of [CiaranMcCann/Worms-Armageddon-HTML5-Clone](https://github.com/CiaranMcCann/Worms-Armageddon-HTML5-Clone)
by Ciaran McCann (2012-2013, Apache 2.0). See [`NOTICE`](NOTICE) and
[`LICENSE.txt`](LICENSE.txt).

Original game design and assets: (C) [Team17](http://www.team17.com).
This clone is a non-commercial educational project; no affiliation with Team17.
