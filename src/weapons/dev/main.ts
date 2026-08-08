import * as THREE from 'three';
import { Engine } from '../../core/engine.js';
import { Events, type EngineContext, type InputState, type System, type UpdateContext } from '../../core/contracts.js';
import { TestLevel } from '../../level/TestLevel.js';
import { RenderSystem } from '../../render/RenderSystem.js';
import { DUSKLINE_A7 } from '../WeaponConfig.js';
import { WeaponSystem } from '../WeaponSystem.js';

interface WeaponProfileTelemetry {
  frames: number;
  flashFrames: number;
  maxDrawCalls: number;
  flashDrawCallsMax: number;
  fired: number;
  impacts: number;
  reloadStarts: number;
  reloadEnds: number;
  shakes: number;
  damageEvents: number;
  startAmmo: number;
}

class HarnessInput implements System {
  readonly name = 'weapon-harness-input';
  readonly state: InputState;

  private readonly held = new Set<string>();
  private readonly edges = new Set<string>();
  private readonly pendingLook = new THREE.Vector2();

  constructor(
    private readonly weapon: WeaponSystem,
    private readonly stress: boolean,
  ) {
    this.state = {
      move: { x: 0, y: 0 },
      look: { x: 0, y: 0 },
      jump: false,
      crouch: false,
      sprint: false,
      fire: false,
      aim: false,
      reload: false,
      pressed: (action: string) => this.edges.has(action),
    };

    addEventListener('keydown', (event) => {
      if (!this.held.has(event.code)) this.edges.add(event.code);
      this.held.add(event.code);
    });
    addEventListener('keyup', (event) => this.held.delete(event.code));
    addEventListener('mousedown', (event) => {
      const code = `Mouse${event.button}`;
      if (!this.held.has(code)) this.edges.add(code);
      this.held.add(code);
      void (document.querySelector('#game') as HTMLCanvasElement).requestPointerLock();
    });
    addEventListener('mouseup', (event) => this.held.delete(`Mouse${event.button}`));
    addEventListener('mousemove', (event) => {
      if (document.pointerLockElement) this.pendingLook.add(new THREE.Vector2(event.movementX, event.movementY));
    });
    addEventListener('contextmenu', (event) => event.preventDefault());
  }

  fixedUpdate(_step: number): void {
    this.state.move.x = Number(this.held.has('KeyD')) - Number(this.held.has('KeyA'));
    this.state.move.y = Number(this.held.has('KeyW')) - Number(this.held.has('KeyS'));
    this.state.jump = this.held.has('Space');
    this.state.crouch = this.held.has('ControlLeft');
    this.state.sprint = this.held.has('ShiftLeft');
    this.state.fire = this.stress || this.held.has('Mouse0');
    this.state.aim = this.stress || this.held.has('Mouse2');
    this.state.reload = this.held.has('KeyR');
  }

  update(_update: UpdateContext, ctx: EngineContext): void {
    const sensitivity = 0.0018 * this.weapon.lookSensitivityScale;
    this.state.look.x = this.pendingLook.x * sensitivity;
    this.state.look.y = this.pendingLook.y * sensitivity;
    ctx.camera.rotation.y -= this.state.look.x;
    ctx.camera.rotation.x = THREE.MathUtils.clamp(
      ctx.camera.rotation.x - this.state.look.y,
      -Math.PI * 0.48,
      Math.PI * 0.48,
    );
    this.pendingLook.set(0, 0);
    this.edges.clear();
  }
}

const query = new URLSearchParams(location.search);
const stressMode = query.get('stress') === '1';
const canvas = document.querySelector('#game') as HTMLCanvasElement;
const engine = new Engine(canvas);
// The profiler stress page must never enter reload during its observation
// window. A harness-only oversized magazine keeps every sample in live fire.
const stressConfig = stressMode
  ? { ...DUSKLINE_A7, magazineSize: 100_000, reserveAmmo: 0 }
  : DUSKLINE_A7;
