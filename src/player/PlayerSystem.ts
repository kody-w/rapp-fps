/**
 * The player system. Binds input → motor → camera and publishes the events the
 * rest of the game listens for.
 *
 * `fixedUpdate` drives the motor at the engine's constant rate; `update` is
 * pure presentation — look, interpolated position, crouch eye-height, view bob,
 * a landing dip spring, and a step-smoothing offset so stairs read as a glide
 * rather than a staircase of camera jumps.
 *
 * It consumes a `StaticWorld` (axis-aligned boxes) and runs
 * `StaticBoxWorld.fromStaticWorld`, which throws on any degenerate or
 * out-of-bounds solid. There is no path that ingests arbitrary meshes, so the
 * unverified slope solver is unreachable by construction.
 */

import * as THREE from 'three';
import {
  Events,
  type EngineContext,
  type InputState,
  type System,
  type UpdateContext,
} from '../core/contracts.js';
import type { StaticWorld } from '../core/collision.js';
import { DEFAULT_PLAYER_TUNING, type PlayerTuning } from './config.js';
import { PlayerInput } from './PlayerInput.js';
import { PlayerMotor } from './PlayerMotor.js';
import { StaticBoxWorld } from './StaticBoxWorld.js';

export interface PlayerSystemOptions {
  world: StaticWorld;
  spawn?: THREE.Vector3;
  /** Authored initial camera yaw. Omitted preserves the level shot orientation. */
  initialYaw?: number;
  /** Slot-owned camera. Omitted preserves the engine's primary camera. */
  camera?: THREE.PerspectiveCamera;
  /** Unique engine registry name. Defaults to `player`. */
  name?: string;
  /** Slot lifecycle gate. Inactive players freeze without consuming input. */
  activeProvider?: () => boolean;
  tuning?: Readonly<PlayerTuning>;
}

type ShotName = 'mid-air' | 'crouched' | 'landing' | 'top-of-step' | 'at-wall' | 'on-stairs';

export class PlayerSystem implements System {
  readonly name: string;

  private readonly tuning: Readonly<PlayerTuning>;
  private readonly worldDefinition: StaticWorld;
  private readonly requestedSpawn?: THREE.Vector3;
  private readonly requestedYaw?: number;
  private readonly requestedCamera?: THREE.PerspectiveCamera;
  private readonly activeProvider: () => boolean;
  private world: StaticBoxWorld | null = null;
  private motor: PlayerMotor | null = null;

  private yaw = 0;
  private pitch = 0;
  private eyeHeight = 0;
  private bobWeight = 0;
  private landingOffset = 0;
  private landingVelocity = 0;
  private stepCameraOffset = 0;
  private lastJumpHeld = false;

  private readonly renderPosition = new THREE.Vector3();
  private readonly cameraRight = new THREE.Vector3();
  private readonly aimEye = new THREE.Vector3();
  private camera: THREE.PerspectiveCamera | null = null;
  private viewBobX = 0;
  private viewOffsetY = 0;
  private viewRoll = 0;
  private viewApplied = false;
  private readonly savedCameraPosition = new THREE.Vector3();
  private shotMode: ShotName | null = null;
  private shotOverlay: HTMLDivElement | null = null;
  private previousShotHook: ((name: string) => void) | undefined;
  private installedShotHook: ((name: string) => void) | null = null;

  constructor(
    private readonly input: InputState | undefined,
    options: PlayerSystemOptions,
  ) {
    this.tuning = options.tuning ?? DEFAULT_PLAYER_TUNING;
    this.name = options.name ?? 'player';
    if (!this.name.trim()) throw new Error('PlayerSystem name must be non-empty');
    this.worldDefinition = options.world;
    this.requestedSpawn = options.spawn?.clone();
    if (options.initialYaw !== undefined && !Number.isFinite(options.initialYaw)) {
      throw new Error('PlayerSystem initialYaw must be finite');
    }
    this.requestedYaw = options.initialYaw;
    this.requestedCamera = options.camera;
    this.activeProvider = options.activeProvider ?? (() => true);
  }

