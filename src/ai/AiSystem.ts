/**
 * The render-facing enemy-AI system.
 *
 * This is the ONLY file in the library that imports `three`. It owns no
 * behaviour: every decision is made by the renderer-free `EnemyAgent`, and this
 * class is purely the adapter that turns the agent's plain-number state into
 * meshes a player can read — the body and its facing, the vision state as a
 * gaze colour, the wind-up telegraph, the muzzle while firing, and the ghost of
 * where the enemy last saw the player. Because the visuals are pure functions
 * of the frozen agent state, a harness can pause the simulation on any tick and
 * the frame is still legible, which is what the shot tool captures.
 *
 * Line-of-sight and cover are resolved by the agent against the SAME
 * `buildArena()` boxes this system renders, so the wall you see is the wall the
 * enemy cannot shoot through.
 */

import * as THREE from 'three';
import { Events } from '../core/contracts.js';
import type {
  DamagePayload, EngineContext, System, UpdateContext,
} from '../core/contracts.js';
import { EnemyAgent } from './agent.js';
import { DEFAULT_ENEMY_CONFIG } from './config.js';
import {
  ARENA_ENEMY_SPAWN, ARENA_ENEMY_YAW, buildArena,
} from './world.js';
import type { Arena } from './world.js';
import type {
  AiState, CombatSink, DamageEvent, EnemyConfig, FireShot, FootstepStimulus,
  StepInput, TargetSample, Vec3,
} from './types.js';

/** What the host reports about the player each fixed step. `null` = no target. */
export interface PlayerSample {
  position: Vec3;
  alive?: boolean;
}

export interface AiSystemOptions {
  config?: EnemyConfig;
  /** Canonical host arena. The private calibration arena remains the fallback. */
  arena?: Arena;
  spawn?: Vec3;
  yaw?: number;
  /** Host combat output; visual output is always preserved and forwarded. */
  combatSink?: CombatSink;
  /** Supplies the player each fixed step. Defaults to the camera's ground point. */
  playerProvider?: (ctx: EngineContext) => PlayerSample | null;
  /** Draw the arena cover boxes. The level owns these in a full game. */
  renderWorld?: boolean;
  /** Target id the enemy attributes sight/last-known to. */
  targetId?: string;
  /** Bus id this enemy answers to for {@link Events.Damage}. */
  enemyId?: string | number;
}

const STATE_COLOR: Record<AiState, number> = {
  patrol: 0x36d17a, //      calm green
  investigate: 0xf2c14e, //  amber — heard something
  engage: 0xff4d3d, //       red — has you
  reposition: 0xff8a3d, //   orange — moving on you
  search: 0xffd24d, //       yellow — lost you, hunting
  dead: 0x555b66, //         grey
};

const WARMUP_STEPS = 24;
const FRAME_STEPS = 2; // fixed steps per 60fps frame, for the per-frame figure

export class AiSystem implements System {
  readonly name = 'ai';

  readonly arena: Arena;
  agent: EnemyAgent;
  /** When frozen, the live fixed step is a no-op so a posed frame holds still. */
  frozen = false;
  private readonly config: EnemyConfig;
  private readonly sink: CombatSink;
  private readonly spawn: Vec3;
  private readonly spawnYaw: number;

  // ── Live CPU probe (secondary, in-browser cross-check) ──────────────────
  lastStepMs = 0;
  avgStepMs = 0;
  maxStepMs = 0;
  sampledSteps = 0;
  private stepMsTotal = 0;

  private readonly opts: {
    renderWorld: boolean;
    targetId: string;
    playerProvider?: (ctx: EngineContext) => PlayerSample | null;
    enemyId: string | number;
  };

  // Per-tick input buffers, filled by bus subscriptions, drained each step.
  private pendingFootsteps: FootstepStimulus[] = [];
  private pendingDamage: DamageEvent[] = [];
  private unsub: Array<() => void> = [];

  // Interpolation between the last two fixed steps.
  private readonly prevPos = new THREE.Vector3();
  private readonly currPos = new THREE.Vector3();
  private prevYaw = 0;
  private currYaw = 0;

