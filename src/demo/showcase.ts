import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { FIXED_TIME_STEP, MAX_FRAME_DELTA, MAX_SUBSTEPS } from "../config";
import { WebPhysicsSolver } from "../physics/WebPhysicsSolver";
import { SpiderChoreographer } from "../spider/choreography/index";
import { loadSpiderRig } from "../spider/SpiderRigLoader";
import { createWebNetworkTraversal } from "../traversal/index";
import { createCobweb } from "../web/createCobweb";
import { SilkRenderer } from "./SilkRenderer";
import "./showcase.css";

const canvas = document.getElementById("stage") as HTMLCanvasElement;
const status = document.getElementById("status") as HTMLElement;
const habitat = document.getElementById("habitat") as HTMLElement;
const stateLabel = document.getElementById("state-label") as HTMLElement;
const activityLabel = document.getElementById("activity") as HTMLElement;
const bondMeter = document.getElementById("bond-meter") as HTMLElement;
const bondLabel = document.getElementById("bond-label") as HTMLElement;
const hungerMeter = document.getElementById("hunger-meter") as HTMLElement;
const hungerLabel = document.getElementById("hunger-label") as HTMLElement;
const memoryLine = document.getElementById("memory-line") as HTMLElement;
const petName = document.getElementById("pet-name") as HTMLElement;
const clock = document.getElementById("clock") as HTMLElement;
const toast = document.getElementById("toast") as HTMLElement;
const reticle = document.getElementById("reticle") as HTMLElement;
const instinctLabel = document.getElementById("instinct-label") as HTMLElement;
const autonomyCount = document.getElementById("autonomy-count") as HTMLElement;
const autonomyLog = document.getElementById("autonomy-log") as HTMLOListElement;
const feedButton = document.querySelector<HTMLButtonElement>("[data-action='feed']");
const followButton = document.querySelector<HTMLButtonElement>("[data-action='follow']");

const mobileExperience =
  window.matchMedia("(max-width: 820px), (pointer: coarse)").matches ||
  Math.min(window.innerWidth, window.innerHeight) <= 560;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, mobileExperience ? 1.35 : 2));
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
const cornerLamp = new THREE.PointLight(0xffd8ac, 10.5, 36, 1.65);
cornerLamp.position.set(8.5, 12.5, 8.5);
scene.add(cornerLamp);

