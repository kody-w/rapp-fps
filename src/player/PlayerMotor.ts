import * as THREE from 'three';
import type { SurfaceKind } from '../core/contracts.js';
import {
  DEFAULT_PLAYER_TUNING,
  jumpSpeedForHeight,
  type PlayerTuning,
} from './config.js';
import {
  StaticCollisionWorld,
  type CapsuleMoveResult,
} from './StaticCollisionWorld.js';

export interface PlayerMotorInput {
  moveX: number;
  moveY: number;
  yaw: number;
  jumpPressed: boolean;
  crouch: boolean;
  sprint: boolean;
}

export interface PlayerMotorEvents {
  footstep?: (payload: {
    position: THREE.Vector3;
    surface: SurfaceKind;
    loud: boolean;
  }) => void;
  landed?: (payload: { impactSpeed: number }) => void;
}

export interface PlayerMotorSnapshot {
  position: [number, number, number];
  velocity: [number, number, number];
  grounded: boolean;
  crouched: boolean;
  sprinting: boolean;
  stamina: number;
  colliderHeight: number;
  gaitPhase: number;
  surface: SurfaceKind;
}

export class PlayerMotor {
  readonly position = new THREE.Vector3();
  readonly previousPosition = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();

  grounded = false;
  crouched = false;
  sprinting = false;
  stamina = 1;
  colliderHeight: number;
  gaitPhase = 0;
  groundSurface: SurfaceKind = 'concrete';
  lastStepHeight = 0;
  lastLandingImpact = 0;

  private coyoteRemaining = 0;
  private jumpBufferRemaining = 0;
  private sprintRecoveryDelayRemaining = 0;
  private footstepDistance = 0;

  private readonly wishDirection = new THREE.Vector3();
  private readonly horizontalVelocity = new THREE.Vector3();
  private readonly displacement = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();

  constructor(
    private readonly world: StaticCollisionWorld,
    spawn = new THREE.Vector3(),
    readonly tuning: Readonly<PlayerTuning> = DEFAULT_PLAYER_TUNING,
    private readonly events: PlayerMotorEvents = {},
  ) {
    this.position.copy(spawn);
    this.previousPosition.copy(spawn);
    this.colliderHeight = tuning.standingHeight;
  }

  fixedUpdate(step: number, input: PlayerMotorInput): CapsuleMoveResult {
    this.previousPosition.copy(this.position);
    this.lastStepHeight = 0;
    this.lastLandingImpact = 0;

    this.updateColliderHeight(step, input.crouch);
    this.updateJumpTimers(step, input.jumpPressed);
    this.updateStamina(step, input);
    this.updateHorizontalVelocity(step, input);
    const intendedHorizontalSpeed = Math.hypot(this.velocity.x, this.velocity.z);

    const wasGrounded = this.grounded;
    if (this.grounded) {
      this.coyoteRemaining = this.tuning.coyoteTime;
      if (this.velocity.y < 0) this.velocity.y = 0;
    }

    if (this.jumpBufferRemaining > 0 && this.coyoteRemaining > 0) {
      this.velocity.y = jumpSpeedForHeight(this.tuning);
      this.grounded = false;
      this.coyoteRemaining = 0;
      this.jumpBufferRemaining = 0;
    }

    this.velocity.y -= this.tuning.gravity * step;
    const impactSpeed = Math.max(0, -this.velocity.y);
    this.displacement.copy(this.velocity).multiplyScalar(step);

    const result = this.world.moveCapsule(this.position, {
      height: this.colliderHeight,
      radius: this.tuning.radius,
      displacement: this.displacement,
      wasGrounded,
      maxStepHeight: this.tuning.maxStepHeight,
      groundSnapDistance: this.tuning.groundSnapDistance,
      minGroundNormalY: Math.cos(
        THREE.MathUtils.degToRad(this.tuning.maxWalkSlopeDegrees),
      ),
    });

    this.position.copy(result.position);
    this.grounded = result.grounded;
    this.groundSurface = result.surface;
    this.lastStepHeight = result.steppedHeight;

    for (const contact of result.contacts) {
      const intoSurface = this.velocity.dot(contact.normal);
      if (intoSurface < 0) this.velocity.addScaledVector(contact.normal, -intoSurface);
    }
    const resolvedHorizontalSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    if (resolvedHorizontalSpeed > intendedHorizontalSpeed + 1e-6) {
      const scale = intendedHorizontalSpeed / resolvedHorizontalSpeed;
      this.velocity.x *= scale;
      this.velocity.z *= scale;
    }
    if (this.grounded) this.velocity.y = 0;
    if (result.hitCeiling && this.velocity.y > 0) this.velocity.y = 0;

    if (!wasGrounded && this.grounded && impactSpeed > 1) {
      this.lastLandingImpact = impactSpeed;
      this.events.landed?.({ impactSpeed });
    }

    this.updateFootsteps(result.actualDisplacement);
    return result;
  }

