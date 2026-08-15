import * as THREE from 'three';
import { FrameProfiler, type ProfilerSnapshot } from '../core/profiler.js';
import {
  AI_FIXED_STEP_SECONDS,
  DEFAULT_SECURITY_AGENT_CONFIG,
  MAX_AI_COVER_CANDIDATES,
  MAX_AI_PATH_POINTS,
  SecurityAgent,
} from './SecurityAgent.js';
import { clamp, round } from './math.js';
import type { AgentDebugView, FootstepPayload } from './types.js';
import { ScenarioWorld, TraceRecorder, type TraceEvent } from './evidence/world.js';

type ShotName = 'patrol' | 'investigate' | 'engage' | 'search' | 'cover';

interface ShotResult {
  name: ShotName;
  agent: SecurityAgent;
  world: ScenarioWorld;
  trace: TraceRecorder;
}

interface BudgetVerdict {
  verified: boolean;
  budgetMs: number;
  overBudget: boolean | null;
  verdict: 'PASS' | 'FAIL' | 'UNVERIFIED';
}

const SHOTS: readonly ShotName[] = ['patrol', 'investigate', 'engage', 'search', 'cover'];
const FRAME_BUDGET_MS = 16.7;
const canvas = document.querySelector<HTMLCanvasElement>('#ai-debug-canvas');
if (!canvas) throw new Error('AI harness canvas is missing');

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x071017);
scene.fog = new THREE.FogExp2(0x071017, 0.027);

const camera = new THREE.PerspectiveCamera(43, innerWidth / innerHeight, 0.1, 80);
camera.position.set(11.5, 12.5, 15.5);
camera.lookAt(0, 0.5, 4.5);

scene.add(new THREE.HemisphereLight(0x9ad7e6, 0x0c1115, 1.2));
const keyLight = new THREE.DirectionalLight(0xffe2a6, 3.2);
keyLight.position.set(-6, 12, 5);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(1024, 1024);
keyLight.shadow.camera.left = -18;
keyLight.shadow.camera.right = 18;
keyLight.shadow.camera.top = 18;
keyLight.shadow.camera.bottom = -18;
scene.add(keyLight);
const rimLight = new THREE.PointLight(0x37c9ef, 18, 35, 2);
rimLight.position.set(7, 5, -2);
scene.add(rimLight);

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(38, 38),
  new THREE.MeshStandardMaterial({
    color: 0x17232a,
    roughness: 0.92,
    metalness: 0.08,
  }),
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

const grid = new THREE.GridHelper(38, 38, 0x2d6673, 0x1a3942);
grid.position.y = 0.012;
const gridMaterial = grid.material as THREE.LineBasicMaterial;
gridMaterial.transparent = true;
gridMaterial.opacity = 0.38;
scene.add(grid);

function industrialBlock(
  x: number,
  z: number,
  width: number,
  height: number,
  depth: number,
  color: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(width, height, depth),
    new THREE.MeshStandardMaterial({
      color,
      roughness: 0.68,
      metalness: 0.42,
    }),
  );
  mesh.position.set(x, height * 0.5, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  return mesh;
}

industrialBlock(-3.8, 4.6, 2.2, 2.4, 1.5, 0x3b4b50);
industrialBlock(3.4, 4.8, 2.8, 1.45, 0.8, 0x59634f);
industrialBlock(0.4, 3.7, 1.6, 1.65, 1.25, 0x51463b);
industrialBlock(-7.4, 8.6, 3.4, 4.2, 2.2, 0x26363c);
industrialBlock(7.2, 8.2, 4.5, 3.2, 1.4, 0x27393f);

const pipeMaterial = new THREE.MeshStandardMaterial({
  color: 0x43545a,
  roughness: 0.48,
  metalness: 0.65,
});
for (const x of [-6.4, 6.2]) {
  const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 13, 16), pipeMaterial);
  pipe.rotation.x = Math.PI / 2;
  pipe.position.set(x, 3.2, 5.5);
  pipe.castShadow = true;
  scene.add(pipe);
}