function buildRoom(): void {
  const bulb = new THREE.Mesh(
    new THREE.SphereGeometry(0.075, 12, 8),
    new THREE.MeshStandardMaterial({
      color: 0xffe8cb,
      emissive: 0xffc88f,
      emissiveIntensity: 4,
      roughness: 0.25,
    }),
  );
  bulb.position.copy(cornerLamp.position);
  scene.add(bulb);

  const roomMaterial = new THREE.MeshStandardMaterial({
    color: 0x090a09,
    roughness: 0.94,
    metalness: 0,
  });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(42, 42), roomMaterial);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.08;
  floor.receiveShadow = true;
  scene.add(floor);

  const wallMaterial = roomMaterial.clone();
  wallMaterial.color.setHex(0x070807);
  const backWall = new THREE.Mesh(new THREE.PlaneGeometry(42, 24), wallMaterial);
  backWall.position.set(0, 10, -11.55);
  backWall.receiveShadow = true;
  scene.add(backWall);
  const sideWall = new THREE.Mesh(new THREE.PlaneGeometry(42, 24), wallMaterial);
  sideWall.position.set(-11.55, 10, 0);
  sideWall.rotation.y = Math.PI / 2;
  sideWall.receiveShadow = true;
  scene.add(sideWall);

  const crateMaterial = new THREE.MeshStandardMaterial({
    color: 0x17130f,
    roughness: 0.88,
  });
  const crate = new THREE.Mesh(new THREE.BoxGeometry(3.6, 3.55, 3.6), crateMaterial);
  crate.position.set(5.2, 1.7, 4.25);
  crate.castShadow = true;
  crate.receiveShadow = true;
  scene.add(crate);

  const dustCount = mobileExperience ? 220 : 460;
  const positions = new Float32Array(dustCount * 3);
  for (let i = 0; i < dustCount; i += 1) {
    positions[i * 3] = THREE.MathUtils.randFloatSpread(25);
    positions[i * 3 + 1] = Math.random() * 16;
    positions[i * 3 + 2] = THREE.MathUtils.randFloatSpread(25);
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

buildRoom();

// --- Simulation --------------------------------------------------------------

// Web tuning is reachable from the query string so it can be swept without an
// edit-and-reload cycle, e.g. ?tautness=0.997&damping=0.3
const tuning = new URLSearchParams(location.search);
const tuned = (key: string): number | undefined => {
  const raw = tuning.get(key);
  const value = raw === null ? NaN : Number(raw);
  return Number.isFinite(value) ? value : undefined;
};

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
const traversal = createWebNetworkTraversal(web.network, FIXED_TIME_STEP);
const silk = new SilkRenderer(scene, web.network);

let choreographer: SpiderChoreographer | null = null;
let loadedRig: Awaited<ReturnType<typeof loadSpiderRig>> | null = null;

const SHOWCASE_CHOREOGRAPHY = {
  // The habitat is theater. Routes provide direction and nearby silk suggests
  // footfalls, but neither reach budgets nor missing contacts may stop her.
  cinematicLocomotion: true,
  travelSpeed: 0.58,
  speedResponse: 5.5,
  stepTriggerDistance: 0.2,
  stepUrgentDistance: 0.36,
  stepLead: 0.23,
  footholdSearchRadius: 1.12,
  legSweepDegrees: 172,
  midlineTolerance: 0.24,
  swingDuration: 0.32,
  swingLift: 0.085,
  minimumPlantedFeet: 4,
  maximumSwingingFeet: 2,
  maximumLeash: 0.72,
  bodyFollowRate: 5.4,
  bodyTurnRate: 2.8,
  bodyLean: 0.12,
  abdomenLag: 0.18,
  pauseChancePerSecond: 0.22,
  bodyWeight: 0.95,
} as const;

interface PetMemory {
  name: string;
  bond: number;
  hunger: number;
  visits: number;
  feedings: number;
  lastVisit: number;
  autonomousActs: number;
  silkMemories: string[];
}

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

const MEMORY_KEY = "pet-black-widow:vesper:v1";
const nowAtLoad = Date.now();

function readMemory(): PetMemory {
  const fallback: PetMemory = {
    name: "Vesper",
    bond: 12,
    hunger: 42,
    visits: 0,
    feedings: 0,
    lastVisit: 0,
    autonomousActs: 0,
    silkMemories: [],
  };
  try {
    const saved = JSON.parse(localStorage.getItem(MEMORY_KEY) ?? "null") as Partial<PetMemory> | null;
    if (!saved) return fallback;
    const elapsedHours = Math.max(0, (nowAtLoad - (saved.lastVisit ?? nowAtLoad)) / 3_600_000);
    return {
      name: typeof saved.name === "string" && saved.name.trim() ? saved.name.slice(0, 18) : fallback.name,
      bond: THREE.MathUtils.clamp(saved.bond ?? fallback.bond, 0, 100),
      hunger: THREE.MathUtils.clamp((saved.hunger ?? fallback.hunger) + elapsedHours * 1.8, 0, 100),
      visits: Math.max(0, Math.floor(saved.visits ?? 0)),
      feedings: Math.max(0, Math.floor(saved.feedings ?? 0)),
      lastVisit: saved.lastVisit ?? 0,
      autonomousActs: Math.max(0, Math.floor(saved.autonomousActs ?? 0)),
      silkMemories: Array.isArray(saved.silkMemories)
        ? saved.silkMemories.filter((item): item is string => typeof item === "string").slice(0, 3)
        : [],
    };
  } catch {
    return fallback;
  }
}

const memory = readMemory();
const previousVisit = memory.lastVisit;
memory.visits += 1;
memory.lastVisit = nowAtLoad;
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
let mothAddress: { strandId: string; t: number } | null = null;
let mothStage: "none" | "noticed" | "hunting" | "caught" = "none";
let mothTimer = 0;
let nextMothTremor = 0;
let mothSource: "keeper" | "wild" = "keeper";
let nextWildPreyAt = 38 + Math.random() * 34;
let freshSilk: THREE.Line | null = null;
let freshSilkPoints: THREE.Vector3[] = [];
const fadingSilk: Array<{ line: THREE.Line; age: number }> = [];
const petWorldPosition = new THREE.Vector3();
const mothWorldPosition = new THREE.Vector3();
const homeWorldPosition = new THREE.Vector3();
let awayMemory = "";

controls.enabled = !followSpider;
followButton?.setAttribute("aria-pressed", String(followSpider));

function hapticPulse(duration = 9): void {
  if (mobileExperience && typeof navigator.vibrate === "function") navigator.vibrate(duration);
}

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
  if (!isNight && memory.bond < 45) return "shelter";
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
  if (previousVisit <= 0) return;
  const hoursAway = Math.max(0, (nowAtLoad - previousVisit) / 3_600_000);
  if (hoursAway < 1.5) return;

  if (hoursAway > 30) {
    awayMemory = "She rebuilt the quietest line while the room belonged to her.";
  } else if (memory.hunger >= 68) {
    awayMemory = "She hunted the outer silk, but kept listening for your signal.";
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
  memory.lastVisit = Date.now();
  try {
    localStorage.setItem(MEMORY_KEY, JSON.stringify(memory));
  } catch {
    // A private browsing policy may block storage. The pet still works for this visit.
  }
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
  petMode = mode;
  fieldNote = note;
  activityLabel.textContent = activity;
}

function bondWord(value: number): string {
  if (value >= 82) return "devoted";
  if (value >= 58) return "familiar";
  if (value >= 32) return "curious";
  if (value >= 16) return "aware";
  return "new";
}

function hungerWord(value: number): string {
  if (value >= 82) return "ravenous";
  if (value >= 58) return "hunting";
  if (value >= 28) return "patient";
  return "sated";
}

function describeMemory(): string {
  if (memory.visits <= 1) return "She has not met you yet. Move gently.";
  const away = previousVisit > 0 ? (nowAtLoad - previousVisit) / 3_600_000 : 0;
  if (away < 1) return `She noticed you came back. Visit ${memory.visits}.`;
  if (away < 24) return `She remembers you from earlier. Visit ${memory.visits}.`;
  const days = Math.max(1, Math.floor(away / 24));
  return `She remembers your signal after ${days} ${days === 1 ? "day" : "days"}.`;
}

function updateHud(): void {
  const state = choreographer?.state;
  const visibleMode = state?.stranded ? "considering" : petMode;
  petName.textContent = memory.name.toUpperCase();
  document.title = `${memory.name} · Autonomous Black Widow`;
  stateLabel.textContent = visibleMode.toUpperCase();
  status.textContent = fieldNote;
  bondMeter.style.width = `${memory.bond}%`;
  bondLabel.textContent = bondWord(memory.bond);
  hungerMeter.style.width = `${memory.hunger}%`;
  hungerLabel.textContent = hungerWord(memory.hunger);
  memoryLine.textContent = describeMemory();
  const minutes = Math.floor(habitatTime / 60).toString().padStart(2, "0");
  const seconds = Math.floor(habitatTime % 60).toString().padStart(2, "0");
  clock.textContent = `${minutes}:${seconds}`;
  if (feedButton) feedButton.disabled = moth !== null;
  renderSilkMemory();
}

function createMoth(): THREE.Group {
  const group = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.035, 0.095, 4, 8),
    new THREE.MeshStandardMaterial({ color: 0x8f806b, roughness: 0.9 }),
  );
  body.rotation.z = Math.PI / 2;
  group.add(body);
  const wingMaterial = new THREE.MeshBasicMaterial({
    color: 0xc9bda5,
    transparent: true,
    opacity: 0.72,
    side: THREE.DoubleSide,
  });
  const wingShape = new THREE.Shape();
  wingShape.moveTo(0, 0);
  wingShape.bezierCurveTo(0.03, 0.12, 0.18, 0.16, 0.2, 0.03);
  wingShape.bezierCurveTo(0.14, -0.02, 0.05, -0.02, 0, 0);
  for (const side of [-1, 1]) {
    const wing = new THREE.Mesh(new THREE.ShapeGeometry(wingShape, 8), wingMaterial);
    wing.name = side < 0 ? "wing-left" : "wing-right";
    wing.scale.y = side;
    wing.rotation.y = Math.PI / 2;
    group.add(wing);
  }
  const glow = new THREE.PointLight(0xdabf91, 0.32, 1.5, 2);
  group.add(glow);
  return group;
}