  // Most recent shot, for the tracer/muzzle while firing.
  private readonly shotOrigin = new THREE.Vector3();
  private readonly shotDir = new THREE.Vector3(0, 0, -1);
  private firedThisFrame = false;

  // Ground-truth player the AI was last told about, for the player marker.
  private readonly lastPlayer = new THREE.Vector3();
  private hasPlayer = false;

  // ── Meshes ──────────────────────────────────────────────────────────────
  private root!: THREE.Group; //      static: world geometry, markers, tracer
  private enemyRoot!: THREE.Group; //  moved + oriented to the agent each frame
  private body!: THREE.Group; //       child of enemyRoot; topples on death
  private visor!: THREE.MeshStandardMaterial;
  private gaze!: THREE.Mesh;
  private gazeMat!: THREE.MeshBasicMaterial;
  private telegraph!: THREE.Mesh;
  private telegraphMat!: THREE.MeshStandardMaterial;
  private muzzle!: THREE.Mesh;
  private muzzleMat!: THREE.MeshStandardMaterial;
  private tracer!: THREE.Mesh;
  private tracerMat!: THREE.MeshStandardMaterial;
  private playerMarker!: THREE.Mesh;
  private ghost!: THREE.Mesh;
  private ghostMat!: THREE.MeshStandardMaterial;
  private readonly disposables: Array<{ dispose(): void }> = [];

  private readonly scratch = new THREE.Vector3();
  private readonly upAxis = new THREE.Vector3(0, 1, 0);

  constructor(options: AiSystemOptions = {}) {
    this.arena = options.arena ?? buildArena();
    this.opts = {
      renderWorld: options.renderWorld ?? true,
      targetId: options.targetId ?? 'player',
      playerProvider: options.playerProvider,
      enemyId: options.enemyId ?? 'enemy-01',
    };

    this.spawn = options.spawn ?? ARENA_ENEMY_SPAWN;
    this.spawnYaw = options.yaw ?? ARENA_ENEMY_YAW;

    const hostSink = options.combatSink;
    const sink: CombatSink = {
      onAim: (aim, time) => hostSink?.onAim?.(aim, time),
      onTelegraph: (aim, windup, time) => hostSink?.onTelegraph?.(aim, windup, time),
      onFire: (shot: FireShot) => {
        this.shotOrigin.set(shot.origin.x, shot.origin.y, shot.origin.z);
        this.shotDir.set(shot.direction.x, shot.direction.y, shot.direction.z);
        this.firedThisFrame = true;
        hostSink?.onFire?.(shot);
      },
      onCease: (reason, time) => hostSink?.onCease?.(reason, time),
    };
    this.sink = sink;
    this.config = options.config ?? DEFAULT_ENEMY_CONFIG;
    this.agent = this.buildAgent();

    this.currPos.set(this.agent.position.x, this.agent.position.y, this.agent.position.z);
    this.prevPos.copy(this.currPos);
    this.prevYaw = this.currYaw = this.agent.yaw;
  }

  init(ctx: EngineContext): void {
    const { scene } = ctx;
    this.root = new THREE.Group();
    this.root.name = 'ai-world';
    scene.add(this.root);
    this.enemyRoot = new THREE.Group();
    this.enemyRoot.name = 'ai-enemy';
    this.enemyRoot.userData.ballisticCollider = true;
    this.enemyRoot.userData.damageTargetId = this.opts.enemyId;
    this.enemyRoot.userData.surface = 'flesh';
    this.enemyRoot.position.set(
      this.agent.position.x, this.agent.position.y, this.agent.position.z,
    );
    scene.add(this.enemyRoot);

    if (this.opts.renderWorld) this.buildWorldMeshes();
    this.buildEnemy();
    this.buildEffects();
    this.buildMarkers();

    this.unsub.push(ctx.bus.on(Events.Footstep, (p: unknown) => {
      const f = p as { position: THREE.Vector3 | Vec3; loud?: boolean | number };
      const loud = typeof f.loud === 'number' ? f.loud : f.loud ? 1 : 0.5;
      this.pendingFootsteps.push({
        position: { x: f.position.x, y: f.position.y, z: f.position.z }, loud,
      });
    }));
    this.unsub.push(ctx.bus.on(Events.Damage, (p: unknown) => {
      const d = p as DamagePayload;
      if (d.id !== this.opts.enemyId) return;
      const src = d.point
        ? { x: d.point.x, y: d.point.y, z: d.point.z }
        : undefined;
      this.pendingDamage.push({ amount: d.amount, sourcePosition: src });
    }));
  }

