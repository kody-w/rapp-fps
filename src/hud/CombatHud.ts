import { Quaternion } from 'three';
import {
  Events,
  type EngineContext,
  type EventBus,
  type System,
} from '../core/contracts.js';
import type { ProfilerSnapshot } from '../core/profiler.js';
import './hud.css';

export const HudEvents = {
  WeaponStatus: 'weapon:status',
  PlayerStatus: 'player:status',
  HitConfirmed: 'combat:hit-confirm',
  Elimination: 'combat:elimination',
  ObjectiveChanged: 'hud:objective',
  InteractionChanged: 'hud:interaction',
} as const;

export interface Vector3Like {
  x: number;
  y: number;
  z: number;
}

export interface QuaternionLike {
  x: number;
  y: number;
  z: number;
  w: number;
}

export type DamageScreenQuadrant = 'top' | 'right' | 'bottom' | 'left';

export interface DamageScreenDirection {
  angleDeg: number;
  quadrant: DamageScreenQuadrant;
}

export interface WeaponHudStatus {
  ammo?: number;
  reserve?: number;
  magazineSize?: number;
  reloading?: boolean;
  /** Current normalized weapon spread, 0 (precise) through 1 (widest). */
  spread?: number;
  /** The weapon system's real ADS transition, 0 (hip) through 1 (ADS). */
  aim?: number;
}

export interface PlayerHudStatus {
  health: number;
  maxHealth?: number;
}

export type CharacterId = string | number;

export interface DamageHudEvent {
  id: CharacterId;
  amount: number;
  /** World-space direction from the damaged player toward the damage source. */
  direction: Vector3Like;
  health?: number;
  maxHealth?: number;
  lethal?: boolean;
}

export interface HitConfirmedEvent {
  lethal?: boolean;
}

export interface EliminationEvent {
  label?: string;
}

export interface ObjectiveHudStatus {
  title: string;
  detail?: string;
}

export interface InteractionHudStatus {
  action: string;
  binding?: string;
}

export interface HudProfilerSource {
  snapshot: () => Pick<
    ProfilerSnapshot,
    'gpuFrameMs' | 'cpuFrameMs' | 'budgetFrameMs'
  >;
  drawCalls: () => number | null;
  budgetMs?: number;
}

export interface CombatHudOptions {
  /** Only Damage events for this character may affect the player HUD. */
  playerId: CharacterId;
  parent?: HTMLElement;
  profiler?: HudProfilerSource;
  /** Defaults to `location.search`; only `hudDebug=1` enables the overlay. */
  query?: string;
}

interface HudState {
  ammo: number;
  reserve: number;
  magazineSize: number;
  reloading: boolean;
  spread: number;
  aim: number;
  health: number;
  maxHealth: number;
  damageAngleDeg: number;
  damageQuadrant: DamageScreenQuadrant;
  damageUntil: number;
  hitUntil: number;
  hitLethal: boolean;
  eliminationUntil: number;
  eliminationLabel: string;
  objective: ObjectiveHudStatus | null;
  interaction: InteractionHudStatus | null;
}

interface HudElements {
  ammo: HTMLElement;
  reserve: HTMLElement;
  reload: HTMLElement;
  health: HTMLElement;
  objective: HTMLElement;
  objectiveTitle: HTMLElement;
  objectiveDetail: HTMLElement;
  interaction: HTMLElement;
  interactionBinding: HTMLElement;
  interactionAction: HTMLElement;
  damage: HTMLElement;
  hit: HTMLElement;
  elimination: HTMLElement;
  eliminationLabel: HTMLElement;
  live: HTMLElement;
  liveText: Text;
}

interface DebugElements {
  root: HTMLElement;
  gpu: HTMLElement;
  cpu: HTMLElement;
  paired: HTMLElement;
  draws: HTMLElement;
  budget: HTMLElement;
}

const DIRTY = {
  RETICLE: 1 << 0,
  AMMO: 1 << 1,
  HEALTH: 1 << 2,
  OBJECTIVE: 1 << 3,
  INTERACTION: 1 << 4,
  DAMAGE: 1 << 5,
  HIT: 1 << 6,
  ELIMINATION: 1 << 7,
  ACCESSIBILITY: 1 << 8,
} as const;

const DIRTY_ALL = (1 << 9) - 1;
const DAMAGE_DURATION_MS = 850;
const HIT_DURATION_MS = 160;
const ELIMINATION_DURATION_MS = 1_500;
const DEBUG_REFRESH_MS = 250;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finiteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

