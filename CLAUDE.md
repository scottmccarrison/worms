# worms - Claude project context

Project-specific instructions for Claude sessions working in this repo. Overrides global `~/CLAUDE.md` defaults where they conflict.

## Mission

Browser-based multiplayer Worms-style artillery game. Friends visit `mccarrison.me/worms`, one hosts a room with a 4-letter code, others join. MVP: 9 weapons (8 classic + Bazooka) + multiplayer with room codes + reconnection. Post-MVP: ~30 weapons, game modes, procedural maps, team cosmetics.

## Target platforms (first-class)

**Mobile-web (landscape) is the primary target.** Desktop is secondary. The product shape ("Cody texts me a link, we tap to play") is inherently mobile-first.

- **Orientation**: landscape-locked in-game. Portrait shows a "rotate your device" splash.
- **Canvas**: Phaser `Scale.FIT` at 1280x720 logical, scales to any viewport. Already working; verified via letterboxing in narrow browsers.
- **Input**: **touch is the primary control surface**; keyboard is additive/desktop-only.
  - Gameplay: on-screen virtual controls (d-pad + action buttons) OR gesture-based (drag-to-aim-and-release). Every gameplay epic must design touch FIRST, then layer keyboard on top.
  - Lobby / menus: big tap targets (>=44px), no hover-dependent UI, OS Web Share API for invite links.
- **Performance budget**: <2s cold load on 4G, 60fps on mid-tier phones (iPhone 12 / Pixel 6 era). Current ~400KB gzipped bundle is on budget.
- **PWA**: Epic 13 ships a Web App Manifest so the site can be installed to home screen; iOS standalone mode handled.
- **Viewport**: already correct (`width=device-width, initial-scale=1`); future PRs should not regress this.

**When writing a plan for any UI- or input-touching epic, the plan MUST include a touch-first section.** Plans that ship "keyboard only" for a gameplay mechanic are incomplete and block merge.

## Status

**Phase**: Foundation + alignment complete. PR #26 (build scaffolding) + PR #27 (orchestration docs) + PR #28 (plan-time resources) + the pivot PR (Phaser stack + server scaffold) all merged.

**Next**: Epic 3 (port destructible terrain algorithm, wrap in a Phaser Scene with planck physics).

See [docs/ROADMAP.md](docs/ROADMAP.md) for full state and [docs/decisions/](docs/decisions/) for architecture decision records.

## Stack

Framework pivot happened 2026-04-20; see [ADR-001](docs/decisions/001-framework-pivot.md) for rationale. Previously planned as hand-rolled Canvas + Socket.IO; now modern indie-game stack:

