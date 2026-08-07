/**
 * A calibration level, not the game level.
 *
 * Its only job is to give the render pipeline and the critic loop something
 * honest to judge: real PBR surfaces at real scale under real light, with the
 * specific cases that expose a bad pipeline —
 *
 *  - a large flat floor, where AO banding and shadow acne show first
 *  - hard edges at a grazing angle, where anti-aliasing either works or crawls
 *  - a metal/rough sweep, where tone mapping either holds colour or blows out
 *  - one genuinely bright emitter, where bloom either selects or smears
 *  - deep shadow next to blown highlight, where dynamic range is decided
 *
 * Replaced entirely once the art level exists. It is a test chart with
 * geometry, and it is honest about that.
 */

import * as THREE from 'three';
import type { EngineContext, System } from '../core/contracts.js';

export class TestLevel implements System {
  readonly name = 'level';
  private disposables: Array<{ dispose(): void }> = [];

  init(ctx: EngineContext): void {
    const { scene } = ctx;

    scene.background = new THREE.Color(0x0b0e13);
    scene.fog = new THREE.FogExp2(0x0b0e13, 0.012);

    // ── Lighting ─────────────────────────────────────────────────────────
    // A key with real shadow, a cool sky fill, and a warm bounce. Three lights
    // is enough for a believable interior if their COLOURS disagree; a single
    // white light from above is what makes a scene read as untextured.
    const key = new THREE.DirectionalLight(0xfff1e0, 3.2);
    key.position.set(-8, 14, 6);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 60;
    const d = 22;
    key.shadow.camera.left = -d;
    key.shadow.camera.right = d;
    key.shadow.camera.top = d;
    key.shadow.camera.bottom = -d;
    key.shadow.bias = -0.0008;
    key.shadow.normalBias = 0.02;
    key.shadow.radius = 4;
    scene.add(key);

    const sky = new THREE.HemisphereLight(0x9dc4ff, 0x2a2118, 0.55);
    scene.add(sky);

    const bounce = new THREE.PointLight(0xffa35c, 18, 22, 2);
    bounce.position.set(5, 2.2, -4);
    scene.add(bounce);

    // The emitter bloom is supposed to select. Emissive far above 1 so it sits
    // in HDR range rather than merely being "bright white".
    const lampGeo = new THREE.SphereGeometry(0.16, 24, 16);
    const lampMat = new THREE.MeshStandardMaterial({
      color: 0xffa35c,
      emissive: 0xffa35c,
      emissiveIntensity: 14,
      toneMapped: true,
    });
    const lamp = new THREE.Mesh(lampGeo, lampMat);
    lamp.position.copy(bounce.position);
    scene.add(lamp);
    this.disposables.push(lampGeo, lampMat);

    // ── Floor ────────────────────────────────────────────────────────────
    const floorGeo = new THREE.PlaneGeometry(80, 80, 1, 1);
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0x3a3d42,
      roughness: 0.82,
      metalness: 0.0,
    });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    this.disposables.push(floorGeo, floorMat);

    // ── Material sweep ───────────────────────────────────────────────────
    // Rough → smooth across X, dielectric → metal across Z. If tone mapping is
    // wrong the metal row goes to flat white; if AO is wrong the spheres float.
    const sphereGeo = new THREE.SphereGeometry(0.45, 48, 32);
    this.disposables.push(sphereGeo);
    for (let i = 0; i < 7; i++) {
      for (let j = 0; j < 2; j++) {
        const mat = new THREE.MeshStandardMaterial({
          color: j === 0 ? 0xb8c0cc : 0xc9a227,
          roughness: 0.05 + (i / 6) * 0.9,
          metalness: j,
        });
        const m = new THREE.Mesh(sphereGeo, mat);
        m.position.set(-4.5 + i * 1.5, 0.45, -2 - j * 1.6);
        m.castShadow = true;
        m.receiveShadow = true;
        scene.add(m);
        this.disposables.push(mat);
      }
    }

    // ── Hard edges at grazing angles ─────────────────────────────────────
    // Long thin boxes receding toward the horizon: the classic aliasing test.
    const barGeo = new THREE.BoxGeometry(0.12, 2.4, 0.12);
    const barMat = new THREE.MeshStandardMaterial({
      color: 0x8d9199, roughness: 0.35, metalness: 0.9,
    });
    this.disposables.push(barGeo, barMat);
    for (let i = 0; i < 14; i++) {
      const bar = new THREE.Mesh(barGeo, barMat);
      bar.position.set(-3 + i * 0.55, 1.2, -8 - i * 1.1);
      bar.castShadow = true;
      scene.add(bar);
    }

    // ── Occluder, for contact shadow and AO ──────────────────────────────
    const wallGeo = new THREE.BoxGeometry(9, 3.4, 0.4);
    const wallMat = new THREE.MeshStandardMaterial({
      color: 0x4a4238, roughness: 0.95, metalness: 0.0,
    });
    const wall = new THREE.Mesh(wallGeo, wallMat);
    wall.position.set(-2, 1.7, -13);
    wall.castShadow = true;
    wall.receiveShadow = true;
    scene.add(wall);
    this.disposables.push(wallGeo, wallMat);

    // Camera at eye height, looking down the sweep.
    ctx.camera.position.set(0.6, 1.65, 3.4);
    ctx.camera.rotation.set(-0.06, 0, 0);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