function offerMoth(source: "keeper" | "wild" = "keeper"): void {
  if (!choreographer || moth) return;
  const farNode = web.network.nodes.get(web.farNodeId);
  const strandId = farNode ? [...farNode.connectedStrandIds][0] : web.homeStrandId;
  if (!strandId) return;
  mothAddress = { strandId, t: 0.58 };
  moth = createMoth();
  mothSource = source;
  if (source === "wild") moth.scale.setScalar(0.72);
  scene.add(moth);
  traversal.getWorldPosition(mothAddress, mothWorldPosition);
  moth.position.copy(mothWorldPosition);
  mothStage = "noticed";
  mothTimer = 0;
  nextMothTremor = 0.15;
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
  scene.remove(moth);
  moth.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) material.dispose();
  });
  moth = null;
  mothAddress = null;
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
 * Makes her black.
 *
 * The GLB ships an untextured pure-white `MeshStandardMaterial` at roughness 1 —
 * it is a rig deliverable, not an art asset — so out of the box she renders as a
 * pale plastic model of a spider. No amount of lighting fixes white. A widow is
 * near-black and *glossy*, and the gloss is doing most of the work: the moving
 * specular highlight across the abdomen is what sells her as wet chitin rather
 * than a silhouette. The game will bring its own materials; this is so the lab
 * shows a black widow.
 */
