import * as Phaser from "phaser";
import type { Worm } from "../worm/Worm";

export interface InputControllerInit {
  scene: Phaser.Scene;
  worms: Worm[]; // all worms, alive + dead
}

export class InputController {
  private readonly scene: Phaser.Scene;
  private readonly worms: Worm[];
  private activeIndex: number;

  // Key bindings
  private readonly keyLeft: Phaser.Input.Keyboard.Key;
  private readonly keyRight: Phaser.Input.Keyboard.Key;
  private readonly keyA: Phaser.Input.Keyboard.Key;
  private readonly keyD: Phaser.Input.Keyboard.Key;
  private readonly keySpace: Phaser.Input.Keyboard.Key;
  private readonly keyBackspace: Phaser.Input.Keyboard.Key;
  private readonly keyShift: Phaser.Input.Keyboard.Key;
  private readonly keyUp: Phaser.Input.Keyboard.Key;
  private readonly keyDown: Phaser.Input.Keyboard.Key;
  private readonly keyW: Phaser.Input.Keyboard.Key;
  private readonly keyS: Phaser.Input.Keyboard.Key;
  private readonly keyTab: Phaser.Input.Keyboard.Key;

  constructor(init: InputControllerInit) {
    this.scene = init.scene;
    this.worms = init.worms;

    const kb = this.scene.input.keyboard;
    if (!kb) throw new Error("InputController: keyboard plugin not available");

    this.keyLeft = kb.addKey(Phaser.Input.Keyboard.KeyCodes.LEFT);
    this.keyRight = kb.addKey(Phaser.Input.Keyboard.KeyCodes.RIGHT);
    this.keyA = kb.addKey(Phaser.Input.Keyboard.KeyCodes.A);
    this.keyD = kb.addKey(Phaser.Input.Keyboard.KeyCodes.D);
    this.keySpace = kb.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
    this.keyBackspace = kb.addKey(Phaser.Input.Keyboard.KeyCodes.BACKSPACE);
    this.keyShift = kb.addKey(Phaser.Input.Keyboard.KeyCodes.SHIFT);
    this.keyUp = kb.addKey(Phaser.Input.Keyboard.KeyCodes.UP);
    this.keyDown = kb.addKey(Phaser.Input.Keyboard.KeyCodes.DOWN);
    this.keyW = kb.addKey(Phaser.Input.Keyboard.KeyCodes.W);
    this.keyS = kb.addKey(Phaser.Input.Keyboard.KeyCodes.S);
    this.keyTab = kb.addKey(Phaser.Input.Keyboard.KeyCodes.TAB);

    // Prevent Tab from stealing browser focus
    this.keyTab.on("down", (evt: KeyboardEvent) => {
      evt.preventDefault?.();
    });

    // Start at first alive worm
    this.activeIndex = this.findNextAliveFrom(0);
    this.updateActiveHighlight();
  }

  /** Called from GameScene.update. Polls keys, dispatches to active worm. */
  update(dtMs: number): void {
    // Tab cycles on single press
    if (Phaser.Input.Keyboard.JustDown(this.keyTab)) {
      this.cycleActive();
      return;
    }

    const worm = this.getActiveWorm();
    if (!worm) return;

    // Walk axis: left/right or A/D
    const goLeft = this.keyLeft.isDown || this.keyA.isDown;
    const goRight = this.keyRight.isDown || this.keyD.isDown;
    let walkDir: -1 | 0 | 1 = 0;
    if (goLeft && !goRight) walkDir = -1;
    else if (goRight && !goLeft) walkDir = 1;
    worm.walk(walkDir);

    // Jump
    if (Phaser.Input.Keyboard.JustDown(this.keySpace)) {
      worm.jump();
    }

    // Backflip
    if (
      Phaser.Input.Keyboard.JustDown(this.keyBackspace) ||
      Phaser.Input.Keyboard.JustDown(this.keyShift)
    ) {
      worm.backflip();
    }

    // Aim axis: up/down or W/S
    const aimUp = this.keyUp.isDown || this.keyW.isDown;
    const aimDown = this.keyDown.isDown || this.keyS.isDown;
    let aimDir: -1 | 0 | 1 = 0;
    if (aimUp && !aimDown) aimDir = -1;
    else if (aimDown && !aimUp) aimDir = 1;
    worm.aim(aimDir);

    void dtMs; // dtMs available for future use (touch smoothing, etc.)
  }

  /** Cycle to next alive worm. */
  cycleActive(): void {
    const next = this.findNextAliveFrom(this.activeIndex + 1);
    if (next === this.activeIndex) return; // all dead or only one alive
    // Deactivate previous highlight
    const prev = this.worms[this.activeIndex];
    if (prev) prev.setActive(false);
    this.activeIndex = next;
    this.updateActiveHighlight();
  }

  getActiveWorm(): Worm | null {
    const w = this.worms[this.activeIndex];
    return w?.isAlive ? w : null;
  }

  // ------ Private ------

  /** Find next alive worm index starting at `from`, wrapping around. Returns current if all dead. */
  private findNextAliveFrom(from: number): number {
    const len = this.worms.length;
    if (len === 0) return 0;
    for (let i = 0; i < len; i++) {
      const idx = (from + i) % len;
      if (this.worms[idx]?.isAlive) return idx;
    }
    // All dead - return current (or 0)
    return this.activeIndex ?? 0;
  }

  private updateActiveHighlight(): void {
    for (let i = 0; i < this.worms.length; i++) {
      this.worms[i]?.setActive(i === this.activeIndex);
    }
  }
}
