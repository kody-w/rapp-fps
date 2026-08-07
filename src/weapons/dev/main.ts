import * as THREE from 'three';
import { Engine } from '../../core/engine.js';
import { Events, type EngineContext, type InputState, type System, type UpdateContext } from '../../core/contracts.js';
import { TestLevel } from '../../level/TestLevel.js';
import { RenderSystem } from '../../render/RenderSystem.js';
import { WeaponSystem } from '../WeaponSystem.js';

class HarnessInput implements System {
  readonly name = 'weapon-harness-input';
  readonly state: InputState;

  private readonly held = new Set<string>();
  private readonly edges = new Set<string>();
  private readonly pendingLook = new THREE.Vector2();
  private readonly stress = new URLSearchParams(location.search).get('stress') === '1';

  constructor(private readonly weapon: WeaponSystem) {
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

const canvas = document.querySelector('#game') as HTMLCanvasElement;
const engine = new Engine(canvas);
const weapon = new WeaponSystem();
const input = new HarnessInput(weapon);
const render = new RenderSystem();
engine.input = input.state;

// Init/update ordering is intentional: the level establishes the camera, input
// writes base look, weapon adds view presentation, then render adds shake.
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
for (const name of [Events.WeaponFired, Events.BulletImpact, Events.Damage, Events.AimChanged]) {
  engine.bus.on(name, (payload) => {
    events.push({ name, payload });
    if (events.length > 32) events.shift();
  });
}

engine.renderer.info.autoReset = false;
engine.present = () => {
  const info = engine.renderer.info;
  info.reset();
  render.render();
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
  __WEAPON_EVENTS__: events,
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