  fixedUpdate(step: number, ctx: EngineContext): void {
    if (this.frozen) return;
    this.prevPos.copy(this.currPos);
    this.prevYaw = this.currYaw;

    const player = this.samplePlayer(ctx);
    const target: TargetSample = player
      ? { id: this.opts.targetId, position: player.position, alive: player.alive ?? true }
      : { id: this.opts.targetId, position: this.agent.position, alive: false };
    this.hasPlayer = !!player && (player.alive ?? true);
    if (player) this.lastPlayer.set(player.position.x, 0, player.position.z);

    const input = {
      target,
      footsteps: this.pendingFootsteps.length ? this.pendingFootsteps : undefined,
      damage: this.pendingDamage.length ? this.pendingDamage : undefined,
    };

    const t0 = performance.now();
    const previousState = this.agent.state;
    this.agent.fixedStep(step, input);
    const dtMs = performance.now() - t0;

    this.pendingFootsteps = [];
    this.pendingDamage = [];

    this.currPos.set(this.agent.position.x, this.agent.position.y, this.agent.position.z);
    this.currYaw = this.agent.yaw;
    // Ballistics runs on the fixed step. Keep its dynamic collider at the
    // authoritative current pose; presentation interpolates it later.
    this.enemyRoot.position.copy(this.currPos);
    this.enemyRoot.rotation.set(0, -this.currYaw, 0);

    if (previousState !== 'dead' && this.agent.state === 'dead') {
      ctx.bus.emit(Events.Elimination, {
        id: this.opts.enemyId,
        label: 'HOSTILE DOWN',
      });
    }

    // Discard warm-up steps; the JIT is not representative of steady state.
    if (this.agent.tick > WARMUP_STEPS) {
      this.lastStepMs = dtMs;
      this.maxStepMs = Math.max(this.maxStepMs, dtMs);
      this.stepMsTotal += dtMs;
      this.sampledSteps++;
      this.avgStepMs = this.stepMsTotal / this.sampledSteps;
    }
  }

  update(u: UpdateContext, _ctx: EngineContext): void {
    const a = this.agent;
    const alpha = a.state === 'dead' ? 1 : u.alpha;

    // Body position/orientation, interpolated for smooth presentation.
    this.scratch.copy(this.prevPos).lerp(this.currPos, alpha);
    this.enemyRoot.position.copy(this.scratch);
    const yaw = lerpAngle(this.prevYaw, this.currYaw, alpha);
    // The agent's forward is (sin yaw, 0, −cos yaw); a Y-rotation of −yaw maps
    // the body's local −Z (its built front) onto exactly that direction.
    this.enemyRoot.rotation.set(0, -yaw, 0);

    const color = STATE_COLOR[a.state];
    this.visor.emissive.setHex(color);
    this.visor.color.setHex(color);

    this.updateDeath(a.state, a.deathSeconds);
    this.updateGaze(a.state);
    this.updateTelegraph();
    this.updateFiring();
    this.updateMarkers();

    this.firedThisFrame = false;
  }

  /** CPU cost summary for the host to publish. Steady-state, warm-up discarded. */
  costSummary(): { perStepMs: number; perStepMaxMs: number; perFrameMs: number; steps: number } {
    return {
      perStepMs: this.avgStepMs,
      perStepMaxMs: this.maxStepMs,
      perFrameMs: this.avgStepMs * FRAME_STEPS,
      steps: this.sampledSteps,
    };
  }

  private buildAgent(): EnemyAgent {
    return new EnemyAgent(
      this.config, this.arena.world, this.arena.cover, this.arena.halfExtent,
      { spawn: this.spawn, yaw: this.spawnYaw, combat: this.sink },
    );
  }

