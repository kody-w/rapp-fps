/**
 * The arena as an engine `System`.
 *
 * Registration matches the merged subsystems (render/fx/audio/hud): a plain
 * class with `name`, `init`, `update`, `dispose`, added to the engine by the
 * boot path — it never self-registers. It runs after `RenderSystem` so the
 * procedural-sky IBL (`scene.environment`) is already live when the materials
 * are added.
 *
 * The one thing this system refuses to do is start with collision that does not
 * match what it drew: `init` runs the correspondence proof against the real
 * merged buffers and throws if it fails, exactly the loud-failure posture the
 * rest of the project takes. A world that silently disagreed with its geometry
 * is the #8 failure mode.
 */

import * as THREE from 'three';
import type { EngineContext, System, UpdateContext } from '../core/contracts.js';
import type { StaticWorld } from '../core/collision.js';
import { buildArena, type ArenaDefinition, type LightSpec } from './arena.js';
import { createArenaMaterials, type ArenaMaterials } from './materials.js';
import { mergeSolidsByMaterial, type MergedGroup } from './geometry.js';
import { buildStaticWorld } from './staticWorld.js';
import { checkCorrespondence, formatReport, type CorrespondenceReport } from './correspondence.js';
import {
  createContactShadowLayer,
  selectGroundContactSolids,
  type ContactShadowLayer,
} from './contactShadows.js';
import {
  createContainerDressingLayer,
  selectContainerSolids,
  type ContainerDressingLayer,
} from './containerDressing.js';

export interface ArenaLevelOptions {
  /**
   * Draw the authored floor contact-grounding marks under floor-standing cover.
   * Defaults to the `contact` URL flag (on unless `?contact=0`), so production
   * always grounds its cover while the evidence harness can capture a matched
   * "off" frame from the same build.
   */
  readonly contactShadows?: boolean;
  /**
   * Dress the cargo containers with procedural ironwork (corner castings, rails,
   * inset end-doors, locking bars) AND drive their corrugation from the rib
   * normal map. Defaults to the `dressing` URL flag (on unless `?dressing=0`), so
   * production ships the finished containers while the evidence harness can
   * capture a matched pre-#67 "off" frame (bare cuboids, albedo-only rib) from
   * the same build. Gating both together keeps the on/off comparison honest.
   */
  readonly containerDressing?: boolean;
}

export class ArenaLevel implements System {
  readonly name = 'level';

  private readonly def: ArenaDefinition;
  private root = new THREE.Group();
  private materials?: ArenaMaterials;
  private groups: MergedGroup[] = [];
  private lights: THREE.Object3D[] = [];
  private beaconMat?: THREE.MeshStandardMaterial;
  private contact?: ContactShadowLayer;
  private readonly contactShadowsOption?: boolean;
  private dressing?: ContainerDressingLayer;
  private readonly containerDressingOption?: boolean;

  private readonly world: StaticWorld;
  private report?: CorrespondenceReport;
  private installedShotHook = false;

  constructor(
    definition: ArenaDefinition = buildArena(),
    world: StaticWorld = buildStaticWorld(definition),
    options: ArenaLevelOptions = {},
  ) {
    this.def = definition;
    this.world = world;
    this.contactShadowsOption = options.contactShadows;
    this.containerDressingOption = options.containerDressing;
  }

  /** Available before init so every simulation receives this exact instance. */
  get staticWorld(): StaticWorld {
    return this.world;
  }

  get definition(): ArenaDefinition {
    return this.def;
  }

  get correspondence(): CorrespondenceReport | undefined {
    return this.report;
  }

  /** The contact-shadow layer, once built by init. Exposed for the fixture. */
  get contactShadows(): ContactShadowLayer | undefined {
    return this.contact;
  }

  /** The container-dressing layer, once built by init. Exposed for the fixture. */
  get containerDressing(): ContainerDressingLayer | undefined {
    return this.dressing;
  }

