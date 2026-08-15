import {
  Events,
  type DamagePayload,
  type EliminationPayload,
  type EngineContext,
  type EventBus,
  type System,
} from '../core/contracts.js';
import type { ArenaDefinition } from '../level/arena.js';
import {
  CampaignRuntime,
  createInMemoryPersistence,
  createLocalStoragePersistence,
  createQueryNavigation,
  InMemoryNavigation,
  type CampaignEvent,
  type KeyValueStore,
  type LocationSeam,
  type MissionDefinition,
  type MissionId,
  type NavigationAdapter,
  type SpawnSlot,
} from './index.js';
import { createProductionCampaignCatalog } from './production.js';

export interface CampaignSystemOptions {
  readonly store: KeyValueStore;
  readonly location: LocationSeam;
}

export interface CampaignStateEvidence {
  readonly missionId: MissionId;
  readonly missionIndex: number;
  readonly missionCount: number;
  readonly furthestUnlockedIndex: number;
  readonly status: 'active' | 'complete';
  readonly fixture: boolean;
  readonly hydration: string;
  readonly message?: string;
}

export interface CampaignMissionEvidence {
  readonly id: MissionId;
  readonly title: string;
  readonly objective: MissionDefinition['objective'];
  readonly playerSpawns: MissionDefinition['playerSpawns'];
  readonly enemyCoverIds: readonly string[];
}

type EliminationWithId = EliminationPayload & {
  readonly id?: string | number;
};

export class CampaignSystem implements System {
  readonly name = 'campaign';
  readonly runtime: CampaignRuntime;
  readonly activeMission: MissionDefinition;
  readonly definition: ArenaDefinition;
  readonly spawn: SpawnSlot;
  readonly fixtureMode: boolean;

  private readonly navigation: NavigationAdapter;
  private readonly pendingEvents: CampaignEvent[];
  private readonly unsubscribers: Array<() => void> = [];
  private ctx: EngineContext | null = null;
  private transitioning = false;
  private transitionTimer: ReturnType<typeof setTimeout> | null = null;
  private evidenceHandle: {
    readonly state: CampaignStateEvidence;
    readonly mission: CampaignMissionEvidence;
  } | null = null;

  private constructor(
    runtime: CampaignRuntime,
    activeMission: MissionDefinition,
    definition: ArenaDefinition,
    fixtureMode: boolean,
    navigation: NavigationAdapter,
    pendingEvents: CampaignEvent[],
  ) {
    this.runtime = runtime;
    this.activeMission = activeMission;
    this.definition = definition;
    this.spawn = activeMission.playerSpawns[0];
    this.fixtureMode = fixtureMode;
    this.navigation = navigation;
    this.pendingEvents = pendingEvents;
  }

  static create(options: CampaignSystemOptions): CampaignSystem {
    const catalog = createProductionCampaignCatalog();
    const params = new URLSearchParams(options.location.getSearch());
    const requested = params.get('mission');
    const fixtureMission = params.get('campaignFixture') === '1' && requested
      ? catalog.byId(requested)
      : undefined;
    const fixtureMode = fixtureMission !== undefined;
    const navigation = createQueryNavigation(options.location);
    const runtimeNavigation = fixtureMode
      ? new InMemoryNavigation()
      : navigation;
    const persistence = fixtureMode
      ? createInMemoryPersistence().adapter
      : createLocalStoragePersistence(options.store);
    const pendingEvents: CampaignEvent[] = [];
    let instance: CampaignSystem | null = null;
    const runtime = CampaignRuntime.create({
      catalog,
      persistence,
      navigation: runtimeNavigation,
      emit: (event) => {
        if (instance) instance.forwardCampaignEvent(event);
        else pendingEvents.push(event);
      },
    });
    const snapshot = runtime.snapshot();
    const activeMissionId = fixtureMission?.id
      ?? snapshot.currentMissionId
      ?? snapshot.finaleMissionId;
    const activeMission = catalog.byId(activeMissionId);
    if (!activeMission) {
      throw new Error(`campaign active mission "${activeMissionId}" is absent`);
    }
    instance = new CampaignSystem(
      runtime,
      activeMission,
      catalog.arenaFor(activeMission.id),
      fixtureMode,
      navigation,
      pendingEvents,
    );
    return instance;
  }

  get stateEvidence(): CampaignStateEvidence {
    const snapshot = this.runtime.snapshot();
    return {
      missionId: this.activeMission.id,
      missionIndex: this.activeMission.order - 1,
      missionCount: snapshot.missionCount,
      furthestUnlockedIndex: snapshot.furthestUnlockedIndex,
      status: snapshot.campaignComplete ? 'complete' : 'active',
      fixture: this.fixtureMode,
      hydration: this.runtime.hydration.status,
      ...(snapshot.campaignComplete ? { message: 'CAMPAIGN COMPLETE' } : {}),
    };
  }