function asCount(value: number | undefined, fallback: number): number {
  return Math.max(0, Math.round(finiteOr(value, fallback)));
}

function quadrantFor(angleDeg: number): DamageScreenQuadrant {
  if (angleDeg >= -45 && angleDeg < 45) return 'top';
  if (angleDeg >= 45 && angleDeg < 135) return 'right';
  if (angleDeg >= 135 || angleDeg < -135) return 'bottom';
  return 'left';
}

/**
 * Converts a world-space direction into the camera's yaw plane.
 *
 * Zero degrees is the top/front HUD quadrant and positive rotation proceeds
 * clockwise. The quaternion is normalized so a partially-updated camera pose
 * cannot skew the result.
 */
export function mapWorldDamageDirection(
  direction: Vector3Like,
  cameraWorldQuaternion: QuaternionLike,
): DamageScreenDirection {
  const qLength = Math.hypot(
    cameraWorldQuaternion.x,
    cameraWorldQuaternion.y,
    cameraWorldQuaternion.z,
    cameraWorldQuaternion.w,
  ) || 1;
  const x = cameraWorldQuaternion.x / qLength;
  const y = cameraWorldQuaternion.y / qLength;
  const z = cameraWorldQuaternion.z / qLength;
  const w = cameraWorldQuaternion.w / qLength;

  const m00 = 1 - 2 * (y * y + z * z);
  const m01 = 2 * (x * y - z * w);
  const m02 = 2 * (x * z + y * w);
  const m10 = 2 * (x * y + z * w);
  const m11 = 1 - 2 * (x * x + z * z);
  const m12 = 2 * (y * z - x * w);
  const m20 = 2 * (x * z - y * w);
  const m21 = 2 * (y * z + x * w);
  const m22 = 1 - 2 * (x * x + y * y);

  // R(q) maps camera-local to world. Its transpose maps world to local.
  const localX = m00 * direction.x + m10 * direction.y + m20 * direction.z;
  const localY = m01 * direction.x + m11 * direction.y + m21 * direction.z;
  const localZ = m02 * direction.x + m12 * direction.y + m22 * direction.z;
  const horizontalLength = Math.hypot(localX, localZ);

  const angleDeg = horizontalLength < 1e-6
    ? (localY >= 0 ? 0 : 180)
    : Math.atan2(localX, -localZ) * 180 / Math.PI;

  return { angleDeg, quadrant: quadrantFor(angleDeg) };
}

function debugEnabled(search: string): boolean {
  return new URLSearchParams(search).get('hudDebug') === '1';
}

function required(root: ParentNode, selector: string): HTMLElement {
  const element = root.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`HUD template is missing ${selector}`);
  return element;
}

function formatMs(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '—' : `${value.toFixed(2)} ms`;
}

export class CombatHud implements System {
  readonly name = 'hud';

  private readonly state: HudState = {
    ammo: 30,
    reserve: 90,
    magazineSize: 30,
    reloading: false,
    spread: 0.5,
    aim: 0,
    health: 100,
    maxHealth: 100,
    damageAngleDeg: 0,
    damageQuadrant: 'top',
    damageUntil: 0,
    hitUntil: 0,
    hitLethal: false,
    eliminationUntil: 0,
    eliminationLabel: 'TARGET DOWN',
    objective: null,
    interaction: null,
  };

  private readonly cameraWorldQuaternion = new Quaternion();
  private readonly subscriptions: Array<() => void> = [];
  private readonly showDebug: boolean;
  private readonly announcementQueue: string[] = [];
  private root: HTMLElement | null = null;
  private elements: HudElements | null = null;
  private debugElements: DebugElements | null = null;
  private camera: EngineContext['camera'] | null = null;
  private dirty = DIRTY_ALL;
  private rafId = 0;
  private renderedDamageActive = false;
  private renderedHitActive = false;
  private renderedEliminationActive = false;
  private lastDebugAt = -Infinity;
  private announcementSerial = 0;

  constructor(private readonly options: CombatHudOptions) {
    const query = options.query
      ?? (typeof location === 'undefined' ? '' : location.search);
    this.showDebug = debugEnabled(query);
  }

  init(ctx: EngineContext): void {
    if (this.root) return;
    this.resetPresentationState();
    this.camera = ctx.camera;
    this.mount(this.options.parent ?? document.body);
    this.subscribe(ctx.bus);
    this.rafId = requestAnimationFrame(this.present);
  }

