/**
 * Persistence — schema-versioned, refusal-first, injectable.
 *
 * A save is never trusted. `parseCampaignSave` is the one gate every read passes
 * through, and it returns an *explicit* status rather than a bare value:
 *
 *  - `absent`        — nothing stored;
 *  - `malformed`     — not JSON, wrong shape, or an impossible field ⇒ refused;
 *  - `stale-version` — schemaVersion newer than this build understands ⇒ refused
 *                      (a downgrade must not silently reinterpret future data);
 *  - `migrated`      — an older but known version, transformed up to current;
 *  - `ok`            — current and well-formed.
 *
 * Refusal returns `null` data, so a corrupt or future save can only ever cause a
 * clean fresh start — it can never forge progress or a completion. Adapters are
 * a thin `KeyValueStore` wrapper: production passes `window.localStorage`
 * (structurally a `KeyValueStore`); tests pass `MemoryKeyValueStore` and can seed
 * arbitrary raw strings to exercise every refusal path. Nothing here touches a
 * global at import time, so the module loads safely in Node.
 */

import type { CampaignProgressState, MissionStatus } from './progress.js';

/** Current on-disk schema. Bump when the persisted shape changes. */
export const CAMPAIGN_SCHEMA_VERSION = 2;

/** Default localStorage key; a parent may override it. */
export const DEFAULT_PERSISTENCE_KEY = 'rapp-fps:campaign:progress';

const VALID_STATUSES: ReadonlySet<string> = new Set<MissionStatus>([
  'locked', 'unlocked', 'current', 'completed',
]);

/** The persisted (unbranded, JSON) form of `CampaignProgressState`. */
export interface PersistedProgress {
  readonly currentMissionId: string | null;
  readonly activeEliminations: number;
  readonly records: Record<string, { readonly status: MissionStatus; readonly bankedEliminations: number }>;
  readonly completedOrder: readonly string[];
  readonly campaignComplete: boolean;
}

export interface CampaignSaveData {
  readonly schemaVersion: number;
  readonly progress: PersistedProgress;
}

export type PersistenceReadStatus = 'ok' | 'absent' | 'malformed' | 'migrated' | 'stale-version';

export interface PersistenceReadResult {
  readonly data: CampaignSaveData | null;
  readonly status: PersistenceReadStatus;
  readonly reason?: string;
}