  /**
   * Reset the agent to tick 0. Used by a harness to deterministically replay to
   * a chosen tick and pose a still frame; the simulation is a pure function of
   * its inputs, so the replayed state is identical every time.
   */
  rebuildAgent(): void {
    this.agent = this.buildAgent();
    this.currPos.set(this.agent.position.x, this.agent.position.y, this.agent.position.z);
    this.prevPos.copy(this.currPos);
    this.prevYaw = this.currYaw = this.agent.yaw;
    this.pendingFootsteps = [];
    this.pendingDamage = [];
    this.firedThisFrame = false;
    this.hasPlayer = false;
    this.lastStepMs = this.avgStepMs = this.maxStepMs = this.stepMsTotal = 0;
    this.sampledSteps = 0;
  }

  /** Advance one deterministic step from an explicit input, for posed replay. */
  poseStep(input: StepInput): void {
    this.prevPos.copy(this.currPos);
    this.prevYaw = this.currYaw;
    this.agent.fixedStep(this.config.fixedStepSeconds, input);
    this.currPos.set(this.agent.position.x, this.agent.position.y, this.agent.position.z);
    this.currYaw = this.agent.yaw;
    this.hasPlayer = input.target.alive;
    this.lastPlayer.set(input.target.position.x, 0, input.target.position.z);
  }

  dispose(): void {
    for (const u of this.unsub) u();
    this.unsub = [];
    for (const d of this.disposables) d.dispose();
    this.root?.parent?.remove(this.root);
    this.enemyRoot?.parent?.remove(this.enemyRoot);
  }

  // ── Player sampling ───────────────────────────────────────────────────────

  private samplePlayer(ctx: EngineContext): PlayerSample | null {
    if (this.opts.playerProvider) return this.opts.playerProvider(ctx);
    // Default: the first-person camera IS the player. Report its ground point;
    // perception adds the configured torso height back on.
    const p = ctx.camera.position;
    return { position: { x: p.x, y: 0, z: p.z }, alive: true };
  }

  // ── Mesh construction ─────────────────────────────────────────────────────