const proxy = new THREE.Group();
const proxyMaterial = new THREE.MeshStandardMaterial({
  color: 0xe5ad42,
  emissive: 0x2b1703,
  roughness: 0.38,
  metalness: 0.45,
});
const proxyWire = new THREE.MeshBasicMaterial({
  color: 0xffdf82,
  wireframe: true,
  transparent: true,
  opacity: 0.48,
});
const body = new THREE.Mesh(new THREE.BoxGeometry(0.75, 1.2, 0.52), proxyMaterial);
body.position.y = 1.05;
body.castShadow = true;
proxy.add(body);
const bodyWire = new THREE.Mesh(new THREE.BoxGeometry(0.86, 1.32, 0.63), proxyWire);
bodyWire.position.y = 1.05;
proxy.add(bodyWire);
const head = new THREE.Mesh(new THREE.OctahedronGeometry(0.35, 0), proxyMaterial);
head.position.y = 1.9;
head.castShadow = true;
proxy.add(head);
const facing = new THREE.ArrowHelper(
  new THREE.Vector3(0, 0, 1),
  new THREE.Vector3(0, 0.16, 0),
  1.45,
  0xffd15d,
  0.28,
  0.18,
);
proxy.add(facing);
scene.add(proxy);

const target = new THREE.Group();
const targetColumn = new THREE.Mesh(
  new THREE.CylinderGeometry(0.25, 0.25, 1.5, 12),
  new THREE.MeshStandardMaterial({
    color: 0xe75048,
    emissive: 0x3c0805,
    roughness: 0.42,
  }),
);
targetColumn.position.y = 0.75;
target.add(targetColumn);
const targetRing = new THREE.Mesh(
  new THREE.TorusGeometry(0.52, 0.035, 8, 32),
  new THREE.MeshBasicMaterial({ color: 0xff7c70 }),
);
targetRing.rotation.x = Math.PI / 2;
targetRing.position.y = 0.04;
target.add(targetRing);
scene.add(target);

function createVisionCone(): THREE.Group {
  const group = new THREE.Group();
  const segments = 40;
  const radius = DEFAULT_SECURITY_AGENT_CONFIG.visionDistance;
  const halfAngle = DEFAULT_SECURITY_AGENT_CONFIG.visionHalfAngleRadians;
  const vertices: number[] = [0, 0.03, 0];
  for (let index = 0; index <= segments; index++) {
    const angle = -halfAngle + (index / segments) * halfAngle * 2;
    vertices.push(Math.sin(angle) * radius, 0.03, Math.cos(angle) * radius);
  }
  const indices: number[] = [];
  for (let index = 1; index <= segments; index++) indices.push(0, index, index + 1);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({
      color: 0x2fc8e8,
      transparent: true,
      opacity: 0.095,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  group.add(mesh);

  const boundaryPoints: THREE.Vector3[] = [new THREE.Vector3()];
  for (let index = 0; index <= segments; index++) {
    const angle = -halfAngle + (index / segments) * halfAngle * 2;
    boundaryPoints.push(new THREE.Vector3(
      Math.sin(angle) * radius,
      0.04,
      Math.cos(angle) * radius,
    ));
  }
  boundaryPoints.push(new THREE.Vector3());
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(boundaryPoints),
    new THREE.LineBasicMaterial({
      color: 0x42dcf8,
      transparent: true,
      opacity: 0.72,
    }),
  );
  group.add(line);
  return group;
}

const visionCone = createVisionCone();
scene.add(visionCone);

const memoryMarker = new THREE.Group();
const memoryRing = new THREE.Mesh(
  new THREE.TorusGeometry(0.48, 0.055, 10, 40),
  new THREE.MeshBasicMaterial({ color: 0xffce5a }),
);
memoryRing.rotation.x = Math.PI / 2;
memoryMarker.add(memoryRing);
const memoryPole = new THREE.Line(
  new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 2.2, 0),
  ]),
  new THREE.LineDashedMaterial({
    color: 0xffce5a,
    dashSize: 0.15,
    gapSize: 0.1,
  }),
);
memoryPole.computeLineDistances();
memoryMarker.add(memoryPole);
scene.add(memoryMarker);