  setWeaponStatus(status: WeaponHudStatus): void {
    const next = {
      ammo: asCount(status.ammo, this.state.ammo),
      reserve: asCount(status.reserve, this.state.reserve),
      magazineSize: Math.max(1, asCount(status.magazineSize, this.state.magazineSize)),
      reloading: status.reloading ?? this.state.reloading,
      spread: clamp(finiteOr(status.spread, this.state.spread), 0, 1),
      aim: clamp(finiteOr(status.aim, this.state.aim), 0, 1),
    };
    if (
      next.ammo === this.state.ammo
      && next.reserve === this.state.reserve
      && next.magazineSize === this.state.magazineSize
      && next.reloading === this.state.reloading
      && next.spread === this.state.spread
      && next.aim === this.state.aim
    ) return;

    Object.assign(this.state, next);
    this.markDirty(DIRTY.AMMO | DIRTY.RETICLE);
  }

  setPlayerStatus(status: PlayerHudStatus): void {
    const maxHealth = Math.max(1, finiteOr(status.maxHealth, this.state.maxHealth));
    const health = clamp(finiteOr(status.health, this.state.health), 0, maxHealth);
    if (health === this.state.health && maxHealth === this.state.maxHealth) return;
    this.state.health = health;
    this.state.maxHealth = maxHealth;
    this.markDirty(DIRTY.HEALTH);
  }

  setObjective(objective: ObjectiveHudStatus | null): void {
    const next = objective?.title.trim()
      ? { title: objective.title.trim(), detail: objective.detail?.trim() ?? '' }
      : null;
    if (
      next?.title === this.state.objective?.title
      && next?.detail === this.state.objective?.detail
    ) return;
    this.state.objective = next;
    if (next) this.announce(`Objective: ${next.title}`);
    this.markDirty(DIRTY.OBJECTIVE);
  }

  setInteraction(interaction: InteractionHudStatus | null): void {
    const next = interaction?.action.trim()
      ? {
          action: interaction.action.trim(),
          binding: interaction.binding?.trim().toUpperCase() ?? '',
        }
      : null;
    if (
      next?.action === this.state.interaction?.action
      && next?.binding === this.state.interaction?.binding
    ) return;
    this.state.interaction = next;
    this.markDirty(DIRTY.INTERACTION);
  }

  confirmHit(event: HitConfirmedEvent = {}): void {
    this.state.hitLethal = event.lethal === true;
    this.state.hitUntil = performance.now() + HIT_DURATION_MS;
    this.markDirty(DIRTY.HIT);
  }

  confirmElimination(event: EliminationEvent = {}): void {
    this.state.eliminationLabel = event.label?.trim() || 'TARGET DOWN';
    this.state.eliminationUntil = performance.now() + ELIMINATION_DURATION_MS;
    this.announce(this.state.eliminationLabel);
    this.markDirty(DIRTY.ELIMINATION);
  }

  resetFeedback(): void {
    this.state.damageUntil = 0;
    this.state.hitUntil = 0;
    this.state.eliminationUntil = 0;
    this.markDirty(DIRTY.DAMAGE | DIRTY.HIT | DIRTY.ELIMINATION);
  }

  dispose(): void {
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe();
    this.root?.remove();
    this.root = null;
    this.elements = null;
    this.debugElements = null;
    this.camera = null;
    this.resetPresentationState();
  }

