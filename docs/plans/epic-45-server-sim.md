# Epic 45 - Server-authoritative sim (port planck to the DO)

Closes #45. Graduates worms from Epic 9's Option C (per-client sim + input relay + turn-end snapshot) to a server-authoritative design where the Durable Object owns the planck World. Client becomes a thin renderer + input capture + audio/particle effects. Removes every Option C band-aid because the gaps they patched stop existing.

Triggered by 2-phone mobile playtest showing within-turn drift (aim arrow not visible to spectator, crater locations diverging, Red-1 position wrong on one phone). Root cause is non-deterministic planck + unhooked input paths. Authoritative sim eliminates both classes.

## Scope

### In scope
- `worker/src/room.ts` owns a planck `World` instance, ticks at 20Hz via DO alarms.
- Server-side Worm / Projectile entity classes (position / velocity / health / team / owner).
- Server-side Terrain: owns the mask + body management + cut log. Broadcasts cut events.
- Server-side `fire.ts` / `explode.ts` ports: active player sends `input_fire`, server runs the weapon logic authoritatively.
- State broadcast protocol: `sim_state { worms, projectiles, rngSeq, tick }` at 20Hz, `terrain_cut { x, y, r, seq }` on events, `fire_event` / `damage_event` / `worm_died` as needed for client VFX.
- Client renders from `sim_state`: worm sprites follow server positions (interpolated), projectile sprites spawn/despawn on server events.
- Client interpolation between state frames (linear for positions, instant snap for health/team).
- Offline mode (`?offline=1`) keeps the current local-planck path via an `OfflineSimAdapter` so single-device dev + testing still work.
- Remove Option C band-aids now unnecessary: drag-to-aim relay, terrain cuts in turn_snapshot, per-frame input broadcasts, full-state fallback reconciler.
- Tests:
  - Server: new `worker/test/sim.test.ts` driving the full physics tick loop with mocked input.
  - Server: existing `room.test.ts` extended to cover `sim_state` broadcast cadence + input -> sim -> broadcast pipeline.
  - Client: `networkBridge` tests simplified (no `applyRemoteInput` replay; just state-apply).
  - Offline path: explicit test asserting local sim is used when `?offline=1`.

### Out of scope (tracked separately)
- **Client-side prediction** - deferred; accept turn-based latency for v1. File a follow-up if mobile feels laggy in playtest.
- **Deterministic replay / spectator rewind** - not needed for MVP.
- **Server-side anti-cheat** beyond input validation - friends game, accept trust.
- **Rope + jetpack in networked mode** - tracked in **#65**. v1 gates them off in networked mode (keyboard R / J become no-ops when `room` is present); offline mode keeps them. Sustained-input utilities interact poorly with 20Hz server ticks + network latency and need client-side prediction to feel right; both deferred to #65.
- **#53 off-map kill floor** - orthogonal bug. Server port naturally fixes it: add `worm.y > worldHeight + margin` check in Simulation.tick that marks the worm dead. Treat as part of the port, not a separate workstream.
- **#47 spectator smoothing** - **SUPERSEDED** by this epic. Authoritative sim eliminates the jitter condition it was tracking. Close after merge.

## Architecture

```
Browser (client)                          DO Room (server)
+-------------+                           +--------------------------+
| GameScene   |  send(input_*)            |  webSocketMessage(ws,m)  |
|  - capture  |  ------------------->     |    validate active       |
|  - render   |                           |    queue input           |
|  - interp   |                           |                          |
|  - VFX      |  <------ sim_state ------ |  tick() @20Hz via alarm: |
|             |  <------ terrain_cut ---- |    apply inputs          |
|             |  <------ fire_event ----- |    step world(dt)         |
|             |  <------ damage_event --- |    detect fire/damage    |
|             |  <------ worm_died ------ |    broadcast sim_state   |
+-------------+                           |    emit events           |
                                          |                          |
                                          |  + World (planck)        |
                                          |  + Terrain (mask+bodies) |
                                          |  + Worms, Projectiles    |
                                          |  + TurnArbiter           |
                                          +--------------------------+
```

Key: the DO runs the planck World. planck.js is pure JS with no native deps - verified compatible with Workers runtime (no `eval`, no DOM requirement).