  teleport(position: THREE.Vector3, velocity = new THREE.Vector3()): void {
    this.position.copy(position);
    this.previousPosition.copy(position);
    this.velocity.copy(velocity);
    this.grounded = false;
    this.coyoteRemaining = 0;
    this.jumpBufferRemaining = 0;
    this.footstepDistance = 0;
  }

  setCrouched(crouched: boolean): void {
    this.crouched = crouched;
    this.colliderHeight = crouched
      ? this.tuning.crouchingHeight
      : this.tuning.standingHeight;
  }

  snapshot(): PlayerMotorSnapshot {
    return {
      position: this.position.toArray() as [number, number, number],
      velocity: this.velocity.toArray() as [number, number, number],
      grounded: this.grounded,
      crouched: this.crouched,
      sprinting: this.sprinting,
      stamina: this.stamina,
      colliderHeight: this.colliderHeight,
      gaitPhase: this.gaitPhase,
      surface: this.groundSurface,
    };
  }

  private updateColliderHeight(step: number, wantsCrouch: boolean): void {
    const target = wantsCrouch
      ? this.tuning.crouchingHeight
      : this.tuning.standingHeight;
    const delta = this.tuning.crouchTransitionSpeed * step;

    if (target < this.colliderHeight) {
      this.colliderHeight = Math.max(target, this.colliderHeight - delta);
    } else if (target > this.colliderHeight) {
      const candidate = Math.min(target, this.colliderHeight + delta);
      if (this.world.canFit(this.position, candidate, this.tuning.radius)) {
        this.colliderHeight = candidate;
      }
    }

    this.crouched = this.colliderHeight
      < this.tuning.standingHeight - COLLIDER_STATE_EPSILON;
  }

  private updateJumpTimers(step: number, jumpPressed: boolean): void {
    this.coyoteRemaining = Math.max(0, this.coyoteRemaining - step);
    this.jumpBufferRemaining = Math.max(0, this.jumpBufferRemaining - step);
    if (jumpPressed) this.jumpBufferRemaining = this.tuning.jumpBufferTime;
  }

  private updateStamina(step: number, input: PlayerMotorInput): void {
    const hasForwardIntent = input.moveY > 0.1;
    const canSprint = this.grounded
      && !this.crouched
      && input.sprint
      && hasForwardIntent
      && this.stamina > 0;

    this.sprinting = canSprint;
    if (canSprint) {
      this.stamina = Math.max(0, this.stamina - step / this.tuning.sprintDuration);
      this.sprintRecoveryDelayRemaining = this.tuning.sprintRecoveryDelay;
      if (this.stamina === 0) this.sprinting = false;
      return;
    }

    this.sprintRecoveryDelayRemaining = Math.max(
      0,
      this.sprintRecoveryDelayRemaining - step,
    );
    if (this.sprintRecoveryDelayRemaining === 0) {
      this.stamina = Math.min(
        1,
        this.stamina + step / this.tuning.sprintRecoveryTime,
      );
    }
  }

