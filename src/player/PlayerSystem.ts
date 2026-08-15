import * as THREE from 'three';
import {
  Events,
  type EngineContext,
  type InputState,
  type System,
  type UpdateContext,
} from '../core/contracts.js';
import {
  DEFAULT_PLAYER_TUNING,
  type PlayerTuning,
} from './config.js';
import { PlayerInput } from './PlayerInput.js';
import { PlayerMotor } from './PlayerMotor.js';
import { StaticCollisionWorld } from './StaticCollisionWorld.js';

export interface PlayerSystemOptions {
  spawn?: THREE.Vector3;
  tuning?: Readonly<PlayerTuning>;
}

type ShotName = 'mid-air' | 'crouched' | 'landing' | 'top-of-step';

export class PlayerSystem implements System {
  readonly name = 'player';

  private readonly tuning: Readonly<PlayerTuning>;
  private readonly requestedSpawn?: THREE.Vector3;
  private world: StaticCollisionWorld | null = null;
  private motor: PlayerMotor | null = null;
  private context: EngineContext | null = null;

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
  private readonly shotRig = new THREE.Group();
  private readonly shotRigDisposables: Array<{ dispose(): void }> = [];
  private shotMode: ShotName | null = null;
  private shotOverlay: HTMLDivElement | null = null;
  private previousShotHook: ((name: string) => void) | undefined;
  private installedShotHook: ((name: string) => void) | null = null;

  constructor(
    private readonly input?: PlayerInput,
    options: PlayerSystemOptions = {},
  ) {
    this.tuning = options.tuning ?? DEFAULT_PLAYER_TUNING;
    this.requestedSpawn = options.spawn?.clone();
  }

  init(ctx: EngineContext): void {
    this.context = ctx;
    this.world = StaticCollisionWorld.fromScene(ctx.scene);

    const spawn = this.requestedSpawn?.clone() ?? new THREE.Vector3(
      ctx.camera.position.x,
      ctx.camera.position.y - this.tuning.standingEyeHeight,
      ctx.camera.position.z,
    );

    this.motor = new PlayerMotor(this.world, spawn, this.tuning, {
      footstep: (payload) => ctx.bus.emit(Events.Footstep, payload),
      landed: ({ impactSpeed }) => {
        ctx.bus.emit(Events.Landed, { impactSpeed });
        this.beginLandingImpact(impactSpeed);
      },
    });

    this.yaw = ctx.camera.rotation.y;
    this.pitch = THREE.MathUtils.clamp(
      ctx.camera.rotation.x,
      -this.tuning.pitchLimitRadians,
      this.tuning.pitchLimitRadians,
    );
    this.eyeHeight = this.tuning.standingEyeHeight;
    ctx.camera.rotation.order = 'YXZ';

    this.createShotRig(ctx.scene);
    this.installShotHook();
  }

  fixedUpdate(step: number, ctx: EngineContext): void {
    const motor = this.motor;
    if (!motor) return;

    if (this.shotMode) {
      motor.previousPosition.copy(motor.position);
      return;
    }

    const input = ctx.input;
    const jumpPressed = this.consumeJumpPressed(input);
    const result = motor.fixedUpdate(step, {
      moveX: input.move.x,
      moveY: input.move.y,
      yaw: this.yaw,
      jumpPressed,
      crouch: input.crouch,
      sprint: input.sprint,
    });

    if (result.steppedHeight > 0) {
      this.stepCameraOffset -= result.steppedHeight;
    }
    this.lastJumpHeld = input.jump;
  }

  update(u: UpdateContext, ctx: EngineContext): void {
    const motor = this.motor;
    if (!motor) return;

    this.applyLook(ctx.input);
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
    ctx.camera.position
      .copy(this.renderPosition)
      .addScaledVector(this.cameraRight, bobX);
    ctx.camera.position.y += this.eyeHeight
      + bobY
      + this.landingOffset
      + this.stepCameraOffset;
    ctx.camera.rotation.set(this.pitch, this.yaw, bobRoll, 'YXZ');

    this.publishState();
    this.updateShotOverlay();
  }

  getMotor(): PlayerMotor | null {
    return this.motor;
  }

