import { inject } from "@vercel/analytics";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  initializeEngagementTracking,
  trackEngagement,
} from "../analytics/engagementTracker";
import { FIXED_TIME_STEP, MAX_FRAME_DELTA, MAX_SUBSTEPS } from "../config";
import { WebPhysicsSolver } from "../physics/WebPhysicsSolver";
import {
  AdaptiveQualityController,
  type AdaptiveQualityLevel,
} from "../rendering/AdaptiveQuality";
import { SpiderChoreographer } from "../spider/choreography/index";
import { loadSpiderRig } from "../spider/SpiderRigLoader";
import { SPIDER_LEG_IDS, type SpiderLegId } from "../spider/SpiderRigSpec";
import { createWebNetworkTraversal } from "../traversal/index";
import { createCobweb, DEFAULT_LEGSPAN } from "../web/createCobweb";
import { createEnclosureLayout } from "../web/enclosureLayout";
import { DewSystem, Firefly, LiveWeatherAtmosphere } from "./Atmosphere";
import {
  PreyWrappingSystem,
  type RearLegWorkPose,
} from "./PreyWrappingSystem";
import { LegGym } from "./LegGym";
import { RigDiagnostics } from "./RigDiagnostics";
import { SilkRenderer } from "./SilkRenderer";
import { SpiderDroppingSystem } from "./SpiderDroppingSystem";
import {
  isGroomableLegId,
  SpiderGroomingSystem,
} from "./SpiderGroomingSystem";
import {
  chooseAutonomousBehavior,
  chooseTouchResponse,
  classifyGesture,
  cautionOf,
  curiosityOf,
  deriveTemperament,
  disruptionNear,
  loadVesperState,
  noteBehaviorTaken,
  pickLocation,
  pruneInvalidLocations,
  recordCalmResponse,
  recordGesture,
  recordKeeperMealCompleted,
  recordLocationEvent,
  saveVesperState,
  tickStress,
  type GestureKind,
} from "./VesperMemory";
import "./showcase.css";

inject();
initializeEngagementTracking();

const canvas = document.getElementById("stage") as HTMLCanvasElement;
const status = document.getElementById("status") as HTMLElement;
const habitat = document.getElementById("habitat") as HTMLElement;
const stateLabel = document.getElementById("state-label") as HTMLElement;
const activityLabel = document.getElementById("activity") as HTMLElement;
const hungerMeter = document.getElementById("hunger-meter") as HTMLElement;
const hungerLabel = document.getElementById("hunger-label") as HTMLElement;
const petName = document.getElementById("pet-name") as HTMLElement;
const clock = document.getElementById("clock") as HTMLElement;
const toast = document.getElementById("toast") as HTMLElement;
const reticle = document.getElementById("reticle") as HTMLElement;
const instinctLabel = document.getElementById("instinct-label") as HTMLElement;
const autonomyCount = document.getElementById("autonomy-count") as HTMLElement;
const autonomyLog = document.getElementById("autonomy-log") as HTMLOListElement;
const feedButton = document.querySelector<HTMLButtonElement>("[data-action='feed']");
const followButton = document.querySelector<HTMLButtonElement>("[data-action='follow']");
const panelToggles = document.querySelectorAll<HTMLButtonElement>("[data-panel-toggle]");

const mobileExperience =
  window.matchMedia("(max-width: 820px), (pointer: coarse)").matches ||
  Math.min(window.innerWidth, window.innerHeight) <= 560;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
const fullPixelRatio = Math.min(window.devicePixelRatio || 1, mobileExperience ? 1.35 : 2);
renderer.setPixelRatio(fullPixelRatio);
renderer.setClearColor(0x050504, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.88;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = mobileExperience ? THREE.BasicShadowMap : THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x050504, 0.013);

const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 400);
camera.position.set(14, 8, 15);

const controls = new OrbitControls(camera, canvas);
controls.target.set(-2, 7, -2);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.rotateSpeed = mobileExperience ? 0.62 : 1;
controls.zoomSpeed = mobileExperience ? 0.82 : 1;
controls.screenSpacePanning = true;
controls.touches.ONE = THREE.TOUCH.ROTATE;
controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;
controls.minDistance = 0.8;
controls.maxDistance = 70;

// Lighting: a cool key from above and a warm rim from behind. The rim is what
// makes a black, glossy abdomen read as an object rather than a hole in the
// screen — without it she disappears against the background entirely.
const ambient = new THREE.AmbientLight(0x2a3040, 0.43);
scene.add(ambient);
const key = new THREE.DirectionalLight(0xbfd4ff, 2.2);
key.position.set(3, 6, 2);
key.castShadow = !mobileExperience;
scene.add(key);
const rim = new THREE.DirectionalLight(0xff7a5c, 1.4);
rim.position.set(-4, 1.5, -3.5);
scene.add(rim);
const fill = new THREE.DirectionalLight(0x6f86b8, 0.7);
fill.position.set(-2, -3, 3);
scene.add(fill);
const redLamp = new THREE.PointLight(0xd31228, 0, 26, 1.8);
redLamp.position.set(2, 9, 4);
scene.add(redLamp);
const WARM_POINT_INTENSITY = 55;
const WARM_WASH_INTENSITY = 620;
const WARM_FILL_INTENSITY = 1.15;
const cornerLamp = new THREE.PointLight(0xffb45f, WARM_POINT_INTENSITY, 30, 1.55);
cornerLamp.position.set(-7.25, 12.5, 4.75);
scene.add(cornerLamp);

// A point source by itself mostly reads as a bright dot at habitat scale. Pair
// the visible bulb with a broad, feathered spot aimed through the middle of the
// web so the lamp actually paints warm light across Vesper and the back wall.
const warmWashTarget = new THREE.Object3D();
warmWashTarget.position.set(-2, 6.2, -2.2);
scene.add(warmWashTarget);
const warmWash = new THREE.SpotLight(
  0xffa84f,
  WARM_WASH_INTENSITY,
  34,
  Math.PI * 0.24,
  0.82,
  1.35,
);
warmWash.position.copy(cornerLamp.position);
warmWash.target = warmWashTarget;
scene.add(warmWash);
const warmFill = new THREE.DirectionalLight(0xffb35d, WARM_FILL_INTENSITY);
warmFill.position.copy(cornerLamp.position);
warmFill.target = warmWashTarget;
scene.add(warmFill);

const enclosure = createEnclosureLayout(DEFAULT_LEGSPAN);

/** Deterministic 0..1 hash of a position, for jitter that never cracks a seam. */
function positionHash(x: number, y: number, z: number): number {
  const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * Local substrate relief, in enclosure-centered coordinates. Shared between the
 * soil mesh and everything that has to sit on it — pebbles, rocks, stick bases
 * — so nothing floats and nothing drowns.
 */
function substrateHeight(localX: number, localZ: number): number {
  const radial = Math.hypot(localX, localZ);
  // Substrate banks up slightly where it was poured against the glass.
  const bank = THREE.MathUtils.smoothstep(radial, enclosure.radius * 0.7, enclosure.radius) * 0.2;
  return (
    0.11 * Math.sin(localX * 0.9 + 1.7) * Math.sin(localZ * 1.1 + 0.4) +
    0.05 * Math.sin(localX * 2.6) * Math.sin(localZ * 3.1 + 2) +
    bank -
    0.05
  );
}

function buildSubstrate(): void {
  const segments = mobileExperience ? 36 : 60;
  const geometry = new THREE.PlaneGeometry(
    enclosure.radius * 2,
    enclosure.radius * 2,
    segments,
    segments,
  );
  geometry.rotateX(-Math.PI / 2);
  const positions = geometry.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(positions.count * 3);
  const soil = new THREE.Color(0x120e09);
  const litter = new THREE.Color(0x2b2013);
  const blend = new THREE.Color();

  for (let i = 0; i < positions.count; i += 1) {
    let x = positions.getX(i);
    let z = positions.getZ(i);
    const radial = Math.hypot(x, z);
    if (radial > enclosure.radius) {
      // The square grid gets pressed into a disk: outside vertices collapse to
      // the rim, which keeps the interior dense enough to hold the relief.
      const scale = enclosure.radius / radial;
      x *= scale;
      z *= scale;
      positions.setX(i, x);
      positions.setZ(i, z);
    }
    const grain = positionHash(x, 0, z);
    positions.setY(i, substrateHeight(x, z) + grain * 0.04);
    blend.copy(soil).lerp(litter, grain * grain * 0.9);
    colors[i * 3] = blend.r;
    colors[i * 3 + 1] = blend.g;
    colors[i * 3 + 2] = blend.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();

  const substrate = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 }),
  );
  substrate.position.set(enclosure.centerX, 0, enclosure.centerZ);
  substrate.receiveShadow = true;
  scene.add(substrate);

  // Loose bark chips and pebbles pressed into the soil.
  const pebbleCount = mobileExperience ? 70 : 150;
  const pebbles = new THREE.InstancedMesh(
    new THREE.DodecahedronGeometry(1, 0),
    new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 }),
    pebbleCount,
  );
  const matrix = new THREE.Matrix4();
  const spot = new THREE.Vector3();
  const tumble = new THREE.Quaternion();
  const squash = new THREE.Vector3();
  const tint = new THREE.Color();
  for (let i = 0; i < pebbleCount; i += 1) {
    const angle = Math.random() * Math.PI * 2;
    const radial = Math.sqrt(Math.random()) * (enclosure.radius - 0.4);
    const localX = Math.cos(angle) * radial;
    const localZ = Math.sin(angle) * radial;
    const size = 0.05 + Math.random() * Math.random() * 0.17;
    spot.set(
      enclosure.centerX + localX,
      substrateHeight(localX, localZ) + size * 0.3,
      enclosure.centerZ + localZ,
    );
    tumble.setFromEuler(
      new THREE.Euler(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI),
    );
    squash.set(size, size * 0.65, size * (0.75 + Math.random() * 0.5));
    matrix.compose(spot, tumble, squash);
    pebbles.setMatrixAt(i, matrix);
    const warmth = Math.random();
    tint.setRGB(0.12 + warmth * 0.08, 0.1 + warmth * 0.05, 0.08 + warmth * 0.03);
    pebbles.setColorAt(i, tint);
  }
  pebbles.receiveShadow = true;
  scene.add(pebbles);
}

function buildStick(spec: (typeof enclosure.sticks)[number]): THREE.Mesh {
  const base = new THREE.Vector3(...spec.base);
  const tip = new THREE.Vector3(...spec.tip);
  const along = tip.clone().sub(base);
  const length = along.length();
  // A little extra length below the base sinks the cut end into the substrate.
  const sink = 0.5;
  const geometry = new THREE.CylinderGeometry(spec.radius * 0.45, spec.radius, length + sink, 9, 7);
  geometry.translate(0, (length + sink) / 2 - sink, 0);

  // Wood is never straight: bow the shaft and roughen the surface, with the
  // jitter keyed to position so shared seam vertices stay welded.
  const positions = geometry.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < positions.count; i += 1) {
    const y = positions.getY(i);
    const wave = Math.sin((y / length) * Math.PI) * spec.radius * 0.7;
    const rough =
      (positionHash(positions.getX(i), y, positions.getZ(i)) - 0.5) * spec.radius * 0.35;
    positions.setX(i, positions.getX(i) + wave + rough);
    positions.setZ(i, positions.getZ(i) + rough * 0.6);
  }
  geometry.computeVertexNormals();

  const bark = new THREE.MeshStandardMaterial({ color: 0x27190f, roughness: 0.96, metalness: 0 });
  const stick = new THREE.Mesh(geometry, bark);
  stick.position.copy(base);
  stick.position.y += substrateHeight(base.x - enclosure.centerX, base.z - enclosure.centerZ);
  stick.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), along.normalize());
  stick.castShadow = true;
  stick.receiveShadow = true;

  // Snapped-off twig stubs, so the branch reads as wood rather than dowel.
  for (const [at, yaw, tilt] of [
    [0.34, 0.7, 1.05],
    [0.62, 2.9, 0.85],
    [0.83, 4.4, 1.2],
  ] as const) {
    const reach = 0.5 + spec.radius * 3;
    const twig = new THREE.Mesh(
      new THREE.CylinderGeometry(spec.radius * 0.18, spec.radius * 0.34, reach, 6),
      bark,
    );
    twig.position.y = at * length;
    twig.rotation.set(0, yaw, tilt);
    twig.translateY(reach / 2);
    twig.castShadow = true;
    stick.add(twig);
  }
  return stick;
}

function buildRock(spec: (typeof enclosure.rocks)[number]): THREE.Mesh {
  const geometry = new THREE.IcosahedronGeometry(spec.radius, 1);
  const positions = geometry.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < positions.count; i += 1) {
    const x = positions.getX(i);
    const y = positions.getY(i);
    const z = positions.getZ(i);
    // Position-keyed jitter keeps duplicated face vertices welded.
    const bump = 1 + (positionHash(x, y, z) - 0.5) * 0.38;
    positions.setXYZ(i, x * bump, Math.max(y * bump * 0.72, -spec.radius * 0.4), z * bump);
  }
  geometry.computeVertexNormals();

  const rock = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ color: 0x1d1e20, roughness: 0.9, metalness: 0.02 }),
  );
  rock.position.set(
    spec.x,
    spec.radius * 0.38 + substrateHeight(spec.x - enclosure.centerX, spec.z - enclosure.centerZ),
    spec.z,
  );
  rock.rotation.y = positionHash(spec.x, 0, spec.z) * Math.PI * 2;
  rock.castShadow = true;
  rock.receiveShadow = true;
  return rock;
}

