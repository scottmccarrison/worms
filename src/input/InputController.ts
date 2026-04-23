import * as Phaser from "phaser";
import { tuning } from "../tuning";
import type { Worm } from "../worm/Worm";

export interface InputControllerInit {
  scene: Phaser.Scene;
  allWorms: Worm[]; // renamed from worms; all worms for cycleWithinTeam lookups
  onEndTurn: () => void; // called on Enter keydown
  onSelectWeapon: (n: 1 | 2 | 3) => void; // called when 1/2/3 pressed in normal state
  onFire: () => void; // called when F pressed in normal state
  onCycleMap: () => void; // called when M pressed; dev affordance to cycle maps
  // Epic 9: optional callbacks fired when local input mutates the active worm.
  // Default to no-op so offline behavior stays identical. GameScene wires these
  // in networked mode to relay inputs to the server.
  onWalk?: (dir: -1 | 0 | 1) => void;
  onJump?: () => void;
  onBackflip?: () => void;
  onAimAngleChange?: (rad: number) => void;
  onAimPowerChange?: (power: number) => void;
}

export class InputController {
  private readonly scene: Phaser.Scene;
  private readonly onEndTurn: () => void;
  private readonly onSelectWeapon: (n: 1 | 2 | 3) => void;
  private readonly onFire: () => void;
  private readonly onCycleMap: () => void;
  private readonly onWalk: (dir: -1 | 0 | 1) => void;
  private readonly onJump: () => void;
  private readonly onBackflip: () => void;
  private readonly onAimAngleChange: (rad: number) => void;
  private readonly onAimPowerChange: (power: number) => void;
  private activeWorm: Worm | null = null;
  private inputAllowed = false;
  private transitioning = false;
  // Track last walk direction so we only fire onWalk on transitions
  // (matches the server contract: press -> send {dir:-1}, release -> send {dir:0}).
  private lastWalkDir: -1 | 0 | 1 = 0;

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
  private readonly keyEnter: Phaser.Input.Keyboard.Key;
  private readonly keyMapCycle: Phaser.Input.Keyboard.Key; // M
  // Weapon keys
  private readonly key1: Phaser.Input.Keyboard.Key;
  private readonly key2: Phaser.Input.Keyboard.Key;
  private readonly key3: Phaser.Input.Keyboard.Key;
  private readonly keyFire: Phaser.Input.Keyboard.Key; // F
  private readonly keyPowerDown: Phaser.Input.Keyboard.Key; // [
  private readonly keyPowerUp: Phaser.Input.Keyboard.Key; // ]

  constructor(init: InputControllerInit) {
    this.scene = init.scene;
    this.onEndTurn = init.onEndTurn;
    this.onSelectWeapon = init.onSelectWeapon;
    this.onFire = init.onFire;
    this.onCycleMap = init.onCycleMap;
    this.onWalk = init.onWalk ?? (() => {});
    this.onJump = init.onJump ?? (() => {});
    this.onBackflip = init.onBackflip ?? (() => {});
    this.onAimAngleChange = init.onAimAngleChange ?? (() => {});
    this.onAimPowerChange = init.onAimPowerChange ?? (() => {});

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
    this.keyEnter = kb.addKey(Phaser.Input.Keyboard.KeyCodes.ENTER);
    this.keyMapCycle = kb.addKey(Phaser.Input.Keyboard.KeyCodes.M);
    // Weapon keys
    this.key1 = kb.addKey(Phaser.Input.Keyboard.KeyCodes.ONE);
    this.key2 = kb.addKey(Phaser.Input.Keyboard.KeyCodes.TWO);
    this.key3 = kb.addKey(Phaser.Input.Keyboard.KeyCodes.THREE);
    this.keyFire = kb.addKey(Phaser.Input.Keyboard.KeyCodes.F);
    this.keyPowerDown = kb.addKey(Phaser.Input.Keyboard.KeyCodes.OPEN_BRACKET);
    this.keyPowerUp = kb.addKey(Phaser.Input.Keyboard.KeyCodes.CLOSED_BRACKET);

    // Prevent Tab and Enter from bubbling to the browser (form submit etc)
    this.keyTab.on("down", (evt: KeyboardEvent) => {
      evt.preventDefault?.();
    });
    this.keyEnter.on("down", (evt: KeyboardEvent) => {
      evt.preventDefault?.();
    });

    // NOTE: active worm is NOT initialized here; TurnManager.start() will call
    // setActiveWorm() inside its START_GAME -> turnActive transition. Until then,
    // no worm is highlighted and inputAllowed is false.
  }

  setActiveWorm(worm: Worm | null): void {
    if (this.activeWorm === worm) return; // idempotent: same worm = no-op

    // Deactivate previous utilities + highlight
    if (this.activeWorm) {
      this.activeWorm.ropeUtility?.deactivate();
      this.activeWorm.jetPackUtility?.deactivate();
      this.activeWorm.setActive(false);
    }
    this.activeWorm = worm;
    if (worm) worm.setActive(true);
  }

  setInputAllowed(allowed: boolean): void {
    this.inputAllowed = allowed;
  }

  setTransitioning(v: boolean): void {
    this.transitioning = v;
  }

  /**
   * Reset the local walk-direction cache to 0 (stopped). Called when
   * network ownership flips away from this client so that the NEXT time
   * we regain control, a fresh press registers as a transition and gets
   * forwarded over the wire. Without this, a carryover walk press silently
   * fails to notify spectators.
   */
  resetWalkState(): void {
    this.lastWalkDir = 0;
  }