/** The minimal store an adapter needs; `window.localStorage` satisfies it. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface CampaignPersistenceAdapter {
  /** Read and classify the stored save. Never throws. */
  read(): PersistenceReadResult;
  /** Persist state (always stamped with the current schema version). */
  write(data: CampaignSaveData): void;
  clear(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Structural validation of a current-schema `PersistedProgress`. */
function isValidProgress(value: unknown): value is PersistedProgress {
  if (!isRecord(value)) return false;
  const { currentMissionId, activeEliminations, records, completedOrder, campaignComplete } = value;
  if (!(typeof currentMissionId === 'string' || currentMissionId === null)) return false;
  if (typeof activeEliminations !== 'number' || !Number.isFinite(activeEliminations) || activeEliminations < 0) return false;
  if (typeof campaignComplete !== 'boolean') return false;
  if (!Array.isArray(completedOrder) || !completedOrder.every((id) => typeof id === 'string')) return false;
  if (!isRecord(records)) return false;
  for (const rec of Object.values(records)) {
    if (!isRecord(rec)) return false;
    if (typeof rec.status !== 'string' || !VALID_STATUSES.has(rec.status)) return false;
    if (typeof rec.bankedEliminations !== 'number' || !Number.isFinite(rec.bankedEliminations) || rec.bankedEliminations < 0) return false;
  }
  return true;
}

/**
 * Migrate an older progress blob up to the current schema, or return `null` if
 * the version is not a known ancestor. v1 lacked per-mission checkpoints and the
 * live elimination counter; v2 adds them, defaulted to zero.
 */
function migrateProgress(fromVersion: number, progress: unknown): PersistedProgress | null {
  if (fromVersion === 1) {
    if (!isRecord(progress) || !isRecord(progress.records)) return null;
    const records: PersistedProgress['records'] = {};
    for (const [id, rec] of Object.entries(progress.records)) {
      if (!isRecord(rec) || typeof rec.status !== 'string' || !VALID_STATUSES.has(rec.status)) return null;
      records[id] = { status: rec.status as MissionStatus, bankedEliminations: 0 };
    }
    const currentMissionId = typeof progress.currentMissionId === 'string' || progress.currentMissionId === null
      ? (progress.currentMissionId as string | null)
      : null;
    const completedOrder = Array.isArray(progress.completedOrder)
      ? progress.completedOrder.filter((v): v is string => typeof v === 'string')
      : [];
    return {
      currentMissionId,
      activeEliminations: 0,
      records,
      completedOrder,
      campaignComplete: progress.campaignComplete === true,
    };
  }
  return null;
}

/** The single trusted read gate. Pure; classifies raw storage content. */
export function parseCampaignSave(raw: string | null): PersistenceReadResult {
  if (raw === null || raw === undefined) return { data: null, status: 'absent' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { data: null, status: 'malformed', reason: 'stored value is not valid JSON' };
  }
  if (!isRecord(parsed)) {
    return { data: null, status: 'malformed', reason: 'stored value is not an object' };
  }
  const version = parsed.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    return { data: null, status: 'malformed', reason: 'missing/invalid schemaVersion' };
  }
  if (version > CAMPAIGN_SCHEMA_VERSION) {
    return {
      data: null,
      status: 'stale-version',
      reason: `save schemaVersion ${version} is newer than supported ${CAMPAIGN_SCHEMA_VERSION}`,
    };
  }

  if (version < CAMPAIGN_SCHEMA_VERSION) {
    const migrated = migrateProgress(version, parsed.progress);
    if (!migrated || !isValidProgress(migrated)) {
      return { data: null, status: 'malformed', reason: `no valid migration path from schemaVersion ${version}` };
    }
    return { data: { schemaVersion: CAMPAIGN_SCHEMA_VERSION, progress: migrated }, status: 'migrated' };
  }

  if (!isValidProgress(parsed.progress)) {
    return { data: null, status: 'malformed', reason: 'progress payload failed shape validation' };
  }
  return { data: { schemaVersion: CAMPAIGN_SCHEMA_VERSION, progress: parsed.progress }, status: 'ok' };
}

/** Project live state into a current-schema save blob. */
export function toSaveData(state: CampaignProgressState): CampaignSaveData {
  const records: PersistedProgress['records'] = {};
  for (const [id, rec] of Object.entries(state.records)) {
    records[id] = { status: rec.status, bankedEliminations: rec.bankedEliminations };
  }
  return {
    schemaVersion: CAMPAIGN_SCHEMA_VERSION,
    progress: {
      currentMissionId: state.currentMissionId,
      activeEliminations: state.activeEliminations,
      records,
      completedOrder: [...state.completedOrder],
      campaignComplete: state.campaignComplete,
    },
  };
}

/** An in-memory `KeyValueStore` for tests and headless runs. */
export class MemoryKeyValueStore implements KeyValueStore {
  private readonly map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }
}

/** Wrap any `KeyValueStore` (including `window.localStorage`) as an adapter. */
export function createLocalStoragePersistence(
  store: KeyValueStore,
  key: string = DEFAULT_PERSISTENCE_KEY,
): CampaignPersistenceAdapter {
  return {
    read: () => parseCampaignSave(store.getItem(key)),
    write: (data) => {
      store.setItem(key, JSON.stringify({ schemaVersion: CAMPAIGN_SCHEMA_VERSION, progress: data.progress }));
    },
    clear: () => store.removeItem(key),
  };
}

/**
 * Convenience in-memory adapter for tests. Returns both the adapter and the
 * backing store so a test can seed arbitrary raw content (malformed, an old
 * version, a future version) and exercise every refusal path.
 */
export function createInMemoryPersistence(
  key: string = DEFAULT_PERSISTENCE_KEY,
): { adapter: CampaignPersistenceAdapter; store: MemoryKeyValueStore } {
  const store = new MemoryKeyValueStore();
  return { adapter: createLocalStoragePersistence(store, key), store };
}