function buildMeshLid(): THREE.Group {
  const lid = new THREE.Group();
  lid.position.set(enclosure.centerX, enclosure.height, enclosure.centerZ);

  // A faint backing keeps the opening legible against the black background,
  // while the crossed wires make it read as ventilation mesh rather than a
  // solid ceiling. Each line is clipped analytically to the circular rim.
  const backing = new THREE.Mesh(
    new THREE.CircleGeometry(enclosure.radius, 72),
    new THREE.MeshStandardMaterial({
      color: 0x090b0b,
      roughness: 0.9,
      metalness: 0.08,
      transparent: true,
      opacity: 0.42,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  backing.rotation.x = Math.PI / 2;
  lid.add(backing);

  const spacing = mobileExperience ? 0.42 : 0.3;
  const wirePositions: number[] = [];
  for (let offset = -enclosure.radius + spacing; offset < enclosure.radius; offset += spacing) {
    const halfChord = Math.sqrt(enclosure.radius * enclosure.radius - offset * offset);
    wirePositions.push(-halfChord, -0.025, offset, halfChord, -0.025, offset);
    wirePositions.push(offset, -0.025, -halfChord, offset, -0.025, halfChord);
  }
  const wireGeometry = new THREE.BufferGeometry();
  wireGeometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(wirePositions, 3),
  );
  const wire = new THREE.LineSegments(
    wireGeometry,
    new THREE.LineBasicMaterial({ color: 0x4a5050, transparent: true, opacity: 0.48 }),
  );
  lid.add(wire);

  const innerRim = new THREE.Mesh(
    new THREE.TorusGeometry(enclosure.radius - 0.08, 0.08, 8, 72),
    new THREE.MeshStandardMaterial({ color: 0x24282b, roughness: 0.5, metalness: 0.7 }),
  );
  innerRim.rotation.x = Math.PI / 2;
  lid.add(innerRim);
  return lid;
}

function buildEnclosure(): void {
  const bulb = new THREE.Mesh(
    new THREE.SphereGeometry(0.09, 12, 8),
    new THREE.MeshStandardMaterial({
      color: 0xffc27a,
      emissive: 0xff7f32,
      emissiveIntensity: 1.8,
      roughness: 0.25,
    }),
  );
  bulb.position.copy(cornerLamp.position);
  scene.add(bulb);

  // The glass wall, rendered inside-out: from outside the cylinder the camera
  // sees straight through the near side, while the far side reads as the curved
  // back of the jar catching the lamps.
  const glassGeometry = new THREE.CylinderGeometry(
    enclosure.radius,
    enclosure.radius,
    enclosure.height,
    72,
    1,
    true,
  );
  const glass = new THREE.Mesh(
    glassGeometry,
    new THREE.MeshStandardMaterial({
      color: 0x0a0d0d,
      roughness: 0.38,
      metalness: 0.06,
      side: THREE.BackSide,
    }),
  );
  glass.position.set(enclosure.centerX, enclosure.height / 2, enclosure.centerZ);
  glass.receiveShadow = true;
  scene.add(glass);

  // A subtle near-side sheen catches motion and highlights without hiding the
  // spider. The opaque BackSide mesh above remains the dark far wall.
  const nearGlass = new THREE.Mesh(
    glassGeometry,
    new THREE.MeshPhysicalMaterial({
      color: 0xb7c8ca,
      roughness: 0.16,
      metalness: 0,
      transparent: true,
      opacity: 0.045,
      depthWrite: false,
      clearcoat: 1,
      clearcoatRoughness: 0.2,
      side: THREE.FrontSide,
    }),
  );
  nearGlass.position.copy(glass.position);
  nearGlass.renderOrder = 4;
  scene.add(nearGlass);

  scene.add(buildMeshLid());

  // Rim bands top and bottom: the silhouette that tells the eye "this is a jar"
  // even when the glass itself has vanished.
  for (const y of [0.1, enclosure.height - 0.1]) {
    const band = new THREE.Mesh(
      new THREE.CylinderGeometry(enclosure.radius + 0.05, enclosure.radius + 0.05, 0.24, 72, 1, true),
      new THREE.MeshStandardMaterial({
        color: 0x14161a,
        roughness: 0.45,
        metalness: 0.65,
        side: THREE.DoubleSide,
      }),
    );
    band.position.set(enclosure.centerX, y, enclosure.centerZ);
    scene.add(band);
  }

  buildSubstrate();
  for (const stick of enclosure.sticks) scene.add(buildStick(stick));
  for (const rock of enclosure.rocks) scene.add(buildRock(rock));

  // Dust hangs inside the glass, not through it.
  const dustCount = mobileExperience ? 220 : 460;
  const positions = new Float32Array(dustCount * 3);
  for (let i = 0; i < dustCount; i += 1) {
    const angle = Math.random() * Math.PI * 2;
    const radial = Math.sqrt(Math.random()) * (enclosure.radius - 0.3);
    positions[i * 3] = enclosure.centerX + Math.cos(angle) * radial;
    positions[i * 3 + 1] = 0.3 + Math.random() * (enclosure.height - 0.6);
    positions[i * 3 + 2] = enclosure.centerZ + Math.sin(angle) * radial;
  }
  const dustGeometry = new THREE.BufferGeometry();
  dustGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const dust = new THREE.Points(
    dustGeometry,
    new THREE.PointsMaterial({
      color: 0xb9b3a8,
      size: 0.018,
      transparent: true,
      opacity: 0.24,
      depthWrite: false,
    }),
  );
  scene.add(dust);
}

buildEnclosure();

// --- Simulation --------------------------------------------------------------

// Web tuning is reachable from the query string so it can be swept without an
// edit-and-reload cycle, e.g. ?tautness=0.997&damping=0.3
const tuning = new URLSearchParams(location.search);
const tuned = (key: string): number | undefined => {
  const raw = tuning.get(key);
  const value = raw === null ? NaN : Number(raw);
  return Number.isFinite(value) ? value : undefined;
};
const feedingTimeScale = THREE.MathUtils.clamp(tuned("feedingScale") ?? 1, 0.05, 4);
const groomingTimeScale = THREE.MathUtils.clamp(tuned("groomingScale") ?? 1, 0.05, 4);
const forceCachedMeal = tuned("cacheMeal") === 1;
const skipCachedMeal = import.meta.env.DEV && tuning.get("noCacheMeal") === "1";
const rigDebugEnabled = tuning.get("rigDebug") === "1";
const forceRestTest = import.meta.env.DEV && tuning.get("restTest") === "1";
/** Deterministic development route used for locomotion and junction-turn QA. */
const forcedTravelNode = import.meta.env.DEV ? tuning.get("travelTo") : null;
let forcedTravelAttempted = false;
const forcedTravelNodeIsValid = (): boolean => Boolean(
  forcedTravelNode && web.network.nodes.has(forcedTravelNode),
);
const forcedTravelRunOwnsAutonomy = (): boolean => {
  if (!forcedTravelNodeIsValid()) return false;
  if (!forcedTravelAttempted) return true;
  if (!choreographer) return false;
  const state = choreographer.state;
  return state.hasRoute || state.arrived;
};
// The leg gym freezes the body and drives scripted foot trajectories, so the
// solver can be stressed and measured without momentum or silk in the picture.
const legGymEnabled = tuning.get("legGym") === "1";
let legGym: LegGym | null = null;
let rigDebugPaused = false;
let rigDebugSteps = 0;
let rigDiagnostics: RigDiagnostics | null = null;

function setRigDebugPaused(paused: boolean): void {
  if (!rigDebugEnabled) return;
  rigDebugPaused = paused;
  if (!paused) rigDebugSteps = 0;
  rigDiagnostics?.setPaused(paused);
}

function stepRigDebug(): void {
  if (!rigDebugEnabled || !rigDebugPaused) return;
  rigDebugSteps += 1;
}

const web = createCobweb({
  // The lab intentionally exaggerates compliance so it can be measured. The
  // habitat wants a widow's web: taut primary lines, chaotic topology, and only
  // a small local answer when she puts weight down.
  tautness: tuned("tautness") ?? 0.974,
  stiffness: tuned("stiffness") ?? 0.92,
  damping: tuned("damping") ?? 0.68,
  linearDensity: tuned("density") ?? 0.005,
  seed: tuned("seed"),
});
const solver = new WebPhysicsSolver(web.network, {
  gravityY: -2.6,
  iterations: 15,
  maximumStrain: 1.4,
});
const fullSolverIterations = solver.settings.iterations;
const traversal = createWebNetworkTraversal(web.network, FIXED_TIME_STEP);
const silk = new SilkRenderer(scene, web.network);

// --- Atmosphere ----------------------------------------------------------------

const dew = new DewSystem(scene, web.network, mobileExperience ? 70 : 120);
const firefly = new Firefly(scene);
const weather = new LiveWeatherAtmosphere(
  scene,
  new THREE.Vector3(enclosure.centerX, 0, enclosure.centerZ),
  enclosure.radius,
  enclosure.height,
  mobileExperience ? 150 : 280,
  {
    live: tuned("weather") !== 0,
    clear: tuned("clear") === 1,
    clouds: tuned("clouds") === 1,
    humidity: tuned("humidity") === 1,
    rain: tuned("rain") === 1,
    storm: tuned("storm") === 1 || tuned("lightning") === 1,
  },
);
const spiderDroppings = new SpiderDroppingSystem(scene, (worldX, worldZ) =>
  substrateHeight(worldX - enclosure.centerX, worldZ - enclosure.centerZ),
);
const forceDew = tuned("dew") === 1;
const forceFirefly = tuned("firefly") === 1;
let nextFireflyAt = forceFirefly ? 6 : 120 + Math.random() * 240;
let nextFireflyGlance = 0;
let fireflyHeldHerGaze = false;

function isNightHour(): boolean {
  const hour = new Date().getHours();
  return hour >= 20 || hour < 5;
}

function isDewHour(): boolean {
  const hour = new Date().getHours();
  return hour >= 4 && hour < 9;
}

let choreographer: SpiderChoreographer | null = null;
let loadedRig: Awaited<ReturnType<typeof loadSpiderRig>> | null = null;
let grooming: SpiderGroomingSystem | null = null;

const SHOWCASE_CHOREOGRAPHY = {
  // Routes steer a continuously moving body; the legs' aggregate success at
  // finding real silk throttles its speed. Sparse silk slows her smoothly
  // instead of gating travel in landing-sized packets.
  cinematicLocomotion: true,
  // This is her web: she crosses it at speed, with strides long enough that
  // the pace is still honestly earned by real footfalls.
  travelSpeed: 0.8,
  speedResponse: 7,
  stepTriggerDistance: 0.2,
  stepUrgentDistance: 0.36,
  stepLead: 0.3,
  footholdSearchRadius: 1.12,
  legSweepDegrees: 172,
  midlineTolerance: 0.24,
  // Per-pair scales in SpiderChoreographer turn these into the front-explore /
  // rear-assist profile: pair I swings longest and highest, pair IV quick and low.
  swingDuration: 0.25,
  swingLift: 0.1,
  minimumPlantedFeet: 4,
  maximumSwingingFeet: 2,
  maximumLeash: 0.72,
  bodyFollowRate: 7.5,
  bodyTurnRate: 4.8,
  bodyLean: 0.12,
  abdomenLag: 0.18,
  // She hangs beneath her silk, occasionally stands on top, never sideways.
  dorsalPreference: 0.8,
  // Rest: draw up close to the web, femora near vertical, patellae converging.
  restStandoffScale: 0.5,
  restArchGain: 1.24,
  // Ordinary rest is a true planted hold. A lifted leg now belongs exclusively
  // to the explicit grooming action, where the gesture has a visible purpose.
  minimumRaisedRestFeet: 0,
  maximumRaisedRestFeet: 0,
  // A master of her own web pauses rarely and briefly; frequent dead stops
  // mid-route read as hesitation, not thought.
  pauseChancePerSecond: 0.08,
  pauseDuration: { min: 0.1, max: 0.35 },
  bodyWeight: 0.95,
  // Repaired-rest joint limits, including the coxa's broader anatomical sector.
  // See ChoreographyConfig.jointLimitScale.
  jointLimitScale: 1.15,
} as const;

type PetMode =
  | "waking"
  | "watching"
  | "wandering"
  | "listening"
  | "stalking"
  | "feeding"
  | "repairing"
  | "grooming"
  | "retreating"
  | "resting";

type Instinct = "hunt" | "repair" | "shelter" | "explore" | "listen" | "groom";

const nowAtLoad = Date.now();
const behaviorDebug = tuning.get("behaviorDebug") === "1";

const {
  state: memory,
  hoursAway,
  newSession,
  budget: sessionBudget,
} = loadVesperState(localStorage, nowAtLoad);
const temperament = deriveTemperament(memory.temperamentSeed);
pruneInvalidLocations(memory, (strandId) => web.network.strands.has(strandId));

/** Console-only development window into the hidden state. Never touches the UI. */
function debugMind(label: string, detail?: unknown): void {
  if (!behaviorDebug) return;
  console.debug(
    `[vesper] ${label}`,
    {
      familiarity: +memory.familiarity.toFixed(3),
      trust: +memory.trust.toFixed(3),
      stress: +memory.stress.toFixed(3),
      temperament: {
        boldness: +temperament.boldness.toFixed(2),
        vibrationSensitivity: +temperament.vibrationSensitivity.toFixed(2),
        foodMotivation: +temperament.foodMotivation.toFixed(2),
      },
      locations: memory.locations.length,
      visitDays: memory.visitDays,
    },
    detail ?? "",
  );
}

debugMind(`loaded · away ${hoursAway.toFixed(1)}h · newSession=${newSession}`);
let petMode: PetMode = "waking";
let fieldNote = "The web is settling before she arrives.";
let activityDeadline = 7;
let habitatTime = 0;
let lastUserAction = -30;
let followSpider = false;
let redWatch = false;
let toastTimer = 0;
let hudTimer = 0;
let moth: THREE.Group | null = null;
let mothWrap: PreyWrappingSystem | null = null;
let mothAddress: { strandId: string; t: number } | null = null;
type MothStage =
  | "none"
  | "noticed"
  | "hunting"
  | "subduing"
  | "wrapping"
  | "feeding"
  | "cached"
  | "returning";
let mothStage: MothStage = "none";
let mothTimer = 0;
let nextMothTremor = 0;
let mothSource: "keeper" | "wild" = "keeper";
let mothFreshScale = 0.98;
let mothMealProgress = 0;
let mothFeedingSeconds = 60;
let mothSubdueSeconds = 1.7;
let mothWrapSeconds = 8;
let mothCacheSeconds = 14;
let mothWillCache = false;
let mothWasCached = false;
let mothCacheAtProgress = 0.42;
let mothFeedingNote = 0;
let mothNoticeSeconds = 1.1;
let nextWildPreyAt = 38 + Math.random() * 34;
let freshSilk: THREE.Line | null = null;
let freshSilkPoints: THREE.Vector3[] = [];
const fadingSilk: Array<{ line: THREE.Line; age: number }> = [];
const petWorldPosition = new THREE.Vector3();
const mothWorldPosition = new THREE.Vector3();
const mothCapturePosition = new THREE.Vector3();
const mothFeedingAnchor = new THREE.Vector3();
const mothFrontFeet = new THREE.Vector3();
const mothFootScratch = new THREE.Vector3();
const mothWrapAttachments = {
  leftSpinneret: new THREE.Vector3(),
  rightSpinneret: new THREE.Vector3(),
  leftHindFoot: new THREE.Vector3(),
  rightHindFoot: new THREE.Vector3(),
};
const mothWorkContact = new THREE.Vector3();
const mothWorkTarget = new THREE.Vector3();
const mothWorkPullPoint = new THREE.Vector3();
const mothWorkPickup = new THREE.Vector3();
const mothWorkRest = new THREE.Vector3();
const mothWorkCoxa = new THREE.Vector3();
const mothWorkOutward = new THREE.Vector3();
const mothWorkTangent = new THREE.Vector3();
const mothWorkParcelCenter = new THREE.Vector3();
const mothWorkRigScale = new THREE.Vector3();
const mothWorkWorldUp = new THREE.Vector3(0, 1, 0);
const mothFilteredWorkTargets = {
  L4: new THREE.Vector3(),
  R4: new THREE.Vector3(),
};
const mothWorkTargetInitialized = { L4: false, R4: false };
const homeWorldPosition = new THREE.Vector3();
const feedingJointRotation = new THREE.Quaternion();
const feedingJointInverse = new THREE.Quaternion();
const feedingJointOverlays = new Map<THREE.Bone, THREE.Quaternion>();
let awayMemory = "";

controls.enabled = !followSpider;
followButton?.setAttribute("aria-pressed", String(followSpider));

function hapticPulse(duration = 9): void {
  if (mobileExperience && typeof navigator.vibrate === "function") navigator.vibrate(duration);
}

type HabitatPanel = "status" | "care";

interface PanelVisibility {
  status: boolean;
  care: boolean;
}

const PANEL_MEMORY_KEY = "pet-black-widow:panels:v1";

function readPanelVisibility(): PanelVisibility {
  const fallback = { status: !mobileExperience, care: !mobileExperience };
  try {
    const saved = JSON.parse(localStorage.getItem(PANEL_MEMORY_KEY) ?? "null") as Partial<PanelVisibility> | null;
    return saved
      ? { status: saved.status ?? fallback.status, care: saved.care ?? fallback.care }
      : fallback;
  } catch {
    return fallback;
  }
}

const panelVisibility = readPanelVisibility();

function setPanelVisibility(panel: HabitatPanel, expanded: boolean): void {
  panelVisibility[panel] = expanded;
  habitat.classList.toggle(`${panel}-collapsed`, !expanded);
  const button = document.querySelector<HTMLButtonElement>(`[data-panel-toggle='${panel}']`);
  button?.setAttribute("aria-expanded", String(expanded));
  button?.setAttribute("aria-label", `${expanded ? "Hide" : "Show"} ${panel} panel`);
  try {
    localStorage.setItem(PANEL_MEMORY_KEY, JSON.stringify(panelVisibility));
  } catch {
    // The panels still work when storage is unavailable.
  }
}

setPanelVisibility("status", panelVisibility.status);
setPanelVisibility("care", panelVisibility.care);
habitat.classList.add("panels-ready");

panelToggles.forEach((button) => {
  button.addEventListener("click", () => {
    const panel = button.dataset.panelToggle as HabitatPanel;
    setPanelVisibility(panel, !panelVisibility[panel]);
    trackEngagement(panel === "status" ? "info_panel_used" : "care_panel_used");
    hapticPulse(7);
  });
});

function rememberAutonomousAct(note: string): void {
  memory.autonomousActs += 1;
  memory.silkMemories = [note, ...memory.silkMemories.filter((item) => item !== note)].slice(0, 3);
  saveMemory();
}

function dominantInstinct(): Instinct {
  const hour = new Date().getHours();
  const isNight = hour >= 19 || hour < 6;
  if (moth || memory.hunger >= 72) return "hunt";
  if (petMode === "repairing") return "repair";
  if (petMode === "listening" || habitatTime - lastUserAction < 9) return "listen";
  if (petMode === "grooming" || memory.hunger < 24) return "groom";
  if (!isNight && cautionOf(memory, temperament, hour) > 0.55) return "shelter";
  return isNight ? "explore" : "shelter";
}

function renderSilkMemory(): void {
  instinctLabel.textContent = dominantInstinct();
  autonomyCount.textContent = memory.autonomousActs.toString().padStart(3, "0");
  autonomyLog.replaceChildren(
    ...memory.silkMemories.map((note) => {
      const item = document.createElement("li");
      item.textContent = note;
      return item;
    }),
  );
}

function reconcileTimeAway(): void {
  // The loader already resolved hunger, stress, and location decay. All that
  // remains is at most one observable memory of the hours alone.
  if (hoursAway < 1.5) return;

  if (hoursAway > 30) {
    awayMemory = "She rebuilt the quietest line while the room belonged to her.";
  } else if (memory.hunger >= 68) {
    awayMemory = "She hunted the outer silk and waited beside the gumfoot lines.";
  } else if (new Date().getHours() >= 7 && new Date().getHours() < 19) {
    awayMemory = "She returned to shadow before the room brightened.";
  } else {
    awayMemory = "She patrolled the anchors after the house went quiet.";
  }
  rememberAutonomousAct(awayMemory);
}

function beginSilkRepair(): void {
  if (!loadedRig || freshSilk) return;
  loadedRig.rootObject.getWorldPosition(petWorldPosition);
  freshSilkPoints = [petWorldPosition.clone()];
  freshSilk = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(freshSilkPoints),
    new THREE.LineBasicMaterial({
      color: 0xded8cb,
      transparent: true,
      opacity: 0.38,
      depthWrite: false,
    }),
  );
  freshSilk.renderOrder = 2;
  scene.add(freshSilk);
}

function finishSilkRepair(): void {
  if (!freshSilk) return;
  if (freshSilkPoints.length > 2) {
    fadingSilk.push({ line: freshSilk, age: 0 });
    rememberAutonomousAct("Spun a fresh safety line across the open web.");
  } else {
    scene.remove(freshSilk);
    freshSilk.geometry.dispose();
    (freshSilk.material as THREE.Material).dispose();
  }
  freshSilk = null;
  freshSilkPoints = [];
}

function updateFreshSilk(dt: number): void {
  if (freshSilk && loadedRig) {
    loadedRig.rootObject.getWorldPosition(petWorldPosition);
    const previousPoint = freshSilkPoints[freshSilkPoints.length - 1];
    if (previousPoint.distanceToSquared(petWorldPosition) > 0.0064 && freshSilkPoints.length < 96) {
      freshSilkPoints.push(petWorldPosition.clone());
      freshSilk.geometry.dispose();
      freshSilk.geometry = new THREE.BufferGeometry().setFromPoints(freshSilkPoints);
    }
  }

  for (let index = fadingSilk.length - 1; index >= 0; index -= 1) {
    const silkMemory = fadingSilk[index];
    silkMemory.age += dt;
    const material = silkMemory.line.material as THREE.LineBasicMaterial;
    material.opacity = THREE.MathUtils.lerp(0.38, 0.08, Math.min(1, silkMemory.age / 45));
    if (silkMemory.age < 80) continue;
    scene.remove(silkMemory.line);
    silkMemory.line.geometry.dispose();
    material.dispose();
    fadingSilk.splice(index, 1);
  }
}

function saveMemory(): void {
  saveVesperState(localStorage, memory);
}

reconcileTimeAway();

function announce(message: string): void {
  toast.textContent = message;
  toast.classList.add("visible");
  toastTimer = 3.4;
}

function setPetMode(mode: PetMode, note: string, activity: string): void {
  if (petMode === "repairing" && mode !== "repairing" && freshSilk) {
    finishSilkRepair();
  }
  if (petMode === "grooming" && mode !== "grooming") {
    grooming?.cancel();
  }
  petMode = mode;
  fieldNote = note;
  activityLabel.textContent = activity;
}

/** Stops locomotion and lets one randomly chosen tarsus clean through the fangs. */
function beginGrooming(
  note: string,
  activity = "drawing one tarsus through her fangs",
  preferredLeg?: SpiderLegId,
): void {
  if (!choreographer || !grooming) return;
  const state = choreographer.state;
  const alreadyStill = state.restPoseSettled
    && (state.intent === "rest" || state.intent === "freeze");
  if (!alreadyStill) choreographer.setIntent({ kind: "freeze" });
  const legId = grooming.start(preferredLeg);
  activityDeadline = Math.max(activityDeadline, habitatTime + 10 / groomingTimeScale);
  const legName = `${legId[0] === "L" ? "left" : "right"} leg ${legId[1]}`;
  setPetMode("grooming", note, `${activity} · ${legName}`);
}

function finishGrooming(): void {
  if (!choreographer || petMode !== "grooming") return;
  choreographer.setIntent({ kind: "rest" });
  setPetMode(
    "resting",
    `${memory.name} returns the cleaned leg to the same strand and goes still.`,
    "settled after grooming",
  );
  activityDeadline = habitatTime + 7 + Math.random() * 8;
}

function hungerWord(value: number): string {
  if (value >= 82) return "ravenous";
  if (value >= 58) return "hunting";
  if (value >= 28) return "patient";
  return "sated";
}

function updateHud(): void {
  const state = choreographer?.state;
  const visibleMode = state?.stranded ? "considering" : petMode;
  petName.textContent = memory.name.toUpperCase();
  document.title = `${memory.name} · Autonomous Black Widow`;
  stateLabel.textContent = visibleMode.toUpperCase();
  status.textContent = fieldNote;
  hungerMeter.style.width = `${memory.hunger}%`;
  hungerLabel.textContent = hungerWord(memory.hunger);
  const minutes = Math.floor(habitatTime / 60).toString().padStart(2, "0");
  const seconds = Math.floor(habitatTime % 60).toString().padStart(2, "0");
  clock.textContent = `${minutes}:${seconds}`;
  if (feedButton) feedButton.disabled = moth !== null;
  renderSilkMemory();
}

function createMoth(): THREE.Group {
  const group = new THREE.Group();
  group.name = "moth-parcel";
  const preyVisual = new THREE.Group();
  preyVisual.name = "prey-visual";
  group.add(preyVisual);
  const bodyMaterial = new THREE.MeshStandardMaterial({
    color: 0x746351,
    roughness: 0.94,
  });
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.041, 0.112, 5, 10),
    bodyMaterial,
  );
  body.name = "moth-abdomen";
  body.position.x = 0.018;
  body.rotation.z = Math.PI / 2;
  preyVisual.add(body);
  const thorax = new THREE.Mesh(new THREE.SphereGeometry(0.057, 10, 7), bodyMaterial);
  thorax.name = "moth-thorax";
  thorax.position.x = -0.055;
  thorax.scale.set(1.08, 0.94, 0.9);
  preyVisual.add(thorax);
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.037, 9, 6),
    new THREE.MeshStandardMaterial({ color: 0x55483d, roughness: 0.88 }),
  );
  head.name = "moth-head";
  head.position.x = -0.118;
  preyVisual.add(head);
  const wingMaterial = new THREE.MeshStandardMaterial({
    color: 0x9f9078,
    roughness: 0.92,
    transparent: true,
    opacity: 0.7,
    side: THREE.DoubleSide,
  });
  const wingShape = new THREE.Shape();
  wingShape.moveTo(0, 0);
  wingShape.bezierCurveTo(0.035, 0.135, 0.2, 0.175, 0.225, 0.035);
  wingShape.bezierCurveTo(0.16, -0.025, 0.055, -0.02, 0, 0);
  const veinMaterial = new THREE.LineBasicMaterial({
    color: 0x766a58,
    transparent: true,
    opacity: 0.42,
  });
  for (const side of [-1, 1]) {
    const wing = new THREE.Mesh(new THREE.ShapeGeometry(wingShape, 8), wingMaterial);
    wing.name = side < 0 ? "wing-left" : "wing-right";
    wing.scale.y = side;
    wing.rotation.y = Math.PI / 2;
    const veins = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0.012, 0.008, 0.001), new THREE.Vector3(0.19, 0.04, 0.001),
        new THREE.Vector3(0.025, 0.02, 0.001), new THREE.Vector3(0.15, 0.105, 0.001),
        new THREE.Vector3(0.06, 0.035, 0.001), new THREE.Vector3(0.09, 0.135, 0.001),
      ]),
      veinMaterial,
    );
    veins.name = "wing-veins";
    wing.add(veins);
    preyVisual.add(wing);
  }
  const antennaMaterial = new THREE.LineBasicMaterial({
    color: 0x69594b,
    transparent: true,
    opacity: 0.7,
  });
  const antennae = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-0.14, 0.014, 0), new THREE.Vector3(-0.235, 0.065, 0.025),
      new THREE.Vector3(-0.14, -0.014, 0), new THREE.Vector3(-0.235, -0.065, -0.025),
    ]),
    antennaMaterial,
  );
  antennae.name = "moth-antennae";
  preyVisual.add(antennae);
  const glow = new THREE.PointLight(0xdabf91, 0.32, 1.5, 2);
  group.add(glow);
  return group;
}