  copyFeetPosition(out: THREE.Vector3): boolean {
    if (!this.motor) return false;
    out.copy(this.motor.position);
    return true;
  }

  copyEyePosition(out: THREE.Vector3): boolean {
    const motor = this.motor;
    if (!motor) return false;
    const crouchT = THREE.MathUtils.clamp(
      (this.tuning.standingHeight - motor.colliderHeight)
        / (this.tuning.standingHeight - this.tuning.crouchingHeight),
      0,
      1,
    );
    const eye = THREE.MathUtils.lerp(
      this.tuning.standingEyeHeight,
      this.tuning.crouchingEyeHeight,
      crouchT,
    );
    out.copy(motor.position);
    out.y += eye;
    return true;
  }

  get currentYaw(): number { return this.yaw; }
  get currentPitch(): number { return this.pitch; }

  lookAt(target: THREE.Vector3): boolean {
    if (!this.copyEyePosition(this.aimEye)) return false;
    const dx = target.x - this.aimEye.x;
    const dy = target.y - this.aimEye.y;
    const dz = target.z - this.aimEye.z;
    const length = Math.hypot(dx, dy, dz);
    if (!Number.isFinite(length) || length < 1e-6) return false;
    this.yaw = Math.atan2(-dx, -dz);
    this.pitch = THREE.MathUtils.clamp(
      Math.asin(dy / length),
      -this.tuning.pitchLimitRadians,
      this.tuning.pitchLimitRadians,
    );
    return true;
  }

  init(ctx: EngineContext): void {
    // The registration guard. A degenerate, out-of-bounds — or non-axis-aligned,
    // which cannot be expressed — world throws here rather than degrading.
    this.world = StaticBoxWorld.fromStaticWorld(this.worldDefinition);

    const camera = this.requestedCamera ?? ctx.camera;
    const spawn = this.requestedSpawn?.clone() ?? new THREE.Vector3(
      camera.position.x,
      camera.position.y - this.tuning.standingEyeHeight,
      camera.position.z,
    );

    this.motor = new PlayerMotor(this.world, spawn, this.tuning, {
      footstep: (payload) => ctx.bus.emit(Events.Footstep, payload),
      landed: ({ impactSpeed }) => {
        ctx.bus.emit(Events.Landed, { impactSpeed });
        this.beginLandingImpact(impactSpeed);
      },
    });

    this.yaw = this.requestedYaw ?? camera.rotation.y;
    this.pitch = this.requestedYaw === undefined
      ? THREE.MathUtils.clamp(
        camera.rotation.x,
        -this.tuning.pitchLimitRadians,
        this.tuning.pitchLimitRadians,
      )
      : 0;
    this.eyeHeight = this.tuning.standingEyeHeight;
    camera.rotation.order = 'YXZ';
    this.camera = camera;

    if (this.name === 'player') this.installShotHook();
  }

  fixedUpdate(step: number, ctx: EngineContext): void {
    const motor = this.motor;
    if (!motor) return;
    if (!this.activeProvider()) {
      motor.previousPosition.copy(motor.position);
      motor.velocity.set(0, 0, 0);
      return;
    }

    // A shot pose is a frozen frame for evidence: hold the motor still so the
    // capture is the exact state named, not one tick of drift past it.
    if (this.shotMode) {
      motor.previousPosition.copy(motor.position);
      return;
    }

    const input = this.input ?? ctx.input;
    const jumpPressed = this.consumeJumpPressed(input);
    const result = motor.fixedUpdate(step, {
      moveX: input.move.x,
      moveY: input.move.y,
      yaw: this.yaw,
      jumpPressed,
      crouch: input.crouch,
      sprint: input.sprint,
    });

    // A step-up is applied to the camera as a downward offset that decays, so
    // the eye rises smoothly instead of teleporting up the riser. A step-down
    // (the ground snap gluing the body to a lower step) is the mirror: an upward
    // offset that decays, so the eye descends as a glide rather than dropping.
    if (result.steppedHeight > 0) {
      this.stepCameraOffset -= result.steppedHeight;
    }
    if (result.steppedDown > 0) {
      this.stepCameraOffset += result.steppedDown;
    }
    this.stepCameraOffset = THREE.MathUtils.clamp(
      this.stepCameraOffset,
      -2 * this.tuning.maxStepHeight,
      2 * this.tuning.maxStepHeight,
    );
    this.lastJumpHeld = input.jump;
  }

