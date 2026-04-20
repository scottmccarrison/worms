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
