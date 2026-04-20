# worms - Claude project context

Project-specific instructions for Claude sessions working in this repo. Overrides global `~/CLAUDE.md` defaults where they conflict.

## Mission

Browser-based multiplayer Worms-style artillery game. Friends visit `mccarrison.me/worms`, one hosts a room with a 4-letter code, others join. MVP: 9 weapons (8 classic + Bazooka) + multiplayer with room codes + reconnection. Post-MVP: ~30 weapons, game modes, procedural maps, team cosmetics.

## Status

**Phase**: Foundation complete (PR #26, merged 2026-04-20). Scaffolding only; no game logic yet.

**Next**: Epic 3 (port destructible terrain from reference/ to planck.js).

See [docs/ROADMAP.md](docs/ROADMAP.md) for full state.

## Stack

- **Build**: Vite 6 + TypeScript 5 (strict, bundler resolution) + Biome 1.9
- **Physics**: planck.js (pure-JS Box2D port). Picked over Rapier (WASM) to avoid cold-load stutter for casual play; bodies are few (few worms + projectiles) so JS perf is fine
- **Multiplayer** (future): Socket.IO 4, authoritative server on EC2 alongside brain. Lockstep ruled out (reference had it, too fragile at >50ms latency)
- **Deploy** (future): static frontend at `mccarrison.me/worms`, WebSocket proxied via nginx to Socket.IO server on the same EC2. Same-origin avoids CORS + extra TLS cert
- **Node**: 20+ (pinned via `.nvmrc`)

## Origin

Fork of [CiaranMcCann/Worms-Armageddon-HTML5-Clone](https://github.com/CiaranMcCann/Worms-Armageddon-HTML5-Clone) (Apache 2.0, 2012-2013, 10 years dead).

The original 74-file TypeScript codebase is archived verbatim under [`reference/`](reference/README.md). It's excluded from Vite's build, Biome's lint, and GitHub's language stats (`.gitattributes linguist-vendored`). **Reference code does not ship.** Each Epic 3-7 ports a module, then the corresponding reference files get deleted in that epic's PR. A final "retire-legacy" PR removes the whole `reference/` tree once everything is ported.

## Asset strategy

- **Zero Team17 assets in the shipped game.** Reference ships copyrighted art; all of it gets replaced.
- **Source**: OpenGameArt.org (CC0/CC-BY) first, commission gaps if needed
- **No AI-generated art** per user preference
- **Audio**: Freesound.org (CC0/CC-BY)
- License tracking: every asset documented in `NOTICE`

## Conventions

- **GitHub issues are the source of truth** for work tracking. Epics #1-15 = MVP roadmap. Enhancements #16-25 = post-MVP. Labels: `epic`, `enhancement`, `bug`, area labels (`area:core`, `area:netcode`, etc.). No milestones - keep labels flat.
- **Plans live in the repo.** When a plan is written for an epic, commit it to `docs/plans/epic-<N>-<shortname>.md` as part of that epic's PR. Opaque `~/.claude/plans/*.md` files are working copies only; the repo version is canonical.
- **No em dashes** in any file or commit message. Use regular hyphens. User preference.
- **Agent workflow**:
  - `/plan` produces a plan file, user approves
  - `/build` creates worktrees at `../worms-wsN`, dispatches Sonnet agents (general-purpose type, NOT Bash) with exact specs, Haiku agents verify diffs
  - `/bugcheck` runs on the merged integration branch before PR
  - PR gets squash-merged, issues auto-close via `Closes #N`
  - Worktrees and local branches cleaned up
- **Auto-merge docs/config/infra PRs.** Hold for review: anything touching game logic once it exists, netcode, or user-visible behavior.
- **Plans must explicitly invoke relevant skills.** Not optional. Specifically:
  - UI-touching epics (#8 lobby, weapon selector, HUD, anything rendering to DOM): include `/frontend-design` as a plan step so we don't ship generic-AI-looking UI
  - Pre-deploy (#13) and anything touching auth/WebSocket security: include `/security-review` before merge
  - Risky PRs (netcode, response shape changes): include `/review` for a second pass

## Plan-time resources

Before writing a plan, pull current docs via Context7 MCP (installed user-scope) for any library the epic depends on. Don't rely on training-cutoff knowledge for specific API surfaces (method names, config shapes, breaking changes). Example query pattern: `resolve-library-id planck.js` then `get-library-docs` with a focused topic like "collision filtering" or "distance joint".

When Context7 doesn't have a library or the topic is non-library (game netcode theory, asset licensing, hosting), use WebFetch against the authoritative URL. See "References by epic" below.

## Pick-up ritual

When resuming work after `/clear` or a new session:

1. Read this file
2. Read `docs/ROADMAP.md` for current phase and open epics
3. `gh pr list --repo scottmccarrison/worms --state all --limit 5` for recent activity
4. `git log --oneline -10` for recent commits
5. Check `docs/plans/` for plans on in-progress epics
6. Ask user what to work on, or propose based on ROADMAP

## Key decisions (rationale that isn't obvious from code)

- **Archive, don't delete, legacy code**: keeps port reference in-tree; beats `git show HEAD~50:src/Worm.ts`
- **planck.js over Rapier**: snappier cold load (no WASM init); casual multiplayer game has few bodies so WASM perf advantage doesn't pay off
- **Authoritative server over lockstep**: reference's lockstep was brittle; turn-based gameplay means only active player's inputs matter, keeping netcode simple
- **Room codes in-memory (not DB-backed)**: 4 letters = 456k combos, collisions rare, games ephemeral, no account system needed

## References by epic

Consult these at plan time. Context7 for library docs; WebFetch for articles. Don't guess from training-cutoff knowledge; these surfaces change.

### Epic 3 — Destructible terrain
- planck.js (via Context7): body construction, collision filtering, polygon fixtures, body destruction
- [Canvas pixel-mask destructible terrain pattern](https://seblagarde.wordpress.com/2012/01/08/pixel-perfect-2d/) (article; same technique used in reference `Terrain.ts`)
- Reference: `reference/src/environment/Terrain.ts`, `reference/src/system/Physics.ts`

### Epic 4 — Worm physics + movement
- planck.js (via Context7): distance joint (ninja rope), contact sensors (foot detection), applyForce vs applyImpulse
- Reference: `reference/src/Worm.ts`, `reference/src/weapons/NinjaRope.ts`, `reference/src/weapons/JetPack.ts`

### Epic 5 — Turn state + win condition
- No external docs needed; pure logic port
- Reference: `reference/src/GameStateManager.ts`, `reference/src/gui/CountDownTimer.ts`

### Epic 6 — Weapon system
- planck.js (via Context7): raycast (hitscan weapons: shotgun, minigun), body types (sensors for mines)
- Reference: `reference/src/weapons/*.ts`, `reference/src/weapons/WeaponManager.ts`
- Wind/trajectory math: basic kinematics, no library needed

### Epic 7 — Maps
- No external library needed for static maps
- For map JSON format, reference Tiled map editor conventions as inspiration: [Tiled JSON format](https://doc.mapeditor.org/en/stable/reference/json-map-format/)

### Epic 8 — Lobby UI
- **Invoke `/frontend-design` skill as a plan step.** Do not write UI directly.
- Context7: Socket.IO client library for the join/create flow integration point
- Inspiration references: Hedgewars lobby UX, Jackbox join-by-code pattern

### Epic 9 — Authoritative server netcode
- [Gaffer On Games — Networked Physics](https://gafferongames.com/categories/networked-physics/) — **read before planning**; canonical reference
- [Gaffer On Games — Introduction to Networked Physics](https://gafferongames.com/post/introduction_to_networked_physics/)
- [Valve Source Multiplayer Networking](https://developer.valvesoftware.com/wiki/Source_Multiplayer_Networking)
- Socket.IO (via Context7): rooms, namespaces, adapter, broadcast patterns, ack timeouts
- Server game loop: `setInterval` or `setImmediate` + accumulator pattern (Gaffer's "Fix Your Timestep")

### Epic 10 — Reconnection
- Socket.IO (via Context7): connection state recovery, session persistence
- [Socket.IO Connection State Recovery docs](https://socket.io/docs/v4/connection-state-recovery)

### Epic 11 — Sprites
- [OpenGameArt.org — filter CC0/CC-BY](https://opengameart.org/art-search-advanced?keys=worm&field_art_type_tid%5B%5D=9&sort_by=count&sort_order=DESC)
- License compatibility: CC0 always OK; CC-BY requires attribution in NOTICE

### Epic 12 — Audio
- [Freesound.org — filter CC0/CC-BY](https://freesound.org/search/?f=license%3A%22Creative+Commons+0%22)

### Epic 13 — Deploy
- **Invoke `/security-review` skill before merge.**
- [Socket.IO Server Deployment guide](https://socket.io/docs/v4/server-deployment/)
- [Nginx WebSocket reverse proxy](https://nginx.org/en/docs/http/websocket.html)
- [OWASP — WebSocket security (CSWSH)](https://owasp.org/www-community/attacks/Cross_Site_WebSocket_Hijacking)
- Same EC2 as brain (100.105.131.123); nginx already terminates TLS for brain

### Epic 14 — CI/CD
- [GitHub Actions security hardening (StepSecurity)](https://github.com/step-security/secure-repo)
- Context7: actions/checkout, actions/setup-node latest docs

### Epic 15 — Tests
- Context7: vitest latest docs
- For E2E later: Playwright (Context7)