  /** Current walk direction (last transition sent). */
  getLastWalkDir(): -1 | 0 | 1 {
    return this.lastWalkDir;
  }

  /**
   * Expose the current input-allowed state. Epic 9 uses this as the
   * authoritative "should I accept local input?" check - networked-mode
   * GameScene flips this false on non-active turns so remote-input replay
   * is the only path that drives the active worm.
   */
  isInputAllowed(): boolean {
    return this.inputAllowed && !this.transitioning;
  }

  getActiveWorm(): Worm | null {
    return this.activeWorm?.isAlive ? this.activeWorm : null;
  }

  /** Cycles to next alive worm on the active worm's OWN team (no jumping teams). */
  cycleWithinTeam(): void {
    if (!this.activeWorm) return;
    const team = this.activeWorm.team;
    const aliveInTeam = team.worms.filter((w) => w.isAlive);
    if (aliveInTeam.length <= 1) return;
    const idx = aliveInTeam.indexOf(this.activeWorm);
    const next = aliveInTeam[(idx + 1) % aliveInTeam.length];
    if (next) this.setActiveWorm(next);
  }

  /** Called from GameScene.update. Polls keys, dispatches to active worm. */
  update(dtMs: number): void {
    if (!this.inputAllowed || this.transitioning) return;

    // Enter ends turn
    if (Phaser.Input.Keyboard.JustDown(this.keyEnter)) {
      this.onEndTurn();
      return;
    }

    // Tab cycles within active team
    if (Phaser.Input.Keyboard.JustDown(this.keyTab)) {
      this.cycleWithinTeam();
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
      // While roped: up/down adjust rope length continuously (m/sec * dt).
      // Aim is LOCKED (arrow keys consumed by rope control; no conflict).
      const dtSec = dtMs / 1000;
      const rate = tuning.rope.adjustRateMps * dtSec;
      if (this.keyUp.isDown || this.keyW.isDown) {
        worm.ropeUtility.adjust(-rate);
      } else if (this.keyDown.isDown || this.keyS.isDown) {
        worm.ropeUtility.adjust(+rate);
      }
    } else if (worm.isJetPacking()) {
      // While jetpacking: walk keys steer horizontally, up thrusts vertical.
      // Aim is LOCKED (arrow keys are consumed by thrust controls).
      const hDir = this.readHorizontalAxis();
      worm.jetPackUtility.setHorizontalInput(hDir);
      worm.jetPackUtility.setVerticalInput(this.keyUp.isDown || this.keyW.isDown);
    } else {
      // Normal movement
      const walkDir = this.readHorizontalAxis();
      worm.walk(walkDir);
      // Fire onWalk only on direction transitions so the server sees one
      // press + one release event, not a stream of per-frame samples.
      if (walkDir !== this.lastWalkDir) {
        this.onWalk(walkDir);
        this.lastWalkDir = walkDir;
      }

      // Jump
      if (Phaser.Input.Keyboard.JustDown(this.keySpace)) {
        worm.jump();
        this.onJump();
      }

      // Backflip
      if (
        Phaser.Input.Keyboard.JustDown(this.keyBackspace) ||
        Phaser.Input.Keyboard.JustDown(this.keyShift)
      ) {
        worm.backflip();
        this.onBackflip();
      }

      // Aim (continuous while held; fire aim-angle callback when the angle
      // actually changes, not every frame).
      const aimDir = this.readAimAxis();
      const prevAim = worm.aimAngle;
      worm.aim(aimDir);
      // Worm.aim queues; actual angle updates happen in Worm.update. The
      // post-update sync below surfaces the real change. For now, fire on
      // input intent - the server relay is advisory, turn_snapshot reconciles.
      if (aimDir !== 0) {
        // Sample the updated angle after aim() runs (Worm.update applies it
        // on its own tick - we approximate here by reading current angle;
        // the final value arrives via turn_snapshot anyway).
        this.onAimAngleChange(worm.aimAngle);
      }
      void prevAim;

      // M cycles maps (dev affordance) - checked BEFORE weapon keys so it takes priority
      if (Phaser.Input.Keyboard.JustDown(this.keyMapCycle)) {
        this.onCycleMap();
        return;
      }

      // Weapon select (1/2/3)
      if (Phaser.Input.Keyboard.JustDown(this.key1)) this.onSelectWeapon(1);
      else if (Phaser.Input.Keyboard.JustDown(this.key2)) this.onSelectWeapon(2);
      else if (Phaser.Input.Keyboard.JustDown(this.key3)) this.onSelectWeapon(3);

      // Fire (F)
      if (Phaser.Input.Keyboard.JustDown(this.keyFire)) {
        this.onFire();
      }

      // Power adjust ([ and ])
      if (Phaser.Input.Keyboard.JustDown(this.keyPowerDown)) {
        worm.nudgeAimPower(-tuning.weapons.powerStepPerPress);
        this.onAimPowerChange(worm.aimPower01);
      } else if (Phaser.Input.Keyboard.JustDown(this.keyPowerUp)) {
        worm.nudgeAimPower(+tuning.weapons.powerStepPerPress);
        this.onAimPowerChange(worm.aimPower01);
      }
    }

    void dtMs; // available for future touch smoothing etc.
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
}