  private mount(parent: HTMLElement): void {
    const root = document.createElement('section');
    root.className = 'combat-hud';
    root.dataset.hudRoot = '';
    root.setAttribute('aria-label', 'Combat status');
    root.innerHTML = `
      <div class="hud-vignette" aria-hidden="true"></div>
      <section class="hud-objective" aria-hidden="true">
        <span class="hud-kicker">CURRENT OBJECTIVE</span>
        <strong class="hud-objective-title"></strong>
        <span class="hud-objective-detail"></span>
      </section>
      <div class="hud-reticle" aria-hidden="true">
        <i class="hud-reticle-tick hud-reticle-top"></i>
        <i class="hud-reticle-tick hud-reticle-right"></i>
        <i class="hud-reticle-tick hud-reticle-bottom"></i>
        <i class="hud-reticle-tick hud-reticle-left"></i>
        <i class="hud-reticle-dot"></i>
      </div>
      <div class="hud-damage" aria-hidden="true">
        <i class="hud-damage-chevron"></i>
      </div>
      <div class="hud-hit" aria-hidden="true">
        <i></i><i></i><i></i><i></i>
      </div>
      <div class="hud-elimination" aria-hidden="true">
        <i></i><span class="hud-elimination-label"></span><i></i>
      </div>
      <section class="hud-health" aria-hidden="true">
        <span class="hud-kicker">VITAL</span>
        <div class="hud-health-row">
          <strong class="hud-health-value"></strong><span class="hud-health-unit">%</span>
        </div>
        <i class="hud-health-track"><i></i></i>
      </section>
      <section class="hud-ammo" aria-hidden="true">
        <span class="hud-reload-state"></span>
        <div class="hud-ammo-row">
          <strong class="hud-ammo-value"></strong>
          <i></i>
          <span class="hud-reserve-value"></span>
        </div>
        <span class="hud-kicker">ROUNDS</span>
      </section>
      <section class="hud-interaction" aria-hidden="true">
        <span class="hud-interaction-binding"></span>
        <i></i>
        <span class="hud-interaction-action"></span>
      </section>
      <p class="hud-live" role="status" aria-live="polite" aria-atomic="true"></p>
    `;

    if (this.showDebug) {
      const debug = document.createElement('aside');
      debug.className = 'hud-debug';
      debug.dataset.hudDebug = '';
      debug.setAttribute('aria-hidden', 'true');
      debug.innerHTML = `
        <span class="hud-debug-heading">FRAME / P95</span>
        <span>GPU <b data-debug-gpu>—</b></span>
        <span>CPU <b data-debug-cpu>—</b></span>
        <span>PAIR <b data-debug-paired>—</b></span>
        <span>DRAW <b data-debug-draws>—</b></span>
        <strong data-debug-budget>overBudget UNVERIFIED</strong>
      `;
      root.append(debug);
      this.debugElements = {
        root: debug,
        gpu: required(debug, '[data-debug-gpu]'),
        cpu: required(debug, '[data-debug-cpu]'),
        paired: required(debug, '[data-debug-paired]'),
        draws: required(debug, '[data-debug-draws]'),
        budget: required(debug, '[data-debug-budget]'),
      };
    }

    parent.append(root);
    this.root = root;
    const live = required(root, '.hud-live');
    const liveText = document.createTextNode('');
    live.append(liveText);
    this.elements = {
      ammo: required(root, '.hud-ammo-value'),
      reserve: required(root, '.hud-reserve-value'),
      reload: required(root, '.hud-reload-state'),
      health: required(root, '.hud-health-value'),
      objective: required(root, '.hud-objective'),
      objectiveTitle: required(root, '.hud-objective-title'),
      objectiveDetail: required(root, '.hud-objective-detail'),
      interaction: required(root, '.hud-interaction'),
      interactionBinding: required(root, '.hud-interaction-binding'),
      interactionAction: required(root, '.hud-interaction-action'),
      damage: required(root, '.hud-damage'),
      hit: required(root, '.hud-hit'),
      elimination: required(root, '.hud-elimination'),
      eliminationLabel: required(root, '.hud-elimination-label'),
      live,
      liveText,
    };
  }

  private subscribe(bus: EventBus): void {
    this.subscriptions.push(
      bus.on<WeaponHudStatus>(HudEvents.WeaponStatus, (payload) => {
        if (payload) this.setWeaponStatus(payload);
      }),
      bus.on<PlayerHudStatus>(HudEvents.PlayerStatus, (payload) => {
        if (payload) this.setPlayerStatus(payload);
      }),
      bus.on<DamageHudEvent>(Events.Damage, (payload) => {
        if (payload?.id === this.options.playerId) this.receiveDamage(payload);
      }),
      bus.on(Events.ReloadStart, () => {
        this.setWeaponStatus({ reloading: true });
        this.announce('Reloading');
      }),
      bus.on(Events.ReloadEnd, () => {
        this.setWeaponStatus({ reloading: false });
        this.announce('Reload complete');
      }),
      bus.on<{ aiming: boolean; t?: number }>(Events.AimChanged, (payload) => {
        if (!payload) return;
        this.setWeaponStatus({
          aim: clamp(finiteOr(payload.t, payload.aiming ? 1 : 0), 0, 1),
        });
      }),
      bus.on<HitConfirmedEvent>(HudEvents.HitConfirmed, (payload) => {
        this.confirmHit(payload ?? {});
      }),
      bus.on<EliminationEvent>(HudEvents.Elimination, (payload) => {
        this.confirmElimination(payload ?? {});
      }),
      bus.on<ObjectiveHudStatus | null>(HudEvents.ObjectiveChanged, (payload) => {
        this.setObjective(payload ?? null);
      }),
      bus.on<InteractionHudStatus | null>(HudEvents.InteractionChanged, (payload) => {
        this.setInteraction(payload ?? null);
      }),
    );
  }