  private updateHorizontalVelocity(step: number, input: PlayerMotorInput): void {
    this.forward.set(-Math.sin(input.yaw), 0, -Math.cos(input.yaw));
    this.right.set(Math.cos(input.yaw), 0, -Math.sin(input.yaw));
    this.wishDirection
      .copy(this.right)
      .multiplyScalar(input.moveX)
      .addScaledVector(this.forward, input.moveY);

    const wishAmount = Math.min(1, this.wishDirection.length());
    if (wishAmount > 1e-8) this.wishDirection.multiplyScalar(1 / wishAmount);

    this.horizontalVelocity.set(this.velocity.x, 0, this.velocity.z);
    const horizontalSpeed = this.horizontalVelocity.length();

    if (this.grounded) {
      if (wishAmount <= 1e-8) {
        const nextSpeed = Math.max(
          0,
          horizontalSpeed - this.tuning.groundDeceleration * step,
        );
        if (horizontalSpeed > 1e-8) {
          this.horizontalVelocity.multiplyScalar(nextSpeed / horizontalSpeed);
        }
      } else {
        const targetSpeed = this.crouched
          ? this.tuning.crouchSpeed
          : this.sprinting
            ? this.tuning.sprintSpeed
            : this.tuning.walkSpeed;
        const acceleration = this.sprinting
          ? this.tuning.sprintAcceleration
          : this.tuning.groundAcceleration;
        let speedLimit = targetSpeed;
        if (horizontalSpeed > targetSpeed) {
          const nextSpeed = Math.max(
            targetSpeed,
            horizontalSpeed - this.tuning.groundDeceleration * step,
          );
          this.horizontalVelocity.multiplyScalar(nextSpeed / horizontalSpeed);
          speedLimit = nextSpeed;
        }
        accelerate(
          this.horizontalVelocity,
          this.wishDirection,
          targetSpeed * wishAmount,
          acceleration,
          step,
        );
        const acceleratedSpeed = this.horizontalVelocity.length();
        if (acceleratedSpeed > speedLimit) {
          this.horizontalVelocity.multiplyScalar(speedLimit / acceleratedSpeed);
        }
      }
    } else if (wishAmount > 1e-8) {
      accelerate(
        this.horizontalVelocity,
        this.wishDirection,
        this.tuning.walkSpeed * wishAmount,
        this.tuning.airAcceleration * this.tuning.airControl,
        step,
      );
    }

    this.velocity.x = this.horizontalVelocity.x;
    this.velocity.z = this.horizontalVelocity.z;
  }

  private updateFootsteps(actualDisplacement: THREE.Vector3): void {
    if (!this.grounded) return;

    const horizontalDistance = Math.hypot(
      actualDisplacement.x,
      actualDisplacement.z,
    );
    if (horizontalDistance <= 1e-5) return;

    const stepLength = this.crouched
      ? this.tuning.crouchStepLength
      : this.sprinting
        ? this.tuning.sprintStepLength
        : this.tuning.walkStepLength;

    this.footstepDistance += horizontalDistance;
    this.gaitPhase = (this.gaitPhase + horizontalDistance / stepLength * Math.PI)
      % (Math.PI * 2);

    while (this.footstepDistance >= stepLength) {
      this.footstepDistance -= stepLength;
      this.events.footstep?.({
        position: this.position.clone(),
        surface: this.groundSurface,
        loud: this.sprinting,
      });
    }
  }
}

const COLLIDER_STATE_EPSILON = 0.02;

function accelerate(
  velocity: THREE.Vector3,
  direction: THREE.Vector3,
  targetSpeed: number,
  acceleration: number,
  step: number,
): void {
  const speedAlongWish = velocity.dot(direction);
  const speedToAdd = targetSpeed - speedAlongWish;
  if (speedToAdd <= 0) return;
  velocity.addScaledVector(direction, Math.min(speedToAdd, acceleration * step));
}
