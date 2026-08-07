import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type {
  EngineContext,
  SurfaceKind,
  SurfaceTag,
  System,
  UpdateContext,
} from '../core/contracts.js';
import { createPortMaterials, type PortMaterials } from './proceduralMaterials.js';

declare global {
  interface Window {
    __SHOT__?: (name: string) => boolean;
    __LEVEL_COLLIDERS__?: readonly THREE.Mesh[];
    __LEVEL_TEXTURE_MEMORY_BYTES__?: number;
  }
}

interface Shot {
  position: [number, number, number];
  target: [number, number, number];
  fov?: number;
}

interface SteamField {
  points: THREE.Points;
  base: Float32Array;
  speed: Float32Array;
}

interface CargoInstance {
  position: [number, number, number];
  scale: [number, number, number];
  color: number;
}

const SHOTS: Record<string, Shot> = {
  spawn: {
    position: [0.5, 1.68, 18],
    target: [0, 1.7, -19],
    fov: 72,
  },
  lane: {
    position: [-2.8, 1.62, 1.5],
    target: [-0.3, 1.45, -31],
    fov: 70,
  },
  flank: {
    position: [10.65, 1.64, 0.8],
    target: [9.2, 1.55, -27],
    fov: 70,
  },
  interior: {
    position: [7.12, 1.66, -26.1],
    target: [5.25, 1.5, -36.1],
    fov: 69,
  },
  vista: {
    position: [11.15, 1.72, -42],
    target: [12.5, 6.5, -67],
    fov: 65,
  },
};

const CONTAINER_SIZE = new THREE.Vector3(2.45, 2.55, 6.05);
const SAFETY_ORANGE = 0xb54b2c;
const HARBOR_BLUE = 0x315a69;
const FADED_TEAL = 0x3c6967;
const WEATHERED_YELLOW = 0xb68c35;
const COLD_GREY = 0x566369;
const JERSEY_BARRIERS: Array<[number, number, number]> = [
  [4.5, 9.4, 0.5],
  [-3.5, 2.5, -0.3],
  [7.2, -4.5, 0.2],
  [-4.3, -11.2, 0],
  [2.2, -19.2, -0.3],
  [-4.4, -31.8, 0.35],
  [6.1, -45.5, -0.2],
];

export class PortLevel implements System {
  readonly name = 'level';

  private root = new THREE.Group();
  private collisionRoot = new THREE.Group();
  private colliders: THREE.Mesh[] = [];
  private geometries = new Set<THREE.BufferGeometry>();
  private geometryCache = new Map<string, THREE.BufferGeometry>();
  private materials!: PortMaterials;
  private colliderMaterial?: THREE.MeshBasicMaterial;
  private steamFields: SteamField[] = [];
  private waterMarkers: THREE.Mesh[] = [];
  private rain?: THREE.LineSegments;
  private rainBase?: Float32Array;
  private shotHook?: (name: string) => boolean;
  private camera?: THREE.PerspectiveCamera;

  init(ctx: EngineContext): void {
    this.materials = createPortMaterials(ctx.renderer);
    this.colliderMaterial = new THREE.MeshBasicMaterial({ visible: false });
    this.materials.materials.push(this.colliderMaterial);
    this.root.name = 'port-level-visuals';
    this.collisionRoot.name = 'port-level-collision';
    this.collisionRoot.visible = false;
    ctx.scene.add(this.root, this.collisionRoot);

    this.configureAtmosphere(ctx);
    this.buildGround();
    this.buildQuayAndWater();
    this.buildCargoYard();
    this.buildMaintenanceBuilding();
    this.buildFlank();
    this.buildCombatCover();
    this.buildGantryAndBackground();
    this.buildSetDressing();
    this.mergeStaticVisuals();
    this.buildCollision();

    this.camera = ctx.camera;
    this.shotHook = (name: string): boolean => this.applyShot(name);
    window.__SHOT__ = this.shotHook;
    window.__LEVEL_COLLIDERS__ = this.colliders;
    window.__LEVEL_TEXTURE_MEMORY_BYTES__ = this.materials.textureMemoryBytes;
    this.applyShot('spawn');
  }

  getCollisionMeshes(): readonly THREE.Mesh[] {
    return this.colliders;
  }

  update(u: UpdateContext): void {
    for (let fieldIndex = 0; fieldIndex < this.steamFields.length; fieldIndex++) {
      const field = this.steamFields[fieldIndex];
      const positions = field.points.geometry.attributes.position;
      for (let i = 0; i < positions.count; i++) {
        const baseIndex = i * 3;
        const phase = u.elapsed * field.speed[i] + i * 0.73 + fieldIndex;
        positions.setX(i, field.base[baseIndex] + Math.sin(phase * 1.7) * 0.42);
        positions.setY(i, field.base[baseIndex + 1] + (u.elapsed * field.speed[i] * 0.52) % 7);
        positions.setZ(i, field.base[baseIndex + 2] + Math.cos(phase * 1.3) * 0.34);
      }
      positions.needsUpdate = true;
    }

    for (let i = 0; i < this.waterMarkers.length; i++) {
      const marker = this.waterMarkers[i];
      const pulse = 0.6 + Math.sin(u.elapsed * 2.2 + i) * 0.4;
      const material = marker.material as THREE.MeshStandardMaterial;
      material.emissiveIntensity = 2.6 + pulse * 1.6;
    }

    if (this.rain && this.rainBase) {
      const positions = this.rain.geometry.attributes.position;
      const streakCount = this.rainBase.length / 3;
      for (let i = 0; i < streakCount; i++) {
        const baseIndex = i * 3;
        const vertexIndex = i * 2;
        const fall = (u.elapsed * 14 + i * 0.137) % 14;
        const drift = (u.elapsed * 2.2 + i * 0.071) % 4;
        const x = this.rainBase[baseIndex] - drift * 0.16;
        const y = this.rainBase[baseIndex + 1] - fall;
        const z = this.rainBase[baseIndex + 2] + drift;
        positions.setXYZ(vertexIndex, x, y, z);
        positions.setXYZ(vertexIndex + 1, x + 0.09, y - 0.72, z + 0.22);
      }
      positions.needsUpdate = true;
    }
  }