### Tick model

DO alarm fires every 50ms. Each alarm:
1. Drain input queue (walk/jump/aim/fire inputs for active player).
2. `world.step(50ms)`.
3. Detect collisions (post-solve), apply damage.
4. If any terrain cut this tick, emit `terrain_cut` events (one per cut).
5. If any worm took damage / died, emit `damage_event` / `worm_died`.
6. Every 50ms (every tick) emit `sim_state` (full worm + projectile snapshot).
7. Advance turn timer. If expired OR all settle, fire `turn_advanced` event, rotate to next team.
8. Schedule next alarm.

Alarm runs inside the DO so hibernation is a non-issue: the alarm handler wakes the DO.

### State broadcast shape

```ts
interface SimState {
  tick: number;                  // monotonic server tick counter
  worms: Array<{
    id: string;                  // e.g. "Red-1"
    x: number; y: number;        // physics-meter coords (client converts to px)
    vx: number; vy: number;
    facing: -1 | 1;
    aimAngle: number;            // radians, relative to facing
    aimPower: number;            // 0..1
    hp: number;
    alive: boolean;
    activeWeapon: string;
    ammoLeft: number;
  }>;
  projectiles: Array<{
    id: string;
    x: number; y: number;
    vx: number; vy: number;
    type: string;                // bazooka | shotgun | grenade
    fuseRemainingMs?: number;
  }>;
  activeTeamId: string;
  activeWormId: string;
  turnEndsAt: number;
}
```

Client keeps two frames: previous + current. Lerps worm positions between them at 60fps for smoothness.

Events emitted as separate messages:

```ts
{ type: "terrain_cut", x, y, r, seq }              // each cut, for cutCircle replay
{ type: "fire_event", wormId, weaponId, angleRad, power }   // VFX trigger
{ type: "damage_event", wormId, amount, fromProjectileId?, impact: { x, y } }
{ type: "worm_died", wormId }
{ type: "game_over", winnerTeamId | null }
```

## Workstreams

### W1 - Server sim (worms-ws1)
**Branch:** `feature/epic-45-server-sim`
**Agent:** general-purpose, Sonnet