const pathPositions = new Float32Array(MAX_AI_PATH_POINTS * 3);
const pathGeometry = new THREE.BufferGeometry();
pathGeometry.setAttribute('position', new THREE.BufferAttribute(pathPositions, 3));
pathGeometry.setDrawRange(0, 0);
const pathLine = new THREE.Line(
  pathGeometry,
  new THREE.LineBasicMaterial({ color: 0x75ed98 }),
);
scene.add(pathLine);

const coverMarkers: THREE.Group[] = [];
for (let index = 0; index < MAX_AI_COVER_CANDIDATES; index++) {
  const marker = new THREE.Group();
  const stem = new THREE.Mesh(
    new THREE.CylinderGeometry(0.07, 0.07, 1, 10),
    new THREE.MeshBasicMaterial({ color: 0xf28c52 }),
  );
  stem.position.y = 0.5;
  stem.name = 'stem';
  marker.add(stem);
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.34, 0.045, 8, 28),
    new THREE.MeshBasicMaterial({ color: 0xf28c52 }),
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.05;
  ring.name = 'ring';
  marker.add(ring);
  marker.visible = false;
  coverMarkers.push(marker);
  scene.add(marker);
}

const stateElement = required('[data-state]');
const shotElement = required('[data-shot]');
const tickElement = required('[data-tick]');
const losElement = required('[data-los]');
const memoryElement = required('[data-memory]');
const pathCountElement = required('[data-path-count]');
const coverListElement = required('[data-cover-list]');
const timelineElement = required('[data-timeline]');
const gpuSupportedElement = required('[data-gpu-supported]');
const gpuBitsElement = required('[data-gpu-bits]');
const gpuDisjointElement = required('[data-gpu-disjoint]');
const gpuElement = required('[data-gpu]');
const cpuElement = required('[data-cpu]');
const rafElement = required('[data-raf]');
const budgetElement = required('[data-budget]');
const budgetMedianElement = required('[data-budget-median]');
const budgetP95Element = required('[data-budget-p95]');
const verdictElement = required('[data-verdict]');

function required(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`AI harness is missing ${selector}`);
  return element;
}

function runTicks(agent: SecurityAgent, count: number): void {
  for (let index = 0; index < count; index++) agent.fixedUpdate(AI_FIXED_STEP_SECONDS);
}

