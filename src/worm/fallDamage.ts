/**
 * Compute damage from a landing impulse.
 * Returns an integer HP value (0 if below threshold).
 *
 * Matches reference: threshold at `threshold * density`, linear scaling,
 * capped at `maxDamage`.
 */
export function fallDamageFromImpulse(
  normalImpulse: number,
  config: { density: number; threshold: number; maxDamage: number },
): number {
  const effectiveThreshold = config.threshold * config.density;
  if (normalImpulse <= effectiveThreshold) return 0;

  const excess = normalImpulse - effectiveThreshold;
  const raw = excess * (config.maxDamage / effectiveThreshold);
  return Math.min(config.maxDamage, Math.round(raw));
}