const recentMothSpots: THREE.Vector3[] = [];
const mothCandidatePosition = new THREE.Vector3();
const mothCandidateProjected = new THREE.Vector3();

/**
 * Picks somewhere for prey to land. Sampled, not fixed: candidates are random
 * strand addresses, kept only if they sit in the web proper and inside the
 * current camera frame, then scored for centrality (the keeper should see the
 * catch), variety (away from where recent moths landed), and a workable
 * distance from Vesper — close enough to reach, far enough to make a hunt.
 */
function chooseMothAddress(): { strandId: string; t: number } | null {
  const strands = web.network.strandList;
  if (loadedRig) loadedRig.rootObject.getWorldPosition(petWorldPosition);
  let best: { strandId: string; t: number } | null = null;
  let bestScore = -Infinity;

  for (let attempt = 0; attempt < 48; attempt += 1) {
    const strand = strands[Math.floor(Math.random() * strands.length)];
    if (!strand.active || strand.broken) continue;
    const t = 0.3 + Math.random() * 0.4;
    traversal.getWorldPosition({ strandId: strand.id, t }, mothCandidatePosition);
    if (mothCandidatePosition.y < 1.8) continue; // stray floor-anchor lines

    mothCandidateProjected.copy(mothCandidatePosition).project(camera);
    if (mothCandidateProjected.z < -1 || mothCandidateProjected.z > 1) continue;
    if (Math.abs(mothCandidateProjected.x) > 0.85 || Math.abs(mothCandidateProjected.y) > 0.85) {
      continue;
    }
    const centrality =
      1 - Math.max(Math.abs(mothCandidateProjected.x), Math.abs(mothCandidateProjected.y));

    let variety = 1;
    for (const spot of recentMothSpots) {
      variety = Math.min(variety, mothCandidatePosition.distanceTo(spot) / 6);
    }

    let reachBias = 0;
    if (loadedRig) {
      const distance = petWorldPosition.distanceTo(mothCandidatePosition);
      reachBias = distance < 1.2 ? -0.6 : distance > 11 ? -0.35 : 0.2;
    }

    const score = centrality + variety * 0.9 + reachBias + Math.random() * 0.15;
    if (score > bestScore) {
      bestScore = score;
      best = { strandId: strand.id, t };
    }
  }
  return best;
}

