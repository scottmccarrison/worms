# Integration Testing

## What it is

In-process Cloudflare Worker via wrangler's `unstable_dev` + native `ws` clients
sending real protocol messages. No mocks, no stubs for the server-side code - the
actual Room Durable Object and turn arbiter run inside a real wrangler dev worker.

## Why

Catches netcode and state-machine bugs that unit tests miss. A unit test for
`turnArbiter.ts` can verify rotation logic in isolation; an integration test
can catch the #117 class of bug where `return_to_lobby` left `turnEndsAt`
stale from game 1 because the full message-dispatch path was never exercised
together. Faster than a 2-device manual playtest by ~15 minutes per cycle.

## Where

- `worker/test/room.test.ts` - original suite. Lobby join, ready, start_game,
  sim_state cadence, resume tokens, auth guards.
- `worker/test/integration/*.test.ts` - multi-turn scenarios. Currently:
  - `lobby-cycle.test.ts` - full game-1 -> return-to-lobby -> game-2 cycle
    (#117 regression).

## Running locally

```
cd worker && npm test
```

The `globalSetup` in `vitest.config.ts` calls `worker/test/global-setup.ts`,
which creates a minimal `dist/index.html` stub if the `dist/` directory does
not exist. This means `npm test` works without running `npm run build` first.

If you have run `npm run build`, the real build is used and the stub is skipped.

CI runs `npm run build` before `npm test` - no change there.

## Adding a scenario

1. Copy `worker/test/integration/lobby-cycle.test.ts` to a new file in the
   same directory.
2. Replace the test body with your scenario.
3. Reuse the `TestClient` class - it is inline-duplicated for now. When a
   third file wants it, extract to `worker/test/helpers/TestClient.ts`.

## Common pitfalls

- **45s turn timer**: the turn auto-advances after 45s + settle grace. If your
  test is slow between game-start and `input_return_to_lobby`, the turn may
  advance mid-test. Send `input_return_to_lobby` promptly after game start,
  or skip the fire step entirely.

- **`state` vs `sim_state`**: `state` is the lobby snapshot (`LobbyState`) and
  carries `turnEndsAt`, `currentTeamId`, `phase`. `sim_state` is the 20Hz
  physics tick snapshot and carries `worms`, `projectiles`, `activeTeamId`.
  Use `state` to assert on turn/phase transitions; use `sim_state` to assert
  on worm positions and projectiles.

- **Resume tokens**: each fresh `joinRoom` call generates a new session and
  resume token. If you close and reopen a connection without passing
  `?resumeToken=`, you get a new session. Pass the token explicitly if you
  want to test reconnection behavior.

- **Asset routes**: the `dist/` stub means `GET /` returns stub HTML. Do not
  test asset or SPA routing behavior in this suite - those need a real build.