function dressAsWidow(mesh: THREE.SkinnedMesh): void {
  const widow = new THREE.MeshStandardMaterial({
    color: 0x0a0a0e,
    roughness: 0.26,
    metalness: 0.05,
  });
  mesh.material = widow;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
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
  scene.add(rig.rootObject);

  choreographer = new SpiderChoreographer({
    rig,
    traversal,
    network: web.network,
    config: SHOWCASE_CHOREOGRAPHY,
  });

  // Let the web hang and settle before the spider arrives, so she lands on silk
  // that has already found its shape rather than silk still falling.
  for (let i = 0; i < 240; i += 1) {
    solver.step(FIXED_TIME_STEP);
  }

  if (!settleSpider()) {
    setStatus("She cannot find safe footing in this web.");
    return;
  }
  traversal.getWorldPosition({ strandId: web.homeStrandId, t: 0.5 }, homeWorldPosition);
  setPetMode(
    "watching",
    awayMemory || (memory.visits > 1
      ? `${memory.name} is still. The web says she knows this visitor.`
      : `${memory.name} tests the air and waits to learn your signal.`),
    awayMemory ? "remembering the hours alone" : "reading the room",
  );
  memory.bond = Math.min(100, memory.bond + (memory.visits > 1 ? 0.6 : 0));
  saveMemory();
  updateHud();
}

