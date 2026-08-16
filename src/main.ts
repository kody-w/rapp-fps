/**
 * Boot. Wires the engine, the pipeline and whatever systems are registered.
 *
 * Kept deliberately thin: everything interesting belongs to a subsystem, and
 * this file is the one place that knows the order they are added in.
 */

import * as THREE from 'three';
import { Engine } from './core/engine.js';
import { RenderSystem } from './render/RenderSystem.js';
import {
  ArenaLevel,
  buildStaticWorld,
} from './level/index.js';
import { CombatFX } from './fx/CombatFX.js';
import { AudioSystem } from './audio/AudioSystem.js';
import { CombatHud } from './hud/CombatHud.js';
import { createPlayer } from './player/index.js';
import { mountTouchControls } from './input/TouchControls.js';
import { WeaponSystem } from './weapons/index.js';
import { AiSystem } from './ai/AiSystem.js';
import {
  CombatSystem,
  createAiArenaBinding,
} from './game/index.js';
import { CampaignSystem } from './campaign/CampaignSystem.js';
import { DEFAULT_ENEMY_CONFIG } from './ai/config.js';
import { lineOfSightClear } from './ai/world.js';
import { createPlayerWithInput } from './player/index.js';
import type { CoopCombatSystem } from './coop/CoopCombatSystem.js';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const engine = new Engine(canvas);
const query = new URLSearchParams(location.search);
const coopFixture = query.get('coopFixture') === '1';
const coopEnabled = coopFixture || query.get('coop') === '1';
const coopRuntime = coopEnabled
  ? await import('./coop/index.js')
  : null;

const render = new RenderSystem();
const campaign = CampaignSystem.create({
  store: window.localStorage,
  location: {
    getSearch: () => location.search,
    setSearch: (next) => {
      history.replaceState(null, '', `${location.pathname}${next}${location.hash}`);
    },
    reload: () => location.reload(),
  },
});
const arenaDefinition = campaign.definition;
const staticWorld = buildStaticWorld(arenaDefinition);
const level = new ArenaLevel(arenaDefinition, staticWorld);
const playerSpawn = new THREE.Vector3(...campaign.spawn.position);
const player2Spawn = new THREE.Vector3(...campaign.activeMission.playerSpawns[1].position);
const camera2 = coopEnabled
  ? new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.05, 2000)
  : null;
if (camera2) camera2.rotation.order = 'YXZ';

const coopSession = coopEnabled
  ? new coopRuntime!.CoopSessionSystem({
    enabled: true,
    fixture: coopFixture,
    player2Spawn,
    renderer: engine.renderer,
    campaign,
  })
  : null;
let coopCombat: CoopCombatSystem | null = null;
const { input, system: player } = createPlayer(canvas, {
  world: staticWorld,
  spawn: playerSpawn,
  initialYaw: campaign.spawn.yaw,
  ...(coopEnabled
    ? {
      name: 'player-1',
      camera: engine.camera,
      activeProvider: () => coopCombat?.isAlive('player-1') ?? true,
    }
    : {}),
});
engine.input = input;
const player2 = coopSession && camera2
  ? createPlayerWithInput(coopSession.player2Input, {
    world: staticWorld,
    spawn: player2Spawn,
    initialYaw: campaign.activeMission.playerSpawns[1].yaw,
    name: 'player-2',
    camera: camera2,
    activeProvider: () => (
      coopSession.isPlayer2Active
      && (coopCombat?.isAlive('player-2') ?? true)
    ),
  })
  : null;

if (coopEnabled && camera2) {
  engine.camera.layers.enable(1);
  camera2.layers.enable(2);
}

// On phones/tablets pointer lock is unavailable, so an on-screen overlay feeds
// the same `input` object: bottom-left joystick → move, bottom-right button →
// fire, drag elsewhere → look. No-ops (returns null) on desktop.
const touchControls = mountTouchControls(input);
const gestureBinding = touchControls ? 'TAP' : 'CLICK';

const playerEye = new THREE.Vector3();
const playerFeet = new THREE.Vector3();
const player2Eye = new THREE.Vector3();
const player2Feet = new THREE.Vector3();
const combat = coopEnabled && player2
  ? new coopRuntime!.CoopCombatSystem({
    world: staticWorld,
    players: [
      {
        id: 'player-1',
        eyeProvider: () => player.copyEyePosition(playerEye) ? playerEye : null,
      },
      {
        id: 'player-2',
        eyeProvider: () => player2.copyEyePosition(player2Eye) ? player2Eye : null,
      },
    ],
  })
  : new CombatSystem({
    world: staticWorld,
    playerEyeProvider: (ctx) => (
      player.copyEyePosition(playerEye) ? playerEye : ctx.camera.position
    ),
  });