Files:
- `worker/package.json` - add `planck` as dependency.
- `worker/src/physics/` - NEW. `world.ts` (planck World wrapper), `scale.ts` (px <-> meters).
- `worker/src/entities/worm.ts` - NEW. Authoritative Worm class: body, fixtures, foot sensor, health, aim state, team ref.
- `worker/src/entities/projectile.ts` - NEW.
- `worker/src/entities/terrain.ts` - NEW. Mask + body management + cut log. Broadcasts `terrain_cut` events.
- `worker/src/weapons/fire.ts` - NEW. Port of `src/weapons/fire.ts` without the Phaser Graphics bits (server has no visuals).
- `worker/src/weapons/explode.ts` - NEW. Port.
- `worker/src/weapons/registry.ts` - NEW. Port the weapon configs.
- `worker/src/sim/simulation.ts` - NEW. Simulation class that owns world + terrain + teams + worms. Ticks on call.
- `worker/src/room.ts` - major rewrite:
  - On `start_game`: instantiate Simulation with the map + teams + seed. Schedule alarm at 50ms.
  - On `input_*`: queue input for next tick (active player only).
  - `alarm()`: drain input queue, call `simulation.tick(50)`, collect events, broadcast.
  - Remove `onTurnSnapshot` (authoritative; no client snapshot needed).
  - Remove `input_aim_*` / `input_fire` relay (server applies authoritatively; clients DON'T see relays, they see `sim_state`).
- `worker/src/turnArbiter.ts` - adapted: the arbiter still tracks teams + turn rotation, but it reads from `simulation.aliveWormsByTeam()` instead of trusting client snapshots.
- `shared/protocol.ts` - extend with `SimState`, `TerrainCutEvent`, `FireEvent`, `DamageEvent`, `WormDiedEvent`. Remove the per-input relay variants (they don't broadcast anymore; server handles internally).
- `worker/test/sim.test.ts` - NEW integration tests: walk/jump/aim/fire through the full tick loop, assert positions + terrain cuts + damage.
- `worker/test/room.test.ts` - update: `sim_state` broadcast cadence, input validation, turn advance.

Commits (12, in order):
1. `feat(worker): add planck dep + physics scale helpers`
2. `feat(worker): Terrain entity (mask + body management + cut log)`
3. `feat(worker): Worm entity with foot sensor + health`
4. `feat(worker): Projectile entity with fuse + owner tracking`
5. `feat(worker): port weapon registry + fire + explode to server`
6. `feat(worker): Simulation class (world + teams + entities + tick)`
7. `feat(worker): turnArbiter reads alive counts from simulation`
8. `feat(worker): room.ts runs alarm-driven sim, broadcasts sim_state`
9. `feat(worker): terrain_cut / fire_event / damage_event / worm_died`
10. `chore(worker): remove turn_snapshot handler + per-input relay`
11. `test(worker): sim integration tests (walk/fire/cut/damage)`
12. `test(worker): room state broadcast + input validation tests`

Every commit footer:
```
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

Acceptance:
- `cd worker && npm install` succeeds with planck.
- `cd worker && npx tsc --noEmit` passes.
- `cd worker && npm test` passes, at least 30 tests.
- `cd worker && npx wrangler dev --local` starts cleanly.

### W2 - Client renderer (worms-ws2)
**Branch:** `feature/epic-45-client-render`
**Agent:** general-purpose, Sonnet (parallel with W1)

Files:
- `package.json` - keep `planck` (needed for offline mode).
- `src/sim/OfflineSimAdapter.ts` - NEW. Wraps the existing local planck sim for `?offline=1` mode. Same interface as the networked adapter so GameScene code is oblivious to which it's using.
- `src/sim/NetworkedSimAdapter.ts` - NEW. Reads from `room.state` (SimState) + `room.onMessage(events)`. Maintains two frames of sim state for interpolation. Exposes `getWormRenderState(id): { x, y, facing, aimAngle, aimPower, hp, alive }` that GameScene calls every render frame.
- `src/sim/SimAdapter.ts` - shared interface.
- `src/scenes/GameScene.ts` - major rewrite:
  - No more local `PhysicsSystem` / `world.step()` / `fire()` / `explode()` / `ProjectileManager`.
  - Worm sprites are thin: get position from `simAdapter.getWormRenderState(id)`, interpolate between the two latest state frames.
  - Terrain sprite listens to `terrain_cut` events, calls `terrain.cutCircle(x, y, r)` to update the visual mask (still client-side: it's just a canvas mask, no bodies).
  - Projectile sprites spawn on `fire_event`, positions from sim state, despawn when server state drops them.
  - Damage numbers / blood particles / screen shake fire on `damage_event`.
  - Worm death animation fires on `worm_died`.
  - Input capture sends directly to `room.send` - no local sim side-effects.
- `src/worm/Worm.ts` - slim down: rendering + aim line only, no physics body, no damage tracking.
- `src/weapons/` - keep registry for touch weapon-drawer UI, remove fire/explode/projectile manager.
- `src/terrain/Terrain.ts` - slim down: sprite + mask + cutCircle (visual only). No bodies, no physics, no flushPendingCuts → body-rebuild.
- Offline gate: `GameScene.init(data)` picks `OfflineSimAdapter` if `!data.room`, else `NetworkedSimAdapter`. Rest of the scene code is uniform.
- Tests:
  - `src/sim/NetworkedSimAdapter.test.ts` - NEW: two sim_state frames → interpolates correctly, events fire on message receipt.
  - Existing Worm/weapons tests: delete server-shifted ones (fire/explode/ProjectileManager). Keep visual ones.

Commits (10, in order):
1. `feat(client): SimAdapter interface + OfflineSimAdapter wrapping local planck`
2. `feat(client): NetworkedSimAdapter reads sim_state + event messages`
3. `feat(client): interpolated render state (two-frame buffer)`
4. `chore(client): slim Worm.ts to render-only (no body, no health)`
5. `chore(client): slim Terrain.ts to visual mask (no bodies)`
6. `chore(client): remove weapons/{fire,explode,ProjectileManager}`
7. `feat(scene): GameScene reads sim state from adapter, no local step()`
8. `feat(scene): terrain_cut / damage_event / worm_died VFX hooks`
9. `feat(scene): input capture sends to room without local side-effects`
10. `test(client): NetworkedSimAdapter interpolation + event dispatch`

Every commit footer:
```
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

Acceptance:
- `npm install` succeeds.
- `npm run typecheck` passes.
- `npm run lint` passes.
- `npm test` passes (expect ~120 tests; some removed, some added).
- `npm run build` succeeds.
- `?offline=1` still renders a local game (uses OfflineSimAdapter).

### W3 - Integration + deploy (Opus, after W1 + W2 merge)
**Branch:** `feature/epic-45-integration`

- Resolve shared/protocol.ts conflicts (both W1 and W2 touch it).
- Verify full build + test + lint green.
- Remove Option C band-aids now dead:
  - GameScene's `throttleAimBroadcast` / `flushPendingAim` - no longer needed, server owns aim.
  - GameScene's `sendTurnSnapshot` / `applyTurnResolved` - no longer needed.
  - Terrain's `consumeTurnCuts()` / `turnCuts` - server's role.
  - networkBridge's `applyRemoteInput` / `buildTurnSnapshot` - dead.
- Update README + CLAUDE.md + ADR-003 (sim graduation).
- Deploy.

Commits (4):
1. `chore: remove Option C band-aids superseded by Epic 45`
2. `docs: ADR-003 server-authoritative sim + README update`
3. `docs(roadmap): flip Epic 45 to Done`
4. `chore: final lint + typecheck cleanup`

## Risks + mitigations

- **planck on Workers**: verified pure JS; no Node deps. If a subtle incompatibility surfaces, fallback is a minimal hand-rolled 2D sim (probably ~500 LOC for worms' needs) but this is unlikely needed.
- **Sim broadcast bandwidth**: 20Hz × ~4 worms × ~100 bytes + up to ~5 projectiles × ~50 bytes = ~10-12 KB/s per client. Trivially under any mobile budget.
- **Sim state size during projectile bursts**: cap projectile count at 8 concurrent to bound state size.
- **Turn timer drift**: client reads `turnEndsAt` from server state; no drift possible.
- **Reconnection**: DO state persists; reconnect reattaches the WebSocket and receives the next `sim_state` broadcast. Simpler than Option C's reconcile-on-resume.
- **Offline mode breaks**: gated via explicit adapter swap, covered by regression test.
- **Client interpolation artifacts**: linear lerp between 50ms frames on fast-moving projectiles = 50-100px per tick. Acceptable for a casual game; can upgrade to extrapolation if it feels bad.
- **Server CPU per tick**: 4-8 worms + a few projectiles is trivial for planck. At 20Hz DO alarm cadence, CPU budget per alarm is ~50ms; actual work is <5ms. Easily fits.

## Bugcheck targets (pre-PR)
- **HIGH**: planck world state corruption if alarms race (two alarms firing concurrently). Defend by checking a `tickInProgress` flag inside the alarm handler.
- **HIGH**: input validation. Active-player-only + field-type validation (dir ∈ {-1, 0, 1}, angleRad finite, power ∈ [0, 1], etc.).
- **HIGH**: terrain cut broadcast storms. Coalesce cuts in the same tick into a single `sim_state` delta, not N `terrain_cut` events.
- **MEDIUM**: projectile-worm collision handling. Ensure server sees the contact (planck post-solve). Already works on client; should port identically.
- **MEDIUM**: reconnection mid-turn: client's state buffer is empty until next sim_state arrives. Briefly show a loading state or freeze on last-known state.
- **LOW**: interpolation "snap" when receiving first state after a pause. Clamp max lerp distance.

## Out-of-scope cleanup tracked separately
- #47 spectator smoothing - SUPERSEDED. Authoritative sim eliminates the condition it was tracking.
- Option C band-aids in `src/`: removed in W3.

## References
- Mini-golf worker + DO pattern.
- Gaffer On Games: https://gafferongames.com/post/snapshot_interpolation/
- planck.js docs: http://piqnt.com/planck.js/
- Epic 13 plan (`docs/plans/epic-13-workers.md`).