  private buildWorldMeshes(): void {
    for (const box of this.arena.world.boxes) {
      const sx = box.max.x - box.min.x;
      const sy = box.max.y - box.min.y;
      const sz = box.max.z - box.min.z;
      const geo = new THREE.BoxGeometry(sx, sy, sz);
      const mat = new THREE.MeshStandardMaterial({
        color: coverColor(box.id),
        roughness: 0.85,
        metalness: 0.04,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(
        (box.min.x + box.max.x) / 2,
        (box.min.y + box.max.y) / 2,
        (box.min.z + box.max.z) / 2,
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.root.add(mesh);
      this.disposables.push(geo, mat);
    }
  }

  private buildEnemy(): void {
    const c = this.agent.config;
    this.body = new THREE.Group();
    this.enemyRoot.add(this.body);

    const radius = 0.32;
    const bodyH = c.eyeHeight - 0.15;
    const torsoGeo = new THREE.CapsuleGeometry(radius, Math.max(0.1, bodyH - radius * 2), 6, 16);
    const torsoMat = new THREE.MeshStandardMaterial({ color: 0x2b3038, roughness: 0.6, metalness: 0.2 });
    const torso = new THREE.Mesh(torsoGeo, torsoMat);
    torso.position.y = bodyH / 2 + 0.05;
    torso.castShadow = true;
    this.body.add(torso);
    this.disposables.push(torsoGeo, torsoMat);

    const headGeo = new THREE.SphereGeometry(0.2, 20, 14);
    const headMat = new THREE.MeshStandardMaterial({ color: 0x20242b, roughness: 0.5, metalness: 0.25 });
    const head = new THREE.Mesh(headGeo, headMat);
    head.position.y = bodyH + 0.12;
    head.castShadow = true;
    this.body.add(head);
    this.disposables.push(headGeo, headMat);

    // A state-coloured visor on the FRONT (local −Z) so facing and mood read at a glance.
    const visorGeo = new THREE.BoxGeometry(0.26, 0.08, 0.06);
    this.visor = new THREE.MeshStandardMaterial({
      color: 0x36d17a, emissive: 0x36d17a, emissiveIntensity: 6, roughness: 0.3,
    });
    const visor = new THREE.Mesh(visorGeo, this.visor);
    visor.position.set(0, bodyH + 0.14, -0.18);
    this.body.add(visor);
    this.disposables.push(visorGeo, this.visor);
  }

  private buildEffects(): void {
    // Gaze bar: a thin beam from the eye along forward, tinted by state.
    const gazeGeo = new THREE.CylinderGeometry(0.02, 0.02, 1, 8);
    gazeGeo.translate(0, 0.5, 0); // origin at the base so we can scale length from the eye
    gazeGeo.rotateX(-Math.PI / 2); // lay the cylinder along −Z (forward)
    this.gazeMat = new THREE.MeshBasicMaterial({ color: 0x36d17a, transparent: true, opacity: 0.5 });
    this.gaze = new THREE.Mesh(gazeGeo, this.gazeMat);
    this.gaze.position.y = this.agent.config.eyeHeight;
    this.body.add(this.gaze);
    this.disposables.push(gazeGeo, this.gazeMat);

    // Telegraph: a charging orb above the head that swells and heats up over
    // the wind-up. A sphere reads as "charging to fire" from any camera angle.
    const telGeo = new THREE.SphereGeometry(0.17, 20, 14);
    this.telegraphMat = new THREE.MeshStandardMaterial({
      color: 0xffef9f, emissive: 0xffb84d, emissiveIntensity: 0, roughness: 0.35,
    });
    this.telegraph = new THREE.Mesh(telGeo, this.telegraphMat);
    this.telegraph.position.y = this.agent.config.eyeHeight + 0.5;
    this.telegraph.visible = false;
    this.body.add(this.telegraph);
    this.disposables.push(telGeo, this.telegraphMat);

    // Muzzle glow at the barrel.
    const muzGeo = new THREE.SphereGeometry(0.12, 16, 12);
    this.muzzleMat = new THREE.MeshStandardMaterial({
      color: 0xffd08a, emissive: 0xffa83a, emissiveIntensity: 0, roughness: 0.3,
    });
    this.muzzle = new THREE.Mesh(muzGeo, this.muzzleMat);
    this.muzzle.visible = false;
    this.root.add(this.muzzle); // world-space, aligned to the fired shot
    this.disposables.push(muzGeo, this.muzzleMat);

    // Tracer: a thin emissive rod along the last shot direction.
    const traGeo = new THREE.CylinderGeometry(0.02, 0.02, 1, 8);
    this.tracerMat = new THREE.MeshStandardMaterial({
      color: 0xfff2c8, emissive: 0xffc860, emissiveIntensity: 8, roughness: 0.4,
    });
    this.tracer = new THREE.Mesh(traGeo, this.tracerMat);
    this.tracer.visible = false;
    this.root.add(this.tracer);
    this.disposables.push(traGeo, this.tracerMat);
  }

  private buildMarkers(): void {
    // The player the AI is reasoning about (ground truth), a bright capsule.
    const pgeo = new THREE.CapsuleGeometry(0.3, 1.1, 6, 14);
    const pmat = new THREE.MeshStandardMaterial({
      color: 0x35c6ff, emissive: 0x1a6fb0, emissiveIntensity: 1.2, roughness: 0.5,
    });
    this.playerMarker = new THREE.Mesh(pgeo, pmat);
    this.playerMarker.castShadow = true;
    this.root.add(this.playerMarker);
    this.disposables.push(pgeo, pmat);

    // The enemy's memory: a translucent ghost at the last-known position.
    const ggeo = new THREE.CapsuleGeometry(0.3, 1.1, 6, 14);
    this.ghostMat = new THREE.MeshStandardMaterial({
      color: 0x9fd8ff, emissive: 0x2a5a80, emissiveIntensity: 0.6,
      transparent: true, opacity: 0.32, roughness: 0.6,
    });
    this.ghost = new THREE.Mesh(ggeo, this.ghostMat);
    this.ghost.visible = false;
    this.root.add(this.ghost);
    this.disposables.push(ggeo, this.ghostMat);
  }

  // ── Per-frame visual updates ───────────────────────────────────────────────

  private updateDeath(state: AiState, deathSeconds: number): void {
    if (state !== 'dead') { this.body.rotation.set(0, 0, 0); this.body.position.y = 0; return; }
    const t = Math.min(1, deathSeconds / Math.max(0.001, this.agent.config.deathSettleSeconds));
    const e = 1 - (1 - t) * (1 - t); // ease-out
    this.body.rotation.z = e * (Math.PI / 2) * 0.92; // topple sideways
    this.body.position.y = -e * 0.15; // settle to the floor
    this.telegraph.visible = false;
    this.muzzle.visible = false;
    this.tracer.visible = false;
    this.gaze.visible = false;
  }

  private updateGaze(state: AiState): void {
    if (state === 'dead') { this.gaze.visible = false; return; }
    this.gaze.visible = true;
    this.gazeMat.color.setHex(STATE_COLOR[state]);
    // A confident, longer beam when it actually sees you; a stub otherwise.
    const len = this.agent.canSeeNow ? 3.4 : 1.1;
    this.gaze.scale.set(1, 1, len);
    this.gazeMat.opacity = this.agent.canSeeNow ? 0.65 : 0.3;
  }

  private updateTelegraph(): void {
    const p = this.agent.telegraphProgress();
    if (p <= 0) { this.telegraph.visible = false; return; }
    this.telegraph.visible = true;
    const scale = 0.7 + p * 1.6;
    this.telegraph.scale.setScalar(scale);
    this.telegraphMat.emissiveIntensity = 1.8 + p * 5.2;
    // Warm up from amber to hot red as the shot approaches; kept below the
    // muzzle-flash intensity so "charging" (orange) reads distinct from "firing" (white).
    this.telegraphMat.emissive.setRGB(1, 0.6 - p * 0.4, 0.24 - p * 0.22);
  }

  private updateFiring(): void {
    const firing = this.agent.combatPhase === 'burst';
    this.muzzle.visible = firing;
    this.tracer.visible = firing;
    if (!firing) { this.muzzleMat.emissiveIntensity = 0; return; }

    this.muzzle.position.copy(this.shotOrigin);
    this.muzzleMat.emissiveIntensity = this.firedThisFrame ? 26 : 10;

    // Lay the tracer from the muzzle along the shot direction.
    const len = 22;
    this.scratch.copy(this.shotDir).multiplyScalar(len * 0.5).add(this.shotOrigin);
    this.tracer.position.copy(this.scratch);
    this.tracer.quaternion.setFromUnitVectors(this.upAxis, this.shotDir);
    this.tracer.scale.set(1, len, 1);
    this.tracerMat.emissiveIntensity = this.firedThisFrame ? 14 : 5;
  }

  private updateMarkers(): void {
    const a = this.agent;
    // Ground-truth player marker at the position the AI was last told about.
    this.playerMarker.visible = this.hasPlayer;
    if (this.hasPlayer) this.playerMarker.position.set(this.lastPlayer.x, 0.95, this.lastPlayer.z);
    // Memory ghost: only meaningful once it has lost sight but still remembers.
    const remembering = a.hasLastKnown && !a.canSeeNow
      && (a.state === 'search' || a.state === 'engage' || a.state === 'reposition');
    this.ghost.visible = remembering;
    if (remembering) this.ghost.position.set(a.lastKnown.x, 0.95, a.lastKnown.z);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function coverColor(id: string): number {
  if (id.startsWith('wall')) return 0x2f3540;
  if (id.startsWith('cover')) return 0x53433a; // the enemy's own cover, warm stone
  if (id.startsWith('hide')) return 0x3d4650; // player-side chest blocks, cool
  if (id.startsWith('pillar')) return 0x474049;
  return 0x3a3f47;
}

/** Shortest-path angular interpolation, so yaw never spins the long way round. */
function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