function offerMoth(source: "keeper" | "wild" = "keeper"): void {
  if (!choreographer || moth) return;
  const picked = chooseMothAddress();
  if (!picked) {
    // Nothing framed nicely; fall back to the far line rather than skip the meal.
    const farNode = web.network.nodes.get(web.farNodeId);
    const strandId = farNode ? [...farNode.connectedStrandIds][0] : web.homeStrandId;
    if (!strandId) return;
    mothAddress = { strandId, t: 0.58 };
  } else {
    mothAddress = picked;
  }
  moth = createMoth();
  mothSource = source;
  mothFreshScale = source === "wild" ? 0.82 : 0.98;
  if (source === "keeper") trackEngagement("moth_offered");
  moth.scale.setScalar(mothFreshScale);
  scene.add(moth);
  traversal.getWorldPosition(mothAddress, mothWorldPosition);
  moth.position.copy(mothWorldPosition);
  recentMothSpots.push(mothWorldPosition.clone());
  if (recentMothSpots.length > 4) recentMothSpots.shift();
  mothStage = "noticed";
  mothTimer = 0;
  nextMothTremor = 0.15;
  mothMealProgress = 0;
  mothFeedingSeconds = (mothSource === "wild" ? 38 + Math.random() * 18 : 52 + Math.random() * 28) * feedingTimeScale;
  mothSubdueSeconds = Math.max(0.8, (1.45 + Math.random() * 0.45) * feedingTimeScale);
  mothWrapSeconds = (6.5 + Math.random() * 3.5) * feedingTimeScale;
  mothCacheSeconds = (11 + Math.random() * 12) * feedingTimeScale;
  mothWillCache = !skipCachedMeal && (forceCachedMeal || Math.random() < 0.38);
  mothWasCached = false;
  mothCacheAtProgress = 0.3 + Math.random() * 0.28;
  mothFeedingNote = 0;
  mothWrap = new PreyWrappingSystem(scene, moth, {
    // A conservative central envelope plus body and wing lobes. Silk follows
    // the inflated union, so it catches the silhouette without sinking into
    // fragile render geometry or tracing every wing-vein crevice.
    radii: new THREE.Vector3(0.13, 0.1, 0.145),
    surfaceLobes: [
      {
        center: new THREE.Vector3(0.005, 0, 0),
        radii: new THREE.Vector3(0.16, 0.058, 0.064),
      },
      {
        center: new THREE.Vector3(-0.012, 0.058, -0.09),
        radii: new THREE.Vector3(0.062, 0.125, 0.17),
        rotation: new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(1, 0, 0),
          -0.16,
        ),
      },
      {
        center: new THREE.Vector3(-0.012, -0.058, -0.09),
        radii: new THREE.Vector3(0.062, 0.125, 0.17),
        rotation: new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(1, 0, 0),
          0.16,
        ),
      },
    ],
    targetDuration: mothWrapSeconds,
    rotationalInertia: source === "wild" ? 0.92 : 1.28,
    mobile: mobileExperience,
  });
  // Prey instinct owns the hunt; the relationship only shades how long she
  // reads the vibration before committing. A hungry, food-driven, settled
  // spider starts sooner; a stressed or wary one listens longer.
  mothNoticeSeconds = THREE.MathUtils.clamp(
    1.4 -
      temperament.foodMotivation * 0.6 -
      memory.hunger / 250 -
      memory.familiarity * 0.3 +
      memory.stress * 0.9,
    0.45,
    2.6,
  );
  if (source === "keeper") lastUserAction = habitatTime;
  setPetMode(
    "listening",
    source === "keeper"
      ? `${memory.name} stops. Eight feet read one tiny vibration.`
      : "A wild gnat chose the wrong strand. She noticed before you did.",
    source === "keeper" ? "prey on the web" : "triangulating wild prey",
  );
  choreographer.setIntent({ kind: "attend", at: mothWorldPosition });
  announce(source === "keeper" ? "A pantry moth catches in the gumfoot silk" : "The web caught something on its own");
}

