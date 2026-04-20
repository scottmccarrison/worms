# ADR-001: Framework pivot to Phaser + Colyseus + planck + Aseprite

- **Status**: Accepted
- **Date**: 2026-04-20
- **Supersedes**: the initial "port reference architecture 1:1" approach established in PR #26 and the Epic 1-15 roadmap as first written
- **Related**: Epic 3 (terrain), 8 (lobby), 9 (netcode), 10 (reconnection)

## Context

Initial approach (PRs #26, #27, #28) was to fork CiaranMcCann/Worms-Armageddon-HTML5-Clone (2013, Apache 2.0) and port its code module-by-module. The reference codebase is ~7000 LOC across 74 TypeScript files with custom implementations of nearly every game-engine concern: asset loading, scene management, sprite animation, camera, input, physics wrappers, audio preloading, lockstep netcode, and a leaderboards stack.

Partway through planning Epic 3, we stopped and audited: ~60% of the reference code is game-engine plumbing that modern web game tools (2024-2026) make obsolete; only ~40% is genuine game logic and algorithms worth keeping. Continuing the port would mean rebuilding a 2013-era game engine from scratch in TypeScript, spending most of our effort on infrastructure that tools like Phaser and Colyseus solve out of the box.

The three priorities the user explicitly named:

1. **Casual drop-in-and-play with friends.** Text a code, click a link, play. No accounts, no install, no friction.
2. **Snappy and intuitive.** Fast cold load, instant input response, smooth framerate, immediate game start.
3. **Reproducible, data-driven content.** Adding a weapon or map should be a data file + sprite, not custom code. Physics tuning should be a live slider, not a recompile.

Against those priorities, a hand-rolled-from-2013-code approach loses on priority 3 (custom engine = custom everything = not reproducible) and partially on priority 2 (every bespoke piece is another surface to optimize). It ties only priority 1, which any stack can deliver.

## Decision

Adopt the following stack for the worms game:

| Layer | Tool | Why |
|---|---|---|
| **Client framework** | Phaser 3 | Batteries-included 2D (sprites, input, scenes, audio, tweens, particles, cameras). Biggest 2D web framework, TypeScript-first, excellent docs. |
| **Physics** | planck.js | Box2D port, unchanged from original plan. Phaser's default Matter.js is swappable; we plug planck in. |
| **Multiplayer** | Colyseus | Room-based multiplayer framework designed for this exact shape: join-by-code, authoritative server, reconnection, binary schema. Collapses what would be three epics of hand-rolled netcode into one integration epic. |
| **Art pipeline** | Aseprite -> JSON atlas | Indie pixel-art standard. Aseprite exports frame data + PNG sprite sheet; Phaser loads both natively. |
| **Live tuning** | dat.gui | Tiny debug UI toggled with `~` for on-the-fly physics/gameplay constants. Hardcoded-constants are banned; all tunables live in `src/tuning.ts`. |
| **State machines** | xstate (added when needed) | Game flow (lobby -> playing -> ended), weapon charge states, etc. Not critical day 1. |
| **Build** | Vite + TypeScript + Biome | Unchanged from PR #26. |
| **Deploy** | Cloudflare Pages (client) + Fly.io or EC2 (server) | Client: static CDN. Server: regional game server. Both low-cost. |

The reference/ archive remains useful but only as **algorithmic reference** (how destructible terrain works, how turn state is computed, how weapon explosions are modeled) — not architectural reference. The port-then-delete convention still applies per file that gets superseded.

## Alternatives considered

1. **Continue hand-rolled Canvas + Socket.IO (status quo)**. Works but rebuilds engine-level infrastructure for every epic. Estimated 12-15 weeks to MVP with ~30% more custom code owned.
2. **Pixi.js only (rendering library)**. Gives us modern WebGL sprite batching but we still hand-roll scenes/input/audio. Middle ground that doesn't fully address priority 3.
3. **Godot 4 with HTML5 export**. World-class visual editor and asset pipeline; loses TypeScript / JS-native workflow; HTML5 export is solid but adds a compile step; multiplayer is not turn-based-friendly out of the box.
4. **PartyKit (Cloudflare Workers + Durable Objects)**. Modern, serverless, cheap. Less mature than Colyseus for turn-based games; smaller community. Worth revisiting if Colyseus hosting becomes a cost/ops issue.
5. **Full Unity or Unreal WebGL export**. Massive overkill for a 2D turn-based browser game.

## Consequences

**Immediate (this PR)**:
- `server/` workspace added for Colyseus scaffold
- `CLAUDE.md` updated with new stack + drop-in philosophy section
- `docs/guides/` added with step-by-step workflows for adding weapons, maps, characters; tuning workflow
- `ROADMAP.md` updated: Epic 8-10 (lobby/netcode/reconnection) collapse under Colyseus integration scope
- Issue comments on #3, #8, #9, #10 referencing this ADR

**Epic 3 (next)**: Implementation changes, scope same. Terrain algorithm port is unchanged. Demo becomes a Phaser Scene instead of a raw Canvas render loop. Adds Phaser + planck + dat.gui as dependencies.

**Epic 4-7 (core gameplay)**: Much less code. Worm = Phaser Sprite + planck body + Aseprite-animated atlas. Weapons = data files + small behavior functions. Maps = PNG + JSON OR procedural generator. Turn state = xstate machine.

**Epic 8-10 (multiplayer)**: Colyseus collapses these. One epic: "Colyseus integration" covers rooms + join codes + authoritative state + schema + reconnection out of the box. Remaining custom work: lobby UI, game-specific schema, turn-handoff protocol.

**Epic 11-12 (assets)**: Aseprite files in `public/assets/` (characters, weapons, effects, terrain themes). Freesound for audio. Licensing tracked in `NOTICE`.

**Epic 13 (deploy)**: Two-target deploy: Cloudflare Pages for the Vite-built client, Fly.io or EC2 for the Colyseus server. nginx proxy `/worms/ws` -> Colyseus if we co-locate on brain's EC2.

**Bundle size trade**: client gains ~400KB gzipped (Phaser) but that's ~1s extra cold load on broadband. Acceptable cost for what we get.

**What we lose**: the "minimal modern stack" purity of a Vite + TypeScript + nothing-else setup. We gain ~3 dependencies but save weeks of writing engine-level code. Net win per our priorities.

## Open questions (non-blocking)

- **Server colocation vs separate host**: run Colyseus on brain's EC2 via nginx proxy, or Fly.io for game-server-specific features (regional routing, DDoS protection)? Revisit at Epic 13.
- **State machines library**: xstate, zustand-with-FSM, or hand-rolled? Revisit at Epic 5.
- **Audio engine**: Phaser's built-in (Howler under the hood) is probably enough; revisit at Epic 12 if we need spatial audio or precise timing.

## How to use this ADR

Future sessions pick this up as "stack is locked; algorithms are ported from reference/; architecture is modern." When writing a plan for any epic, check the References by epic section in CLAUDE.md, verify stack alignment before proposing custom infrastructure, and cite this ADR in any PR that revisits the decision.