  private receiveDamage(payload: DamageHudEvent): void {
    const maxHealth = Math.max(1, finiteOr(payload.maxHealth, this.state.maxHealth));
    const amount = Math.max(0, finiteOr(payload.amount, 0));
    const health = payload.health === undefined
      ? clamp(this.state.health - amount, 0, maxHealth)
      : clamp(finiteOr(payload.health, this.state.health), 0, maxHealth);
    this.state.health = health;
    this.state.maxHealth = maxHealth;

    if (
      Number.isFinite(payload.direction.x)
      && Number.isFinite(payload.direction.y)
      && Number.isFinite(payload.direction.z)
    ) {
      if (this.camera) {
        this.camera.updateMatrixWorld();
        this.camera.getWorldQuaternion(this.cameraWorldQuaternion);
      } else {
        this.cameraWorldQuaternion.identity();
      }
      const mapped = mapWorldDamageDirection(payload.direction, this.cameraWorldQuaternion);
      this.state.damageAngleDeg = mapped.angleDeg;
      this.state.damageQuadrant = mapped.quadrant;
      this.state.damageUntil = performance.now() + DAMAGE_DURATION_MS;
    }

    this.announce(payload.lethal ? 'Health depleted' : `Health ${Math.round(health)}`);
    this.markDirty(DIRTY.HEALTH | DIRTY.DAMAGE);
  }

  private announce(message: string): void {
    if (!message) return;
    this.announcementQueue.push(message);
    this.markDirty(DIRTY.ACCESSIBILITY);
  }

  private markDirty(mask: number): void {
    this.dirty |= mask;
  }

  private present = (now: number): void => {
    this.rafId = requestAnimationFrame(this.present);
    const elements = this.elements;
    const root = this.root;
    if (!elements || !root) return;

    const damageActive = now < this.state.damageUntil;
    const hitActive = now < this.state.hitUntil;
    const eliminationActive = now < this.state.eliminationUntil;
    if (damageActive !== this.renderedDamageActive) this.dirty |= DIRTY.DAMAGE;
    if (hitActive !== this.renderedHitActive) this.dirty |= DIRTY.HIT;
    if (eliminationActive !== this.renderedEliminationActive) {
      this.dirty |= DIRTY.ELIMINATION;
    }

    const dirty = this.dirty;
    this.dirty = 0;
    if (dirty & DIRTY.RETICLE) this.renderReticle(root);
    if (dirty & DIRTY.AMMO) this.renderAmmo(root, elements);
    if (dirty & DIRTY.HEALTH) this.renderHealth(root, elements);
    if (dirty & DIRTY.OBJECTIVE) this.renderObjective(elements);
    if (dirty & DIRTY.INTERACTION) this.renderInteraction(elements);
    if (dirty & DIRTY.DAMAGE) {
      this.renderedDamageActive = damageActive;
      elements.damage.classList.toggle('is-visible', damageActive);
      elements.damage.style.setProperty(
        '--damage-angle',
        `${this.state.damageAngleDeg.toFixed(2)}deg`,
      );
      elements.damage.dataset.quadrant = this.state.damageQuadrant;
    }
    if (dirty & DIRTY.HIT) {
      this.renderedHitActive = hitActive;
      elements.hit.classList.toggle('is-visible', hitActive);
      elements.hit.classList.toggle('is-lethal', this.state.hitLethal);
    }
    if (dirty & DIRTY.ELIMINATION) {
      this.renderedEliminationActive = eliminationActive;
      elements.elimination.classList.toggle('is-visible', eliminationActive);
      elements.eliminationLabel.textContent = this.state.eliminationLabel;
    }
    if (dirty & DIRTY.ACCESSIBILITY) {
      const message = this.announcementQueue.shift();
      if (message !== undefined) {
        this.announcementSerial++;
        const repeatMarker = this.announcementSerial % 2 === 0 ? '\u2060' : '';
        elements.liveText.data = `${message}${repeatMarker}`;
        elements.live.dataset.message = message;
      }
      if (this.announcementQueue.length > 0) this.dirty |= DIRTY.ACCESSIBILITY;
    }

    if (this.debugElements && now - this.lastDebugAt >= DEBUG_REFRESH_MS) {
      this.lastDebugAt = now;
      this.renderDebug(this.debugElements);
    }
  };