  update(u: UpdateContext, ctx: EngineContext): void {
    const motor = this.motor;
    if (!motor) return;

    const input = this.input ?? ctx.input;
    const camera = this.camera ?? ctx.camera;
    if (this.activeProvider()) this.applyLook(input);
    this.renderPosition.lerpVectors(
      motor.previousPosition,
      motor.position,
      THREE.MathUtils.clamp(u.alpha, 0, 1),
    );

    const crouchT = THREE.MathUtils.clamp(
      (this.tuning.standingHeight - motor.colliderHeight)
        / (this.tuning.standingHeight - this.tuning.crouchingHeight),
      0,
      1,
    );
    const targetEyeHeight = THREE.MathUtils.lerp(
      this.tuning.standingEyeHeight,
      this.tuning.crouchingEyeHeight,
      crouchT,
    );
    this.eyeHeight = damp(this.eyeHeight, targetEyeHeight, 18, u.dt);

    const horizontalSpeed = Math.hypot(motor.velocity.x, motor.velocity.z);
    const movingOnGround = motor.grounded && horizontalSpeed > 0.2 && !this.shotMode;
    this.bobWeight = damp(this.bobWeight, movingOnGround ? 1 : 0, 12, u.dt);
    this.stepCameraOffset = damp(this.stepCameraOffset, 0, 15, u.dt);
    if (this.shotMode !== 'landing') this.integrateLandingSpring(u.dt);

    const gaitScale = motor.sprinting ? 1.18 : motor.crouched ? 0.48 : 1;
    const bobX = Math.sin(motor.gaitPhase)
      * this.tuning.bobHorizontalMeters
      * this.bobWeight
      * gaitScale;
    const bobY = (0.5 - Math.abs(Math.cos(motor.gaitPhase)))
      * this.tuning.bobVerticalMeters
      * this.bobWeight
      * gaitScale;
    const bobRoll = Math.sin(motor.gaitPhase)
      * this.tuning.bobRollRadians
      * this.bobWeight
      * gaitScale;

    this.cameraRight.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    // Authoritative pose. The true eye position and look angles that every
    // observer between frames — AI, networking, this project's verify-slice —
    // reads off window.engine.camera. Cosmetic view effects (head-bob, landing
    // dip, step glide, bob-roll) are recorded here but NOT baked in; they are
    // applied only around the draw and restored, the same discipline
    // RenderSystem uses for camera shake, so the shared camera is never left
    // dressed with presentation-only motion between frames.
    this.viewBobX = bobX;
    this.viewOffsetY = bobY + this.landingOffset + this.stepCameraOffset;
    this.viewRoll = bobRoll;

    camera.position.copy(this.renderPosition);
    camera.position.y += this.eyeHeight;
    camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');

    this.publishState();
    this.updateShotOverlay();
  }

  /**
   * Apply the transient first-person view effects — head-bob, landing dip, step
   * glide and bob-roll — to the camera immediately before the frame is drawn.
   * The presenter must pair this with restoreView() after the draw, exactly as
   * it brackets RenderSystem's camera shake, so the effects reach the rendered
   * image without ever polluting the pose that observers read between frames.
   */
  applyViewEffects(): void {
    const camera = this.camera;
    if (!camera || this.viewApplied) return;
    this.savedCameraPosition.copy(camera.position);
    camera.position.addScaledVector(this.cameraRight, this.viewBobX);
    camera.position.y += this.viewOffsetY;
    camera.rotation.z = this.viewRoll;
    camera.updateMatrixWorld(true);
    this.viewApplied = true;
  }