const aiBinding = createAiArenaBinding(arenaDefinition, staticWorld);
let ai: AiSystem;
ai = new AiSystem({
  arena: aiBinding.arena,
  spawn: aiBinding.spawn,
  yaw: aiBinding.yaw,
  renderWorld: false,
  renderMarkers: false,
  renderGaze: false,
  combatSink: combat.enemySink,
  playerProvider: () => {
    if (coopCombat && player2 && coopSession) {
      const enemy = new THREE.Vector3();
      ai.copyPosition(enemy);
      const candidates = [
        {
          id: 'player-1',
          hasFeet: player.copyFeetPosition(playerFeet),
          feet: playerFeet,
          alive: coopCombat.isAlive('player-1'),
          active: true,
        },
        {
          id: 'player-2',
          hasFeet: player2.copyFeetPosition(player2Feet),
          feet: player2Feet,
          alive: coopCombat.isAlive('player-2'),
          active: coopSession.isPlayer2Active,
        },
      ].filter((candidate) => candidate.hasFeet && candidate.alive && candidate.active);
      if (candidates.length === 0) return null;
      const from = {
        x: enemy.x,
        y: enemy.y + DEFAULT_ENEMY_CONFIG.eyeHeight,
        z: enemy.z,
      };
      const visible = candidates.filter((candidate) => lineOfSightClear(
        aiBinding.arena.world,
        from,
        {
          x: candidate.feet.x,
          y: candidate.feet.y + DEFAULT_ENEMY_CONFIG.targetSampleHeight,
          z: candidate.feet.z,
        },
      ));
      const pool = visible.length > 0 ? visible : candidates;
      pool.sort((a, b) => (
        enemy.distanceToSquared(a.feet) - enemy.distanceToSquared(b.feet)
      ));
      const target = pool[0];
      return {
        id: target.id,
        position: {
          x: target.feet.x,
          y: target.feet.y,
          z: target.feet.z,
        },
        alive: true,
      };
    }
    const hasFeet = player.copyFeetPosition(playerFeet);
    return {
      position: hasFeet
        ? { x: playerFeet.x, y: playerFeet.y, z: playerFeet.z }
        : {
          x: arenaDefinition.playerSpawn[0],
          y: arenaDefinition.playerSpawn[1],
          z: arenaDefinition.playerSpawn[2],
        },
      alive: combat instanceof CombatSystem ? combat.isPlayerAlive : false,
    };
  },
});
combat.bindEnemy(ai);
coopCombat = combat instanceof CombatSystem ? null : combat;
const weapon = coopEnabled
  ? new WeaponSystem({
    name: 'weapon-1',
    ownerId: 'player-1',
    input,
    camera: engine.camera,
    viewLayer: 1,
    activeProvider: () => coopCombat?.isAlive('player-1') ?? true,
  })
  : new WeaponSystem();
weapon.useStaticWorld(staticWorld);
const weapon2 = coopSession && camera2
  ? new WeaponSystem({
    name: 'weapon-2',
    ownerId: 'player-2',
    input: coopSession.player2Input,
    camera: camera2,
    viewLayer: 2,
    activeProvider: () => (
      coopSession.isPlayer2Active
      && (coopCombat?.isAlive('player-2') ?? true)
    ),
  })
  : null;
weapon2?.useStaticWorld(staticWorld);

const fx = new CombatFX();
const audio = new AudioSystem();
const hudParents = coopEnabled ? createCoopHudParents() : null;
const hud = new CombatHud({
  playerId: coopEnabled ? 'player-1' : 'player',
  ...(coopEnabled
    ? {
      name: 'hud-1',
      parent: hudParents!.top,
      className: 'coop-hud coop-primary',
    }
    : {}),
  profiler: {
    snapshot: () => engine.profiler.snapshot(),
    drawCalls: () => {
      const stats = (window as unknown as {
        __SCENE_STATS__?: { drawCallsPerFrame?: number };
      }).__SCENE_STATS__;
      return stats?.drawCallsPerFrame ?? null;
    },
  },
});
const hud2 = coopEnabled && hudParents
  ? new CombatHud({
    playerId: 'player-2',
    name: 'hud-2',
    parent: hudParents.bottom,
    className: 'coop-hud coop-secondary',
  })
  : null;