  private resetPresentationState(): void {
    this.dirty = DIRTY_ALL;
    this.renderedDamageActive = false;
    this.renderedHitActive = false;
    this.renderedEliminationActive = false;
    this.lastDebugAt = -Infinity;
    this.announcementQueue.length = 0;
    this.announcementSerial = 0;
    this.state.damageUntil = 0;
    this.state.hitUntil = 0;
    this.state.eliminationUntil = 0;
    this.cameraWorldQuaternion.identity();
  }

  private renderReticle(root: HTMLElement): void {
    const precisionGap = 2.5;
    const hipGap = 9 + this.state.spread * 17;
    const gap = precisionGap + (hipGap - precisionGap) * (1 - this.state.aim);
    root.style.setProperty('--reticle-gap', `${gap.toFixed(2)}px`);
    root.style.setProperty('--reticle-gap-negative', `${(-gap).toFixed(2)}px`);
    root.style.setProperty('--reticle-opacity', this.state.reloading ? '0.56' : '1');
    root.dataset.reticle = this.state.aim >= 0.9
      ? 'ads'
      : this.state.aim <= 0.1 ? 'hip' : 'transition';
  }

  private renderAmmo(root: HTMLElement, elements: HudElements): void {
    elements.ammo.textContent = String(this.state.ammo).padStart(2, '0');
    elements.reserve.textContent = String(this.state.reserve).padStart(2, '0');
    elements.reload.textContent = this.state.reloading ? 'RELOADING' : '';
    root.classList.toggle('is-reloading', this.state.reloading);
    root.classList.toggle('is-empty', this.state.ammo === 0);
  }

  private renderHealth(root: HTMLElement, elements: HudElements): void {
    const ratio = clamp(this.state.health / this.state.maxHealth, 0, 1);
    elements.health.textContent = String(Math.round(ratio * 100)).padStart(2, '0');
    root.style.setProperty('--health-ratio', ratio.toFixed(3));
    root.style.setProperty(
      '--danger-opacity',
      ratio <= 0.25 ? ((0.25 - ratio) / 0.25 * 0.44 + 0.08).toFixed(3) : '0',
    );
    root.classList.toggle('is-low-health', ratio <= 0.25);
  }

  private renderObjective(elements: HudElements): void {
    const objective = this.state.objective;
    elements.objective.classList.toggle('is-visible', objective !== null);
    elements.objectiveTitle.textContent = objective?.title ?? '';
    elements.objectiveDetail.textContent = objective?.detail ?? '';
  }

  private renderInteraction(elements: HudElements): void {
    const interaction = this.state.interaction;
    elements.interaction.classList.toggle('is-visible', interaction !== null);
    elements.interactionBinding.textContent = interaction?.binding ?? '';
    elements.interactionAction.textContent = interaction?.action ?? '';
  }

  private renderDebug(elements: DebugElements): void {
    const source = this.options.profiler;
    if (!source) return;

    const snapshot = source.snapshot();
    const gpuP95 = snapshot.gpuFrameMs.p95;
    const cpuP95 = snapshot.cpuFrameMs.p95;
    const pairedP95 = snapshot.budgetFrameMs.p95;
    const draws = source.drawCalls();
    const budgetMs = source.budgetMs ?? 16.7;
    const overBudget = pairedP95 === null ? null : pairedP95 > budgetMs;

    elements.gpu.textContent = formatMs(gpuP95);
    elements.cpu.textContent = formatMs(cpuP95);
    elements.paired.textContent = formatMs(pairedP95);
    elements.draws.textContent = draws === null ? '—' : String(Math.round(draws));
    elements.budget.textContent = overBudget === null
      ? 'overBudget UNVERIFIED'
      : `overBudget ${overBudget ? 'TRUE' : 'FALSE'} · ${budgetMs.toFixed(1)} ms`;
    elements.root.dataset.overBudget = overBudget === null
      ? 'unverified'
      : String(overBudget);
  }
}
