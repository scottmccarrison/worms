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
  private readonly keyRope: Phaser.Input.Keyboard.Key; // R
  private readonly keyJetPack: Phaser.Input.Keyboard.Key; // J

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
    this.keyRope = kb.addKey(Phaser.Input.Keyboard.KeyCodes.R);
    this.keyJetPack = kb.addKey(Phaser.Input.Keyboard.KeyCodes.J);

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

    // ---------------------------------------------------------------------------
    // Rope and JetPack activation toggles (always available regardless of state)
    // ---------------------------------------------------------------------------

    if (Phaser.Input.Keyboard.JustDown(this.keyRope)) {
      worm.ropeUtility.isActive() ? worm.ropeUtility.deactivate() : worm.ropeUtility.activate();
    }

    if (Phaser.Input.Keyboard.JustDown(this.keyJetPack)) {
      worm.jetPackUtility.isActive()
        ? worm.jetPackUtility.deactivate()
        : worm.jetPackUtility.activate();
    }

    // ---------------------------------------------------------------------------
    // State-dependent movement dispatch
    // ---------------------------------------------------------------------------

    if (worm.isRoped()) {
      // While roped: up/down extend/retract the rope; walk keys are no-ops (worm.walk guards it)
      // Aim still works normally
      if (this.keyUp.isDown || this.keyW.isDown) worm.ropeUtility.retract();
      if (this.keyDown.isDown || this.keyS.isDown) worm.ropeUtility.extend();

      // Aim axis (rope doesn't block aim)
      const aimDir = this.readAimAxis();
      worm.aim(aimDir);
    } else if (worm.isJetPacking()) {
      // While jetpacking: walk keys steer horizontally via JetPack.setHorizontalInput
      const hDir = this.readHorizontalAxis();
      worm.jetPackUtility.setHorizontalInput(hDir);
      worm.jetPackUtility.setVerticalInput(this.keyUp.isDown || this.keyW.isDown);

      // Aim still works
      const aimDir = this.readAimAxis();
      worm.aim(aimDir);
    } else {
      // Normal movement
      const walkDir = this.readHorizontalAxis();
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

      // Aim
      const aimDir = this.readAimAxis();
      worm.aim(aimDir);
    }

    void dtMs; // available for future touch smoothing etc.
  }

  /** Cycle to next alive worm. Auto-detaches rope and deactivates jetpack on previous worm. */
  cycleActive(): void {
    const next = this.findNextAliveFrom(this.activeIndex + 1);
    if (next === this.activeIndex) return; // all dead or only one alive

    // Deactivate utilities on previous worm
    const prev = this.worms[this.activeIndex];
    if (prev) {
      prev.ropeUtility?.deactivate();
      prev.jetPackUtility?.deactivate();
    }

    // Deactivate previous highlight
    if (prev) prev.setActive(false);
    this.activeIndex = next;
    this.updateActiveHighlight();
  }

  getActiveWorm(): Worm | null {
    const w = this.worms[this.activeIndex];
    return w?.isAlive ? w : null;
  }

  // ------ Private ------

  /** Read horizontal walk axis. -1 left, 0 none, 1 right. */
  private readHorizontalAxis(): -1 | 0 | 1 {
    const goLeft = this.keyLeft.isDown || this.keyA.isDown;
    const goRight = this.keyRight.isDown || this.keyD.isDown;
    if (goLeft && !goRight) return -1;
    if (goRight && !goLeft) return 1;
    return 0;
  }

  /** Read aim axis. -1 up, 0 none, 1 down. */
  private readAimAxis(): -1 | 0 | 1 {
    const aimUp = this.keyUp.isDown || this.keyW.isDown;
    const aimDown = this.keyDown.isDown || this.keyS.isDown;
    if (aimUp && !aimDown) return -1;
    if (aimDown && !aimUp) return 1;
    return 0;
  }

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