  /** Restore the authoritative pose after the draw. Safe to call unpaired. */
  restoreView(): void {
    const camera = this.camera;
    if (!camera || !this.viewApplied) return;
    camera.position.copy(this.savedCameraPosition);
    camera.rotation.z = 0;
    camera.updateMatrixWorld(true);
    this.viewApplied = false;
  }

  getMotor(): PlayerMotor | null {
    return this.motor;
  }

  setShotState(name: string): void {
    if (!isShotName(name) || !this.motor) return;
    this.shotMode = name;
    this.bobWeight = 0;
    this.stepCameraOffset = 0;
    this.landingOffset = 0;
    this.landingVelocity = 0;
    this.motor.setCrouched(false);
    this.eyeHeight = this.tuning.standingEyeHeight;

    switch (name) {
      case 'mid-air':
        this.motor.teleport(new THREE.Vector3(0, 1.2, 4), new THREE.Vector3(0, 0.4, -2.4));
        this.motor.grounded = false;
        this.yaw = 0;
        this.pitch = -0.16;
        break;
      case 'crouched':
        this.motor.teleport(new THREE.Vector3(11, 0, -2));
        this.motor.grounded = true;
        this.motor.setCrouched(true);
        this.eyeHeight = this.tuning.crouchingEyeHeight;
        this.yaw = Math.PI / 2;
        this.pitch = -0.05;
        break;
      case 'landing':
        this.motor.teleport(new THREE.Vector3(0, 0, 5));
        this.motor.grounded = true;
        this.yaw = 0;
        this.pitch = -0.12;
        this.landingOffset = -this.tuning.landingDipMeters;
        break;
      case 'top-of-step':
        this.motor.teleport(new THREE.Vector3(6, 0.3, 2));
        this.motor.grounded = true;
        this.yaw = -Math.PI / 2;
        this.pitch = -0.2;
        break;
      case 'at-wall':
        this.motor.teleport(new THREE.Vector3(-6, 0, 3.4));
        this.motor.grounded = true;
        this.yaw = 0;
        this.pitch = -0.12;
        break;
      case 'on-stairs':
        this.motor.teleport(new THREE.Vector3(0, 0.6, -4.8));
        this.motor.grounded = true;
        this.yaw = 0;
        this.pitch = -0.18;
        break;
    }

    this.ensureShotOverlay();
    this.updateShotOverlay();
  }

  dispose(): void {
    if (this.input instanceof PlayerInput) this.input.dispose();
    this.world = null;
    this.motor = null;
    this.camera = null;
    this.viewApplied = false;

    this.shotOverlay?.remove();
    this.shotOverlay = null;

    const global = window as unknown as {
      __SHOT__?: (name: string) => void;
      __PLAYER_STATE__?: unknown;
      __PLAYER_STATES__?: Record<string, unknown>;
    };
    if (global.__SHOT__ === this.installedShotHook) {
      global.__SHOT__ = this.previousShotHook;
    }
    if (this.name === 'player') delete global.__PLAYER_STATE__;
    if (global.__PLAYER_STATES__) delete global.__PLAYER_STATES__[this.name];
  }

  private consumeJumpPressed(input: InputState): boolean {
    if (input instanceof PlayerInput) return input.consumePressed('jump');
    return input.pressed('jump') || (input.jump && !this.lastJumpHeld);
  }

  private applyLook(input: InputState): void {
    const look = input instanceof PlayerInput ? input.consumeLook() : input.look;
    this.yaw -= look.x;
    this.pitch = THREE.MathUtils.clamp(
      this.pitch - look.y,
      -this.tuning.pitchLimitRadians,
      this.tuning.pitchLimitRadians,
    );
  }