function buildShot(name: ShotName): ShotResult {
  const world = new ScenarioWorld();
  const trace = new TraceRecorder();
  const agent = new SecurityAgent(
    'security-debug',
    0x51c0_7a11,
    {
      perception: world,
      navigation: world,
      cover: world,
      combat: trace,
      observer: trace,
    },
  );
  agent.setPose({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
  agent.setHome({ x: 0, y: 0, z: -1.5 });
  trace.stimulus(0, 'shot-start', { name });

  switch (name) {
    case 'patrol':
      runTicks(agent, 30);
      break;
    case 'investigate': {
      const footstep: FootstepPayload = {
        position: { x: -3.2, y: 0, z: 4.4 },
        surface: 'metal',
        loud: 0.82,
      };
      trace.stimulus(0, 'Footstep', {
        position: footstep.position,
        surface: footstep.surface,
        loud: footstep.loud,
      });
      agent.hearFootstep(footstep);
      runTicks(agent, 42);
      break;
    }
    case 'engage':
      world.targetPresent = true;
      world.occluded = false;
      trace.stimulus(0, 'LOS-on');
      runTicks(agent, 110);
      break;
    case 'search':
      world.targetPresent = true;
      world.occluded = false;
      trace.stimulus(0, 'LOS-on');
      runTicks(agent, 110);
      trace.stimulus(110, 'occlusion-on');
      world.occluded = true;
      runTicks(agent, 52);
      break;
    case 'cover':
      world.targetPresent = true;
      world.occluded = false;
      trace.stimulus(0, 'LOS-on');
      runTicks(agent, 290);
      break;
  }

  return { name, agent, world, trace };
}

function formatMs(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(3)} ms`;
}

function budgetVerdict(snapshot: ProfilerSnapshot): BudgetVerdict {
  const verified = snapshot.gpuSupported
    && snapshot.gpuDisjointCount === 0
    && snapshot.gpuFrameMs.p95 !== null
    && snapshot.cpuFrameMs.p95 !== null
    && snapshot.budgetFrameMs.p95 !== null;
  if (!verified) {
    return {
      verified: false,
      budgetMs: FRAME_BUDGET_MS,
      overBudget: null,
      verdict: 'UNVERIFIED',
    };
  }
  const overBudget = (snapshot.budgetFrameMs.p95 ?? Number.POSITIVE_INFINITY) > FRAME_BUDGET_MS;
  return {
    verified: true,
    budgetMs: FRAME_BUDGET_MS,
    overBudget,
    verdict: overBudget ? 'FAIL' : 'PASS',
  };
}

function updatePath(debug: Readonly<AgentDebugView>): void {
  for (let index = 0; index < debug.path.count; index++) {
    const point = debug.path.points[index];
    pathPositions[index * 3] = point.x;
    pathPositions[index * 3 + 1] = point.y + 0.12;
    pathPositions[index * 3 + 2] = point.z;
  }
  const attribute = pathGeometry.getAttribute('position') as THREE.BufferAttribute;
  attribute.needsUpdate = true;
  pathGeometry.setDrawRange(0, debug.path.count);
}

function updateCover(debug: Readonly<AgentDebugView>): void {
  const rows: string[] = [];
  for (let index = 0; index < coverMarkers.length; index++) {
    const marker = coverMarkers[index];
    const visible = index < debug.cover.count;
    marker.visible = visible;
    if (!visible) continue;
    const candidate = debug.cover.candidates[index];
    const selected = index === debug.selectedCoverIndex;
    marker.position.set(candidate.position.x, candidate.position.y, candidate.position.z);
    const normalized = clamp(candidate.score, 0, 1);
    const color = new THREE.Color().setHSL(0.04 + normalized * 0.28, 0.82, 0.58);
    const stem = marker.getObjectByName('stem') as THREE.Mesh;
    const ring = marker.getObjectByName('ring') as THREE.Mesh;
    (stem.material as THREE.MeshBasicMaterial).color.copy(selected ? new THREE.Color(0xffe18f) : color);
    (ring.material as THREE.MeshBasicMaterial).color.copy(selected ? new THREE.Color(0xffffff) : color);
    stem.scale.y = 0.45 + normalized * 2.25;
    stem.position.y = stem.scale.y * 0.5;
    ring.scale.setScalar(selected ? 1.45 : 1);
    rows.push(
      `<div class="cover-row${selected ? ' is-selected' : ''}">`
      + `<span>${selected ? '▶ ' : ''}${candidate.id}</span>`
      + `<span>${candidate.score.toFixed(3)}</span></div>`,
    );
  }
  coverListElement.innerHTML = rows.length > 0
    ? rows.join('')
    : 'No scored candidates in this shot.';
}

function updateTimeline(events: readonly TraceEvent[]): void {
  timelineElement.replaceChildren();
  const visibleEvents = events.slice(-9);
  for (const event of visibleEvents) {
    const item = document.createElement('li');
    const isIntent = event.kind !== 'transition' && event.kind !== 'stimulus';
    if (isIntent) item.className = 'intent';
    const label = event.kind === 'transition'
      ? `${String(event.data.from)} → ${String(event.data.to)}`
      : event.kind === 'stimulus'
        ? String(event.data.label)
        : event.kind;
    item.textContent = `${event.atSeconds.toFixed(2)}  ${label}`;
    timelineElement.append(item);
  }
}

let current = buildShot('patrol');

function presentShot(result: ShotResult): Record<string, unknown> {
  current = result;
  const debug = result.agent.getDebugView();
  proxy.position.set(debug.position.x, debug.position.y, debug.position.z);
  visionCone.position.copy(proxy.position);
  visionCone.rotation.y = Math.atan2(debug.forward.x, debug.forward.z);
  target.visible = result.world.targetPresent;
  target.position.set(
    result.world.targetPosition.x,
    0,
    result.world.targetPosition.z,
  );
  memoryMarker.visible = debug.hasLastKnownPosition;
  memoryMarker.position.set(
    debug.lastKnownPosition.x,
    debug.lastKnownPosition.y + 0.03,
    debug.lastKnownPosition.z,
  );
  updatePath(debug);
  updateCover(debug);
  updateTimeline(result.trace.events);

  stateElement.textContent = debug.state;
  shotElement.textContent = result.name;
  tickElement.textContent = String(debug.tick);
  losElement.textContent = String(debug.targetVisible);
  losElement.style.color = debug.targetVisible ? '#72f0aa' : '#d8f5fc';
  memoryElement.textContent = debug.memoryConfidence.toFixed(3);
  pathCountElement.textContent = String(debug.path.count);
  document.documentElement.dataset.shot = result.name;
  return {
    shot: result.name,
    state: debug.state,
    tick: debug.tick,
    targetVisible: debug.targetVisible,
    memoryConfidence: round(debug.memoryConfidence, 6),
    pathCount: debug.path.count,
    coverCount: debug.cover.count,
    selectedCoverIndex: debug.selectedCoverIndex,
  };
}

function setShot(name: string): Record<string, unknown> {
  const valid = SHOTS.find((shot) => shot === name) ?? 'patrol';
  return presentShot(buildShot(valid));
}

presentShot(current);

const profiler = new FrameProfiler(renderer);
let lastFrameMs = performance.now();
let framesSeen = 0;
let overlayCountdown = 0;

function renderProfiler(): void {
  const snapshot = profiler.snapshot();
  const verdict = budgetVerdict(snapshot);
  gpuSupportedElement.textContent = String(snapshot.gpuSupported);
  gpuBitsElement.textContent = String(snapshot.gpuCounterBits);
  gpuDisjointElement.textContent = String(snapshot.gpuDisjointCount);
  gpuElement.textContent = formatMs(snapshot.gpuFrameMs.p95);
  cpuElement.textContent = formatMs(snapshot.cpuFrameMs.p95);
  rafElement.textContent = formatMs(snapshot.rafIntervalMs.p95);
  budgetElement.textContent = formatMs(snapshot.budgetFrameMs.p95);
  budgetMedianElement.textContent = formatMs(snapshot.budgetFrameMsMedian);
  budgetP95Element.textContent = formatMs(snapshot.budgetFrameMsP95);
  verdictElement.textContent = `${verdict.verdict} · ${FRAME_BUDGET_MS.toFixed(1)} ms`;
  verdictElement.dataset.status = verdict.verdict.toLowerCase();
}

function frame(nowMs: number): void {
  const frameToken = profiler.beginFrame(nowMs - lastFrameMs);
  lastFrameMs = nowMs;
  profiler.beginGpu();
  try {
    renderer.render(scene, camera);
  } finally {
    profiler.endGpu();
    profiler.endFrame(frameToken);
  }
  if (--overlayCountdown <= 0) {
    renderProfiler();
    overlayCountdown = 12;
  }
  if (++framesSeen === 18) {
    (window as unknown as Record<string, unknown>).__FRAME_READY__ = true;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function gpuInfo(): Record<string, unknown> {
  const gl = renderer.getContext();
  const extension = gl.getExtension('WEBGL_debug_renderer_info');
  const vendor = extension
    ? gl.getParameter(extension.UNMASKED_VENDOR_WEBGL)
    : gl.getParameter(gl.VENDOR);
  const rendererName = extension
    ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL)
    : gl.getParameter(gl.RENDERER);
  return {
    webgl2: typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext,
    vendor: String(vendor),
    renderer: String(rendererName),
  };
}

function report(): Record<string, unknown> {
  const snapshot = profiler.snapshot();
  return {
    shot: current.name,
    state: current.agent.getDebugView().state,
    gpu: gpuInfo(),
    profiler: snapshot,
    budget: budgetVerdict(snapshot),
    drawCalls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    caveats: {
      characterArt: 'No character model or animation is provided; the gold shape is an abstract debug proxy.',
      combatFeel: 'Subjective combat feel remains unverified.',
      integration: 'No production player, weapon, authored level, collision, navigation, or health authority is connected.',
    },
  };
}

Object.assign(window as unknown as Record<string, unknown>, {
  __AI_HARNESS__: {
    shots: SHOTS,
    setShot,
    report,
    profiler,
    resetProfiler: () => profiler.reset(),
  },
});

const requestedShot = new URLSearchParams(location.search).get('shot') ?? 'patrol';
setShot(requestedShot);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight, false);
});

addEventListener('pagehide', () => {
  profiler.dispose();
  renderer.dispose();
});
