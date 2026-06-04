# Multiplayer Parity Sweep + Bigger World & Teams

Brings the online (Cloudflare Durable Object) game up to parity with the
offline client, applies a wider world (15360x1280), and grows teams from 2 to
4 worms. Multi-PR epic.

## Root cause

The game has two independent simulations:

- **Offline** (`src/sim/OfflineSimAdapter.ts` + client physics) - the living,
  fully-featured codebase used via `?offline=1`.
- **Online** (`worker/src/sim/simulation.ts`, the authoritative DO) - a
  hand-ported copy that drifted behind.

Updates landed offline and never reached the worker. Every "multiplayer is
missing X" symptom traces to this fork.

## Gap inventory

| Capability | Offline | Online (worker) | Tracked |
|---|---|---|---|
| World size | 6144x1280 (now 15360) | stale 2560x1024 hardcode | (this epic) |
| Ninja rope | `NinjaRope.ts` works | `toggleRope()` no-op stub | #65 / #82 |
| Drill | `Drill.ts` utility | not wired to worker | #201 |
| Jetpack force | up 17 / side 10 (#221) | up 15 / side 8 (drift) | (this epic) |
| Jetpack activation | reliable | J-key/button bug online | #160 |
| Teams | 2 (want 4) | 2 | #46 |
| Terrain sync | stable | guest float/sink at start | #173 |

## Locked decisions

- World: **15360x1280** (go-wide, 2.5x width, height unchanged). Width stays
  under the ~16384px WebGL max-texture-size ceiling (terrain is one canvas
  texture this wide, `src/terrain/Terrain.ts`).
- Teams: **2 -> 4** worms per team.
- Terrain mask transport is **deflate-compressed** (see PR1). An uncompressed
  15360 mask is ~3.2MB of base64 and overflows DO storage (`SQLITE_TOOBIG`);
  compressed it is ~20-45KB. This was a pre-existing ceiling the online/offline
  split hid (online never grew past 2560).

---

## PR1 - Unify world size + go wide + mask compression  [DONE]

Branch `feat/world-unify-gowide`. Foundation; likely closes #173.

- `shared/worldConfig.ts`: `WORLD_WIDTH_PX` 6144 -> 15360 (+ ceiling note).
- Removed the stale `2560x1024` hardcodes; `worker/src/room.ts` and
  `src/scenes/LobbyScene.ts` now import from `worldConfig`. This is the actual
  split-brain bug (host generated 2560, worker validated 2560, offline used
  6144) and the most likely cause of #173.
- Placeholder barrels (`room.ts`) scaled to world width.
- Mask + material map are deflate-compressed for the wire and DO storage:
  - shared helpers `packedToWire` / `wireToPacked` (+ `bytesToBase64` /
    `base64ToBytes`) in `shared/maskPack.ts` using `CompressionStream("deflate-raw")`.
  - host (`LobbyScene.handleStart`, now async) compresses before `start_game`.
  - worker (`room.ts` start path, flat fallback, and resume-from-storage)
    decompresses incoming and stores/forwards the compressed form; resume is
    legacy-tolerant (`decodeStoredPacked`) so a deploy does not break an
    in-flight game.
  - guest (`LobbyScene` `game_started` handler, now async) inflates back to the
    uncompressed base64 `GameScene` already decodes - GameScene untouched.
- Tests: `shared/maskPack.test.ts` round-trip + wide-world-under-128KB.
- Verified: root 462 tests, worker 113 tests, lint, typecheck, vite build all
  green. Worker game-start tests previously failed `SQLITE_TOOBIG` at 15360;
  compression fixes them.

**Post-merge gate:** deploy (`npm run deploy`) then a live multiplayer playtest
to confirm guest worms no longer float/sink (#173) and the 15360 world renders.

## PR2 - Teams 2 -> 4  [touches #46]

- `src/tuning.ts`: `team.wormsPerTeam` 2->4, `worldgen.spawn.minPerTeam` 2->4.
- `worker/src/room.ts`: `WORMS_PER_TEAM` 2->4.
- `src/maps/registry.ts`: `maxWorms` 4->8 all entries; add 4 island spawnPoints.
- Scale worker no-map fallback spawn grid (`room.ts` ~929).
- Update tests asserting 4 total worms -> 8 (`worker/test/sim.test.ts`,
  `twoTeams()` helper).
- Accept: 4/team spawn without overlap on terraworld + geometric maps; turn
  rotation cycles all 4; win condition count-agnostic (already is).

## PR3 - Jetpack tuning sync + activation bug  [fixes #160]

- `worker/src/entities/worm.ts`: `UP_FORCE` 15->17, `SIDE_FORCE` 8->10 to match
  offline `tuning.jetpack` (commit #221). Consider a shared constant to prevent
  re-drift.
- Investigate + fix #160 (J-key / on-screen button does not activate jetpack
  online).

## PR4 - Networked drill  [closes #201, touches #203]

- Reuse `input_fire`; worker `applyFire` branches on `weapon.id==="drill"` ->
  new `applyDrill()` that cuts a rect + emits `terrain_cut`.
- Port `cutRect()` into `worker/src/entities/terrain.ts`.
- Extend `TerrainCutEvent` (`shared/protocol.ts`) with optional
  `angleRad/lengthPx/widthPx`; guest branches rect vs circle in the
  `terrain_cut` handler.
- Un-stub `NetworkedSimAdapter.executeDrill`. Client-side cooldown/usesPerTurn
  gating is sufficient (arbiter already gates turn ownership).

## PR5 - Networked rope  [closes #82/#65, the big one]

- Follow the jetpack netcode pattern: 5 new `input_rope_*` protocol messages,
  server-authoritative rope (planck `DistanceJoint`) in the worker Worm +
  step-loop joint hook, new `WormRenderState` rope fields (anchor + active +
  length) so spectators draw the rope line.
- Client raycasts locally and sends the anchor; un-stub
  `NetworkedSimAdapter.toggleRope` + add fire/extend/retract/release.
- Mutual exclusivity with jetpack; reset on turn start.

---

## Sequencing

PR1 first (foundation, fixes #173). PR2-5 build on it and are mutually
independent, but all touch `protocol.ts` / `room.ts` / `simulation.ts`, so
stage those shared-file edits to avoid conflicts (sequence the protocol
additions, or run on a shared integration branch with a final bugcheck).

These are netcode / game-logic PRs -> held for review (`needs-review`), not
auto-merged. `/bugcheck` before each PR. Deploy + smoke after PR1 and after the
rope/drill PRs.