// --- Test seam ---------------------------------------------------------------
// The illusion is visual, but its mechanics are not: feet either hold real
// addresses on real silk or they do not. This lets that be checked without a
// camera, by stepping the same fixed-step loop the renderer drives.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__silklab = {
    step(count: number) {
      for (let i = 0; i < count; i += 1) {
        solver.step(FIXED_TIME_STEP);
        choreographer?.update(FIXED_TIME_STEP);
      }
      return choreographer?.state;
    },
    state: () => choreographer?.state,
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
          }))
        : [],
    travelTo: (nodeId: string) =>
      choreographer?.setIntent({ kind: "travel", to: { kind: "node", nodeId } }),
    raw: () => ({ choreographer, traversal, rig: loadedRig, network: web.network }),
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
      choreographer = new SpiderChoreographer({
        rig: loadedRig,
        traversal,
        network: web.network,
        config: {
          ...SHOWCASE_CHOREOGRAPHY,
          ...overrides,
        } as ConstructorParameters<typeof SpiderChoreographer>[0]["config"],
      });
      return settleSpider();
    },
  };
}

// --- Intent ------------------------------------------------------------------

const pointer = new THREE.Vector2();
const projected = new THREE.Vector3();

/**
 * Picking silk by raycast is hopeless — the strands are a few thousandths of a
 * unit wide. Instead the nearest particle in *screen space* wins, which is what
 * the player means when they click near a thread anyway.
 */
function pickSilk(event: PointerEvent): THREE.Vector3 | null {
  const rect = canvas.getBoundingClientRect();
  pointer.set(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );

  const store = web.network.particles;
  let bestDistance = 0.05; // squared NDC radius — a forgiving click target
  let bestDepth = Infinity;
  let best: THREE.Vector3 | null = null;

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
      best = world;
    }
  }
  return best;
}

interface TapCandidate {
  pointerId: number;
  x: number;
  y: number;
  startedAt: number;
  moved: boolean;
}

let tapCandidate: TapCandidate | null = null;

function suggestDestination(event: PointerEvent): void {
  if (!choreographer) return;
  const target = pickSilk(event);
  if (!target) return;
  choreographer.setIntent({
    kind: "travel",
    to: { kind: "world", position: target, maximumSnapDistance: 0.5 },
  });
  lastUserAction = habitatTime;
  memory.bond = Math.min(100, memory.bond + 0.12);
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
});

canvas.addEventListener("pointermove", (event) => {
  if (!tapCandidate || tapCandidate.pointerId !== event.pointerId) return;
  const distance = Math.hypot(event.clientX - tapCandidate.x, event.clientY - tapCandidate.y);
  if (distance > 11) tapCandidate.moved = true;
});

canvas.addEventListener("pointerup", (event) => {
  if (!tapCandidate || tapCandidate.pointerId !== event.pointerId) return;
  const candidate = tapCandidate;
  tapCandidate = null;
  if (candidate.moved || performance.now() - candidate.startedAt > 450) return;
  suggestDestination(event);
});

canvas.addEventListener("pointercancel", () => {
  tapCandidate = null;
});

function retreat(): void {
  if (!choreographer) return;
  choreographer.setIntent({ kind: "retreat", to: { kind: "node", nodeId: web.retreatNodeId } });
  lastUserAction = habitatTime;
  setPetMode("retreating", `${memory.name} knows the safest knot in the web.`, "returning to her retreat");
  announce("She goes home without needing to be shown the way");
}

function signalOnWeb(): void {
  if (!choreographer) return;
  pluckSilk(1.55);
  lastUserAction = habitatTime;
  memory.bond = Math.min(100, memory.bond + 0.45);
  setPetMode("listening", `${memory.name} turns toward the signature of your touch.`, "recognizing your tremor");
  announce(memory.bond > 45 ? "She knows that vibration now" : "She felt you through every foot");
  saveMemory();
}

