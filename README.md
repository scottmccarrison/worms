# Worms

Browser-based multiplayer Worms-style artillery game.

## Status

Modernized scaffolding. The legacy 2013 codebase is archived under
[`reference/`](reference/README.md) and is being ported module-by-module
into `src/`.

## Quick start

Requires Node 20+. The game has a client (Phaser 3 + planck.js) and a
Cloudflare Worker + Durable Object backend; run both locally for the
lobby flow, or just the client for single-device dev (`?offline=1`).

Client (terminal 1):

    npm install
    npm run dev          # Vite on http://localhost:5173/worms/

Worker (terminal 2):

    cd worker
    npm install
    npx wrangler dev --local   # Worker + DO on :8787

Then open http://localhost:5173/worms/. For single-device dev that skips
the lobby entirely, use http://localhost:5173/worms/?offline=1.

## Deploy

Production deploy to `mccarrison.me/worms`:

    ./scripts/deploy.sh

Builds client + runs `wrangler deploy` from `worker/`. Refuses to deploy
from non-master branches or with uncommitted changes.

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

Worker (`worker/`):

| Command                      | What it does                              |
| ---------------------------- | ----------------------------------------- |
| `npx wrangler dev --local`   | Local worker + DO on :8787.               |
| `npx wrangler deploy`        | Deploy to `mccarrison.me/worms`.          |
| `npx wrangler deploy --dry-run` | Validate config without deploying.     |
| `npx tsc --noEmit`           | Typecheck.                                |
| `npm test`                   | Vitest with `unstable_dev` harness.       |

## Stack

- TypeScript 5 (strict, bundler resolution)
- Vite 6 (dev server + bundler)
- Phaser 3 + planck.js (game + physics)
- Cloudflare Workers + Durable Objects (multiplayer rooms + state + reconnection)
- xstate 5 (turn state machine)
- Biome 1.9 (lint + format)
- Vitest (unit + integration tests)

## Multiplayer smoke test

1. Start worker: `cd worker && npx wrangler dev --local`
2. Start client: `npm run dev`
3. Tab A: http://localhost:5173/worms/, nickname "Alice", Create Room, note the 4-letter code.
4. Tab B (incognito): http://localhost:5173/worms/?room=CODE, nickname "Bob", Join.
5. Alice picks a map, both hit Ready, Alice clicks Start Game.
6. Both tabs transition to the same map with the same seed. Teams are
   assigned by join order (Alice = team red, Bob = team blue).
7. Alice's tab is active first; Bob's tab shows a "Waiting for Alice..."
   banner and has input locked. Alice walks, fires, ends turn.
8. Server rotates the active team; Bob's input unlocks and Alice's tab
   shows the spectator banner. Positions snap at each turn boundary.
9. Keep alternating until one team has no alive worms. Server broadcasts
   game_over; both tabs show the win banner.

## Mobile controls

Touch is the primary control surface (see [`CLAUDE.md`](CLAUDE.md) "Target
platforms"); desktop keyboard is additive. On any touch device:

- **Walk**: tap-and-hold on the left or right half of the screen. Your
  worm walks that direction until you release.
- **Jump**: double-tap the same side within 250ms.
- **Backflip**: long-press (400ms+) on either side.
- **Aim + fire**: drag from the active worm (within ~40px of its sprite)
  in the direction you want to shoot. Distance from the worm sets power.
  Release to fire.
- **Rope / Jetpack** (offline mode only, per [#65](https://github.com/scottmccarrison/worms/issues/65)):
  small buttons in the top-right corner. Activating either shows a
  4-button d-pad at the bottom-center (left / right / up / down) that
  replaces half-screen walking while the utility is engaged.

Keyboard shortcuts (desktop): arrow keys / WASD to walk, SPACE to jump,
SHIFT for backflip, R / J to toggle rope / jetpack, F to fire, 1 / 2 / 3 to
select weapon, ENTER to end turn.

Gesture thresholds are live-tunable in the dat.gui panel (toggle with the
`` ` `` key in dev builds) under `touch.wormHitRadiusPx`,
`touch.doubleTapMaxMs`, `touch.longPressMs`.

## Reconnection

If a player drops (network hiccup, tab crash), their slot is held for 60
seconds via a resume token stored in DO storage. Other players see a
"(disconnected, Ns)" indicator; if the disconnected player is the active
turn owner, the turn timer freezes until they return. After 60s their
team auto-forfeits (all worms die) and the remaining players keep
playing.

Clients cache `room.reconnectionToken` in localStorage (10-minute TTL)
keyed by room code. Reloading the tab with `?room=CODE` in the URL uses
the cached token to rejoin silently. Lobby-phase reloads land you back
in the room; mid-game reloads currently drop you in a stale lobby view
([#51](https://github.com/scottmccarrison/worms/issues/51) is tracking
the proper "rejoin active game" handoff).

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