  init(ctx: EngineContext): void {
    const { scene } = ctx;
    this.root.name = 'arena';
    scene.add(this.root);

    // ── Collision, derived from the same solids as the geometry ───────────
    // ── Geometry: merge by material, one mesh per group ───────────────────
    // The container rib normal map (the one new #67 texture) is generated only
    // when the dressing is on, so `?dressing=0` reproduces the exact pre-#67
    // container material (albedo-only rib + generic metal bump) for evidence.
    const dressingOn = this.containerDressingEnabled();
    this.materials = createArenaMaterials(ctx.renderer, { containerRibNormal: dressingOn });
    this.groups = mergeSolidsByMaterial(this.def.solids);
    for (const group of this.groups) {
      const material = this.materials.byKey[group.material];
      const mesh = new THREE.Mesh(group.geometry, material);
      mesh.name = `arena:${group.material}`;
      mesh.castShadow = group.castShadow;
      mesh.receiveShadow = group.receiveShadow;
      mesh.matrixAutoUpdate = false; // static
      mesh.updateMatrix();
      this.root.add(mesh);
    }
    this.beaconMat = this.materials.byKey.beacon as THREE.MeshStandardMaterial;

    // ── Prove render ⇄ collision correspondence against the real buffers ──
    this.report = checkCorrespondence(this.def, this.world, this.groups);
    if (typeof window !== 'undefined') {
      (window as unknown as Record<string, unknown>).__ARENA_CHECK__ = this.report;
      (window as unknown as Record<string, unknown>).__LEVEL_STATIC_WORLD__ = this.world;
      (window as unknown as Record<string, unknown>).__ARENA_SPAWNS__ = {
        player: this.def.playerSpawn,
        enemy: this.def.enemySpawn,
      };
    }
    if (!this.report.ok) {
      // Loud failure: the running game must not present cover the player cannot
      // trust. This is the guard #8 lacked.
      throw new Error(`arena render/collision correspondence FAILED\n${formatReport(this.report)}`);
    }

    // ── Contact grounding: authored floor marks under floor-standing cover ──
    // Purely render-only: derived from the same collidable `Solid` records the
    // proof above just validated, added as ONE extra InstancedMesh, and never
    // fed to the collider — so it grounds the cover without touching the 5/5
    // correspondence. Off with `?contact=0` for a matched evidence frame.
    if (this.contactShadowsEnabled()) {
      this.contact = createContactShadowLayer(selectGroundContactSolids(this.def));
      this.root.add(this.contact.mesh);
    }
    if (typeof window !== 'undefined') {
      (window as unknown as Record<string, unknown>).__CONTACT_SHADOWS__ = this.contact
        ? {
          enabled: true,
          count: this.contact.instances.length,
          ids: this.contact.instances.map((c) => c.id),
          penumbra: this.contact.penumbra,
          yOffset: this.contact.yOffset,
          peak: this.contact.peak,
          instances: this.contact.instances,
        }
        : { enabled: false };
    }

    // ── Container dressing: procedural ironwork on the cargo containers ─────
    // Two extra merged meshes (structure + hardware) derived from the same
    // container `Solid` bounds; render-only, NOT added to `this.groups`, so the
    // 5/5 correspondence above is untouched and the collider stays the body box.
    // Off with `?dressing=0` (paired with the plain material) for a matched
    // pre-#67 evidence frame.
    if (dressingOn) {
      this.dressing = createContainerDressingLayer(selectContainerSolids(this.def));
      for (const mesh of this.dressing.meshes) this.root.add(mesh);
    }
    if (typeof window !== 'undefined') {
      (window as unknown as Record<string, unknown>).__CONTAINER_DRESSING__ = this.dressing
        ? {
          enabled: true,
          triangleCount: this.dressing.triangleCount,
          drawCalls: this.dressing.meshes.length,
          assemblies: this.dressing.assemblies.map((a) => ({
            id: a.id,
            longAxis: a.longAxis,
            doorEnd: a.doorEnd,
            partCount: a.parts.length,
          })),
        }
        : { enabled: false };
    }

    // ── Lighting: blue-hour ambient, warm practicals ──────────────────────
    for (const spec of this.def.lights) this.addLight(scene, spec);

    // ── Atmosphere ────────────────────────────────────────────────────────
    scene.fog = new THREE.FogExp2(this.def.fog.color, this.def.fog.density);

    // ── Camera: default framing is the spawn read ─────────────────────────
    this.applyShot(ctx.camera, 'spawn');
    this.installShotHook(ctx.camera);
  }