const weapon = new WeaponSystem(stressConfig);
const input = new HarnessInput(weapon, stressMode);
const render = new RenderSystem();
engine.input = input.state;

// Init/update ordering is intentional: the level establishes the camera, input
// writes base look, weapon adds view presentation, then render owns presentation.
engine.add(new TestLevel());
engine.add(input);
engine.add(weapon);
engine.add(render);
await engine.init();

engine.scene.traverse((object) => {
  if ((object as THREE.Mesh).isMesh && object.userData.surfaceTag === undefined) {
    object.userData.surfaceTag = { surface: 'concrete' };
  }
});

const events: Array<{ name: string; payload: unknown }> = [];
const profile: WeaponProfileTelemetry = {
  frames: 0,
  flashFrames: 0,
  maxDrawCalls: 0,
  flashDrawCallsMax: 0,
  fired: 0,
  impacts: 0,
  reloadStarts: 0,
  reloadEnds: 0,
  shakes: 0,
  damageEvents: 0,
  startAmmo: weapon.magazineAmmo,
};
const resetProfile = (): void => {
  profile.frames = 0;
  profile.flashFrames = 0;
  profile.maxDrawCalls = 0;
  profile.flashDrawCallsMax = 0;
  profile.fired = 0;
  profile.impacts = 0;
  profile.reloadStarts = 0;
  profile.reloadEnds = 0;
  profile.shakes = 0;
  profile.damageEvents = 0;
  profile.startAmmo = weapon.magazineAmmo;
};

for (const name of [
  Events.WeaponFired,
  Events.BulletImpact,
  Events.Damage,
  Events.AimChanged,
  Events.ReloadStart,
  Events.ReloadEnd,
  Events.Shake,
]) {
  engine.bus.on(name, (payload) => {
    events.push({ name, payload });
    if (events.length > 512) events.shift();
    if (name === Events.WeaponFired) profile.fired++;
    else if (name === Events.BulletImpact) profile.impacts++;
    else if (name === Events.ReloadStart) profile.reloadStarts++;
    else if (name === Events.ReloadEnd) profile.reloadEnds++;
    else if (name === Events.Shake) profile.shakes++;
    else if (name === Events.Damage) profile.damageEvents++;
  });
}

engine.renderer.info.autoReset = false;
engine.present = () => {
  const flashActive = weapon.isFlashActive;
  profile.frames++;
  if (flashActive) profile.flashFrames++;
  const info = engine.renderer.info;
  info.reset();
  render.render();
  profile.maxDrawCalls = Math.max(profile.maxDrawCalls, info.render.calls);
  if (flashActive) profile.flashDrawCallsMax = Math.max(profile.flashDrawCallsMax, info.render.calls);
  (window as unknown as Record<string, unknown>).__SCENE_STATS__ = {
    drawCallsPerFrame: info.render.calls,
    trianglesPerFrame: info.render.triangles,
    textures: info.memory.textures,
    geometries: info.memory.geometries,
    programs: info.programs?.length ?? 0,
  };
};

Object.assign(window as unknown as Record<string, unknown>, {
  engine,
  THREE,
  __WEAPON__: weapon,
  __WEAPON_INPUT__: input.state,
  __WEAPON_EVENTS__: events,
  __WEAPON_PROFILE__: profile,
  __RESET_WEAPON_PROFILE__: resetProfile,
  __STRESS_MODE__: stressMode,
  __SHOT__: (name: string) => {
    const capture = weapon.capture(name);
    (window as unknown as Record<string, unknown>).__WEAPON_CAPTURE__ = capture;
  },
});

engine.start();

let presented = 0;
const markReady = (): void => {
  if (++presented >= 20) {
    (window as unknown as Record<string, unknown>).__FRAME_READY__ = true;
    return;
  }
  requestAnimationFrame(markReady);
};
requestAnimationFrame(markReady);
