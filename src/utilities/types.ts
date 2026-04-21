import type { Worm } from "../worm/Worm";

/** Minimal shared contract. Rope and JetPack each implement independently. */
export interface Utility {
  readonly worm: Worm;
  isActive(): boolean;
  activate(): void;
  deactivate(): void;
  update(dtMs: number): void;
  /** Called when Worm is about to be destroyed. Should clean up all physics bodies/joints. */
  destroy(): void;
}