  private addLight(scene: THREE.Scene, spec: LightSpec): void {
    if (spec.kind === 'directional') {
      const light = new THREE.DirectionalLight(spec.color, spec.intensity);
      if (spec.position) light.position.set(...spec.position);
      light.target.position.set(0, 0, -9);
      if (spec.castShadow) {
        light.castShadow = true;
        light.shadow.mapSize.set(2048, 2048);
        light.shadow.camera.near = 0.5;
        light.shadow.camera.far = 60;
        const d = 17;
        light.shadow.camera.left = -d;
        light.shadow.camera.right = d;
        light.shadow.camera.top = d;
        light.shadow.camera.bottom = -d;
        light.shadow.bias = -0.0008;
        light.shadow.normalBias = 0.02;
        light.shadow.radius = 4;
      }
      scene.add(light);
      scene.add(light.target);
      this.lights.push(light, light.target);
    } else if (spec.kind === 'hemisphere') {
      const light = new THREE.HemisphereLight(spec.color, spec.groundColor ?? 0x000000, spec.intensity);
      scene.add(light);
      this.lights.push(light);
    } else {
      const light = new THREE.PointLight(spec.color, spec.intensity, spec.distance ?? 0, spec.decay ?? 2);
      if (spec.position) light.position.set(...spec.position);
      scene.add(light);
      this.lights.push(light);
    }
  }

  private applyShot(camera: THREE.PerspectiveCamera, name: string): void {
    const shot = this.def.shots.find((s) => s.name === name);
    if (!shot) return;
    camera.position.set(...shot.position);
    camera.lookAt(new THREE.Vector3(...shot.lookAt));
    if (shot.fov && camera.fov !== shot.fov) {
      camera.fov = shot.fov;
      camera.updateProjectionMatrix();
    }
  }

  private installShotHook(camera: THREE.PerspectiveCamera): void {
    if (typeof window === 'undefined') return;
    (window as unknown as Record<string, unknown>).__SHOT__ = (name: string) => {
      this.applyShot(camera, name);
    };
    (window as unknown as Record<string, unknown>).__SHOT_LIST__ = this.def.shots.map((s) => ({
      name: s.name,
      caption: s.caption,
    }));
    this.installedShotHook = true;
  }

  /** Constructor override wins; otherwise the `contact` URL flag (default on). */
  private contactShadowsEnabled(): boolean {
    if (this.contactShadowsOption !== undefined) return this.contactShadowsOption;
    if (typeof location === 'undefined') return true;
    return new URLSearchParams(location.search).get('contact') !== '0';
  }

  /** Constructor override wins; otherwise the `dressing` URL flag (default on). */
  private containerDressingEnabled(): boolean {
    if (this.containerDressingOption !== undefined) return this.containerDressingOption;
    if (typeof location === 'undefined') return true;
    return new URLSearchParams(location.search).get('dressing') !== '0';
  }

  update(u: UpdateContext): void {
    // A slow, deterministic beacon pulse — a little life at the objective end
    // without perturbing frame timing. Everything else is static.
    if (this.beaconMat) {
      this.beaconMat.emissiveIntensity = 6 + Math.sin(u.elapsed * 1.6) * 1.4;
    }
  }

  dispose(): void {
    this.root.parent?.remove(this.root);
    for (const group of this.groups) group.geometry.dispose();
    this.groups = [];
    this.contact?.dispose();
    this.contact = undefined;
    this.dressing?.dispose();
    this.dressing = undefined;
    this.materials?.dispose();
    this.materials = undefined;
    for (const light of this.lights) light.parent?.remove(light);
    this.lights = [];
    if (this.installedShotHook && typeof window !== 'undefined') {
      const w = window as unknown as Record<string, unknown>;
      delete w.__SHOT__;
      delete w.__SHOT_LIST__;
      delete w.__ARENA_CHECK__;
      delete w.__LEVEL_STATIC_WORLD__;
      delete w.__ARENA_SPAWNS__;
      delete w.__CONTACT_SHADOWS__;
      delete w.__CONTAINER_DRESSING__;
      this.installedShotHook = false;
    }
  }
}