function toggleFollow(button: HTMLButtonElement): void {
  followSpider = !followSpider;
  button.setAttribute("aria-pressed", String(followSpider));
  controls.enabled = !followSpider;
  announce(followSpider ? `Keeping ${memory.name} in view` : "Camera free · drag to orbit");
}

function toggleLights(button: HTMLButtonElement): void {
  redWatch = !redWatch;
  button.setAttribute("aria-pressed", String(redWatch));
  habitat.classList.toggle("red-watch", redWatch);
  redLamp.intensity = redWatch ? 3.2 : 0;
  cornerLamp.intensity = redWatch ? 0.25 : 10.5;
  key.intensity = redWatch ? 0.42 : 2.2;
  fill.intensity = redWatch ? 0.16 : 0.7;
  ambient.intensity = redWatch ? 0.18 : 0.43;
  renderer.toneMappingExposure = redWatch ? 0.72 : 0.88;
  announce(redWatch ? "Red observation light — less visible to her" : "Cool habitat light restored");
}

function renamePet(): void {
  const next = window.prompt("What should she answer to?", memory.name);
  if (!next?.trim()) return;
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
  traversal.getWorldPosition(mothAddress, mothWorldPosition);
  moth.position.copy(mothWorldPosition);
  moth.position.y += Math.sin(habitatTime * 11) * 0.012;
  moth.rotation.y = Math.sin(habitatTime * 7) * 0.16;
  const flutter = Math.sin(habitatTime * 34) * 0.55;
  moth.children.find((child) => child.name === "wing-left")?.rotation.set(0, Math.PI / 2 + flutter, 0);
  moth.children.find((child) => child.name === "wing-right")?.rotation.set(0, Math.PI / 2 - flutter, 0);

  nextMothTremor -= dt;
  if (nextMothTremor <= 0 && mothStage !== "caught") {
    const strand = web.network.strands.get(mothAddress.strandId);
    if (strand) {
      const point = strand.particleIndices[Math.max(1, strand.particleIndices.length >> 1)];
      web.network.particles.previousPositions[point * 3] -= 0.42 * FIXED_TIME_STEP;
    }
    nextMothTremor = 0.7 + Math.random() * 1.5;
  }

  if (mothStage === "noticed" && mothTimer > 1.1) {
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
    mothStage = "caught";
    mothTimer = 0;
    choreographer.setIntent({ kind: "freeze" });
    moth.scale.setScalar(0.72);
    setPetMode("feeding", `${memory.name} wraps first. Venom is patient.`, "feeding privately");
  }

  if (mothStage === "caught" && mothTimer > 1.4) {
    const caughtWildPrey = mothSource === "wild";
    removeMoth();
    mothStage = "none";
    memory.hunger = Math.max(0, memory.hunger - (caughtWildPrey ? 24 : 46));
    if (caughtWildPrey) {
      rememberAutonomousAct("Caught a wild gnat by reading its tremor through the silk.");
    } else {
      memory.bond = Math.min(100, memory.bond + 7);
      memory.feedings += 1;
    }
    saveMemory();
    choreographer.setIntent({ kind: "rest" });
    setPetMode(
      "grooming",
      caughtWildPrey
        ? `${memory.name} cleans one pedipalp. The habitat fed itself.`
        : `${memory.name} eats in the quiet center of her web.`,
      "sated and cleaning",
    );
    activityDeadline = habitatTime + 10 + Math.random() * 8;
    nextWildPreyAt = habitatTime + 52 + Math.random() * 70;
    announce(
      caughtWildPrey
        ? `${memory.name} made her own luck`
        : `${memory.name} accepted your moth · familiarity increased`,
    );
  }
}