  private beginLandingImpact(impactSpeed: number): void {
    const normalised = THREE.MathUtils.clamp((impactSpeed - 2) / 10, 0, 1);
    this.landingOffset = Math.min(
      this.landingOffset,
      -this.tuning.landingDipMeters * normalised,
    );
    this.landingVelocity = 0;
  }

  private integrateLandingSpring(dt: number): void {
    const clampedDt = Math.min(dt, 1 / 30);
    const angularFrequency = 24;
    const acceleration = -angularFrequency * angularFrequency * this.landingOffset
      - 2 * angularFrequency * this.landingVelocity;
    this.landingVelocity += acceleration * clampedDt;
    this.landingOffset += this.landingVelocity * clampedDt;
    if (Math.abs(this.landingOffset) < 1e-5 && Math.abs(this.landingVelocity) < 1e-4) {
      this.landingOffset = 0;
      this.landingVelocity = 0;
    }
  }

  private installShotHook(): void {
    const global = window as unknown as { __SHOT__?: (name: string) => void };
    this.previousShotHook = global.__SHOT__;
    this.installedShotHook = (name: string): void => this.setShotState(name);
    global.__SHOT__ = this.installedShotHook;
  }

  private ensureShotOverlay(): void {
    if (this.shotOverlay) return;
    const overlay = document.createElement('div');
    overlay.id = 'player-shot-state';
    Object.assign(overlay.style, {
      position: 'fixed',
      left: '28px',
      bottom: '28px',
      zIndex: '1000',
      padding: '12px 15px',
      color: '#eaf4ff',
      background: 'rgba(5, 10, 18, 0.78)',
      border: '1px solid rgba(138, 194, 255, 0.75)',
      borderRadius: '4px',
      font: '600 14px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace',
      letterSpacing: '0.02em',
      whiteSpace: 'pre',
      pointerEvents: 'none',
      textShadow: '0 1px 2px #000',
    });
    document.body.append(overlay);
    this.shotOverlay = overlay;
  }

  private updateShotOverlay(): void {
    if (!this.shotMode || !this.shotOverlay || !this.motor) return;
    const state = this.motor.snapshot();
    this.shotOverlay.textContent = [
      `PLAYER STATE  ${this.shotMode.toUpperCase()}`,
      `grounded ${String(state.grounded).padEnd(5)}  crouched ${String(state.crouched)}`,
      `feet y   ${state.position[1].toFixed(2)} m   speed ${Math.hypot(...state.velocity).toFixed(2)} m/s`,
      `capsule  ${state.colliderHeight.toFixed(2)} m × ${(this.tuning.radius * 2).toFixed(2)} m`,
    ].join('\n');
  }

  private publishState(): void {
    if (!this.motor) return;
    const global = window as unknown as {
      __PLAYER_STATE__?: unknown;
      __PLAYER_STATES__?: Record<string, unknown>;
    };
    const state = {
      ...this.motor.snapshot(),
      yaw: this.yaw,
      pitch: this.pitch,
      sensitivityRadPerPixel: this.tuning.lookSensitivityRadPerPixel,
      shot: this.shotMode,
    };
    global.__PLAYER_STATES__ ??= {};
    global.__PLAYER_STATES__[this.name] = state;
    if (this.name === 'player') global.__PLAYER_STATE__ = state;
  }
}

function damp(current: number, target: number, sharpness: number, dt: number): number {
  return THREE.MathUtils.lerp(current, target, 1 - Math.exp(-sharpness * dt));
}

function isShotName(name: string): name is ShotName {
  return name === 'mid-air'
    || name === 'crouched'
    || name === 'landing'
    || name === 'top-of-step'
    || name === 'at-wall'
    || name === 'on-stairs';
}