  get missionEvidence(): CampaignMissionEvidence {
    return {
      id: this.activeMission.id,
      title: this.activeMission.title,
      objective: this.activeMission.objective,
      playerSpawns: this.activeMission.playerSpawns,
      enemyCoverIds: this.activeMission.enemies.flatMap((enemy) => enemy.coverSolidIds),
    };
  }

  init(ctx: EngineContext): void {
    this.ctx = ctx;
    this.installEvidence();
    for (const event of this.pendingEvents.splice(0)) {
      this.forwardCampaignEvent(event);
    }
    this.unsubscribers.push(
      ctx.bus.on<EliminationWithId>(Events.Elimination, () => this.handleElimination()),
      ctx.bus.on<DamagePayload>(Events.Damage, (damage) => {
        if (damage?.id === 'player' && damage.lethal) this.handlePlayerDeath();
      }),
    );
    if (this.runtime.snapshot().campaignComplete) this.publishCampaignComplete(ctx.bus);
    else this.publishActiveObjective(ctx.bus);
  }

  dispose(): void {
    if (this.transitionTimer !== null) {
      clearTimeout(this.transitionTimer);
      this.transitionTimer = null;
    }
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
    this.ctx = null;
    if (typeof window !== 'undefined') {
      const global = window as unknown as Record<string, unknown>;
      if (global.__CAMPAIGN__ === this.evidenceHandle) delete global.__CAMPAIGN__;
    }
    this.evidenceHandle = null;
  }

  private handleElimination(): void {
    const ctx = this.ctx;
    if (!ctx || this.transitioning) return;
    if (this.runtime.snapshot().campaignComplete) {
      this.publishCampaignComplete(ctx.bus);
      return;
    }
    if (this.fixtureMode) {
      ctx.bus.emit(Events.ObjectiveChanged, {
        title: 'MISSION COMPLETE',
        detail: `${this.activeMission.title} fixture complete. Progress was not persisted.`,
      });
      return;
    }

    this.transitioning = true;
    this.runtime.reportElimination();
    const snapshot = this.runtime.snapshot();
    if (snapshot.campaignComplete) {
      this.transitioning = false;
      this.publishCampaignComplete(ctx.bus);
      return;
    }

    const nextMissionId = snapshot.currentMissionId;
    if (!nextMissionId) {
      throw new Error('campaign advanced without a next mission or completion');
    }
    const next = snapshot.missions.find((mission) => mission.id === nextMissionId);
    ctx.bus.emit(Events.ObjectiveChanged, {
      title: 'MISSION COMPLETE',
      detail: next ? `Next operation: ${next.title}` : 'Loading the next operation.',
    });
    this.scheduleReload(nextMissionId, 900);
  }

  private handlePlayerDeath(): void {
    const ctx = this.ctx;
    if (!ctx || this.transitioning) return;
    if (this.runtime.snapshot().campaignComplete) {
      this.transitioning = true;
      this.publishCampaignComplete(ctx.bus);
      this.scheduleReload(this.activeMission.id, 650);
      return;
    }
    this.transitioning = true;
    if (!this.fixtureMode) this.runtime.reportPlayerDeath();
    ctx.bus.emit(Events.ObjectiveChanged, {
      title: 'MISSION FAILED',
      detail: 'Restarting the current checkpoint.',
    });
    this.scheduleReload(this.activeMission.id, 650);
  }

  private scheduleReload(missionId: MissionId, delayMs: number): void {
    this.transitionTimer = setTimeout(() => {
      this.transitionTimer = null;
      this.navigation.requestMission(missionId);
    }, delayMs);
  }

  private publishActiveObjective(bus: EventBus): void {
    bus.emit(Events.ObjectiveChanged, {
      title: this.activeMission.objective.title,
      detail:
        `MISSION ${this.activeMission.order}/3 · ${this.activeMission.title} — `
        + this.activeMission.objective.summary,
    });
  }

  private publishCampaignComplete(bus: EventBus): void {
    bus.emit(Events.ObjectiveChanged, {
      title: 'CAMPAIGN COMPLETE',
      detail: 'Cargo Breach, Relay Blackout, and Foundry Last Light secured.',
    });
  }

  private forwardCampaignEvent(event: CampaignEvent): void {
    this.ctx?.bus.emit(event.type, event);
  }

  private installEvidence(): void {
    if (typeof window === 'undefined') return;
    const self = this;
    const handle = {
      get state(): CampaignStateEvidence {
        return self.stateEvidence;
      },
      get mission(): CampaignMissionEvidence {
        return self.missionEvidence;
      },
    };
    this.evidenceHandle = handle;
    (window as unknown as Record<string, unknown>).__CAMPAIGN__ = handle;
  }
}