  dispose(): void {
    if (window.__SHOT__ === this.shotHook) delete window.__SHOT__;
    if (window.__LEVEL_COLLIDERS__ === this.colliders) delete window.__LEVEL_COLLIDERS__;
    delete window.__LEVEL_TEXTURE_MEMORY_BYTES__;

    this.root.removeFromParent();
    this.collisionRoot.removeFromParent();
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials.materials) material.dispose();
    for (const texture of this.materials.textures) texture.dispose();
  }

  private applyShot(name: string): boolean {
    const shot = SHOTS[name];
    if (!shot || !this.camera) return false;
    this.camera.position.fromArray(shot.position);
    this.camera.fov = shot.fov ?? 72;
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(new THREE.Vector3().fromArray(shot.target));
    this.camera.updateMatrixWorld(true);
    return true;
  }

  private configureAtmosphere(ctx: EngineContext): void {
    const { scene } = ctx;
    scene.background = new THREE.Color(0x172735);
    scene.fog = new THREE.FogExp2(0x263b49, 0.0125);

    this.root.add(this.createSky());

    const sky = new THREE.HemisphereLight(0x91b8d0, 0x141d22, 1.62);
    this.root.add(sky);

    const moon = new THREE.DirectionalLight(0xa9c9dd, 2.05);
    moon.position.set(-24, 34, 12);
    moon.target.position.set(0, 0, -20);
    moon.castShadow = true;
    moon.shadow.mapSize.set(2048, 2048);
    moon.shadow.camera.near = 3;
    moon.shadow.camera.far = 95;
    moon.shadow.camera.left = -37;
    moon.shadow.camera.right = 37;
    moon.shadow.camera.top = 42;
    moon.shadow.camera.bottom = -34;
    moon.shadow.bias = -0.00045;
    moon.shadow.normalBias = 0.035;
    moon.shadow.radius = 3;
    this.root.add(moon, moon.target);

    const portBounce = new THREE.DirectionalLight(0x5d91a8, 0.72);
    portBounce.position.set(34, 14, -55);
    portBounce.target.position.set(4, 0, -22);
    this.root.add(portBounce, portBounce.target);

    this.addLightPool(new THREE.Vector3(-6.2, 4.5, -18), 0xff9b45, 30, 18);
    this.addLightPool(new THREE.Vector3(6.5, 3.2, -24.3), 0x54d6ec, 16, 12);
    this.addLightPool(new THREE.Vector3(6.2, 2.8, -33.2), 0xffa74f, 20, 13);
    this.addLightPool(new THREE.Vector3(-8.5, 2.6, -45), 0xff6f42, 17, 11);
    this.createRain();
  }

  private buildGround(): void {
    const yardGeometry = this.box(29, 0.34, 77).clone();
    this.geometries.add(yardGeometry);
    const yardUv = yardGeometry.attributes.uv;
    for (let i = 0; i < yardUv.count; i++) {
      yardUv.setXY(i, yardUv.getX(i) * 4, yardUv.getY(i) * 10);
    }
    const yard = this.mesh(
      yardGeometry,
      this.materials.ground,
      [0, -0.17, -17],
      { receiveShadow: true },
    );
    yard.name = 'rain-soaked quay apron';
    this.root.add(yard);

    const curb = this.mesh(
      this.box(0.42, 0.28, 76),
      this.materials.safetyYellow,
      [-14.25, 0.14, -17],
      { castShadow: true, receiveShadow: true },
    );
    this.root.add(curb);

    const laneStripeMaterial = this.materials.safetyWhite.clone();
    laneStripeMaterial.opacity = 0.43;
    laneStripeMaterial.transparent = true;
    this.materials.materials.push(laneStripeMaterial);
    for (let z = 14; z >= -49; z -= 6.5) {
      const line = this.mesh(
        this.box(0.1, 0.015, 3.4),
        laneStripeMaterial,
        [-1.65, 0.015, z],
        { receiveShadow: true },
      );
      this.root.add(line);
    }

    const random = this.random(0x1e7e1);
    for (let i = 0; i < 27; i++) {
      const x = -11.5 + random() * 23;
      const z = 15 - random() * 62;
      const puddle = this.mesh(
        this.circle(1, 24),
        this.materials.puddle,
        [x, 0.014 + i * 0.00003, z],
      );
      puddle.rotation.x = -Math.PI / 2;
      puddle.rotation.z = random() * Math.PI;
      puddle.scale.set(0.8 + random() * 2.1, 0.25 + random() * 0.68, 1);
      this.root.add(puddle);
    }

    for (let z = 11; z >= -45; z -= 7) {
      const drain = this.mesh(
        this.box(0.9, 0.025, 0.22),
        this.materials.darkMetal,
        [-4.5, 0.018, z],
        { receiveShadow: true },
      );
      this.root.add(drain);
    }

    for (const z of [4, -13, -33]) {
      const arrow = new THREE.Group();
      arrow.add(this.mesh(
        this.box(0.16, 0.018, 1.5),
        this.materials.safetyYellow,
        [0, 0.021, 0.35],
      ));
      for (const x of [-0.32, 0.32]) {
        const head = this.mesh(
          this.box(0.15, 0.018, 0.85),
          this.materials.safetyYellow,
          [x, 0.021, -0.38],
        );
        head.rotation.y = x < 0 ? -0.72 : 0.72;
        arrow.add(head);
      }
      arrow.position.set(1.3, 0, z);
      this.root.add(arrow);
    }
  }

  private buildQuayAndWater(): void {
    const water = this.mesh(
      this.plane(88, 110),
      this.materials.water,
      [31, -0.42, -27],
    );
    water.rotation.x = -Math.PI / 2;
    water.name = 'harbor water';
    this.root.add(water);

    const quayFace = this.mesh(
      this.box(0.75, 2.15, 77),
      this.materials.concreteDark,
      [14.7, -0.78, -17],
      { castShadow: true, receiveShadow: true },
    );
    this.root.add(quayFace);

    const rail = this.createRailing(68, 2.2);
    rail.position.set(13.7, 0, -15.5);
    rail.rotation.y = 0;
    this.root.add(rail);

    const markerGeometry = this.sphere(0.105, 10, 7);
    for (let z = 10; z >= -45; z -= 8.2) {
      const post = this.mesh(
        this.cylinder(0.05, 0.05, 0.75, 8),
        this.materials.darkMetal,
        [13.62, 0.67, z],
        { castShadow: true },
      );
      const markerMaterial = this.materials.emissiveCyan.clone();
      this.materials.materials.push(markerMaterial);
      const marker = this.mesh(markerGeometry, markerMaterial, [13.62, 1.08, z]);
      this.waterMarkers.push(marker);
      this.root.add(post, marker);
    }

    const bollardGeometry = this.cylinder(0.24, 0.33, 0.7, 12);
    for (const [x, z] of [[11.4, 8], [11.6, -8], [11.3, -27], [11.5, -44]]) {
      const bollard = this.mesh(
        bollardGeometry,
        this.materials.rustedMetal,
        [x, 0.35, z],
        { castShadow: true, receiveShadow: true },
      );
      this.root.add(bollard);
    }

    const random = this.random(0xb001);
    for (let i = 0; i < 24; i++) {
      const pylon = this.mesh(
        this.cylinder(0.18, 0.24, 5 + random() * 1.8, 8),
        this.materials.darkMetal,
        [19 + random() * 38, 0.25 + random() * 0.5, 8 - random() * 76],
      );
      pylon.rotation.z = (random() - 0.5) * 0.04;
      this.root.add(pylon);
    }
  }

  private buildCargoYard(): void {
    const instances: CargoInstance[] = [
      { position: [-10.1, 1.28, 4], scale: [1, 1, 1], color: SAFETY_ORANGE },
      { position: [-10.1, 3.88, 4], scale: [1, 1, 1], color: COLD_GREY },
      { position: [-10.1, 1.28, -2.4], scale: [1, 1, 1], color: HARBOR_BLUE },
      { position: [-7.45, 1.28, -6.2], scale: [1, 1, 1], color: FADED_TEAL },
      { position: [-10.1, 1.28, -11.5], scale: [1, 1, 1], color: WEATHERED_YELLOW },
      { position: [-10.1, 3.88, -11.5], scale: [1, 1, 1], color: SAFETY_ORANGE },
      { position: [-7.35, 1.28, -16.9], scale: [1, 1, 1], color: HARBOR_BLUE },
      { position: [-10.1, 1.28, -22], scale: [1, 1, 1], color: COLD_GREY },
      { position: [-10.1, 3.88, -22], scale: [1, 1, 1], color: FADED_TEAL },
      { position: [-10.1, 6.48, -22], scale: [1, 1, 1], color: WEATHERED_YELLOW },
      { position: [-7.55, 1.28, -28.6], scale: [1, 1, 1], color: SAFETY_ORANGE },
      { position: [-10.1, 1.28, -34.8], scale: [1, 1, 1], color: HARBOR_BLUE },
      { position: [-10.1, 3.88, -34.8], scale: [1, 1, 1], color: COLD_GREY },
      { position: [-7.5, 1.28, -41], scale: [1, 1, 1], color: FADED_TEAL },
      { position: [-10.1, 1.28, -47], scale: [1, 1, 1], color: WEATHERED_YELLOW },
    ];

    const container = this.box(CONTAINER_SIZE.x, CONTAINER_SIZE.y, CONTAINER_SIZE.z, 1, 1, 12);
    const cargo = new THREE.InstancedMesh(container, this.materials.paintedMetal, instances.length);
    cargo.name = 'stacked cargo containers';
    cargo.castShadow = true;
    cargo.receiveShadow = true;
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    for (let i = 0; i < instances.length; i++) {
      position.fromArray(instances[i].position);
      scale.fromArray(instances[i].scale);
      matrix.compose(position, rotation, scale);
      cargo.setMatrixAt(i, matrix);
      cargo.setColorAt(i, new THREE.Color(instances[i].color));
    }
    cargo.instanceMatrix.needsUpdate = true;
    cargo.instanceColor!.needsUpdate = true;
    cargo.computeBoundingSphere();
    this.root.add(cargo);

    const barGeometry = this.box(0.055, 2.28, 0.07);
    const bars: Array<[number, number, number]> = [];
    for (const instance of instances) {
      if (instance.position[1] > 2) continue;
      const [x, y, z] = instance.position;
      for (let side = -1; side <= 1; side += 2) {
        for (let rib = -5; rib <= 5; rib++) {
          bars.push([x + side * 1.245, y, z + rib * 0.48]);
        }
      }
    }
    const ribs = new THREE.InstancedMesh(barGeometry, this.materials.darkMetal, bars.length);
    ribs.castShadow = true;
    for (let i = 0; i < bars.length; i++) {
      position.fromArray(bars[i]);
      matrix.makeTranslation(position.x, position.y, position.z);
      ribs.setMatrixAt(i, matrix);
    }
    ribs.instanceMatrix.needsUpdate = true;
    ribs.computeBoundingSphere();
    this.root.add(ribs);

    for (const [x, z, angle] of [
      [-5.7, -1.4, -0.25],
      [-4.4, -13.2, 0.15],
      [-5.9, -33.3, -0.12],
    ] as Array<[number, number, number]>) {
      const gate = this.createContainerDoorFrame();
      gate.position.set(x, 0, z);
      gate.rotation.y = angle;
      this.root.add(gate);
    }
  }

  private buildMaintenanceBuilding(): void {
    const building = new THREE.Group();
    building.name = 'maintenance building';

    const wallParts: Array<{
      size: [number, number, number];
      position: [number, number, number];
      material?: THREE.Material;
    }> = [
      { size: [8.4, 0.35, 16], position: [0, 0.18, 0] },
      { size: [0.35, 4.4, 16], position: [-4.2, 2.2, 0] },
      { size: [0.35, 4.4, 16], position: [4.2, 2.2, 0] },
      { size: [8.4, 4.4, 0.35], position: [0, 2.2, -8] },
      { size: [8.4, 4.4, 0.35], position: [0, 2.2, 8] },
      { size: [8.8, 0.3, 16.4], position: [0, 4.55, 0], material: this.materials.darkMetal },
      { size: [3.35, 4.4, 0.3], position: [-2.52, 2.2, 5.1] },
      { size: [2.1, 1.1, 0.3], position: [2.9, 3.85, 5.1] },
      { size: [0.8, 4.4, 0.3], position: [3.8, 2.2, 5.1] },
    ];
    for (const part of wallParts) {
      const wall = this.mesh(
        this.box(...part.size),
        part.material ?? this.materials.concrete,
        part.position,
        { castShadow: true, receiveShadow: true },
      );
      building.add(wall);
    }

    const window = this.mesh(
      this.box(1.9, 1.4, 0.08),
      this.materials.glass,
      [2.75, 2.65, 5.3],
      { receiveShadow: true },
    );
    building.add(window);

    const sign = this.mesh(
      this.plane(3.9, 0.98),
      this.materials.sign,
      [-1.15, 4.15, 5.32],
    );
    building.add(sign);

    const doorFrame = this.createDoorFrame(2.25, 3.15, 0.28);
    doorFrame.position.set(1.45, 0, 5.28);
    building.add(doorFrame);

    const interiorStrip = this.mesh(
      this.box(3.6, 0.08, 0.14),
      this.materials.emissiveCyan,
      [0.5, 4.23, -2.7],
    );
    building.add(interiorStrip);

    const workbench = this.mesh(
      this.box(3.4, 0.14, 0.9),
      this.materials.darkMetal,
      [-1.6, 1.05, -5.9],
      { castShadow: true, receiveShadow: true },
    );
    const benchLegs = new THREE.Group();
    for (const x of [-2.9, -0.3]) {
      for (const z of [-6.25, -5.58]) {
        benchLegs.add(this.mesh(
          this.box(0.12, 1.02, 0.12),
          this.materials.darkMetal,
          [x, 0.51, z],
          { castShadow: true },
        ));
      }
    }
    building.add(workbench, benchLegs);

    const lockers = new THREE.Group();
    for (let i = 0; i < 4; i++) {
      const locker = this.mesh(
        this.box(0.68, 2.15, 0.72),
        this.materials.rustedMetal,
        [-3.55, 1.08, -4.4 + i * 0.86],
        { castShadow: true, receiveShadow: true },
      );
      lockers.add(locker);
    }
    building.add(lockers);

    const pipes = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const pipe = this.mesh(
        this.cylinder(0.09, 0.09, 8.2, 10),
        this.materials.darkMetal,
        [3.62 - i * 0.34, 3.55, -0.7],
        { castShadow: true },
      );
      pipe.rotation.x = Math.PI / 2;
      pipes.add(pipe);
    }
    building.add(pipes);

    const shelving = new THREE.Group();
    for (const x of [3.28, 4.0]) {
      for (const z of [-1.8, -4.9]) {
        shelving.add(this.mesh(
          this.box(0.09, 2.65, 0.09),
          this.materials.darkMetal,
          [x, 1.33, z],
          { castShadow: true },
        ));
      }
    }
    for (const y of [0.42, 1.28, 2.14]) {
      shelving.add(this.mesh(
        this.box(0.82, 0.08, 3.25),
        this.materials.darkMetal,
        [3.64, y, -3.35],
        { castShadow: true, receiveShadow: true },
      ));
    }
    for (const [x, y, z, material] of [
      [3.55, 0.7, -2.55, this.materials.rustedMetal],
      [3.62, 1.58, -3.9, this.materials.safetyYellow],
      [3.55, 2.46, -2.25, this.materials.rustedMetal],
    ] as Array<[number, number, number, THREE.Material]>) {
      shelving.add(this.mesh(
        this.box(0.58, 0.5, 0.72),
        material,
        [x, y, z],
        { castShadow: true, receiveShadow: true },
      ));
    }
    building.add(shelving);

    const powerCabinet = this.mesh(
      this.box(1.35, 1.95, 0.34),
      this.materials.safetyYellow,
      [1.9, 1.45, -7.72],
      { castShadow: true, receiveShadow: true },
    );
    const cabinetInset = this.mesh(
      this.box(1.05, 1.42, 0.04),
      this.materials.darkMetal,
      [1.9, 1.45, -7.53],
    );
    const cabinetLamp = this.mesh(
      this.sphere(0.075, 10, 7),
      this.materials.emissiveRed,
      [2.25, 1.92, -7.49],
    );
    building.add(powerCabinet, cabinetInset, cabinetLamp);

    const trench = new THREE.Group();
    trench.add(this.mesh(
      this.box(0.85, 0.035, 5.8),
      this.materials.rubber,
      [0.65, 0.03, -2.1],
      { receiveShadow: true },
    ));
    for (let z = -4.7; z <= 0.5; z += 0.38) {
      trench.add(this.mesh(
        this.box(0.78, 0.025, 0.055),
        this.materials.darkMetal,
        [0.65, 0.055, z],
      ));
    }
    building.add(trench);

    const utilityCrates = new THREE.Group();
    for (const [x, y, z, scale] of [
      [-0.25, 0.34, -5.05, 1],
      [0.5, 0.3, -5.35, 0.82],
      [-0.1, 0.94, -5.3, 0.72],
    ] as Array<[number, number, number, number]>) {
      const crate = this.mesh(
        this.box(0.82, 0.68, 0.78),
        this.materials.wood,
        [x, y, z],
        { castShadow: true, receiveShadow: true },
      );
      crate.scale.setScalar(scale);
      utilityCrates.add(crate);
    }
    building.add(utilityCrates);

    const innerLight = new THREE.PointLight(0x65e0ee, 7, 9, 2);
    innerLight.position.set(0.5, 3.5, -2.2);
    const taskLight = new THREE.PointLight(0xff8c47, 4, 7, 2);
    taskLight.position.set(-1.4, 2.7, -5.6);
    building.add(innerLight, taskLight);

    building.position.set(5.7, 0, -29.8);
    this.root.add(building);

    const exhaust = this.createSteamField(new THREE.Vector3(8.8, 4.8, -32.5), 22, 0x51ea);
    this.root.add(exhaust.points);

    const roofTank = this.mesh(
      this.cylinder(1.25, 1.25, 3.5, 18),
      this.materials.rustedMetal,
      [7.8, 5.9, -34.2],
      { castShadow: true, receiveShadow: true },
    );
    roofTank.rotation.z = Math.PI / 2;
    this.root.add(roofTank);
  }

  private buildFlank(): void {
    const pipeRun = new THREE.Group();
    pipeRun.name = 'seaward flank';

    const pipeGeometry = this.cylinder(0.22, 0.22, 20, 12);
    for (let i = 0; i < 3; i++) {
      const pipe = this.mesh(
        pipeGeometry,
        i === 1 ? this.materials.rustedMetal : this.materials.darkMetal,
        [9.1 + i * 0.58, 2.2 + i * 0.32, -10.8],
        { castShadow: true, receiveShadow: true },
      );
      pipe.rotation.x = Math.PI / 2;
      pipeRun.add(pipe);
    }

    for (let z = -2; z >= -20; z -= 4) {
      const support = this.createPipeSupport();
      support.position.set(9.68, 0, z);
      pipeRun.add(support);
    }

    const valve = new THREE.Group();
    const wheel = this.mesh(
      this.torus(0.55, 0.075, 8, 22),
      this.materials.safetyYellow,
      [8.9, 2.1, -13],
      { castShadow: true },
    );
    wheel.rotation.y = Math.PI / 2;
    valve.add(wheel);
    for (let i = 0; i < 4; i++) {
      const spoke = this.mesh(
        this.box(0.06, 1.05, 0.06),
        this.materials.safetyYellow,
        [8.9, 2.1, -13],
      );
      spoke.rotation.z = i * Math.PI / 4;
      valve.add(spoke);
    }
    pipeRun.add(valve);
    this.root.add(pipeRun);

    const flankCanopy = this.mesh(
      this.box(4.8, 0.22, 10),
      this.materials.darkMetal,
      [9.3, 4.3, -15],
      { castShadow: true, receiveShadow: true },
    );
    this.root.add(flankCanopy);

    const steam = this.createSteamField(new THREE.Vector3(9.8, 2.3, -6.3), 16, 0x991a);
    this.root.add(steam.points);
  }

  private buildCombatCover(): void {
    const cover: Array<{
      size: [number, number, number];
      position: [number, number, number];
      material: THREE.Material;
      rotation?: number;
    }> = [
      {
        size: [3.3, 1.05, 0.7],
        position: [-0.2, 0.53, 8],
        material: this.materials.concrete,
        rotation: -0.12,
      },
      {
        size: [1.5, 1.2, 1.3],
        position: [4.8, 0.6, 4.7],
        material: this.materials.rustedMetal,
      },
      {
        size: [2.9, 1.08, 0.74],
        position: [-1, 0.54, -3.4],
        material: this.materials.concrete,
        rotation: 0.18,
      },
      {
        size: [1.3, 2.25, 1.15],
        position: [2.6, 1.13, -9],
        material: this.materials.darkMetal,
      },
      {
        size: [3.6, 1.04, 0.7],
        position: [-0.2, 0.52, -15.3],
        material: this.materials.concrete,
        rotation: -0.08,
      },
      {
        size: [1.6, 2.35, 1.4],
        position: [-3.2, 1.18, -22],
        material: this.materials.rustedMetal,
      },
      {
        size: [2.8, 1.08, 0.72],
        position: [0, 0.54, -29],
        material: this.materials.concrete,
        rotation: 0.15,
      },
      {
        size: [3.2, 1.1, 0.74],
        position: [-2.1, 0.55, -38.3],
        material: this.materials.concrete,
        rotation: -0.16,
      },
    ];

    for (const item of cover) {
      const mesh = this.mesh(
        this.box(...item.size),
        item.material,
        item.position,
        { castShadow: true, receiveShadow: true },
      );
      mesh.rotation.y = item.rotation ?? 0;
      this.root.add(mesh);
    }

    for (const [x, z] of [[2.6, 5.4], [1.4, -7], [3.2, -16.4], [-0.2, -24.8]]) {
      this.root.add(this.createPalletStack(x, z));
    }

    const checkpoint = this.createCheckpointGate();
    checkpoint.position.set(-1.8, 0, -45.8);
    this.root.add(checkpoint);
  }

  private buildGantryAndBackground(): void {
    const gantry = new THREE.Group();
    gantry.name = 'gantry crane silhouette';
    const steel = this.materials.darkMetal;

    for (const x of [-2.8, 17.8]) {
      const leg = this.mesh(
        this.box(0.75, 18, 0.75),
        steel,
        [x, 9, -61],
        { castShadow: true, receiveShadow: true },
      );
      leg.rotation.z = x < 0 ? -0.06 : 0.06;
      gantry.add(leg);
    }

    gantry.add(this.mesh(
      this.box(24, 1.15, 1.15),
      steel,
      [7.5, 17.6, -61],
      { castShadow: true, receiveShadow: true },
    ));
    gantry.add(this.mesh(
      this.box(1.0, 1.0, 24),
      steel,
      [7.5, 17.8, -53],
      { castShadow: true, receiveShadow: true },
    ));

    for (let x = -2; x <= 17; x += 3.2) {
      const brace = this.mesh(
        this.box(0.28, 0.28, 8.3),
        steel,
        [x, 13.2, -61],
        { castShadow: true },
      );
      brace.rotation.x = Math.PI / 2;
      brace.rotation.z = (x % 6.4) < 1 ? 0.72 : -0.72;
      gantry.add(brace);
    }

    const cabin = this.mesh(
      this.box(3.6, 2.2, 3),
      this.materials.rustedMetal,
      [2.2, 16.1, -55.5],
      { castShadow: true, receiveShadow: true },
    );
    const cabinGlass = this.mesh(
      this.box(3.15, 0.9, 0.05),
      this.materials.glass,
      [2.2, 16.25, -53.98],
    );
    gantry.add(cabin, cabinGlass);

    const hookCable = this.mesh(
      this.cylinder(0.045, 0.045, 12, 6),
      steel,
      [7.5, 11.2, -52.5],
    );
    const hook = this.mesh(
      this.torus(0.35, 0.08, 8, 18, Math.PI * 1.4),
      this.materials.safetyYellow,
      [7.5, 5.25, -52.5],
      { castShadow: true },
    );
    hook.rotation.z = Math.PI * 0.35;
    gantry.add(hookCable, hook);
    this.root.add(gantry);

    const warehouse = this.mesh(
      this.box(39, 10, 15),
      this.materials.concreteDark,
      [-17, 5, -70],
      { castShadow: true, receiveShadow: true },
    );
    this.root.add(warehouse);

    const tanks = new THREE.Group();
    for (const [x, z, radius, height] of [
      [24, -68, 5.4, 12],
      [35, -73, 6.3, 15],
      [48, -66, 4.8, 10],
    ] as Array<[number, number, number, number]>) {
      const tank = this.mesh(
        this.cylinder(radius, radius, height, 20),
        this.materials.darkMetal,
        [x, height / 2 - 0.2, z],
        { castShadow: true, receiveShadow: true },
      );
      tanks.add(tank);
      const cap = this.mesh(
        this.sphere(radius, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2),
        this.materials.darkMetal,
        [x, height - 0.2, z],
        { castShadow: true },
      );
      tanks.add(cap);
    }
    this.root.add(tanks);

    const skyline = new THREE.Group();
    for (let i = 0; i < 14; i++) {
      const tower = this.mesh(
        this.box(0.45, 10 + (i % 4) * 3, 0.45),
        this.materials.darkMetal,
        [-35 + i * 8.4, 6 + (i % 4) * 1.5, -100 - (i % 3) * 8],
      );
      skyline.add(tower);
    }
    this.root.add(skyline);
  }

  private buildSetDressing(): void {
    const lampPosts = [
      [-6.2, -18, 0],
      [6.5, -24.3, Math.PI],
      [-8.5, -45, 0],
    ] as Array<[number, number, number]>;
    for (const [x, z, rotation] of lampPosts) {
      const lamp = this.createLampPost();
      lamp.position.set(x, 0, z);
      lamp.rotation.y = rotation;
      this.root.add(lamp);
    }

    for (const [x, z, rotation] of JERSEY_BARRIERS) {
      const barrier = this.createJerseyBarrier();
      barrier.position.set(x, 0, z);
      barrier.rotation.y = rotation;
      this.root.add(barrier);
    }

    const random = this.random(0xd3c0);
    for (let i = 0; i < 18; i++) {
      const drum = this.createDrum(i % 4 === 0);
      drum.position.set(-4 + random() * 14, 0, 12 - random() * 57);
      drum.rotation.y = random() * Math.PI;
      this.root.add(drum);
    }

    for (const [x, z] of [[-5, 10], [5.3, -6], [-3.6, -28], [7.8, -42]]) {
      const coneCluster = new THREE.Group();
      for (let i = 0; i < 3; i++) {
        const cone = this.mesh(
          this.cone(0.22, 0.65, 10),
          this.materials.safetyYellow,
          [i * 0.42, 0.34, (i % 2) * 0.32],
          { castShadow: true },
        );
        coneCluster.add(cone);
      }
      coneCluster.position.set(x, 0, z);
      this.root.add(coneCluster);
    }

    const cableGeometry = this.torus(0.74, 0.045, 6, 28);
    for (const [x, z, angle] of [[4.4, 1.7, 0.2], [-1.2, -12, -0.2], [4.4, -38, 0.4]]) {
      const coil = this.mesh(
        cableGeometry,
        this.materials.rubber,
        [x, 0.14, z],
      );
      coil.scale.y = 0.48;
      coil.rotation.x = Math.PI / 2;
      coil.rotation.z = angle;
      this.root.add(coil);
    }
  }

  private mergeStaticVisuals(): void {
    interface MergeBucket {
      material: THREE.Material;
      meshes: THREE.Mesh[];
      castShadow: boolean;
      receiveShadow: boolean;
      renderOrder: number;
    }

    this.root.updateMatrixWorld(true);
    const buckets = new Map<string, MergeBucket>();
    this.root.traverse((object) => {
      if (!(object instanceof THREE.Mesh) || object instanceof THREE.InstancedMesh) return;
      if (Array.isArray(object.material) || object.userData.noMerge === true) return;
      const key = [
        object.material.uuid,
        object.castShadow ? 1 : 0,
        object.receiveShadow ? 1 : 0,
        object.renderOrder,
      ].join(':');
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          material: object.material,
          meshes: [],
          castShadow: object.castShadow,
          receiveShadow: object.receiveShadow,
          renderOrder: object.renderOrder,
        };
      }
      bucket.meshes.push(object);
      buckets.set(key, bucket);
    });

    for (const bucket of buckets.values()) {
      if (bucket.meshes.length < 2) continue;
      const transformed = bucket.meshes.map((mesh) => (
        mesh.geometry.clone().applyMatrix4(mesh.matrixWorld)
      ));
      const mergedGeometry = mergeGeometries(transformed, false);
      for (const geometry of transformed) geometry.dispose();
      if (!mergedGeometry) continue;

      this.geometries.add(mergedGeometry);
      const merged = new THREE.Mesh(mergedGeometry, bucket.material);
      merged.name = `merged-${bucket.material.type}`;
      merged.castShadow = bucket.castShadow;
      merged.receiveShadow = bucket.receiveShadow;
      merged.renderOrder = bucket.renderOrder;
      mergedGeometry.computeBoundingBox();
      mergedGeometry.computeBoundingSphere();
      for (const mesh of bucket.meshes) mesh.removeFromParent();
      this.root.add(merged);
    }
  }

  private buildCollision(): void {
    this.addCollider('ground', this.box(29, 0.4, 77), [0, -0.2, -17], 'concrete');
    this.addCollider('west-yard-boundary', this.box(0.8, 8, 77), [-14.55, 4, -17], 'concrete');
    this.addCollider('quay-edge', this.box(0.8, 2.5, 77), [14.7, 0.45, -17], 'concrete');
    this.addCollider('harbor-water', this.box(52, 0.16, 90), [40, -0.4, -24], 'water');

    const cargoPositions: Array<[number, number, number]> = [
      [-10.1, 2.55, 4],
      [-10.1, 1.28, -2.4],
      [-7.45, 1.28, -6.2],
      [-10.1, 2.55, -11.5],
      [-7.35, 1.28, -16.9],
      [-10.1, 3.85, -22],
      [-7.55, 1.28, -28.6],
      [-10.1, 2.55, -34.8],
      [-7.5, 1.28, -41],
      [-10.1, 1.28, -47],
    ];
    for (let i = 0; i < cargoPositions.length; i++) {
      const [x, y, z] = cargoPositions[i];
      const height = y > 3 ? 7.65 : y > 2 ? 5.1 : 2.55;
      this.addCollider(`cargo-stack-${i}`, this.box(2.5, height, 6.1), [x, height / 2, z], 'metal');
    }

    const buildingParts: Array<{
      name: string;
      size: [number, number, number];
      position: [number, number, number];
      surface: SurfaceKind;
    }> = [
      { name: 'maintenance-floor', size: [8.4, 0.4, 16], position: [5.7, 0.2, -29.8], surface: 'concrete' },
      { name: 'maintenance-west-wall', size: [0.4, 4.6, 16], position: [1.5, 2.3, -29.8], surface: 'concrete' },
      { name: 'maintenance-east-wall', size: [0.4, 4.6, 16], position: [9.9, 2.3, -29.8], surface: 'concrete' },
      { name: 'maintenance-back-wall', size: [8.4, 4.6, 0.4], position: [5.7, 2.3, -37.8], surface: 'concrete' },
      { name: 'maintenance-front-left', size: [3.4, 4.6, 0.35], position: [3.18, 2.3, -24.7], surface: 'concrete' },
      { name: 'maintenance-front-right', size: [0.9, 4.6, 0.35], position: [9.5, 2.3, -24.7], surface: 'concrete' },
      { name: 'maintenance-front-header', size: [2.2, 1.15, 0.35], position: [8.6, 4.03, -24.7], surface: 'concrete' },
      { name: 'maintenance-window', size: [1.9, 1.4, 0.12], position: [8.45, 2.65, -24.5], surface: 'glass' },
      { name: 'maintenance-roof', size: [8.8, 0.35, 16.4], position: [5.7, 4.55, -29.8], surface: 'metal' },
    ];
    for (const part of buildingParts) {
      this.addCollider(part.name, this.box(...part.size), part.position, part.surface);
    }

    const cover: Array<[string, [number, number, number], [number, number, number], SurfaceKind, number?]> = [
      ['spawn-cover', [3.3, 1.05, 0.7], [-0.2, 0.53, 8], 'concrete', -0.12],
      ['drum-crate', [1.5, 1.2, 1.3], [4.8, 0.6, 4.7], 'metal'],
      ['lane-cover-a', [2.9, 1.08, 0.74], [-1, 0.54, -3.4], 'concrete', 0.18],
      ['lane-tall-cover', [1.3, 2.25, 1.15], [2.6, 1.13, -9], 'metal'],
      ['lane-cover-b', [3.6, 1.04, 0.7], [-0.2, 0.52, -15.3], 'concrete', -0.08],
      ['lane-tall-cover-b', [1.6, 2.35, 1.4], [-3.2, 1.18, -22], 'metal'],
      ['lane-cover-c', [2.8, 1.08, 0.72], [0, 0.54, -29], 'concrete', 0.15],
      ['lane-cover-d', [3.2, 1.1, 0.74], [-2.1, 0.55, -38.3], 'concrete', -0.16],
      ['flank-pipe-bank', [2.7, 3.7, 20], [9.7, 2.1, -10.8], 'metal'],
      ['flank-canopy', [4.8, 0.25, 10], [9.3, 4.3, -15], 'metal'],
      ['checkpoint-left', [5, 3.4, 0.5], [-5.4, 1.7, -45.8], 'metal'],
      ['checkpoint-right', [5, 3.4, 0.5], [2, 1.7, -45.8], 'metal'],
    ];
    for (const [name, size, position, surface, rotation] of cover) {
      this.addCollider(name, this.box(...size), position, surface, rotation);
    }

    for (let i = 0; i < JERSEY_BARRIERS.length; i++) {
      const [x, z, rotation] = JERSEY_BARRIERS[i];
      this.addCollider(
        `jersey-barrier-${i}`,
        this.box(2.2, 1, 0.72),
        [x, 0.5, z],
        'concrete',
        rotation,
      );
    }

    this.addCollider(
      'interior-utility-crates',
      this.box(1.8, 1.45, 1.5),
      [5.7, 0.72, -35.1],
      'wood',
    );
  }

  private addCollider(
    name: string,
    geometry: THREE.BufferGeometry,
    position: [number, number, number],
    surface: SurfaceKind,
    rotationY = 0,
  ): void {
    const collider = new THREE.Mesh(geometry, this.colliderMaterial);
    collider.name = name;
    collider.position.fromArray(position);
    collider.rotation.y = rotationY;
    collider.userData = {
      collision: true,
      surface,
    } satisfies SurfaceTag & { collision: true };
    collider.updateMatrixWorld(true);
    this.collisionRoot.add(collider);
    this.colliders.push(collider);
  }

  private createJerseyBarrier(): THREE.Group {
    const group = new THREE.Group();
    const lower = this.mesh(
      this.box(2.2, 0.45, 0.72),
      this.materials.concrete,
      [0, 0.225, 0],
      { castShadow: true, receiveShadow: true },
    );
    const upper = this.mesh(
      this.box(1.88, 0.55, 0.34),
      this.materials.concrete,
      [0, 0.72, 0],
      { castShadow: true, receiveShadow: true },
    );
    const stripe = this.mesh(
      this.box(2.205, 0.12, 0.735),
      this.materials.safetyYellow,
      [0, 0.56, 0],
    );
    group.add(lower, upper, stripe);
    return group;
  }

  private createDrum(hazard: boolean): THREE.Group {
    const group = new THREE.Group();
    const body = this.mesh(
      this.cylinder(0.31, 0.31, 0.9, 14),
      hazard ? this.materials.safetyYellow : this.materials.rustedMetal,
      [0, 0.45, 0],
      { castShadow: true, receiveShadow: true },
    );
    group.add(body);
    for (const y of [0.13, 0.45, 0.77]) {
      group.add(this.mesh(
        this.torus(0.315, 0.025, 5, 18),
        this.materials.darkMetal,
        [0, y, 0],
      ));
    }
    return group;
  }

  private createPalletStack(x: number, z: number): THREE.Group {
    const group = new THREE.Group();
    for (let level = 0; level < 2; level++) {
      for (let slat = -2; slat <= 2; slat++) {
        group.add(this.mesh(
          this.box(1.25, 0.09, 0.16),
          this.materials.wood,
          [0, 0.16 + level * 0.29, slat * 0.22],
          { castShadow: true, receiveShadow: true },
        ));
      }
      for (const beamZ of [-0.42, 0, 0.42]) {
        group.add(this.mesh(
          this.box(0.15, 0.17, 0.15),
          this.materials.wood,
          [-0.44, 0.07 + level * 0.29, beamZ],
          { castShadow: true },
        ));
        group.add(this.mesh(
          this.box(0.15, 0.17, 0.15),
          this.materials.wood,
          [0.44, 0.07 + level * 0.29, beamZ],
          { castShadow: true },
        ));
      }
    }
    group.position.set(x, 0, z);
    group.rotation.y = (x + z) * 0.07;
    return group;
  }

  private createLampPost(): THREE.Group {
    const group = new THREE.Group();
    const pole = this.mesh(
      this.box(0.15, 4.6, 0.15),
      this.materials.darkMetal,
      [0, 2.3, 0],
      { castShadow: true },
    );
    const arm = this.mesh(
      this.box(1.35, 0.12, 0.12),
      this.materials.darkMetal,
      [0.6, 4.55, 0],
      { castShadow: true },
    );
    const housing = this.mesh(
      this.box(0.58, 0.2, 0.36),
      this.materials.darkMetal,
      [1.2, 4.43, 0],
      { castShadow: true },
    );
    const emitter = this.mesh(
      this.box(0.43, 0.035, 0.24),
      this.materials.emissiveOrange,
      [1.2, 4.3, 0],
    );
    group.add(pole, arm, housing, emitter);
    return group;
  }

  private createPipeSupport(): THREE.Group {
    const group = new THREE.Group();
    for (const x of [-1.1, 1.1]) {
      group.add(this.mesh(
        this.box(0.13, 3.6, 0.13),
        this.materials.darkMetal,
        [x, 1.8, 0],
        { castShadow: true },
      ));
    }
    group.add(this.mesh(
      this.box(2.35, 0.14, 0.14),
      this.materials.darkMetal,
      [0, 3.55, 0],
      { castShadow: true },
    ));
    return group;
  }

  private createDoorFrame(width: number, height: number, depth: number): THREE.Group {
    const group = new THREE.Group();
    for (const x of [-width / 2, width / 2]) {
      group.add(this.mesh(
        this.box(0.16, height, depth),
        this.materials.safetyYellow,
        [x, height / 2, 0],
        { castShadow: true },
      ));
    }
    group.add(this.mesh(
      this.box(width + 0.16, 0.16, depth),
      this.materials.safetyYellow,
      [0, height, 0],
      { castShadow: true },
    ));
    return group;
  }

  private createContainerDoorFrame(): THREE.Group {
    const group = this.createDoorFrame(2.25, 2.45, 0.16);
    for (const x of [-0.56, 0.56]) {
      group.add(this.mesh(
        this.cylinder(0.035, 0.035, 2.15, 6),
        this.materials.darkMetal,
        [x, 1.25, -0.1],
      ));
    }
    return group;
  }

  private createCheckpointGate(): THREE.Group {
    const group = new THREE.Group();
    const frame = this.createDoorFrame(7.5, 3.7, 0.36);
    group.add(frame);
    const sign = this.mesh(
      this.plane(4.5, 0.85),
      this.materials.sign,
      [0, 3.25, 0.22],
    );
    group.add(sign);
    for (const x of [-3.4, 3.4]) {
      const red = this.mesh(
        this.sphere(0.12, 10, 7),
        this.materials.emissiveRed,
        [x, 3.78, 0],
      );
      group.add(red);
    }
    return group;
  }

  private createRailing(length: number, height: number): THREE.Group {
    const group = new THREE.Group();
    const railGeometry = this.box(0.09, 0.09, length);
    for (const y of [height * 0.55, height]) {
      group.add(this.mesh(
        railGeometry,
        this.materials.darkMetal,
        [0, y, 0],
        { castShadow: true },
      ));
    }
    const postGeometry = this.box(0.11, height, 0.11);
    const count = Math.floor(length / 3.4);
    const posts = new THREE.InstancedMesh(postGeometry, this.materials.darkMetal, count);
    const matrix = new THREE.Matrix4();
    for (let i = 0; i < count; i++) {
      matrix.makeTranslation(0, height / 2, -length / 2 + i * 3.4);
      posts.setMatrixAt(i, matrix);
    }
    posts.instanceMatrix.needsUpdate = true;
    posts.castShadow = true;
    posts.computeBoundingSphere();
    group.add(posts);
    return group;
  }

  private createSteamField(origin: THREE.Vector3, count: number, seed: number): SteamField {
    const random = this.random(seed);
    const geometry = new THREE.BufferGeometry();
    const base = new Float32Array(count * 3);
    const speed = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      base[i * 3] = origin.x + (random() - 0.5) * 1.2;
      base[i * 3 + 1] = origin.y - random() * 6.8;
      base[i * 3 + 2] = origin.z + (random() - 0.5) * 1.1;
      speed[i] = 0.42 + random() * 0.55;
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(base.slice(), 3));
    this.geometries.add(geometry);
    const points = new THREE.Points(geometry, this.materials.steam);
    points.frustumCulled = false;
    const field = { points, base, speed };
    this.steamFields.push(field);
    return field;
  }

  private createSky(): THREE.Mesh {
    const material = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      vertexShader: `
        varying vec3 vDirection;
        void main() {
          vDirection = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec3 vDirection;
        void main() {
          vec3 d = normalize(vDirection);
          float height = smoothstep(-0.16, 0.74, d.y);
          vec3 horizon = vec3(0.025, 0.075, 0.115);
          vec3 zenith = vec3(0.004, 0.02, 0.052);
          vec3 color = mix(horizon, zenith, height);

          vec3 glowDirection = normalize(vec3(-0.48, 0.02, -1.0));
          float dusk = pow(max(dot(d, glowDirection), 0.0), 13.0)
            * (1.0 - smoothstep(0.03, 0.38, abs(d.y)));
          color += vec3(0.075, 0.023, 0.008) * dusk;

          float cloud = sin(d.x * 22.0 + d.z * 11.0)
            * sin(d.z * 29.0 - d.x * 7.0);
          cloud = smoothstep(0.48, 0.92, cloud * 0.5 + 0.5)
            * (1.0 - smoothstep(0.08, 0.58, d.y));
          color = mix(color, color * 0.63, cloud * 0.28);
          gl_FragColor = vec4(color, 1.0);
        }
      `,
    });
    this.materials.materials.push(material);
    const sky = new THREE.Mesh(this.sphere(760, 28, 16), material);
    sky.position.set(0, 0, -20);
    sky.renderOrder = -1000;
    sky.frustumCulled = false;
    return sky;
  }

  private createRain(): void {
    const count = 280;
    const random = this.random(0x7a17);
    const base = new Float32Array(count * 3);
    const positions = new Float32Array(count * 6);
    for (let i = 0; i < count; i++) {
      let x = -14 + random() * 28;
      const y = 2 + random() * 14;
      let z = 18 - random() * 78;
      while (x > 1.2 && x < 10.2 && z < -24.2 && z > -38.2) {
        x = -14 + random() * 28;
        z = 18 - random() * 78;
      }
      base.set([x, y, z], i * 3);
      positions.set([x, y, z, x + 0.09, y - 0.72, z + 0.22], i * 6);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geometries.add(geometry);
    const material = new THREE.LineBasicMaterial({
      color: 0xc7e9f3,
      transparent: true,
      opacity: 0.14,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: true,
    });
    this.materials.materials.push(material);
    this.rain = new THREE.LineSegments(geometry, material);
    this.rain.frustumCulled = false;
    this.rain.renderOrder = 3;
    this.rainBase = base;
    this.root.add(this.rain);
  }

  private addLightPool(
    position: THREE.Vector3,
    color: THREE.ColorRepresentation,
    intensity: number,
    distance: number,
  ): void {
    const light = new THREE.PointLight(color, intensity, distance, 2);
    light.position.copy(position);
    this.root.add(light);
  }

  private mesh(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    position: [number, number, number],
    options: { castShadow?: boolean; receiveShadow?: boolean } = {},
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.fromArray(position);
    mesh.castShadow = options.castShadow ?? false;
    mesh.receiveShadow = options.receiveShadow ?? false;
    return mesh;
  }

  private random(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state += 0x6d2b79f5;
      let value = state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
  }

  private track<T extends THREE.BufferGeometry>(geometry: T): T {
    this.geometries.add(geometry);
    return geometry;
  }

  private cached<T extends THREE.BufferGeometry>(key: string, create: () => T): T {
    const cached = this.geometryCache.get(key);
    if (cached) return cached as T;
    const geometry = this.track(create());
    this.geometryCache.set(key, geometry);
    return geometry;
  }

  private box(
    width: number,
    height: number,
    depth: number,
    widthSegments = 1,
    heightSegments = 1,
    depthSegments = 1,
  ): THREE.BoxGeometry {
    const key = `box:${width}:${height}:${depth}:${widthSegments}:${heightSegments}:${depthSegments}`;
    return this.cached(key, () => new THREE.BoxGeometry(
      width,
      height,
      depth,
      widthSegments,
      heightSegments,
      depthSegments,
    ));
  }

  private plane(width: number, height: number): THREE.PlaneGeometry {
    return this.cached(`plane:${width}:${height}`, () => new THREE.PlaneGeometry(width, height));
  }

  private circle(radius: number, segments: number): THREE.CircleGeometry {
    return this.cached(`circle:${radius}:${segments}`, () => new THREE.CircleGeometry(radius, segments));
  }

  private cylinder(
    radiusTop: number,
    radiusBottom: number,
    height: number,
    segments: number,
  ): THREE.CylinderGeometry {
    return this.cached(
      `cylinder:${radiusTop}:${radiusBottom}:${height}:${segments}`,
      () => new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments),
    );
  }

  private sphere(
    radius: number,
    widthSegments: number,
    heightSegments: number,
    phiStart?: number,
    phiLength?: number,
    thetaStart?: number,
    thetaLength?: number,
  ): THREE.SphereGeometry {
    const key = `sphere:${radius}:${widthSegments}:${heightSegments}:${phiStart ?? ''}:`
      + `${phiLength ?? ''}:${thetaStart ?? ''}:${thetaLength ?? ''}`;
    return this.cached(key, () => new THREE.SphereGeometry(
      radius,
      widthSegments,
      heightSegments,
      phiStart,
      phiLength,
      thetaStart,
      thetaLength,
    ));
  }

  private cone(radius: number, height: number, segments: number): THREE.ConeGeometry {
    return this.cached(
      `cone:${radius}:${height}:${segments}`,
      () => new THREE.ConeGeometry(radius, height, segments),
    );
  }

  private torus(
    radius: number,
    tube: number,
    radialSegments: number,
    tubularSegments: number,
    arc?: number,
  ): THREE.TorusGeometry {
    const key = `torus:${radius}:${tube}:${radialSegments}:${tubularSegments}:${arc ?? ''}`;
    return this.cached(
      key,
      () => new THREE.TorusGeometry(radius, tube, radialSegments, tubularSegments, arc),
    );
  }
}