  setShotState(name: string): void {
    if (!isShotName(name) || !this.motor) return;
    this.shotMode = name;
    this.shotRig.visible = name === 'top-of-step';
    this.bobWeight = 0;
    this.stepCameraOffset = 0;
    this.landingOffset = 0;
    this.landingVelocity = 0;

    if (name === 'mid-air') {
      this.motor.teleport(
        new THREE.Vector3(0.6, 1.05, 1.4),
        new THREE.Vector3(0, 0.35, -2.2),
      );
      this.motor.grounded = false;
      this.motor.setCrouched(false);
      this.yaw = 0;
      this.pitch = -0.18;
    } else if (name === 'crouched') {
      this.motor.teleport(new THREE.Vector3(0.6, 0, 3.4));
      this.motor.grounded = true;
      this.motor.setCrouched(true);
      this.eyeHeight = this.tuning.crouchingEyeHeight;
      this.yaw = 0;
      this.pitch = -0.08;
    } else if (name === 'landing') {
      this.motor.teleport(new THREE.Vector3(0.6, 0, 2.5));
      this.motor.grounded = true;
      this.motor.setCrouched(false);
      this.eyeHeight = this.tuning.standingEyeHeight;
      this.yaw = 0;
      this.pitch = -0.12;
      this.landingOffset = -this.tuning.landingDipMeters;
    } else {
      this.motor.teleport(new THREE.Vector3(8, 0.3, 0.45));
      this.motor.grounded = true;
      this.motor.setCrouched(false);
      this.eyeHeight = this.tuning.standingEyeHeight;
      this.yaw = 0;
      this.pitch = -0.2;
    }

    this.ensureShotOverlay();
    this.updateShotOverlay();
  }

  dispose(): void {
    this.input?.dispose();
    this.world?.dispose();
    this.world = null;
    this.motor = null;

    if (this.context) this.context.scene.remove(this.shotRig);
    for (const disposable of this.shotRigDisposables) disposable.dispose();
    this.shotRigDisposables.length = 0;
    this.shotOverlay?.remove();
    this.shotOverlay = null;

    const global = window as unknown as {
      __SHOT__?: (name: string) => void;
      __PLAYER_STATE__?: unknown;
    };
    if (global.__SHOT__ === this.installedShotHook) {
      global.__SHOT__ = this.previousShotHook;
    }
    delete global.__PLAYER_STATE__;
  }

  private consumeJumpPressed(input: InputState): boolean {
    if (input instanceof PlayerInput) return input.consumePressed('jump');
    return input.pressed('jump') || (input.jump && !this.lastJumpHeld);
  }

  private applyLook(input: InputState): void {
    const look = input instanceof PlayerInput
      ? input.consumeLook()
      : input.look;
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
    const global = window as unknown as {
      __SHOT__?: (name: string) => void;
    };
    this.previousShotHook = global.__SHOT__;
    this.installedShotHook = (name: string): void => this.setShotState(name);
    global.__SHOT__ = this.installedShotHook;
  }

  private createShotRig(scene: THREE.Scene): void {
    this.shotRig.name = 'player-shot-rig';
    this.shotRig.visible = false;
    this.shotRig.position.set(8, 0, 0);
    this.shotRig.userData.playerCollision = false;

    const stepGeometry = new THREE.BoxGeometry(2.6, 0.3, 2.4);
    const wallGeometry = new THREE.BoxGeometry(2.6, 0.8, 0.35);
    const stepMaterial = new THREE.MeshStandardMaterial({
      color: 0x44698c,
      roughness: 0.72,
      metalness: 0.08,
    });
    const wallMaterial = new THREE.MeshStandardMaterial({
      color: 0x8c503f,
      roughness: 0.86,
      metalness: 0,
    });
    const step = new THREE.Mesh(stepGeometry, stepMaterial);
    step.position.set(0, 0.15, 0.45);
    step.castShadow = true;
    step.receiveShadow = true;
    step.userData.playerCollision = false;
    const wall = new THREE.Mesh(wallGeometry, wallMaterial);
    wall.position.set(0, 0.4, -1.1);
    wall.castShadow = true;
    wall.receiveShadow = true;
    wall.userData.playerCollision = false;

    this.shotRig.add(step, wall);
    scene.add(this.shotRig);
    this.shotRigDisposables.push(
      stepGeometry,
      wallGeometry,
      stepMaterial,
      wallMaterial,
    );
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
    };
    global.__PLAYER_STATE__ = {
      ...this.motor.snapshot(),
      yaw: this.yaw,
      pitch: this.pitch,
      sensitivityRadPerPixel: this.tuning.lookSensitivityRadPerPixel,
      shot: this.shotMode,
    };
  }
}

function damp(current: number, target: number, sharpness: number, dt: number): number {
  return THREE.MathUtils.lerp(current, target, 1 - Math.exp(-sharpness * dt));
}

function isShotName(name: string): name is ShotName {
  return name === 'mid-air'
    || name === 'crouched'
    || name === 'landing'
    || name === 'top-of-step';
}
