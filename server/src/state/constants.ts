/**
 * Shared timing constants for the Epic 9 turn arbiter.
 *
 * `TURN_DURATION_MS` is the wall-clock budget a player has to complete
 * their turn. `SETTLE_GRACE_MS` is additional time the server waits
 * past `turnEndsAt` for the active client's `turn_snapshot` to arrive
 * before force-advancing with last-known state.
 */
export const TURN_DURATION_MS = 45_000;
export const SETTLE_GRACE_MS = 6_000;
