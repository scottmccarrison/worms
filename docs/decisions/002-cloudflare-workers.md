# ADR-002: Cloudflare Workers + Durable Objects for multiplayer

## Status
Accepted (Epic 13).

## Context

[ADR-001](001-framework-pivot.md) picked Phaser + Colyseus + planck as the stack. Colyseus was a pragmatic choice - it shipped room-based multiplayer + reconnection + schema replication out of the box, and we didn't want to hand-roll those.

When we began Epic 13 (deploy), the original plan was "Socket.IO on EC2". Inspection of the established game-hosting pattern on mccarrison.me (see `mini-golf` and `skifree-web`) revealed the actual convention: Cloudflare Workers + Durable Objects + `wrangler deploy`. Both repos run each game's multiplayer backend as a Durable Object, host the client via the Worker's `[assets]` binding, and live at `mccarrison.me/<game>` with zero shared infrastructure.

Putting worms on EC2 (Colyseus as-is) would make it the odd one out - a fourth operational pattern to remember, with shared-infra touches on brain-api-1 (nginx config, cloudflared ingress, systemd unit) whose cleanup risk is non-zero.

## Decision

Port the Colyseus multiplayer layer to Cloudflare Workers + Durable Objects. Retire the `server/` directory (Colyseus + Express) in favor of a new `worker/` directory mirroring the mini-golf layout.

Ship at `mccarrison.me/worms` via `wrangler deploy`.

## Consequences

### Gained
- **Pattern consistency**: one deploy mechanism for every game on mccarrison.me (`scripts/deploy.sh` -> `wrangler deploy`).
- **Zero shared-infra changes**: no touches to brain's nginx, cloudflared, or systemd. Rollback is `wrangler delete`.
- **Free-tier economics**: Workers + DO fit Cloudflare's free tier at our scale. Colyseus on EC2 would share brain's $25/mo.
- **Hibernation**: inactive rooms cost $0 (DO sleeps between messages).
- **Edge latency**: DO runs closer to the user than a single-region EC2.
- **D1 on-ramp**: if we ever add leaderboards, D1 plugs in cleanly (mini-golf pattern).

### Lost
- **`@colyseus/schema` binary-patch replication**: replaced with full-state JSON broadcasts on every change. Total state is <1 KB; trivial at our scale.
- **`allowReconnection(N)` library feature**: replaced with resume tokens stored in DO storage. Pattern is clean (~50 lines).
- **`@colyseus/testing` harness**: replaced with `wrangler unstable_dev` + a `ws` client in Vitest. Different tooling.
- **`colyseus.js` client**: replaced with a thin `WsClient` wrapper around native `WebSocket` (~150 lines).
- **`setSimulationInterval` timer**: replaced with DO alarms (hibernation-safe).

### Rewrite surface
Roughly 350 LOC of new transport code. Game logic (TurnArbiter, lobby state, input relay, forfeit semantics) is unchanged.

## Alternatives considered

1. **Deploy Colyseus to EC2 at `worms.mccarrison.me`** (stepping stone). Rejected: creates shared-infra cleanup work later, breaks pattern for no gain.
2. **Hybrid: Worker static + Colyseus on EC2**. Rejected: worst of both worlds - new infra AND pattern break.
3. **Port to Partykit** (Colyseus-like lib on Workers). Rejected: adds a dependency that duplicates what we can write in ~100 lines.

## References
- Mini-golf repo: https://github.com/scottmccarrison/mini-golf/tree/main/worker
- Skifree repo: https://github.com/scottmccarrison/skifree-web/tree/main/worker
- Cloudflare Durable Objects: https://developers.cloudflare.com/durable-objects/
- DO WebSocket hibernation: https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- [ADR-001](001-framework-pivot.md): original Phaser + Colyseus + planck pivot.