const avatars = coopEnabled && player2 && coopCombat && coopSession
  ? new coopRuntime!.CoopAvatarSystem([
    {
      player,
      visibleToLayer: 2,
      active: () => true,
      alive: () => coopCombat!.isAlive('player-1'),
      color: 0x3b7f9d,
    },
    {
      player: player2,
      visibleToLayer: 1,
      active: () => coopSession.isPlayer2Active,
      alive: () => coopCombat!.isAlive('player-2'),
      color: 0xb6843f,
    },
  ])
  : null;

// Development-only mutation seam for the integration verifier. Production
// builds always register all three; Vite folds `import.meta.env.DEV` to false.
const integrationOmit = import.meta.env.DEV
  ? new URLSearchParams(location.search).get('integrationOmit')
  : null;
const enabled = (name: 'fx' | 'audio' | 'hud'): boolean => integrationOmit !== name;

engine.add(render);
engine.add(level);
if (coopSession) engine.add(coopSession);
engine.add(player);
if (player2) engine.add(player2);
if (enabled('fx')) engine.add(fx);
if (enabled('audio')) engine.add(audio);
if (enabled('hud')) engine.add(hud);
if (enabled('hud') && hud2) engine.add(hud2);
if (avatars) engine.add(avatars);
engine.add(combat);
engine.add(ai);
engine.add(weapon);
if (weapon2) engine.add(weapon2);
engine.add(campaign);

if (coopSession && player2 && weapon2 && coopCombat) {
  coopSession.bindRuntime({
    player1: player,
    player2,
    weapon1: weapon,
    weapon2,
    combat: coopCombat,
  });
}
await engine.init();

// The pipeline owns presentation once it is initialised.
// `renderer.info` resets on every render call, so reading it after the composer
// reports its last fullscreen pass — "1 draw call, 1 triangle" for a twenty-mesh
// scene, a plausible number that means nothing. Disabling autoReset makes the
// counters accumulate across every pass in the frame, which is the honest total
// cost of presenting one frame, and we reset it ourselves at the boundary.
engine.renderer.info.autoReset = false;
const coopRenderer = coopEnabled ? new coopRuntime!.CoopRenderCoordinator() : null;
engine.present = () => {
  const info = engine.renderer.info;
  info.reset();
  const split = Boolean(
    coopRenderer
    && coopSession?.isPlayer2Active
    && player2
    && camera2
    && weapon2,
  );
  updateCoopHudLayout(hudParents, split);
  player.applyViewEffects();
  if (split) player2!.applyViewEffects();
  try {
    if (split) {
      const result = coopRenderer!.renderCoop(
        coopSession!.renderPlan,
        engine.scene,
        [engine.camera, camera2!],
        engine.renderer,
        {
          prepareSlot: (index) => {
            if (index === 0) weapon.reapplyViewProjection();
            else weapon2!.reapplyViewProjection();
          },
        },
      );
      if (!result.rendered) throw new Error(`co-op render refused: ${result.reason}`);
    } else {
      render.render();
    }
  } finally {
    if (split) player2!.restoreView();
    player.restoreView();
  }
  (window as unknown as Record<string, unknown>).__SCENE_STATS__ = {
    // Totals for the WHOLE frame, scene plus post. Labelled as such so nobody
    // compares it against a scene-only figure from another engine.
    drawCallsPerFrame: info.render.calls,
    trianglesPerFrame: info.render.triangles,
    textures: info.memory.textures,
    geometries: info.memory.geometries,
    programs: info.programs?.length ?? 0,
  };
};

engine.start();

// Web Audio may only start from a real user gesture. Keep the listeners until
// arming actually succeeds; reattach them if the context later becomes
// suspended/interrupted. The whole composition is gated when audio is omitted
// by the integration mutation, not only its engine registration.
let audioArmListenersAttached = false;
const removeAudioArmListeners = (): void => {
  if (!audioArmListenersAttached) return;
  removeEventListener('pointerdown', armAudio);
  removeEventListener('keydown', armAudio);
  audioArmListenersAttached = false;
};
const addAudioArmListeners = (): void => {
  if (audioArmListenersAttached || !enabled('audio')) return;
  addEventListener('pointerdown', armAudio);
  addEventListener('keydown', armAudio);
  audioArmListenersAttached = true;
};
const armAudio = (): void => {
  if (!enabled('audio')) return;
  void audio.arm().then((armed) => {
    document.documentElement.dataset.audio = audio.status.state;
    if (armed) {
      coopSession?.closeCheckpoint();
      if (enabled('hud')) hud.setInteraction(null);
      removeAudioArmListeners();
    }
  });
};

