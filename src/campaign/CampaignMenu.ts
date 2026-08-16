import type { CampaignSystem } from './CampaignSystem.js';
import type { MissionId } from './ids.js';
import { productionMissions } from './production.js';
import './campaign-menu.css';

interface MenuCardState {
  readonly id: MissionId;
  readonly status: 'locked' | 'unlocked' | 'current' | 'completed';
  readonly selectable: boolean;
}

export interface CampaignMenuState {
  readonly visible: true;
  readonly coopSelected: boolean;
  readonly completedCount: number;
  readonly missionCount: number;
  readonly cards: readonly MenuCardState[];
}

export function campaignMenuRequired(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.get('play') !== '1' && params.get('campaignFixture') !== '1';
}

/**
 * Mount the campaign menu and intentionally never resolve. Selecting an action
 * performs one navigation into `play=1`; until that unload occurs, boot remains
 * suspended before `Engine` construction.
 */
export function waitForCampaignSelection(campaign: CampaignSystem): Promise<never> {
  const snapshot = campaign.runtime.snapshot();
  const byId = new Map(snapshot.missions.map((mission) => [mission.id, mission]));
  const root = document.createElement('main');
  root.className = 'campaign-menu';
  root.dataset.campaignMenu = '';
  root.setAttribute('aria-label', 'Campaign mission select');

  const progress = snapshot.campaignComplete
    ? 'CAMPAIGN COMPLETE'
    : `${snapshot.completedCount} / ${snapshot.missionCount} OPERATIONS SECURED`;
  const continueMissionId = snapshot.currentMissionId ?? snapshot.finaleMissionId;
  const continueMission = byId.get(continueMissionId);
  const continueLabel = snapshot.campaignComplete
    ? 'RETURN TO FINALE'
    : snapshot.completedCount > 0
      ? 'CONTINUE CAMPAIGN'
      : 'BEGIN CAMPAIGN';

  root.innerHTML = `
    <div class="campaign-menu-backdrop" aria-hidden="true"></div>
    <header class="campaign-menu-header">
      <span class="campaign-menu-eyebrow">OPENRAPPTER // DUSKLINE OPERATIONS</span>
      <h1>CAMPAIGN</h1>
      <p>Choose an operation. Progress is stored on this device.</p>
      <div class="campaign-menu-progress">
        <i style="--progress:${snapshot.completedCount / snapshot.missionCount}"></i>
        <span>${progress}</span>
      </div>
    </header>
    <section class="campaign-menu-cards" aria-label="Campaign missions"></section>
    <footer class="campaign-menu-footer">
      <button class="campaign-menu-continue" data-menu-action="continue" type="button">
        <span>${continueLabel}</span>
        <strong>${continueMission?.title ?? 'CAMPAIGN'}</strong>
      </button>
      <label class="campaign-menu-coop">
        <input type="checkbox" data-menu-action="coop">
        <span><strong>COUCH CO-OP</strong><small>KEYBOARD + GAMEPAD</small></span>
      </label>
      <span class="campaign-menu-hint">SELECT AN UNLOCKED OPERATION · PROGRESS SAVES AUTOMATICALLY</span>
    </footer>
  `;

  const cards = root.querySelector<HTMLElement>('.campaign-menu-cards');
  if (!cards) throw new Error('CampaignMenu template is missing .campaign-menu-cards');
  const cardStates: MenuCardState[] = [];

  for (const definition of productionMissions) {
    const mission = byId.get(definition.id);
    if (!mission) throw new Error(`CampaignMenu mission "${definition.id}" is absent from snapshot`);
    const selectable = mission.status !== 'locked';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `campaign-menu-card mission-${definition.order} is-${mission.status}`;
    button.dataset.missionId = definition.id;
    button.disabled = !selectable;
    button.setAttribute(
      'aria-label',
      `${definition.title}: ${mission.status}${selectable ? '' : ', unavailable'}`,
    );
    button.innerHTML = `
      <span class="campaign-card-number">0${definition.order}</span>
      <span class="campaign-card-status">${statusLabel(mission.status)}</span>
      <span class="campaign-card-art" aria-hidden="true">
        <i></i><i></i><i></i>
      </span>
      <span class="campaign-card-copy">
        <strong>${definition.title}</strong>
        <b>${definition.objective.title}</b>
        <span>${definition.brief}</span>
      </span>
      <span class="campaign-card-action">${selectable ? actionLabel(mission.status) : 'LOCKED'}</span>
    `;
    if (selectable) {
      button.addEventListener('click', () => {
        campaign.runtime.replay(definition.id);
        launch(definition.id);
      }, { once: true });
    }
    cards.append(button);
    cardStates.push({
      id: definition.id,
      status: mission.status,
      selectable,
    });
  }

  const continueButton = root.querySelector<HTMLButtonElement>('[data-menu-action="continue"]');
  if (!continueButton) throw new Error('CampaignMenu template is missing Continue');
  const coopToggle = root.querySelector<HTMLInputElement>('[data-menu-action="coop"]');
  if (!coopToggle) throw new Error('CampaignMenu template is missing Couch Co-op');
  coopToggle.checked = new URLSearchParams(location.search).get('coop') === '1';
  continueButton.addEventListener('click', () => launch(continueMissionId), { once: true });

  const evidence = {
    get state(): CampaignMenuState {
      return {
        visible: true,
        coopSelected: coopToggle.checked,
        completedCount: snapshot.completedCount,
        missionCount: snapshot.missionCount,
        cards: cardStates,
      };
    },
  };
  (window as unknown as Record<string, unknown>).__CAMPAIGN_MENU__ = evidence;
  document.body.append(root);
  continueButton.focus({ preventScroll: true });

  return new Promise<never>(() => {});
}

function launch(missionId: MissionId): void {
  const params = new URLSearchParams(location.search);
  params.set('mission', missionId);
  params.set('play', '1');
  const coop = document.querySelector<HTMLInputElement>('[data-menu-action="coop"]');
  if (coop?.checked) params.set('coop', '1');
  else params.delete('coop');
  params.delete('campaignFixture');
  history.replaceState(null, '', `${location.pathname}?${params.toString()}${location.hash}`);
  location.reload();
}

function statusLabel(status: MenuCardState['status']): string {
  switch (status) {
    case 'current': return 'CURRENT OPERATION';
    case 'completed': return '\u2713 SECURED';
    case 'unlocked': return 'AVAILABLE';
    case 'locked': return '\u25a3 CLASSIFIED';
  }
}

function actionLabel(status: MenuCardState['status']): string {
  if (status === 'current') return 'DEPLOY';
  return status === 'completed' ? 'REPLAY' : 'SELECT';
}