- **Client framework**: Phaser 3 (batteries-included 2D: sprites, input, scenes, audio, tweens, particles, camera)
- **Physics**: planck.js (Box2D port). Phaser's default Matter.js is swapped out; we plug planck in.
- **Multiplayer**: Colyseus (room-based server framework: join-by-code, authoritative state, binary schema, reconnection). Collapses Epic 8-10 into one integration epic.
- **Art pipeline**: Aseprite -> JSON atlas. Standard indie pixel-art workflow; Phaser loads both natively.
- **Live tuning**: dat.gui overlay toggled with `` ` `` (backtick) in dev builds. All tunables live in `src/tuning.ts`; no hardcoded magic numbers in game logic.
- **State machines** (added when needed): xstate for game flow (lobby -> playing -> ended), weapon charge states, etc.
- **Build**: Vite 6 + TypeScript 5 (strict, bundler resolution) + Biome 1.9
- **Node**: 20+ (pinned via `.nvmrc`)

**Deploy** (future): client to Cloudflare Pages (static CDN). Server (Colyseus) to Fly.io or co-located on brain's EC2 with nginx proxying `/worms/ws`. See Epic 13.

## Drop-in philosophy

Adding content should be a data file + sprite, not custom code. The stack is chosen so:

- **A new weapon** = one Aseprite sprite + one `src/weapons/<name>.ts` config file (mostly data; maybe 10-30 lines of unique behavior for things like homing missiles). See [docs/guides/adding-a-weapon.md](docs/guides/adding-a-weapon.md).
- **A new map** = one PNG mask + one JSON config, OR a procedural generator function. See [docs/guides/adding-a-map.md](docs/guides/adding-a-map.md).
- **A new character (worm skin)** = one Aseprite file with named animation tags. See [docs/guides/adding-a-character.md](docs/guides/adding-a-character.md).
- **Tuning** = drag a slider, commit the value. Never edit hardcoded magic numbers. See [docs/guides/tuning-physics.md](docs/guides/tuning-physics.md).

**The one custom thing**: destructible terrain. Unlike other entities (one sprite + one body), terrain is a pixel mask + hundreds of static bodies rebuilt on every explosion. Always a custom subsystem; ported algorithmically from the 2013 reference, wrapped as a Phaser GameObject.

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
- **Touch-first for gameplay + UI epics.** See "Target platforms" above. Any plan that ships a mechanic with keyboard-only controls is incomplete. Test on mobile viewport before PR (Chrome DevTools device emulation at minimum).

## Plan-time resources

Before writing a plan, pull current docs via Context7 MCP (installed user-scope) for any library the epic depends on. Don't rely on training-cutoff knowledge for specific API surfaces (method names, config shapes, breaking changes). Example query pattern: `resolve-library-id planck.js` then `get-library-docs` with a focused topic like "collision filtering" or "distance joint".

When Context7 doesn't have a library or the topic is non-library (game netcode theory, asset licensing, hosting), use WebFetch against the authoritative URL. See "References by epic" below.

## Pick-up ritual

When resuming work after `/clear` or a new session:

1. Read this file
2. Skim `docs/decisions/` for any ADRs that affect the upcoming work
3. Read `docs/ROADMAP.md` for current phase and open epics
4. `gh pr list --repo scottmccarrison/worms --state all --limit 5` for recent activity
5. `git log --oneline -10` for recent commits
6. Check `docs/plans/` for plans on in-progress epics
7. Ask user what to work on, or propose based on ROADMAP

## Key decisions (rationale that isn't obvious from code)

- **Framework pivot (2026-04-20)**: switched from hand-rolled Canvas + Socket.IO to Phaser 3 + Colyseus + planck + Aseprite. Port the algorithms from reference/, not the architecture. See [ADR-001](docs/decisions/001-framework-pivot.md).
- **Terrain is the one custom subsystem**: every other entity is sprite + body (drop-in data); terrain is a pixel mask + many bodies that don't fit that pattern. Custom by necessity.
- **Archive, don't delete, legacy code**: keeps port reference in-tree; beats `git show HEAD~50:src/Worm.ts`. Each epic deletes its corresponding reference files in the same PR (port-then-delete).
- **planck.js over Rapier**: snappier cold load (no WASM init); casual multiplayer game has few bodies so WASM perf advantage doesn't pay off.
- **Colyseus over hand-rolled Socket.IO**: collapses Epic 8-10 (lobby/netcode/reconnection) into one integration epic. Binary schema, room codes, reconnection all built in.
- **Authoritative server over lockstep**: reference's lockstep was brittle; turn-based gameplay means only active player's inputs matter, keeping netcode simple.
- **Room codes in-memory (not DB-backed)**: 4 letters = 456k combos, collisions rare, games ephemeral, no account system needed. Colyseus assigns these as Room ids.
- **No hardcoded tunables in game logic**: everything tweakable lives in `src/tuning.ts`. Live-editable via dat.gui in dev builds. Makes iteration fast and code grep-friendly.
- **No AI-generated art** (user preference): CC0/CC-BY from OpenGameArt/Freesound, commission gaps if needed.

## References by epic

Consult these at plan time. Context7 for library docs; WebFetch for articles. Don't guess from training-cutoff knowledge; these surfaces change.

### Epic 3 — Destructible terrain
- **Phaser 3** (via Context7): Scene lifecycle, GameObjects, custom rendering
- planck.js (via Context7): body construction, collision filtering, polygon fixtures, body destruction
- [Canvas pixel-mask destructible terrain pattern](https://seblagarde.wordpress.com/2012/01/08/pixel-perfect-2d/) (article; same technique used in reference `Terrain.ts`)
- Reference: `reference/src/environment/Terrain.ts`, `reference/src/system/Physics.ts`
- **Note**: implementation wraps the terrain algorithm as a Phaser GameObject; not a raw Canvas loop

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
- **Touch input design required**: weapon select = tap big icons in a drawer; aim + power = drag from worm (direction = angle, distance from worm = power); release = fire. Keyboard stays as secondary. See mobile input enhancement issue.

### Epic 7 — Maps
- No external library needed for static maps
- For map JSON format, reference Tiled map editor conventions as inspiration: [Tiled JSON format](https://doc.mapeditor.org/en/stable/reference/json-map-format/)

### Epic 8-10 — Multiplayer (Colyseus integration, collapsed)

Per [ADR-001](docs/decisions/001-framework-pivot.md), Epic 8 (lobby/rooms), Epic 9 (authoritative state), and Epic 10 (reconnection) collapse into one integration epic. Colyseus provides rooms, state sync, and connection recovery out of the box.

- **Colyseus** (via Context7): Room lifecycle, state schema, client-server message flow, binary serialization
- [Colyseus docs](https://docs.colyseus.io/) - the canonical source
- [Colyseus examples](https://github.com/colyseus/examples) - turn-based game example patterns
- [Gaffer On Games — Networked Physics](https://gafferongames.com/categories/networked-physics/) - still useful for understanding trade-offs even though Colyseus handles most of it
- **Invoke `/frontend-design` skill** for the lobby UI portion — do not write UI directly
- **Mobile-first lobby UI**: big tap targets, portrait-friendly splash, [Web Share API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Share_API) (`navigator.share({ url, title })`) for invite link on mobile, clipboard fallback on desktop. Room code input: large numeric/letter input with auto-focus and uppercase enforcement.

### Epic 11 — Sprites
- [OpenGameArt.org — filter CC0/CC-BY](https://opengameart.org/art-search-advanced?keys=worm&field_art_type_tid%5B%5D=9&sort_by=count&sort_order=DESC)
- License compatibility: CC0 always OK; CC-BY requires attribution in NOTICE

### Epic 12 — Audio
- [Freesound.org — filter CC0/CC-BY](https://freesound.org/search/?f=license%3A%22Creative+Commons+0%22)

### Epic 13 — Deploy
- **Invoke `/security-review` skill before merge.**
- Client: Cloudflare Pages (static bundle from `npm run build`)
- Server: [Colyseus Server Deployment guide](https://docs.colyseus.io/deployment/) - Fly.io recommended, or EC2 co-located with brain
- [Nginx WebSocket reverse proxy](https://nginx.org/en/docs/http/websocket.html)
- [OWASP — WebSocket security (CSWSH)](https://owasp.org/www-community/attacks/Cross_Site_WebSocket_Hijacking)
- If co-locating: same EC2 as brain (100.105.131.123); nginx already terminates TLS
- **PWA manifest + iOS standalone**: ship `public/manifest.webmanifest` + `apple-touch-icon`, set `display: "standalone"`, so users can "Add to Home Screen" and launch full-screen. Handle iOS `navigator.standalone` edge cases.

### Epic 14 — CI/CD
- [GitHub Actions security hardening (StepSecurity)](https://github.com/step-security/secure-repo)
- Context7: actions/checkout, actions/setup-node latest docs

### Epic 15 — Tests
- Context7: vitest latest docs
- For E2E later: Playwright (Context7)