let unsubscribeAudioStatus = (): void => {};
if (enabled('audio')) {
  if (enabled('hud')) hud.setInteraction({ action: 'DEPLOY', binding: gestureBinding });
  addAudioArmListeners();
  unsubscribeAudioStatus = audio.subscribeStatus((status) => {
    document.documentElement.dataset.audio = status.state;
    if (status.state === 'armed') {
      removeAudioArmListeners();
      if (enabled('hud')) hud.setInteraction(null);
      return;
    }
    if (
      status.state === 'unarmed'
      || status.state === 'suspended'
      || status.state === 'interrupted'
    ) {
      addAudioArmListeners();
      if (enabled('hud')) {
        hud.setInteraction({
          action: status.state === 'unarmed' ? 'DEPLOY' : 'RESUME',
          binding: gestureBinding,
        });
      }
      return;
    }
    if (status.state === 'unavailable' || status.state === 'closed') {
      removeAudioArmListeners();
      if (enabled('hud')) hud.setInteraction({ action: 'AUDIO UNAVAILABLE', binding: '' });
    }
  });
} else {
  document.documentElement.dataset.audio = 'omitted';
}

// Clear semantic input edges after every engine frame, once all systems have
// had a chance to observe them.
let clearInputRaf = 0;
const clearInput = () => {
  input.endFrame();
  clearInputRaf = requestAnimationFrame(clearInput);
};
clearInputRaf = requestAnimationFrame(clearInput);

// A screenshot harness needs to know the first real frame has been presented,
// not merely that the page loaded — otherwise it captures an empty buffer and
// a critic reviews a black rectangle.
let framesSeen = 0;
let readyRaf = 0;
const markReady = () => {
  if (++framesSeen >= 12) {
    (window as unknown as { __FRAME_READY__: boolean }).__FRAME_READY__ = true;
    readyRaf = 0;
    return;
  }
  readyRaf = requestAnimationFrame(markReady);
};
readyRaf = requestAnimationFrame(markReady);

let disposed = false;
const disposeApp = (): void => {
  if (disposed) return;
  disposed = true;
  removeAudioArmListeners();
  unsubscribeAudioStatus();
  if (clearInputRaf) cancelAnimationFrame(clearInputRaf);
  if (readyRaf) cancelAnimationFrame(readyRaf);
  touchControls?.dispose();
  engine.dispose();
  hudParents?.root.remove();
};

const gameplay = {
  get state() {
    return {
      worldBoxes: staticWorld.boxes.length,
      playerHealth: combat instanceof CombatSystem
        ? combat.currentPlayerHealth
        : combat.getPlayer('player-1').health,
      player2Health: coopCombat
        ? coopCombat.getPlayer('player-2').health
        : null,
      enemyHealth: ai.currentHealth,
      enemyState: ai.state,
      weaponAmmo: weapon.magazineAmmo,
      weaponReserve: weapon.reserveAmmo,
      missionId: campaign.stateEvidence.missionId,
      campaignStatus: campaign.stateEvidence.status,
    };
  },
};

Object.assign(window as unknown as Record<string, unknown>, {
  engine,
  THREE,
  __INTEGRATION__: {
    fx,
    audio,
    hud,
    hud2,
    player,
    player2,
    ai,
    combat,
    coopSession,
    campaign,
    gameplay,
    dispose: disposeApp,
  },
});

addEventListener('pagehide', (event) => {
  // A persisted pagehide enters BFCache. Disposing here returns a dead app on
  // pageshow; the browser freezes/resumes the existing object graph for us.
  if (!event.persisted) disposeApp();
});

interface CoopHudParents {
  readonly root: HTMLDivElement;
  readonly top: HTMLDivElement;
  readonly bottom: HTMLDivElement;
}

function createCoopHudParents(): CoopHudParents {
  const root = document.createElement('div');
  root.dataset.coopHudRoot = '';
  Object.assign(root.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '20',
    pointerEvents: 'none',
  });
  const top = document.createElement('div');
  const bottom = document.createElement('div');
  for (const element of [top, bottom]) {
    Object.assign(element.style, {
      position: 'absolute',
      left: '0',
      right: '0',
      overflow: 'hidden',
    });
    root.append(element);
  }
  document.body.append(root);
  updateCoopHudLayout({ root, top, bottom }, true);
  return { root, top, bottom };
}

function updateCoopHudLayout(
  parents: CoopHudParents | null,
  split: boolean,
): void {
  if (!parents) return;
  if (split) {
    Object.assign(parents.top.style, { top: '0', bottom: '50%' });
    Object.assign(parents.bottom.style, {
      display: 'block',
      top: '50%',
      bottom: '0',
    });
  } else {
    Object.assign(parents.top.style, { top: '0', bottom: '0' });
    parents.bottom.style.display = 'none';
  }
}