function updateAutonomy(dt: number): void {
  if (!choreographer) return;
  memory.hunger = Math.min(100, memory.hunger + dt * 0.004);
  if (moth) return;

  const state = choreographer.state;
  if ((petMode === "wandering" || petMode === "retreating" || petMode === "repairing") && state.arrived) {
    const arrivedFromRepair = petMode === "repairing";
    if (arrivedFromRepair) finishSilkRepair();
    choreographer.setIntent({ kind: "rest" });
    const arrivedFromRetreat = petMode === "retreating";
    setPetMode(
      arrivedFromRepair ? "grooming" : arrivedFromRetreat ? "resting" : "watching",
      arrivedFromRepair
        ? `${memory.name} tests the new line with one deliberate foot.`
        : arrivedFromRetreat
        ? `${memory.name} folds herself into the knot she trusts most.`
        : `${memory.name} stops because the web has changed beneath her.`,
      arrivedFromRepair ? "inspecting fresh silk" : arrivedFromRetreat ? "safe in her retreat" : "sampling the silk",
    );
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

  const choice = Math.random();
  const instinct = dominantInstinct();
  const repairChance = instinct === "explore" ? 0.28 : 0.14;
  const shelterChance = instinct === "shelter" ? 0.48 : 0.2;
  if (choice < repairChance) {
    choreographer.setIntent({ kind: "travel", to: { kind: "node", nodeId: web.farNodeId }, urgency: 0.42 });
    beginSilkRepair();
    setPetMode("repairing", `${memory.name} pays out a line where the web feels too open.`, "reinforcing the web");
  } else if (choice < repairChance + 0.3) {
    choreographer.setIntent({ kind: "travel", to: { kind: "node", nodeId: web.farNodeId }, urgency: 0.55 });
    setPetMode("wandering", `${memory.name} begins a patrol no one asked for.`, "checking the far anchors");
    rememberAutonomousAct("Patrolled the far anchors without being asked.");
  } else if (choice < repairChance + 0.3 + shelterChance) {
    choreographer.setIntent({ kind: "retreat", to: { kind: "node", nodeId: web.retreatNodeId } });
    setPetMode("retreating", `${memory.name} decides the open web has seen enough of her.`, "returning to shadow");
    rememberAutonomousAct("Chose the retreat when the room felt too exposed.");
  } else if (instinct === "groom" || choice < 0.9) {
    choreographer.setIntent({ kind: "freeze" });
    setPetMode(
      instinct === "groom" ? "grooming" : "listening",
      instinct === "groom"
        ? `${memory.name} draws each leg through her chelicerae, one by one.`
        : `${memory.name} stills every joint. Something moved beyond the glass.`,
      instinct === "groom" ? "grooming all eight legs" : "listening through silk",
    );
    rememberAutonomousAct(instinct === "groom" ? "Stopped to groom all eight legs." : "Stilled herself to read the room through silk.");
  } else {
    choreographer.setIntent({ kind: "rest" });
    setPetMode("resting", `${memory.name} does nothing at all, with great intention.`, "breathing beneath the web");
  }
  activityDeadline = habitatTime + 12 + Math.random() * 20;
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

function frame(now: number): void {
  const delta = Math.min((now - previous) / 1000, MAX_FRAME_DELTA);
  previous = now;
  accumulator += delta;
  habitatTime += delta;

  let steps = 0;
  while (accumulator >= FIXED_TIME_STEP && steps < MAX_SUBSTEPS) {
    solver.step(FIXED_TIME_STEP);
    choreographer?.update(FIXED_TIME_STEP);
    accumulator -= FIXED_TIME_STEP;
    steps += 1;
  }
  if (steps >= MAX_SUBSTEPS) {
    accumulator = 0;
  }

  updateMoth(delta);
  updateAutonomy(delta);
  updateFreshSilk(delta);
  if (toastTimer > 0) {
    toastTimer -= delta;
    if (toastTimer <= 0) toast.classList.remove("visible");
  }
  hudTimer -= delta;
  if (hudTimer <= 0) {
    updateHud();
    hudTimer = 0.2;
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
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);

updateHud();
window.addEventListener("beforeunload", saveMemory);
document.addEventListener("visibilitychange", () => {
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
  setStatus(error instanceof Error ? error.message : String(error));
  console.error(error);
});
