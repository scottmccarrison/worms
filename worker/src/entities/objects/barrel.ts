/**
 * Barrel: dynamic body, 1 HP, explodes on destroy. Currently a thin wrapper
 * over ObjectInstance because the catalog carries all behavior. Reserved for
 * kind-specific overrides as the catalog grows.
 */

import { ObjectInstance, type ObjectInstanceInit } from "../objectInstance.js";

export class Barrel extends ObjectInstance {
  constructor(init: Omit<ObjectInstanceInit, "kind">) {
    super({ ...init, kind: "barrel" });
  }
}