function removeMoth(): void {
  if (!moth) return;
  mothWrap?.dispose();
  mothWrap = null;
  scene.remove(moth);
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  moth.traverse((child) => {
    if (!(child instanceof THREE.Mesh || child instanceof THREE.Line || child instanceof THREE.Points)) return;
    geometries.add(child.geometry);
    const objectMaterials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of objectMaterials) materials.add(material);
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  moth = null;
  mothAddress = null;
}

/** The cocoon keeps its size while the consumed insect gradually collapses within it. */
function updateMothContentsScale(): void {
  if (!moth) return;
  const preyVisual = moth.getObjectByName("prey-visual");
  preyVisual?.scale.setScalar(THREE.MathUtils.lerp(1, 0.68, mothMealProgress));
}

/** Remove last frame's additive feeding pose before the locomotion rig runs. */
function removeFeedingLimbPose(): void {
  for (const [bone, overlay] of feedingJointOverlays) {
    feedingJointInverse.copy(overlay).invert();
    bone.quaternion.multiply(feedingJointInverse);
  }
  feedingJointOverlays.clear();
}

/** Adds small, alternating work motions without replacing the rig's grounded pose. */
function applyFeedingLimbPose(
  intensity: number,
  speed: number,
  rearLegWork?: RearLegWorkPose,
): void {
  if (!loadedRig || intensity <= 0) return;
  const legIds = ["L1", "R1", "L4", "R4"] as const;
  for (let legIndex = 0; legIndex < legIds.length; legIndex += 1) {
    const legId = legIds[legIndex];
    const side = legId[0] === "L" ? -1 : 1;
    const leg = loadedRig.legs[legId];
    const jointCount = Math.min(3, leg.joints.length);
    for (let jointIndex = 0; jointIndex < jointCount; jointIndex += 1) {
      const bone = leg.joints[jointIndex];
      const phase = habitatTime * speed + legIndex * 1.7 + jointIndex * 0.8;
      const isRearLeg = legId === "L4" || legId === "R4";
      const isWorkingRearLeg = Boolean(
        rearLegWork
        && ((legId === "L4" && rearLegWork.activeSide === "left")
          || (legId === "R4" && rearLegWork.activeSide === "right")),
      );
      // The active rear chain is solved to a real world target below. Never
      // record an additive overlay on those same bones: inverting it next
      // frame would corrupt the IK result left by the presentation pass.
      if (isWorkingRearLeg) continue;
      const idleMotion = Math.sin(phase) * intensity * (0.12 - jointIndex * 0.025);
      const angle = isRearLeg && rearLegWork
        ? Math.sin(phase) * 0.012
        : idleMotion;
      feedingJointRotation.setFromAxisAngle(
        loadedRig.axes.boneBend,
        angle * side,
      );
      bone.quaternion.multiply(feedingJointRotation);
      feedingJointOverlays.set(bone, feedingJointRotation.clone());
    }
  }
  loadedRig.rootObject.updateMatrixWorld(true);
}

/**
 * Presentation-only leg-IV work. Semantic contact and load remain untouched;
 * this runs after locomotion, so the web solver stays stable while the visible
 * rear foot genuinely reaches from its live contact to spinneret and prey.
 */
function solveWrappingRearLegIK(work: RearLegWorkPose, dt: number): void {
  if (!loadedRig || !choreographer || !moth || !mothWrap) return;
  if (!mothWrap.getWorkingContactWorld(mothWorkContact)) return;
  const legId = work.activeSide === "left" ? "L4" : "R4";
  const otherLegId = legId === "L4" ? "R4" : "L4";
  mothWorkTargetInitialized[otherLegId] = false;
  const leg = loadedRig.legs[legId];
  const semanticContact = choreographer.contacts.get(legId);
  if (semanticContact?.hasResolvedWorldPosition) {
    mothWorkRest.set(
      semanticContact.worldPosition.x,
      semanticContact.worldPosition.y,
      semanticContact.worldPosition.z,
    );
  } else {
    leg.footHome.getWorldPosition(mothWorkRest);
  }
  mothWorkPickup.copy(
    work.activeSide === "left"
      ? mothWrapAttachments.leftSpinneret
      : mothWrapAttachments.rightSpinneret,
  );
  moth.getWorldPosition(mothWorkParcelCenter);
  mothWorkOutward.subVectors(mothWorkContact, mothWorkParcelCenter).normalize();
  mothWorkTangent.subVectors(mothWorkPickup, mothWorkContact);
  mothWorkTangent.addScaledVector(
    mothWorkOutward,
    -mothWorkTangent.dot(mothWorkOutward),
  );
  if (mothWorkTangent.lengthSq() < 1e-6) {
    mothWorkTangent.subVectors(mothWorkPickup, mothWorkContact);
    mothWorkTangent.addScaledVector(
      mothWorkOutward,
      -mothWorkTangent.dot(mothWorkOutward),
    );
  }
  if (mothWorkTangent.lengthSq() < 1e-6) {
    mothWorkTangent.crossVectors(mothWorkOutward, mothWorkWorldUp);
  }
  mothWorkTangent.normalize();
  mothWorkPullPoint
    .copy(mothWorkContact)
    .addScaledVector(mothWorkOutward, 0.04)
    .addScaledVector(mothWorkTangent, 0.105);

  if (work.action === "searching") {
    mothWorkTarget.lerpVectors(mothWorkRest, mothWorkPickup, work.reach);
  } else if (work.action === "grabbing") {
    mothWorkTarget.copy(mothWorkPickup);
  } else if (work.action === "pulling") {
    const easedPull = work.pull * work.pull * (3 - 2 * work.pull);
    mothWorkTarget.lerpVectors(mothWorkPickup, mothWorkPullPoint, easedPull);
  } else if (work.action === "releasing") {
    mothWorkTarget.copy(mothWorkPullPoint);
  } else {
    const reset = 1 - THREE.MathUtils.clamp(work.reach / 0.42, 0, 1);
    mothWorkTarget.lerpVectors(mothWorkPullPoint, mothWorkRest, reset);
  }

  const filteredTarget = mothFilteredWorkTargets[legId];
  if (!mothWorkTargetInitialized[legId]) {
    leg.footTip.getWorldPosition(filteredTarget);
    mothWorkTargetInitialized[legId] = true;
  }
  filteredTarget.lerp(mothWorkTarget, 1 - Math.exp(-26 * dt));

  leg.joints[0].getWorldPosition(mothWorkCoxa);
  mothWorkOutward.subVectors(filteredTarget, mothWorkCoxa);
  loadedRig.rootObject.getWorldScale(mothWorkRigScale);
  const reachScale = (mothWorkRigScale.x + mothWorkRigScale.y + mothWorkRigScale.z) / 3;
  const minimumReach = leg.reach.min * reachScale * 1.05;
  const maximumReach = leg.reach.max * reachScale * 0.9;
  const targetDistance = THREE.MathUtils.clamp(
    mothWorkOutward.length(),
    minimumReach,
    maximumReach,
  );
  if (mothWorkOutward.lengthSq() > 1e-8) {
    filteredTarget.copy(mothWorkCoxa).add(
      mothWorkOutward.normalize().multiplyScalar(targetDistance),
    );
  }
  choreographer.ik.solve(legId, filteredTarget);
  loadedRig.rootObject.updateMatrixWorld(true);
}

function positionMothAtMouth(stage: MothStage): void {
  if (!moth || !loadedRig) return;
  loadedRig.head.getWorldPosition(mothFeedingAnchor);
  loadedRig.footTips.L1.getWorldPosition(mothFrontFeet);
  loadedRig.footTips.R1.getWorldPosition(mothFootScratch);
  mothFrontFeet.add(mothFootScratch).multiplyScalar(0.5);
  mothFeedingAnchor.lerp(mothFrontFeet, 0.28);

  // Distinct stages, distinct energy: a violent pinned struggle, a deliberate
  // rotation while silk goes on, then stillness. During the long feed the
  // parcel is held against her mouthparts and barely moves at all.
  const tumble = stage === "subduing" ? 0.5 : stage === "wrapping" ? 0.18 : 0.035;
  mothWorldPosition.copy(mothFeedingAnchor);
  mothWorldPosition.x += Math.sin(habitatTime * 7.1) * 0.055 * tumble;
  mothWorldPosition.y += Math.cos(habitatTime * 8.3) * 0.035 * tumble;
  mothWorldPosition.z += Math.sin(habitatTime * 6.2 + 1.1) * 0.05 * tumble;

  if (stage === "subduing") {
    const progress = THREE.MathUtils.clamp(mothTimer / Math.max(0.01, mothSubdueSeconds), 0, 1);
    const eased = progress * progress * (3 - 2 * progress);
    moth.position.lerpVectors(mothCapturePosition, mothWorldPosition, eased);
  } else {
    moth.position.copy(mothWorldPosition);
  }

  updateMothContentsScale();
  moth.updateMatrixWorld(true);
}

function finishMothMeal(): void {
  if (!moth || !choreographer) return;
  const caughtWildPrey = mothSource === "wild";
  const finishedAddress = mothAddress;
  removeMoth();
  mothStage = "none";
  mothMealProgress = 1;
  memory.hunger = Math.max(0, memory.hunger - (caughtWildPrey ? 24 : 46));
  if (caughtWildPrey) {
    rememberAutonomousAct("Caught a wild gnat by reading its tremor through the silk.");
  } else {
    // The completed meal is the meaningful event — offering one is not.
    recordKeeperMealCompleted(memory, sessionBudget);
    trackEngagement("moth_meal_completed");
    if (finishedAddress) {
      recordLocationEvent(memory, finishedAddress.strandId, finishedAddress.t, "catch", Date.now());
    }
    debugMind("keeper meal completed");
  }
  saveMemory();
  // The terminal feeding frame still has its prey-handling leg overlay applied.
  // Clear it before grooming samples a home foot position, or the cleaned leg
  // would return to a pose that existed only while it was holding the moth.
  removeFeedingLimbPose();
  beginGrooming(
    caughtWildPrey
      ? `${memory.name} finishes every usable part, then folds one tarsus to her mouthparts.`
      : `${memory.name} finishes the moth and draws one silk-dusted leg through her chelicerae.`,
    "sated and cleaning",
  );
  activityDeadline = Math.max(
    activityDeadline,
    habitatTime + 10 + Math.random() * 8,
  );
  nextWildPreyAt = habitatTime + 52 + Math.random() * 70;
  announce(
    caughtWildPrey
      ? `${memory.name} made her own luck`
      : `${memory.name} finished the moth down to the wing hinges`,
  );
}

const footfallDirection = new THREE.Vector3();

/**
 * A footfall pressed into the silk. Each landing tugs the strand a little way
 * toward her body — the direction a gripping claw actually loads it — with a
 * falloff over the neighbouring particles so the disturbance rings briefly
 * through the local web and dies. Deliberately about a seventh of a keeper's
 * pluck: presence, not bounce.
 */
function pressFootfall(address: { strandId: string; t: number }): void {
  const strand = web.network.strands.get(address.strandId);
  if (!strand || !loadedRig) return;
  const count = strand.particleIndices.length;
  const center = Math.max(1, Math.min(count - 2, Math.round(address.t * (count - 1))));
  loadedRig.rootObject.getWorldPosition(petWorldPosition);
  const store = web.network.particles;

  for (let offset = -2; offset <= 2; offset += 1) {
    const index = center + offset;
    if (index <= 0 || index >= count - 1) continue; // endpoints anchor the web
    const particle = strand.particleIndices[index];
    footfallDirection
      .set(
        petWorldPosition.x - store.positions[particle * 3],
        petWorldPosition.y - store.positions[particle * 3 + 1],
        petWorldPosition.z - store.positions[particle * 3 + 2],
      )
      .normalize();
    const push = 0.22 * (1 - Math.abs(offset) * 0.38) * FIXED_TIME_STEP;
    store.previousPositions[particle * 3] -= footfallDirection.x * push;
    store.previousPositions[particle * 3 + 1] -= footfallDirection.y * push;
    store.previousPositions[particle * 3 + 2] -= footfallDirection.z * push;
  }
}

function pluckSilk(strength = 1.2): void {
  const address = choreographer?.bodyAddress ?? { strandId: web.homeStrandId, t: 0.5 };
  const strand = web.network.strands.get(address.strandId);
  if (!strand) return;
  const localIndex = Math.max(1, Math.min(strand.particleIndices.length - 2, Math.round(address.t * (strand.particleIndices.length - 1))));
  const particle = strand.particleIndices[localIndex];
  web.network.particles.previousPositions[particle * 3 + 2] -= strength * FIXED_TIME_STEP;
  traversal.getWorldPosition(address, mothWorldPosition);
  choreographer?.setIntent({ kind: "attend", at: mothWorldPosition });
}

function setStatus(text: string): void {
  fieldNote = text;
}

/**
 * Dresses her in the model's original authored material.
 *
 * The GLB ships an untextured pure-white `MeshStandardMaterial` — it is a rig
 * deliverable, not an art asset — but the mesh kept its UVs, so the original
 * texture set drops straight back on: painted near-black chitin with the red
 * hourglass where it belongs, an authored roughness map that keeps her matte
 * with a believable sheen, and a normal map for the fine surface detail.
 * Textures loaded outside GLTFLoader default to `flipY = true`, which would
 * mirror every map against glTF's UV convention — hence the explicit false.
 */
function dressAsWidow(mesh: THREE.SkinnedMesh): void {
  const loader = new THREE.TextureLoader();
  const load = (url: string, isColor: boolean): THREE.Texture => {
    const texture = loader.load(url);
    texture.flipY = false;
    if (isColor) texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  };

  const widow = new THREE.MeshStandardMaterial({
    map: load("/assets/spider/textures/widow_basecolor.png", true),
    roughnessMap: load("/assets/spider/textures/widow_roughness.png", false),
    normalMap: load("/assets/spider/textures/widow_normal.png", false),
    roughness: 1,
    metalness: 0,
  });
  mesh.material = widow;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
}

/**
 * Eye shine. Spider eyes throw light straight back at whoever holds the lamp —
 * the tapetum behind the retina works like a bicycle reflector. Under the red
 * observation light, hers catch. It is the red-light mode's reward: turn the
 * lamp on her and the dark looks back.
 */
let eyeShine: THREE.Sprite | null = null;

function attachEyeShine(head: THREE.Object3D): void {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 32;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    // Two principal glints with two fainter ones above: her anterior median
    // eyes catch hardest, the laterals barely.
    const glint = (x: number, y: number, r: number, strength: number): void => {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(255, 214, 200, ${strength})`);
      g.addColorStop(0.4, `rgba(255, 96, 80, ${strength * 0.55})`);
      g.addColorStop(1, "rgba(255, 60, 50, 0)");
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    };
    glint(22, 19, 8, 1);
    glint(42, 19, 8, 1);
    glint(15, 9, 4, 0.4);
    glint(49, 9, 4, 0.4);
  }
  const texture = new THREE.CanvasTexture(canvas);
  eyeShine = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    }),
  );
  eyeShine.scale.set(0.09, 0.045, 1);
  eyeShine.position.set(0, 0.06, 0);
  head.add(eyeShine);
}

function updateEyeShine(dt: number): void {
  if (!eyeShine) return;
  const target = redWatch ? 0.85 + Math.sin(habitatTime * 0.7) * 0.1 : 0;
  const material = eyeShine.material;
  material.opacity += (target - material.opacity) * Math.min(1, dt * 2.5);
  eyeShine.visible = material.opacity > 0.02;
}

/** Places her on the home strand. Returns false if she could not find footing. */
function settleSpider(): boolean {
  if (!choreographer) {
    return false;
  }
  const home = { strandId: web.homeStrandId, t: 0.5 };
  const silkPoint = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  traversal.getWorldPosition(home, silkPoint);
  traversal.getTangent(home, tangent);

  // A widow hangs beneath her web: dorsal side down, legs reaching up to the silk.
  const up = new THREE.Vector3(0, -1, 0);
  const position = silkPoint.clone().addScaledVector(up, choreographer.config.bodyStandoff);
  if (!choreographer.settle(position, tangent, up)) {
    return false;
  }
  controls.target.copy(silkPoint);
  if (mobileExperience) {
    const portrait = window.innerHeight >= window.innerWidth;
    const initialOffset = portrait
      ? new THREE.Vector3(3, 1.35, 3.25)
      : new THREE.Vector3(3.7, 1.55, 3.8);
    camera.position.copy(silkPoint).add(initialOffset);
    camera.lookAt(silkPoint);
    controls.update();
  }
  return true;
}

async function boot(): Promise<void> {
  setStatus("Something glossy is waking in the dark.");
  const rig = await loadSpiderRig();
  loadedRig = rig;
  dressAsWidow(rig.mesh);
  attachEyeShine(rig.head);
  scene.add(rig.rootObject);

  choreographer = new SpiderChoreographer({
    rig,
    traversal,
    network: web.network,
    config: SHOWCASE_CHOREOGRAPHY,
    onFootPlant: (_legId, address) => pressFootfall(address),
  });
  grooming = new SpiderGroomingSystem(rig, choreographer.ik);

  if (rigDebugEnabled) {
    rigDiagnostics = new RigDiagnostics(scene, habitat, rig, choreographer, {
      onTogglePause: () => setRigDebugPaused(!rigDebugPaused),
      onStep: stepRigDebug,
    });
    rigDiagnostics.setPaused(false);
  }

  // Let the web hang and settle before the spider arrives, so she lands on silk
  // that has already found its shape rather than silk still falling.
  for (let i = 0; i < 240; i += 1) {
    solver.step(FIXED_TIME_STEP);
  }

  if (!settleSpider()) {
    trackEngagement("load_failed");
    setStatus("She cannot find safe footing in this web.");
    return;
  }
  if (tuning.get("poop") === "1") {
    window.setTimeout(() => spiderDroppings.dropNow(rig.spinnerets.center), 3_000);
  }
  if (legGymEnabled && choreographer) {
    legGym = new LegGym(rig, choreographer.ik);
    setStatus("Leg gym: body frozen, feet on scripted trajectories.");
  }
  traversal.getWorldPosition({ strandId: web.homeStrandId, t: 0.5 }, homeWorldPosition);
  setPetMode(
    "watching",
    awayMemory || `${memory.name} hangs motionless, reading the room through the silk.`,
    awayMemory ? "remembering the hours alone" : "reading the room",
  );
  if (forcedTravelNode && forcedTravelNodeIsValid()) {
    choreographer.setIntent({
      kind: "travel",
      to: { kind: "node", nodeId: forcedTravelNode },
    });
    setPetMode(
      "wandering",
      `${memory.name} follows a deterministic locomotion test route.`,
      `testing the turn into ${forcedTravelNode}`,
    );
  } else if (forceRestTest) {
    choreographer.setIntent({ kind: "rest" });
    setPetMode(
      "resting",
      `${memory.name} holds a deterministic resting pose for foot-placement review.`,
      "at rest",
    );
  } else if (import.meta.env.DEV && tuning.get("groom") === "1") {
    const requestedLeg = tuning.get("groomLeg");
    const preferredLeg = isGroomableLegId(requestedLeg) ? requestedLeg : undefined;
    if (requestedLeg === null || preferredLeg) {
      beginGrooming(
        `${memory.name} folds one leg to her mouthparts for a grooming test.`,
        "grooming test",
        preferredLeg,
      );
    }
  }

  // After a real absence she may, once settled, briefly face a stretch of
  // silk she has history with — then get on with her day. Long cooldown, no
  // announcement: either the keeper notices, or they don't.
  if (
    hoursAway >= 10 &&
    memory.familiarity >= 0.3 &&
    (memory.behaviorCooldowns.returnGlance ?? 0) <= nowAtLoad
  ) {
    const spot = pickLocation(memory, "touched") ?? pickLocation(memory, "calmSpot");
    if (spot) {
      returnGlance = { strandId: spot.strandId, t: spot.t };
      memory.behaviorCooldowns.returnGlance = nowAtLoad + 20 * 3_600_000;
      debugMind("return glance armed", spot);
    }
  }

  saveMemory();
  updateHud();
}

// --- Test seam ---------------------------------------------------------------
// The illusion is visual, but its mechanics are not: feet either hold real
// addresses on real silk or they do not. This lets that be checked without a
// camera, by stepping the same fixed-step loop the renderer drives.
if (import.meta.env.DEV) {
  document.documentElement.dataset.webTest = JSON.stringify({
    retreatNodeId: web.retreatNodeId,
    farNodeId: web.farNodeId,
  });
  (window as unknown as Record<string, unknown>).__silklab = {
    step(count: number) {
      for (let i = 0; i < count; i += 1) {
        grooming?.restoreBasePose();
        solver.step(FIXED_TIME_STEP);
        if (legGym) legGym.update(FIXED_TIME_STEP);
        else choreographer?.update(FIXED_TIME_STEP);
        if (grooming?.update(
          FIXED_TIME_STEP * groomingTimeScale,
          choreographer?.state.restPoseSettled ?? false,
        )) {
          finishGrooming();
        }
      }
      return choreographer?.state;
    },
    gym: () => legGym?.metrics() ?? null,
    gymReset: () => legGym?.reset(),
    state: () => choreographer?.state,
    feeding: () => ({
      stage: mothStage,
      progress: Number(mothMealProgress.toFixed(3)),
      willCache: mothWillCache,
      wasCached: mothWasCached,
      wrapping: mothWrap?.snapshot ?? null,
    }),
    groom: (legId?: string) => {
      if (legId !== undefined && !isGroomableLegId(legId)) return null;
      const preferred = isGroomableLegId(legId) ? legId : undefined;
      beginGrooming(
        `${memory.name} folds one leg to her mouthparts for a grooming test.`,
        "grooming test",
        preferred,
      );
      return grooming?.snapshot ?? null;
    },
    grooming: () => grooming?.snapshot ?? null,
    poop: () => loadedRig ? spiderDroppings.dropNow(loadedRig.spinnerets.center) : false,
    dropping: () => spiderDroppings.snapshot,
    web: () => ({
      retreatNodeId: web.retreatNodeId,
      farNodeId: web.farNodeId,
      homeStrandId: web.homeStrandId,
      legSpan: web.legSpan,
    }),
    feet: () =>
      choreographer
        ? [...choreographer.contacts.entries()].map(([legId, contact]) => ({
            legId,
            state: contact.state,
            strandId: contact.strandId,
            t: contact.t,
            valid: contact.contactValid,
            reach: contact.reachStatus,
            load: Number(contact.carriedLoadNewtons.toFixed(3)),
            restRole: grooming?.snapshot.active && grooming.snapshot.legId === legId
              ? "grooming"
              : choreographer?.isRestLegRaised(legId)
                ? "raised"
                : contact.isPlanted && contact.contactValid
                  ? "contact"
                  : "neutral",
            visualGap: grooming?.snapshot.active && grooming.snapshot.legId === legId
              ? null
              : loadedRig && contact.hasResolvedWorldPosition
              ? Number(
                  loadedRig.legs[legId].footTip
                    .getWorldPosition(new THREE.Vector3())
                    .distanceTo(
                      new THREE.Vector3(
                        contact.worldPosition.x,
                        contact.worldPosition.y,
                        contact.worldPosition.z,
                      ),
                    )
                    .toFixed(4),
                )
              : null,
          }))
        : [],
    travelTo: (nodeId: string) =>
      choreographer?.setIntent({ kind: "travel", to: { kind: "node", nodeId } }),
    raw: () => ({ choreographer, traversal, rig: loadedRig, network: web.network, dew, firefly, weather }),
    webSense: () => ({
      disturbance: Number(webDisturbance.toFixed(3)),
      respondsAfter: Number((nextTouchResponseAt - habitatTime).toFixed(1)),
      recentEnergy: Number(recentGestureEnergy.toFixed(2)),
    }),
    mind: () => ({
      familiarity: Number(memory.familiarity.toFixed(4)),
      trust: Number(memory.trust.toFixed(4)),
      stress: Number(memory.stress.toFixed(4)),
      curiosity: Number(curiosityOf(memory, temperament).toFixed(3)),
      caution: Number(cautionOf(memory, temperament, new Date().getHours()).toFixed(3)),
      temperament,
      visitDays: memory.visitDays,
      locations: memory.locations.map((l) => ({
        strandId: l.strandId,
        t: Number(l.t.toFixed(2)),
        gentle: Number(l.gentle.toFixed(2)),
        disruptive: Number(l.disruptive.toFixed(2)),
        catches: Number(l.catches.toFixed(2)),
        calm: Number(l.calm.toFixed(2)),
      })),
      budget: { ...sessionBudget },
      gainsToday: {
        familiarity: Number(memory.familiarityGainToday.toFixed(4)),
        trust: Number(memory.trustGainToday.toFixed(4)),
      },
    }),
    /** Frames the spider so a screenshot actually shows her. */
    look: (distance = 1.6, azimuth = 0.7, elevation = 0.35) => {
      if (!loadedRig) return null;
      const focus = loadedRig.rootObject.getWorldPosition(new THREE.Vector3());
      controls.target.copy(focus);
      camera.position.set(
        focus.x + Math.cos(azimuth) * Math.cos(elevation) * distance,
        focus.y + Math.sin(elevation) * distance,
        focus.z + Math.sin(azimuth) * Math.cos(elevation) * distance,
      );
      camera.lookAt(focus);
      controls.update();
      renderer.render(scene, camera);
      return focus.toArray().map((v) => +v.toFixed(2));
    },
    /**
     * Pings a strand and reports how it rings.
     *
     * The reason this project exists is that the web answers back, so "is it
     * still bouncy" has to be measurable rather than a matter of opinion.
     */
    ping: (strandId: string, impulse = 3) => {
      const strand = web.network.strands.get(strandId);
      if (!strand) return null;
      const mid = strand.particleIndices[strand.particleIndices.length >> 1];
      const store = web.network.particles;
      const rest = new THREE.Vector3(
        store.positions[mid * 3],
        store.positions[mid * 3 + 1],
        store.positions[mid * 3 + 2],
      );
      // Kick it sideways and watch it ring.
      store.previousPositions[mid * 3 + 2] -= impulse * FIXED_TIME_STEP;
      const probe = new THREE.Vector3();

      // Track the *envelope*, not the instantaneous offset. A ringing string
      // passes back through its rest position every half period, so asking when
      // the offset first goes small measures the period and calls a lively web
      // dead. Sample the peak within each window and watch that decay instead.
      const WINDOW = 12; // 0.1 s
      const envelope: number[] = [];
      let windowPeak = 0;
      let crossings = 0;
      let previousSide = 0;

      for (let i = 0; i < 720; i += 1) {
        solver.step(FIXED_TIME_STEP);
        probe.set(
          store.positions[mid * 3],
          store.positions[mid * 3 + 1],
          store.positions[mid * 3 + 2],
        );
        const offset = probe.clone().sub(rest);
        const d = offset.length();
        windowPeak = Math.max(windowPeak, d);
        const side = Math.sign(offset.z);
        if (side !== 0 && previousSide !== 0 && side !== previousSide) crossings += 1;
        previousSide = side;
        if ((i + 1) % WINDOW === 0) {
          envelope.push(windowPeak);
          windowPeak = 0;
        }
      }

      const peak = Math.max(...envelope);
      const decayed = envelope.findIndex((v, i) => i > 1 && v < peak * 0.2);
      return {
        peakSwingUnits: +peak.toFixed(4),
        peakSwingLegSpans: +(peak / web.legSpan).toFixed(3),
        // How long until the swing falls to a fifth of its peak.
        ringSeconds: decayed < 0 ? ">6" : +(decayed * WINDOW * FIXED_TIME_STEP).toFixed(2),
        // Each pass through rest is half an oscillation; more means livelier.
        oscillations: Math.floor(crossings / 2),
      };
    },
    /** Rebuilds the spider with different tuning, for sweeping settings. */
    rebuild: (overrides: Partial<Record<string, number>>) => {
      if (!loadedRig) return false;
      // The new solver captures "rest" from the bones as they stand, so put
      // them back into bind pose first — rebuilding mid-stride would otherwise
      // bake the current walking pose in as the rig's neutral.
      choreographer?.ik.resetAll();
      choreographer = new SpiderChoreographer({
        rig: loadedRig,
        traversal,
        network: web.network,
        config: {
          ...SHOWCASE_CHOREOGRAPHY,
          ...overrides,
        } as ConstructorParameters<typeof SpiderChoreographer>[0]["config"],
        onFootPlant: (_legId, address) => pressFootfall(address),
      });
      rigDiagnostics?.setChoreographer(choreographer);
      return settleSpider();
    },
    rigDiagnostics: () => rigDiagnostics?.snapshot() ?? [],
  };
}

// --- Intent ------------------------------------------------------------------

const pointer = new THREE.Vector2();
const projected = new THREE.Vector3();

interface SilkPick {
  particle: number;
  world: THREE.Vector3;
}

/**
 * Picking silk by raycast is hopeless — the strands are a few thousandths of a
 * unit wide. Instead the nearest particle in *screen space* wins, which is what
 * the player means when they click near a thread anyway. The pick radius is a
 * forgiving screen-space target and has nothing to do with rendered thickness.
 */
function pickSilkAt(clientX: number, clientY: number): SilkPick | null {
  const rect = canvas.getBoundingClientRect();
  pointer.set(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );

  const store = web.network.particles;
  let bestDistance = 0.05; // squared NDC radius
  let bestDepth = Infinity;
  let best: SilkPick | null = null;

  for (let i = 0; i < store.count; i += 1) {
    projected.set(store.positions[i * 3], store.positions[i * 3 + 1], store.positions[i * 3 + 2]);
    const world = projected.clone();
    projected.project(camera);
    if (projected.z < -1 || projected.z > 1) {
      continue;
    }
    const dx = projected.x - pointer.x;
    const dy = projected.y - pointer.y;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance && projected.z < bestDepth) {
      bestDistance = Math.max(distance, 1e-6);
      bestDepth = projected.z;
      best = { particle: i, world };
    }
  }
  return best;
}

function pickSilk(event: PointerEvent): THREE.Vector3 | null {
  return pickSilkAt(event.clientX, event.clientY)?.world ?? null;
}

interface TapCandidate {
  pointerId: number;
  x: number;
  y: number;
  startedAt: number;
  moved: boolean;
}

let tapCandidate: TapCandidate | null = null;

// --- Touching the web ----------------------------------------------------------
// With the camera following her, drags are free — so a drag becomes a finger
// laid against the silk. Each brush displaces a small neighbourhood of
// particles; the whole drag is aggregated into ONE gesture and only that
// finished gesture is recorded against her memory — pointer movement itself
// earns nothing.

interface WebTouch {
  pointerId: number;
  x: number;
  y: number;
  lastImpulseAt: number;
}

/** Maps every physics particle back to a semantic strand address. */
const particleAddresses = new Map<number, { strandId: string; t: number }>();
for (const strand of web.network.strandList) {
  const lastIndex = strand.particleIndices.length - 1;
  for (let i = 0; i <= lastIndex; i += 1) {
    particleAddresses.set(strand.particleIndices[i], {
      strandId: strand.id,
      t: lastIndex > 0 ? i / lastIndex : 0.5,
    });
  }
}

interface ActiveGesture {
  energy: number;
  startedAt: number;
  brushes: number;
  /** The strand address most recently brushed — the gesture's location. */
  strandId: string | null;
  t: number;
}

let webTouch: WebTouch | null = null;
let activeGesture: ActiveGesture | null = null;
/** Gesture energy over the last ~30 s, for spotting sustained disruption. */
let recentGestureEnergy = 0;
/** Completed gestures over the last ~30 s. */
let recentGestureCount = 0;
/** Decaying sum of recent brush energy — what her feet actually read. */
let webDisturbance = 0;
const webDisturbancePoint = new THREE.Vector3();
let webDisturbanceStrandId: string | null = null;
let nextTouchResponseAt = 0;
/** Set when she answers a disturbance; a quiet follow-up earns calm credit. */
let pendingCalmResponseAt = 0;
const brushDirection = new THREE.Vector3();
const brushBasisX = new THREE.Vector3();
const brushBasisY = new THREE.Vector3();
const brushOffset = new THREE.Vector3();

/**
 * Lays a moving touch into the silk: a gentle displacement along the drag
 * direction, spread over nearby particles with falloff. Tuned well below the
 * deliberate signal pluck — brushing silk, not strumming a bass string.
 */
function brushSilk(pick: SilkPick, dx: number, dy: number): void {
  const speed = Math.hypot(dx, dy);
  if (speed < 1) return;
  const strength = THREE.MathUtils.clamp(speed / 26, 0.08, 0.5);

  // Screen drag mapped into world space through the camera basis.
  brushBasisX.setFromMatrixColumn(camera.matrixWorld, 0);
  brushBasisY.setFromMatrixColumn(camera.matrixWorld, 1);
  brushDirection
    .set(0, 0, 0)
    .addScaledVector(brushBasisX, dx)
    .addScaledVector(brushBasisY, -dy)
    .normalize();

  const store = web.network.particles;
  const radius = 0.34;
  const radiusSq = radius * radius;
  for (let i = 0; i < store.count; i += 1) {
    brushOffset.set(
      store.positions[i * 3] - pick.world.x,
      store.positions[i * 3 + 1] - pick.world.y,
      store.positions[i * 3 + 2] - pick.world.z,
    );
    const distanceSq = brushOffset.lengthSq();
    if (distanceSq > radiusSq) continue;
    const falloff = 1 - Math.sqrt(distanceSq) / radius;
    const push = strength * falloff * 0.55 * FIXED_TIME_STEP;
    store.previousPositions[i * 3] -= brushDirection.x * push;
    store.previousPositions[i * 3 + 1] -= brushDirection.y * push;
    store.previousPositions[i * 3 + 2] -= brushDirection.z * push;
  }

  webDisturbance = Math.min(3, webDisturbance + strength * 0.55);
  webDisturbancePoint.copy(pick.world);

  const address = particleAddresses.get(pick.particle) ?? null;
  webDisturbanceStrandId = address?.strandId ?? null;
  if (activeGesture) {
    activeGesture.energy += strength;
    activeGesture.brushes += 1;
    if (address) {
      activeGesture.strandId = address.strandId;
      activeGesture.t = address.t;
    }
  }
}

/** Closes the running gesture and records it as one meaningful event. */
function finishGesture(): void {
  const gesture = activeGesture;
  activeGesture = null;
  if (!gesture || gesture.brushes < 2 || gesture.energy < 0.2) return;

  const duration = habitatTime - gesture.startedAt;
  const kind: GestureKind = classifyGesture(gesture.energy, duration, recentGestureEnergy);
  recentGestureEnergy = Math.min(20, recentGestureEnergy + gesture.energy);
  recentGestureCount = Math.min(10, recentGestureCount + 1);

  recordGesture(memory, sessionBudget, kind, gesture.energy);
  if (gesture.strandId) {
    recordLocationEvent(
      memory,
      gesture.strandId,
      gesture.t,
      kind === "disruptive" ? "disruptive" : "gentle",
      Date.now(),
      kind === "moderate" ? 0.5 : 1,
    );
  }
  // A forceful gesture right after she answered cancels the calm credit.
  if (kind === "disruptive") pendingCalmResponseAt = 0;
  debugMind(`gesture ${kind}`, {
    energy: +gesture.energy.toFixed(2),
    duration: +duration.toFixed(1),
    recentEnergy: +recentGestureEnergy.toFixed(2),
  });
  saveMemory();
}

/**
 * Her side of the exchange. Disturbance decays on its own; if enough of it
 * accumulates while she is free, the hidden state weighs an answer: ignore,
 * freeze, attend, approach, or retreat. Nothing here interrupts feeding,
 * stalking, or a retreat already underway, and nothing is guaranteed — the
 * same touch on different days can earn a different spider.
 */
function updateWebSense(dt: number): void {
  webDisturbance = Math.max(0, webDisturbance - dt * (0.35 + webDisturbance * 0.12));
  recentGestureEnergy = Math.max(0, recentGestureEnergy - dt * 0.4);
  recentGestureCount = Math.max(0, recentGestureCount - dt / 12);
  tickStress(memory, dt);

  // She answered earlier and nothing forceful followed: that quiet is trust.
  if (pendingCalmResponseAt > 0 && habitatTime - pendingCalmResponseAt > 18) {
    pendingCalmResponseAt = 0;
    recordCalmResponse(memory, sessionBudget);
    debugMind("calm response credited");
  }

  if (!choreographer || webDisturbance < 0.85 || habitatTime < nextTouchResponseAt) return;

  const free =
    !moth &&
    (petMode === "watching" ||
      petMode === "resting" ||
      petMode === "listening" ||
      petMode === "grooming" ||
      petMode === "wandering");
  if (!free) return;

  if (loadedRig) loadedRig.rootObject.getWorldPosition(petWorldPosition);
  const distance = loadedRig ? petWorldPosition.distanceTo(webDisturbancePoint) : Infinity;
  const liveGestureKind: GestureKind =
    recentGestureEnergy > 8 ? "disruptive" : recentGestureEnergy > 3.5 ? "moderate" : "gentle";

  const decision = chooseTouchResponse(
    memory,
    temperament,
    {
      gesture: liveGestureKind,
      distance,
      recentGestures: Math.ceil(recentGestureCount),
      placeStress: disruptionNear(memory, webDisturbanceStrandId),
      hunger: memory.hunger,
      hourOfDay: new Date().getHours(),
    },
    Math.random(),
  );
  debugMind(`touch response: ${decision.response}`, decision.weights);

  switch (decision.response) {
    case "ignore":
      // Not obliged to care. A short refractory gap, then the silk settles.
      nextTouchResponseAt = habitatTime + 5 + Math.random() * 7;
      webDisturbance *= 0.5;
      return;
    case "freeze":
      choreographer.setIntent({ kind: "freeze" });
      setPetMode(
        "listening",
        `${memory.name} flattens against the silk and waits for the strand to settle.`,
        "holding perfectly still",
      );
      break;
    case "attend":
      choreographer.setIntent({ kind: "attend", at: webDisturbancePoint });
      setPetMode(
        "listening",
        `${memory.name} turns by degrees toward the strand that moved.`,
        "reading the vibration",
      );
      break;
    case "approach":
      choreographer.setIntent({
        kind: "travel",
        to: { kind: "world", position: webDisturbancePoint.clone(), maximumSnapDistance: 0.9 },
        urgency: 0.75,
      });
      setPetMode(
        "wandering",
        `${memory.name} crosses toward the strand that moved, one careful line at a time.`,
        "investigating the disturbance",
      );
      break;
    case "retreat":
      choreographer.setIntent({ kind: "retreat", to: { kind: "node", nodeId: web.retreatNodeId } });
      setPetMode(
        "retreating",
        `${memory.name} withdraws to the high corner and goes still.`,
        "withdrawing",
      );
      break;
  }

  if (decision.response !== "retreat") pendingCalmResponseAt = habitatTime;
  webDisturbance = 0;
  nextTouchResponseAt = habitatTime + 16 + Math.random() * 26;
}

function suggestDestination(event: PointerEvent): void {
  if (!choreographer) return;
  const target = pickSilk(event);
  if (!target) return;
  trackEngagement("strand_destination_chosen");
  choreographer.setIntent({
    kind: "travel",
    to: { kind: "world", position: target, maximumSnapDistance: 0.5 },
  });
  lastUserAction = habitatTime;
  setPetMode("wandering", `${memory.name} accepts the suggestion, but chooses every step herself.`, "following your signal");
  reticle.style.left = `${event.clientX}px`;
  reticle.style.top = `${event.clientY}px`;
  reticle.style.display = "block";
  reticle.getAnimations().forEach((animation) => animation.cancel());
  requestAnimationFrame(() => reticle.getAnimations().forEach((animation) => animation.play()));
  hapticPulse(7);
}

canvas.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || !choreographer) return;
  tapCandidate = {
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    startedAt: performance.now(),
    moved: false,
  };
  if (followSpider) {
    webTouch = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      lastImpulseAt: 0,
    };
    activeGesture = { energy: 0, startedAt: habitatTime, brushes: 0, strandId: null, t: 0.5 };
  }
});

canvas.addEventListener("pointermove", (event) => {
  if (tapCandidate && tapCandidate.pointerId === event.pointerId) {
    const distance = Math.hypot(event.clientX - tapCandidate.x, event.clientY - tapCandidate.y);
    if (distance > 11) tapCandidate.moved = true;
  }

  if (webTouch && webTouch.pointerId === event.pointerId) {
    const now = performance.now();
    const dx = event.clientX - webTouch.x;
    const dy = event.clientY - webTouch.y;
    // Throttled: pointermove can fire per-pixel, and each brush already covers
    // a neighbourhood.
    if (now - webTouch.lastImpulseAt > 30 && Math.hypot(dx, dy) > 2) {
      const pick = pickSilkAt(event.clientX, event.clientY);
      if (pick) {
        trackEngagement("web_touched");
        brushSilk(pick, dx, dy);
        lastUserAction = habitatTime;
      }
      webTouch.lastImpulseAt = now;
      webTouch.x = event.clientX;
      webTouch.y = event.clientY;
    }
  }
});

canvas.addEventListener("pointerup", (event) => {
  if (webTouch && webTouch.pointerId === event.pointerId) {
    webTouch = null;
    finishGesture();
  }
  if (!tapCandidate || tapCandidate.pointerId !== event.pointerId) return;
  const candidate = tapCandidate;
  tapCandidate = null;
  if (candidate.moved || performance.now() - candidate.startedAt > 450) return;
  suggestDestination(event);
});

canvas.addEventListener("pointercancel", () => {
  tapCandidate = null;
  webTouch = null;
  finishGesture();
});

function retreat(): void {
  if (!choreographer) return;
  trackEngagement("retreat_used");
  choreographer.setIntent({ kind: "retreat", to: { kind: "node", nodeId: web.retreatNodeId } });
  lastUserAction = habitatTime;
  setPetMode("retreating", `${memory.name} knows the safest knot in the web.`, "returning to her retreat");
  announce("She goes home without needing to be shown the way");
}

let lastSignalAt = -999;
let signalBurst = 0;

function signalOnWeb(): void {
  if (!choreographer) return;
  trackEngagement("web_touched");
  pluckSilk(1.55);
  const sinceLast = habitatTime - lastSignalAt;
  lastSignalAt = habitatTime;
  lastUserAction = habitatTime;

  // One unhurried pluck is a signal; a drumroll of them is a disturbance.
  // Neither the button nor the pointer can farm anything by repetition.
  signalBurst = Math.max(0, signalBurst - sinceLast / 25) + 1;
  if (sinceLast >= 90) {
    recordGesture(memory, sessionBudget, "gentle", 0.6);
    saveMemory();
  } else if (signalBurst >= 4) {
    signalBurst = 0;
    recordGesture(memory, sessionBudget, "disruptive", 3);
    debugMind("signal spam registered as disruptive");
    saveMemory();
  }

  setPetMode("listening", `${memory.name} turns toward the pluck and holds the line taut.`, "reading your tremor");
  announce("The pluck runs down every anchor line");
}

function toggleFollow(button: HTMLButtonElement): void {
  trackEngagement("camera_follow_used");
  followSpider = !followSpider;
  button.setAttribute("aria-pressed", String(followSpider));
  controls.enabled = !followSpider;
  announce(followSpider ? `Keeping ${memory.name} in view` : "Camera free · drag to orbit");
}

function toggleLights(button: HTMLButtonElement): void {
  trackEngagement("observation_light_used");
  redWatch = !redWatch;
  button.setAttribute("aria-pressed", String(redWatch));
  habitat.classList.toggle("red-watch", redWatch);
  redLamp.intensity = redWatch ? 3.2 : 0;
  cornerLamp.intensity = redWatch ? 0.25 : WARM_POINT_INTENSITY;
  warmWash.intensity = redWatch ? 0 : WARM_WASH_INTENSITY;
  warmFill.intensity = redWatch ? 0.04 : WARM_FILL_INTENSITY;
  key.intensity = redWatch ? 0.42 : 2.2;
  fill.intensity = redWatch ? 0.16 : 0.7;
  ambient.intensity = redWatch ? 0.18 : 0.43;
  renderer.toneMappingExposure = redWatch ? 0.72 : 0.88;
  announce(redWatch ? "Red observation light — less visible to her" : "Cool habitat light restored");
}

function renamePet(): void {
  const next = window.prompt("What should she answer to?", memory.name);
  if (!next?.trim()) return;
  trackEngagement("vesper_renamed");
  memory.name = next.trim().slice(0, 18);
  saveMemory();
  updateHud();
  announce(`She is ${memory.name} now`);
}

document.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((button) => {
  button.addEventListener("click", () => {
    hapticPulse();
    switch (button.dataset.action) {
      case "feed":
        offerMoth("keeper");
        break;
      case "signal":
        signalOnWeb();
        break;
      case "retreat":
        retreat();
        break;
      case "follow":
        toggleFollow(button);
        break;
      case "lights":
        toggleLights(button);
        break;
      case "rename":
        renamePet();
        break;
    }
  });
});

window.addEventListener("keydown", (event) => {
  if (rigDebugEnabled && event.key.toLowerCase() === "p") {
    setRigDebugPaused(!rigDebugPaused);
    return;
  }
  if (rigDebugEnabled && event.key === ".") {
    stepRigDebug();
    return;
  }
  if (!choreographer) {
    return;
  }
  switch (event.key.toLowerCase()) {
    case "r":
      retreat();
      break;
    case "f":
      choreographer.setIntent({ kind: "freeze" });
      lastUserAction = habitatTime;
      setPetMode("listening", `${memory.name} flattens into the silk and waits.`, "perfectly still");
      break;
    case "g":
      choreographer.setIntent({ kind: "travel", to: { kind: "node", nodeId: web.farNodeId } });
      lastUserAction = habitatTime;
      setPetMode("wandering", `${memory.name} crosses the long silk on her own terms.`, "patrolling the far line");
      break;
    case " ":
      event.preventDefault();
      choreographer.setIntent({ kind: "rest" });
      lastUserAction = habitatTime;
      setPetMode("resting", `${memory.name} settles her weight across the web.`, "at rest");
      break;
  }
});

function updateMoth(dt: number): void {
  if (!moth || !mothAddress || !choreographer) return;
  mothTimer += dt;
  const mothIsOnWeb = mothStage === "noticed"
    || mothStage === "hunting"
    || mothStage === "cached"
    || mothStage === "returning";
  traversal.getWorldPosition(mothAddress, mothWorldPosition);
  if (mothIsOnWeb) moth.position.copy(mothWorldPosition);

  const leftWing = moth.getObjectByName("wing-left");
  const rightWing = moth.getObjectByName("wing-right");
  if (mothStage === "noticed" || mothStage === "hunting") {
    moth.position.y += Math.sin(habitatTime * 11) * 0.012;
    moth.rotation.y = Math.sin(habitatTime * 7) * 0.16;
    const flutter = Math.sin(habitatTime * 34) * 0.55;
    leftWing?.rotation.set(0, Math.PI / 2 + flutter, 0);
    rightWing?.rotation.set(0, Math.PI / 2 - flutter, 0);
  } else if (mothStage === "subduing" || mothStage === "wrapping") {
    const wrapCoverage = mothWrap?.snapshot.coverage ?? 0;
    const subdueFreedom = mothStage === "subduing"
      ? 1 - THREE.MathUtils.clamp(mothTimer / Math.max(0.01, mothSubdueSeconds), 0, 1) * 0.58
      : 0.42 * Math.pow(1 - wrapCoverage, 1.7);
    const flutter = Math.sin(habitatTime * 31) * 0.34 * subdueFreedom;
    const pinnedAngle = THREE.MathUtils.lerp(0.12, 0.025, wrapCoverage);
    leftWing?.rotation.set(0, Math.PI / 2 + pinnedAngle + flutter, 0);
    rightWing?.rotation.set(0, Math.PI / 2 - pinnedAngle - flutter, 0);
  } else {
    leftWing?.rotation.set(0, Math.PI / 2 + 0.12, 0);
    rightWing?.rotation.set(0, Math.PI / 2 - 0.12, 0);
  }

  nextMothTremor -= dt;
  if (nextMothTremor <= 0 && (mothStage === "noticed" || mothStage === "hunting")) {
    const strand = web.network.strands.get(mothAddress.strandId);
    if (strand) {
      const point = strand.particleIndices[Math.max(1, strand.particleIndices.length >> 1)];
      web.network.particles.previousPositions[point * 3] -= 0.42 * FIXED_TIME_STEP;
    }
    nextMothTremor = 0.7 + Math.random() * 1.5;
  }

  if (mothStage === "noticed" && mothTimer > mothNoticeSeconds * feedingTimeScale) {
    mothStage = "hunting";
    mothTimer = 0;
    choreographer.setIntent({
      kind: "travel",
      to: { kind: "world", position: mothWorldPosition, maximumSnapDistance: 0.9 },
      urgency: 1.35,
    });
    setPetMode("stalking", `${memory.name} has separated prey from noise.`, "stalking the moth");
  }

  if (loadedRig) loadedRig.rootObject.getWorldPosition(petWorldPosition);
  const closeEnough = loadedRig ? petWorldPosition.distanceTo(mothWorldPosition) < 0.82 : false;
  if (mothStage === "hunting" && (closeEnough || (choreographer.state.arrived && mothTimer > 2))) {
    mothStage = "subduing";
    mothTimer = 0;
    mothCapturePosition.copy(moth.position);
    choreographer.setIntent({ kind: "freeze" });
    moth.scale.setScalar(mothFreshScale);
    setPetMode(
      "feeding",
      `${memory.name} pins the moth with her front legs. The web becomes a workbench.`,
      "subduing and turning prey",
    );
    announce("Eight legs close around the moth");
  }

  if (mothStage === "subduing") {
    positionMothAtMouth("subduing");
    mothWrap?.updateSubduing(dt);
    applyFeedingLimbPose(1, 10.5);
    if (mothTimer >= mothSubdueSeconds) {
      mothStage = "wrapping";
      mothTimer = 0;
      setPetMode(
        "feeding",
        `${memory.name} tumbles the moth while silk crosses it from every direction.`,
        "wrapping and rotating prey",
      );
    }
  } else if (mothStage === "wrapping") {
    positionMothAtMouth("wrapping");
    if (loadedRig) {
      loadedRig.spinnerets.left.getWorldPosition(mothWrapAttachments.leftSpinneret);
      loadedRig.spinnerets.right.getWorldPosition(mothWrapAttachments.rightSpinneret);
      loadedRig.footTips.L4.getWorldPosition(mothWrapAttachments.leftHindFoot);
      loadedRig.footTips.R4.getWorldPosition(mothWrapAttachments.rightHindFoot);
    }
    const plannedWrap = mothWrap?.advanceWrapping(dt, mothWrapAttachments);
    applyFeedingLimbPose(0.85, 7, plannedWrap?.leg);
    if (plannedWrap) solveWrappingRearLegIK(plannedWrap.leg, dt);
    if (loadedRig) {
      loadedRig.spinnerets.left.getWorldPosition(mothWrapAttachments.leftSpinneret);
      loadedRig.spinnerets.right.getWorldPosition(mothWrapAttachments.rightSpinneret);
      loadedRig.footTips.L4.getWorldPosition(mothWrapAttachments.leftHindFoot);
      loadedRig.footTips.R4.getWorldPosition(mothWrapAttachments.rightHindFoot);
    }
    const wrapState = mothWrap?.completeWrappingStep(dt, mothWrapAttachments);
    const coverageSolved = wrapState?.complete && mothTimer >= mothWrapSeconds * 0.65;
    if (coverageSolved || mothTimer >= mothWrapSeconds * 1.5) {
      mothWrap?.seal();
      mothWorkTargetInitialized.L4 = false;
      mothWorkTargetInitialized.R4 = false;
      mothStage = "feeding";
      mothTimer = 0;
      setPetMode(
        "feeding",
        `${memory.name} rotates the silk parcel between her legs and settles her fangs.`,
        "feeding slowly",
      );
      announce("The moth is wrapped. The long meal begins");
    }
  } else if (mothStage === "feeding") {
    positionMothAtMouth("feeding");
    applyFeedingLimbPose(0.32, 3.2);
    mothWrap?.settle(dt);
    mothMealProgress = Math.min(1, mothMealProgress + dt / Math.max(0.01, mothFeedingSeconds));

    if (mothFeedingNote === 0 && mothMealProgress > 0.36) {
      mothFeedingNote = 1;
      setPetMode(
        "feeding",
        `${memory.name} pauses between patient pulls, keeping the parcel turning.`,
        "working through the moth",
      );
    } else if (mothFeedingNote === 1 && mothMealProgress > 0.72) {
      mothFeedingNote = 2;
      setPetMode(
        "feeding",
        `${memory.name} is nearly finished. Even the smallest movements are deliberate.`,
        "finishing the meal",
      );
    }

    if (mothWillCache && !mothWasCached && mothMealProgress >= mothCacheAtProgress) {
      mothStage = "cached";
      mothTimer = 0;
      mothWasCached = true;
      traversal.getWorldPosition(mothAddress, mothWorldPosition);
      moth.position.copy(mothWorldPosition);
      updateMothContentsScale();
      choreographer.setIntent({ kind: "travel", to: { kind: "node", nodeId: web.retreatNodeId } });
      setPetMode(
        "retreating",
        `${memory.name} hangs the wrapped moth where the silk will remember it.`,
        "caching the meal",
      );
      announce("She saves the moth for later");
      return;
    }

    if (mothMealProgress >= 1) finishMothMeal();
  } else if (mothStage === "cached") {
    updateMothContentsScale();
    if (mothTimer >= mothCacheSeconds) {
      mothStage = "returning";
      mothTimer = 0;
      choreographer.setIntent({
        kind: "travel",
        to: { kind: "world", position: mothWorldPosition, maximumSnapDistance: 0.9 },
        urgency: 0.9,
      });
      setPetMode(
        "stalking",
        `${memory.name} turns back toward the parcel exactly where she left it.`,
        "returning to cached prey",
      );
    }
  } else if (mothStage === "returning") {
    updateMothContentsScale();
    if (loadedRig) loadedRig.rootObject.getWorldPosition(petWorldPosition);
    const reachedCache = loadedRig ? petWorldPosition.distanceTo(mothWorldPosition) < 0.82 : false;
    if (reachedCache || choreographer.state.arrived || mothTimer > 12 * feedingTimeScale) {
      mothStage = "feeding";
      mothTimer = 0;
      choreographer.setIntent({ kind: "freeze" });
      setPetMode(
        "feeding",
        `${memory.name} finds the exact place she left off.`,
        "resuming the meal",
      );
      announce("She came back for it");
    }
  }
}

/** One-shot after-absence glance toward remembered silk, armed at boot. */
let returnGlance: { strandId: string; t: number } | null = null;
/** Set when a travel should end in rest rather than watchful sampling. */
let arrivalRest = false;
const rememberedSpotPosition = new THREE.Vector3();

/** Routes a location memory through the normal travel intent. */
function travelToRememberedSpot(spot: { strandId: string; t: number }, urgency: number): boolean {
  if (!choreographer || !web.network.strands.has(spot.strandId)) return false;
  traversal.getWorldPosition(spot, rememberedSpotPosition);
  choreographer.setIntent({
    kind: "travel",
    to: { kind: "world", position: rememberedSpotPosition.clone(), maximumSnapDistance: 1.2 },
    urgency,
  });
  return true;
}

function updateAutonomy(dt: number): void {
  if (!choreographer) return;
  memory.hunger = Math.min(100, memory.hunger + dt * 0.004);
  if (forceRestTest) return;
  if (grooming?.snapshot.active) return;
  if (forcedTravelRunOwnsAutonomy()) return;
  if (moth) return;

  const state = choreographer.state;
  if ((petMode === "wandering" || petMode === "retreating" || petMode === "repairing") && state.arrived) {
    const arrivedFromRepair = petMode === "repairing";
    if (arrivedFromRepair) finishSilkRepair();
    choreographer.setIntent({ kind: "rest" });
    const arrivedFromRetreat = petMode === "retreating";
    const restHere = arrivalRest;
    arrivalRest = false;
    setPetMode(
      arrivedFromRepair ? "watching" : arrivedFromRetreat || restHere ? "resting" : "watching",
      arrivedFromRepair
        ? `${memory.name} tests the new line with one deliberate foot.`
        : arrivedFromRetreat
        ? `${memory.name} folds herself into the knot she trusts most.`
        : restHere
        ? `${memory.name} settles her weight and lets the strand stop swaying.`
        : `${memory.name} stops because the web has changed beneath her.`,
      arrivedFromRepair ? "inspecting fresh silk" : arrivedFromRetreat ? "safe in her retreat" : restHere ? "settled mid-web" : "sampling the silk",
    );
    // Where she chooses to stop is itself a memory, occasionally.
    const bodyAddress = choreographer.bodyAddress;
    if (bodyAddress && habitatTime - lastUserAction > 20 && Math.random() < 0.5) {
      recordLocationEvent(memory, bodyAddress.strandId, bodyAddress.t, "calm", Date.now(), 0.5);
    }
    activityDeadline = habitatTime + 8 + Math.random() * 12;
    return;
  }

  if (
    habitatTime >= nextWildPreyAt &&
    memory.hunger >= 55 &&
    habitatTime - lastUserAction > 16 &&
    (!state.hasRoute || state.arrived)
  ) {
    offerMoth("wild");
    nextWildPreyAt = habitatTime + 70 + Math.random() * 90;
    return;
  }

  if (
    habitatTime < activityDeadline ||
    habitatTime - lastUserAction < 12 ||
    (state.hasRoute && !state.arrived)
  ) {
    return;
  }

  // Once settled after a long absence: one silent look toward remembered silk.
  if (returnGlance && habitatTime > 9) {
    const spot = returnGlance;
    returnGlance = null;
    if (web.network.strands.has(spot.strandId)) {
      traversal.getWorldPosition(spot, rememberedSpotPosition);
      choreographer.setIntent({ kind: "attend", at: rememberedSpotPosition });
      setPetMode(
        "watching",
        `${memory.name} pauses, facing a stretch of silk as if she expects it to move.`,
        "watching one strand",
      );
      activityDeadline = habitatTime + 7 + Math.random() * 5;
      return;
    }
  }

  const hour = new Date().getHours();
  const decision = chooseAutonomousBehavior(
    memory,
    temperament,
    {
      hunger: memory.hunger,
      hourOfDay: hour,
      isNight: hour >= 19 || hour < 6,
      secondsSinceUserAction: habitatTime - lastUserAction,
      hasTouchedSpot: pickLocation(memory, "touched") !== null,
      hasCalmSpot: pickLocation(memory, "calmSpot") !== null,
      hasCatchSpot: pickLocation(memory, "catchSpot") !== null,
    },
    Date.now(),
    Math.random(),
  );
  noteBehaviorTaken(memory, decision.id, Date.now());
  debugMind(`autonomy: ${decision.id}`, decision.weights);

  switch (decision.id) {
    case "repair":
      choreographer.setIntent({ kind: "travel", to: { kind: "node", nodeId: web.farNodeId }, urgency: 0.42 });
      beginSilkRepair();
      setPetMode("repairing", `${memory.name} pays out a line where the web feels too open.`, "reinforcing the web");
      break;
    case "patrol":
      choreographer.setIntent({ kind: "travel", to: { kind: "node", nodeId: web.farNodeId }, urgency: 0.55 });
      setPetMode("wandering", `${memory.name} begins a patrol no one asked for.`, "checking the far anchors");
      rememberAutonomousAct("Patrolled the far anchors without being asked.");
      break;
    case "shelter":
      choreographer.setIntent({ kind: "retreat", to: { kind: "node", nodeId: web.retreatNodeId } });
      setPetMode("retreating", `${memory.name} decides the open web has seen enough of her.`, "returning to shadow");
      rememberAutonomousAct("Chose the retreat when the room felt too exposed.");
      break;
    case "groom":
      beginGrooming(
        `${memory.name} stops, folds one leg inward, and combs the tarsus through her chelicerae.`,
      );
      rememberAutonomousAct("Stopped to groom a tarsus through her chelicerae.");
      break;
    case "listen":
      choreographer.setIntent({ kind: "freeze" });
      setPetMode("listening", `${memory.name} stills every joint. Something moved beyond the glass.`, "listening through silk");
      rememberAutonomousAct("Stilled herself to read the room through silk.");
      break;
    case "visitTouched": {
      const spot = pickLocation(memory, "touched");
      if (spot && travelToRememberedSpot(spot, 0.6)) {
        setPetMode("wandering", `${memory.name} crosses to a stretch of silk and tests it, foot by foot.`, "walking a particular line");
        rememberAutonomousAct("Went back to one strand and walked it end to end.");
      } else {
        choreographer.setIntent({ kind: "rest" });
        setPetMode("resting", `${memory.name} does nothing at all, with great intention.`, "breathing beneath the web");
      }
      break;
    }
    case "restFamiliar": {
      const spot = pickLocation(memory, "calmSpot");
      if (spot && travelToRememberedSpot(spot, 0.4)) {
        arrivalRest = true;
        setPetMode("wandering", `${memory.name} moves off with somewhere clearly in mind.`, "crossing the web");
        rememberAutonomousAct("Settled at the same mid-web junction as before.");
      } else {
        choreographer.setIntent({ kind: "rest" });
        setPetMode("resting", `${memory.name} does nothing at all, with great intention.`, "breathing beneath the web");
      }
      break;
    }
    case "inspectCatch": {
      const spot = pickLocation(memory, "catchSpot");
      if (spot && travelToRememberedSpot(spot, 0.55)) {
        setPetMode("wandering", `${memory.name} detours mid-patrol and pauses where the silk is roughened.`, "retracing a line");
        rememberAutonomousAct("Paused on patrol where the silk still carries old wrap marks.");
      } else {
        choreographer.setIntent({ kind: "rest" });
        setPetMode("resting", `${memory.name} does nothing at all, with great intention.`, "breathing beneath the web");
      }
      break;
    }
    default:
      choreographer.setIntent({ kind: "rest" });
      setPetMode("resting", `${memory.name} does nothing at all, with great intention.`, "breathing beneath the web");
      break;
  }
  activityDeadline = Math.max(
    activityDeadline,
    habitatTime + 12 + Math.random() * 20,
  );
}

function updateAtmosphere(dt: number): void {
  weather.update(dt, habitatTime, redWatch);

  // Live humidity takes precedence. The old dawn window remains a graceful
  // offline fallback, and neither path announces itself in the interface.
  const condensed = forceDew || weather.silkCondensed || (!weather.hasConditions && isDewHour());
  dew.setCondensed(condensed);
  dew.update(dt, habitatTime);

  // Some nights, a visitor.
  if (!firefly.active && (forceFirefly || isNightHour()) && habitatTime >= nextFireflyAt) {
    firefly.launch();
    nextFireflyGlance = habitatTime + 3;
    fireflyHeldHerGaze = false;
  }
  if (firefly.active) {
    firefly.update(dt, habitatTime);
    // She notices it through stillness. This is deliberately a one-shot freeze:
    // repeatedly replanning an `attend` route to the moving ember made a spider
    // whose HUD still said RESTING replant her feet every few seconds.
    const free = !moth
      && petMode !== "feeding"
      && petMode !== "stalking"
      && petMode !== "grooming"
      && choreographer;
    if (free && !fireflyHeldHerGaze && habitatTime >= nextFireflyGlance) {
      const intent = choreographer?.state.intent;
      // Do not disturb an already locked rest/freeze pose merely to notice it.
      if (intent !== "rest" && intent !== "freeze") {
        choreographer?.setIntent({ kind: "freeze" });
      }
      fireflyHeldHerGaze = true;
    }
  } else if (fireflyHeldHerGaze) {
    fireflyHeldHerGaze = false;
    nextFireflyAt = habitatTime + (forceFirefly ? 30 : 240 + Math.random() * 420);
    if (
      !moth
      && petMode !== "feeding"
      && petMode !== "stalking"
      && petMode !== "grooming"
    ) {
      choreographer?.setIntent({ kind: "rest" });
    }
  }
}

// --- Loop --------------------------------------------------------------------

let viewportWidth = 0;
let viewportHeight = 0;

function resize(): void {
  const width = canvas.clientWidth || window.innerWidth;
  const height = canvas.clientHeight || window.innerHeight;
  // Compare against the last requested CSS size, not canvas.width — that is the
  // drawing buffer, which pixelRatio has already scaled, so it never matches and
  // the renderer reallocates its buffer every single frame.
  if (width === viewportWidth && height === viewportHeight) {
    return;
  }
  viewportWidth = width;
  viewportHeight = height;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

let previous = performance.now();
let accumulator = 0;
const adaptiveQuality = new AdaptiveQualityController();

function applyAdaptiveQuality(level: AdaptiveQualityLevel): void {
  const reducedPixelRatio = mobileExperience ? 1.1 : 1.5;
  const minimumPixelRatio = mobileExperience ? 0.9 : 1.1;
  const pixelRatio = level === 0
    ? fullPixelRatio
    : Math.min(fullPixelRatio, level === 1 ? reducedPixelRatio : minimumPixelRatio);
  renderer.setPixelRatio(pixelRatio);

  // XPBD is deliberately less sensitive to iteration count than a spring
  // solver. This trims CPU work without changing the simulation clock or any
  // of Vesper's decisions, routes, and timings.
  solver.settings.iterations = level === 0 ? fullSolverIterations : level === 1 ? 12 : 8;

  // Shadows are the last visible detail to go. Mobile already has no casting
  // key light, so this emergency step is effectively invisible there.
  const shadowsEnabled = level < 2;
  if (renderer.shadowMap.enabled !== shadowsEnabled) {
    renderer.shadowMap.enabled = shadowsEnabled;
    if (shadowsEnabled) renderer.shadowMap.needsUpdate = true;
  }
}

function frame(now: number): void {
  const qualityDecision = adaptiveQuality.observe(now, document.hidden);
  if (qualityDecision) applyAdaptiveQuality(qualityDecision.level);

  const realDelta = Math.min((now - previous) / 1000, MAX_FRAME_DELTA);
  previous = now;
  let delta = realDelta;
  if (rigDebugEnabled && rigDebugPaused) {
    accumulator = 0;
    delta = rigDebugSteps > 0 ? FIXED_TIME_STEP : 0;
    if (rigDebugSteps > 0) rigDebugSteps -= 1;
  }
  accumulator += delta;
  habitatTime += delta;
  grooming?.restoreBasePose();
  removeFeedingLimbPose();

  let steps = 0;
  while (accumulator >= FIXED_TIME_STEP && steps < MAX_SUBSTEPS) {
    solver.step(FIXED_TIME_STEP);
    if (legGym) legGym.update(FIXED_TIME_STEP);
    else if (choreographer) {
      choreographer.update(FIXED_TIME_STEP);
      if (forcedTravelNodeIsValid()) forcedTravelAttempted = true;
    }
    accumulator -= FIXED_TIME_STEP;
    steps += 1;
  }
  if (steps >= MAX_SUBSTEPS) {
    accumulator = 0;
  }

  if (!legGym) {
    updateMoth(delta);
    if (grooming?.update(
      delta * groomingTimeScale,
      choreographer?.state.restPoseSettled ?? false,
    )) {
      finishGrooming();
    }
    updateAutonomy(delta);
    updateAtmosphere(delta);
    updateWebSense(delta);
  }
  updateFreshSilk(delta);
  updateEyeShine(delta);
  spiderDroppings.update(
    delta,
    loadedRig?.spinnerets.center ?? null,
    !legGym && mothStage === "none",
  );
  if (toastTimer > 0) {
    toastTimer -= delta;
    if (toastTimer <= 0) toast.classList.remove("visible");
  }
  hudTimer -= delta;
  if (hudTimer <= 0) {
    updateHud();
    hudTimer = 0.2;
  }

  if (import.meta.env.DEV && grooming) {
    document.documentElement.dataset.groomTest = JSON.stringify({
      ...grooming.snapshot,
      choreographer: choreographer?.state ?? null,
      feet: loadedRig
        ? Object.fromEntries(
            SPIDER_LEG_IDS.map((legId) => [
              legId,
              loadedRig!.footTips[legId]
                .getWorldPosition(new THREE.Vector3())
                .toArray(),
            ]),
          )
        : null,
    });
  }

  if (import.meta.env.DEV && choreographer) {
    if (loadedRig) loadedRig.rootObject.getWorldPosition(petWorldPosition);
    document.documentElement.dataset.routeTest = JSON.stringify({
      state: choreographer.state,
      mothStage,
      bodyPosition: loadedRig ? petWorldPosition.toArray() : null,
      mothPosition: moth && mothAddress ? mothWorldPosition.toArray() : null,
      mothAddress,
    });
  }

  if (import.meta.env.DEV && forcedTravelNodeIsValid() && choreographer) {
    const turnRuntime = choreographer as unknown as {
      bodyForward: THREE.Vector3;
      bodyUp: THREE.Vector3;
      desiredForward: THREE.Vector3;
      cinematicSupportForward: THREE.Vector3;
      cinematicFeet: Map<string, { position: THREE.Vector3; moving: boolean }>;
    };
    const state = choreographer.state;
    document.documentElement.dataset.turnTest = JSON.stringify({
      status: !forcedTravelAttempted
        ? "pending"
        : state.arrived
          ? "complete"
          : state.hasRoute
            ? "active"
            : "failed",
      state,
      bodyPosition: loadedRig?.rootObject.position.toArray() ?? null,
      bodyForward: turnRuntime.bodyForward.toArray(),
      bodyUp: turnRuntime.bodyUp.toArray(),
      desiredForward: turnRuntime.desiredForward.toArray(),
      supportForward: turnRuntime.cinematicSupportForward.toArray(),
      feet: [...turnRuntime.cinematicFeet].map(([legId, foot]) => ({
        legId,
        moving: foot.moving,
        position: foot.position.toArray(),
      })),
    });
  }

  resize();
  if (followSpider && loadedRig) {
    loadedRig.rootObject.getWorldPosition(petWorldPosition);
    controls.target.lerp(petWorldPosition, Math.min(1, delta * 4));
    const desiredCamera = petWorldPosition.clone().add(new THREE.Vector3(2.1, 1.1, 2.4));
    camera.position.lerp(desiredCamera, Math.min(1, delta * 1.8));
    camera.lookAt(controls.target);
  }
  controls.update();
  silk.update(camera);
  rigDiagnostics?.update(now);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);

updateHud();
window.addEventListener("beforeunload", saveMemory);
document.addEventListener("visibilitychange", () => {
  adaptiveQuality.observe(performance.now(), true);
  if (document.hidden) {
    saveMemory();
    return;
  }
  previous = performance.now();
  accumulator = 0;
});

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  });
}

boot().catch((error: unknown) => {
  trackEngagement("load_failed");
  setStatus(error instanceof Error ? error.message : String(error));
  console.error(error);
});
