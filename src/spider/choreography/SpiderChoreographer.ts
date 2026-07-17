import * as THREE from "three";
import {
  WebRoutePlanner,
  type PlannedRoute,
  type StrandAddress,
  type StrandTraversal,
  type Vec3Like,
} from "../../traversal/index";
import type { WebNetwork } from "../../web/WebNetwork";
import { SpiderBodyPose, type SpiderSupportSample } from "../SpiderBodyPose";
import { createBlackWidowFootContacts, type SpiderFootContact } from "../SpiderFootContact";
import { SpiderIKSolver } from "../SpiderIKSolver";
import { SpiderLoadDistributor } from "../SpiderLoadDistributor";
import type { SpiderRig } from "../SpiderRig";
import { SPIDER_LEG_IDS, type SpiderLegId } from "../SpiderRigSpec";
import {
  createChoreographyConfig,
  type ChoreographyConfig,
} from "./ChoreographyConfig";
import { FootholdSearch } from "./FootholdSearch";
import { Gait, type LegDesire } from "./Gait";
import { destinationOf, moodFor, type SpiderIntent } from "./Intent";
import { Personality } from "./Personality";
import { RouteFollower } from "./RouteFollower";
import { Swing } from "./StepMotion";

/**
 * Fraction of a leg's maximum reach that counts as its working limit.
 *
 * Shared deliberately: the body refuses to pull any leg past it, and a leg that
 * hits it is the leg asking to step. One number, both sides of the deal.
 */
// The showcase is allowed to use nearly the entire authored reach. The former
// 0.9 comfort clamp made one trailing foot veto body motion before the gait had
// room to replace it, producing a slow whole-body scoot.
const REACH_LIMIT = 0.98;

/**
 * Absolute floor on planted feet, used only to break a deadlock.
 *
 * `minimumPlantedFeet` governs *voluntary* stepping and is there to keep the
 * gait looking sure-footed. This is different: a leg stretched to its limit with
 * nowhere to step vetoes body motion in every direction, and if the gait minimum
 * also forbids letting go, the spider is wedged. She cannot actually fall — the
 * body is kinematic — so the honest resolution is to let the leg go and hang off
 * the rest for a moment while it hunts for silk.
 */
const EMERGENCY_PLANTED_FLOOR = 3;

/** Consecutive failed searches before a leg gives up and just holds in the air. */
const HOLD_AFTER_FAILURES = 3;

/** How far the body must move before a held leg bothers looking again. */
const HOLD_RELEASE_DISTANCE = 0.12;

const CINEMATIC_GAIT: readonly (readonly SpiderLegId[])[] = [
  ["L1", "R3"],
  ["R1", "L3"],
  ["L2", "R4"],
  ["R2", "L4"],
];

interface CinematicFootState {
  readonly position: THREE.Vector3;
  readonly start: THREE.Vector3;
  readonly destination: THREE.Vector3;
  address: StrandAddress | null;
  elapsed: number;
  duration: number;
  moving: boolean;
}

export interface ChoreographerOptions {
  readonly rig: SpiderRig;
  readonly traversal: StrandTraversal;
  readonly network: WebNetwork;
  readonly config?: Partial<ChoreographyConfig>;
  /**
   * Fired the instant a foot finishes its swing and takes hold of real silk.
   * The habitat uses it to press a small footfall disturbance into the web.
   */
  readonly onFootPlant?: (legId: SpiderLegId, address: StrandAddress) => void;
}

export interface ChoreographerState {
  readonly intent: SpiderIntent["kind"];
  readonly plantedCount: number;
  readonly swingingCount: number;
  readonly speed: number;
  readonly confidence: number;
  readonly paused: boolean;
  readonly leash: number;
  readonly hasRoute: boolean;
  readonly routeRemaining: number;
  readonly arrived: boolean;
  /** Set when the spider wanted to move a foot and the web offered nowhere to put it. */
  readonly stranded: boolean;
}

/**
 * The invisible choreographer.
 *
 * Everything the player believes about the spider is produced here, and almost
 * none of it is simulated. What *is* simulated is the part the eye checks:
 * feet hold real semantic addresses on real silk, the IK solves to wherever that
 * silk actually is this frame, and the spider's weight goes back into the web.
 * Everything else — which foot, which moment, how bold, how long it hesitates —
 * is stagecraft, and it is cheap on purpose.
 */
export class SpiderChoreographer {
  readonly config: ChoreographyConfig;
  readonly contacts: Map<SpiderLegId, SpiderFootContact>;
  readonly ik: SpiderIKSolver;
  readonly bodyPose: SpiderBodyPose;
  readonly loads: SpiderLoadDistributor;
  readonly route = new RouteFollower();

  private readonly rig: SpiderRig;
  private readonly traversal: StrandTraversal;
  private readonly planner: WebRoutePlanner;
  private readonly footholds: FootholdSearch;
  private readonly gait = new Gait();
  private readonly personality: Personality;
  private readonly onFootPlant?: (legId: SpiderLegId, address: StrandAddress) => void;

  private intent: SpiderIntent = { kind: "rest" };
  private intentDirty = false;
  private swings = new Map<SpiderLegId, Swing>();

  private readonly bodyForward = new THREE.Vector3(1, 0, 0);
  private readonly bodyUp = new THREE.Vector3(0, 1, 0);
  /** The body's own world position — the single source of truth for placement. */
  private readonly bodyPosition = new THREE.Vector3();
  private readonly previousPosition = new THREE.Vector3();
  private readonly velocity = new THREE.Vector3();

  private readonly travelPoint = new THREE.Vector3();
  private readonly aheadPoint = new THREE.Vector3();
  private readonly aim = new THREE.Vector3();
  private readonly scratch = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly reachVector = new THREE.Vector3();
  private readonly coxa = new THREE.Vector3();
  private readonly sweep = new THREE.Vector3();
  private readonly sweepScratch = new THREE.Vector3();
  private readonly contactDir = new THREE.Vector3();
  private readonly bodyRight = new THREE.Vector3();
  private readonly desiredForward = new THREE.Vector3(1, 0, 0);
  private readonly desiredUp = new THREE.Vector3(0, 1, 0);
  private readonly desiredRight = new THREE.Vector3(0, 0, 1);
  private readonly currentFrameMatrix = new THREE.Matrix4();
  private readonly desiredFrameMatrix = new THREE.Matrix4();
  private readonly currentFrameOrientation = new THREE.Quaternion();
  private readonly desiredFrameOrientation = new THREE.Quaternion();

  private readonly supportSamples: SpiderSupportSample[] = [];
  private readonly occupied: StrandAddress[] = [];
  private readonly desires: LegDesire[] = [];
  /**
   * Seconds a leg must wait before asking to step again — after landing, so a
   * foot that lands still short of its home cannot thrash; and after finding
   * nowhere to stand, so one unlucky leg cannot out-rank and starve the others.
   */
  private readonly stepCooldown = new Map<SpiderLegId, number>();
  /** Consecutive times a leg has looked for silk and found none. */
  private readonly stepFailures = new Map<SpiderLegId, number>();
  /** Body position at the moment a leg gave up. Present means "held in the air". */
  private readonly holdAnchors = new Map<SpiderLegId, THREE.Vector3>();
  /**
   * Presentation filter for abrupt semantic target changes.
   *
   * Contact remains honest â€” it is still the real silk address â€” but the
   * rendered foot is allowed a few frames to arrive there. This hides single
   * frame topology/physics discontinuities that read as a broken leg rather
   * than useful accuracy.
   */
  private readonly visualFootTargets = new Map<SpiderLegId, THREE.Vector3>();
  private poseDelta = 1 / 120;
  private readonly cinematicFeet = new Map<SpiderLegId, CinematicFootState>();
  private cinematicGaitIndex = 0;
  private cinematicStepClock = 0;

  private speed = 0;
  private leash = 0;
  private stranded = false;
  /** Drives the idle wave of a leg that has nowhere to stand. */
  private searchPhase = 0;
  private readonly abdomenRest = new THREE.Quaternion();
  private readonly abdomenSwing = new THREE.Quaternion();
  private abdomenLagTarget = 0;

  constructor(options: ChoreographerOptions) {
    this.rig = options.rig;
    this.traversal = options.traversal;
    this.onFootPlant = options.onFootPlant;
    this.config = createChoreographyConfig(options.config);
    this.planner = new WebRoutePlanner(options.traversal);
    this.footholds = new FootholdSearch(options.traversal);
    this.personality = new Personality(this.config);

    const reachByLeg = Object.fromEntries(
      SPIDER_LEG_IDS.map((id) => [id, this.rig.legs[id].reach]),
    ) as Record<SpiderLegId, (typeof this.rig.legs)[SpiderLegId]["reach"]>;
    this.contacts = createBlackWidowFootContacts(reachByLeg);

    // Anatomical joint behavior, in two regimes. The coxa — where the leg meets
    // the body — is a ball-and-socket and is left entirely free: it needs the
    // whole hemisphere to swing the leg fore, aft, up, down, and out, and it is
    // the joint that absorbs whatever rotation the rest of the chain refuses.
    // Every joint past it is treated as a hinge — but a hinge is enforced by
    // what it *forbids*, not what it allows: sideways swing and twist are held
    // to the spec's tight ranges, while flex/extend about the bend axis stays
    // free. Clamping bend is what tears the mesh: the authored bend ranges are
    // wide enough (tibia -60°..+20°, ×scale) that adjacent joints can legally
    // fold against each other into a zig-zag, and the CCD contact-recovery pass
    // drives them onto exactly those boundaries — every euler angle reads
    // "within limits" while segment directions reverse by 90-135° and the
    // skinned joints visibly dislocate. FABRIK's preferred-pose bias already
    // keeps bend in the natural range; the clamps only need to stop splay and
    // corkscrew, which swing and twist do.
    const scale = this.config.jointLimitScale;
    this.ik = new SpiderIKSolver(
      SPIDER_LEG_IDS.map((id) => ({
        id,
        bones: this.rig.legs[id].chain,
        reach: {
          minimum: this.rig.legs[id].reach.min,
          comfortable: this.rig.legs[id].reach.comfortable,
          maximum: this.rig.legs[id].reach.max,
        },
        jointLimits:
          scale > 0
            ? this.rig.legs[id].jointLimits.map((limit, jointIndex) =>
                jointIndex === 0
                  ? undefined
                  : {
                      swingZ: { min: limit.swing_z[0] * scale, max: limit.swing_z[1] * scale },
                      twistY: { min: limit.twist_y[0] * scale, max: limit.twist_y[1] * scale },
                      unit: "degrees" as const,
                    },
              )
            : undefined,
      })),
      { bendBias: 1, maxIterations: 12, enforceJointLimits: scale > 0 },
    );

    this.bodyPose = new SpiderBodyPose({
      root: this.rig.rootObject,
      modelForward: this.rig.axes.forward,
      modelUp: this.rig.axes.up,
    });

    this.loads = new SpiderLoadDistributor(options.network, this.contacts.values());
    this.loads.setMode("position-weighted").setTotalWeight(this.config.bodyWeight);

    this.abdomenRest.copy(this.rig.abdomen.quaternion);
  }

  private plantedCount(): number {
    let planted = 0;
    for (const contact of this.contacts.values()) {
      if (contact.isPlanted) planted += 1;
    }
    return planted;
  }

  get state(): ChoreographerState {
    const planted = this.plantedCount();
    return {
      intent: this.intent.kind,
      plantedCount: planted,
      swingingCount: this.swings.size,
      speed: this.speed,
      confidence: this.personality.confidence,
      paused: this.personality.isPaused,
      leash: this.leash,
      hasRoute: this.route.hasRoute,
      routeRemaining: this.route.remaining,
      arrived: this.route.arrived,
      stranded: this.stranded,
    };
  }

  /** The spider's own idea of where it is: the route cursor, or the silk beneath her. */
  get bodyAddress(): StrandAddress | null {
    const cursor = this.route.addressAt(0);
    if (cursor) {
      return { strandId: cursor.strandId, t: cursor.t };
    }
    if (!this.bodyPose.frame.valid) {
      return null;
    }
    if (this.config.cinematicLocomotion) {
      const hit = this.traversal.findClosestPoint(this.bodyPosition, {
        maximumDistance: this.rig.aggregateReach.maximum * 3,
        traversableOnly: true,
      });
      return hit ? hit.address : null;
    }
    // The nearest silk to the support centre. Picking a particular foot's strand
    // instead would start every route from wherever one leg happened to land.
    const hit = this.traversal.findClosestPoint(this.bodyPose.frame.center, {
      maximumDistance: this.rig.aggregateReach.maximum * 1.5,
      traversableOnly: true,
    });
    return hit ? hit.address : null;
  }

  setIntent(intent: SpiderIntent): void {
    this.intent = intent;
    this.intentDirty = true;
    this.stranded = false;
  }

  /**
   * Puts the spider on the web for the first time.
   *
   * Every foot gets a real foothold or the placement fails — we never start the
   * illusion with a foot hanging in space, because the eye finds that instantly.
   */
  settle(position: THREE.Vector3, forward: THREE.Vector3, up: THREE.Vector3): boolean {
    this.bodyForward.copy(forward).normalize();
    this.bodyUp.copy(up).normalize();
    this.desiredForward.copy(this.bodyForward);

    // Provisional placement so the FootHome bones land near the silk.
    const basis = new THREE.Matrix4().makeBasis(
      new THREE.Vector3().crossVectors(this.bodyForward, this.bodyUp).normalize(),
      this.bodyUp,
      this.bodyForward.clone().negate(),
    );
    const modelBasis = new THREE.Matrix4().makeBasis(
      new THREE.Vector3().crossVectors(this.rig.axes.forward, this.rig.axes.up).normalize(),
      this.rig.axes.up,
      this.rig.axes.forward.clone().negate(),
    );
    const orientation = new THREE.Quaternion()
      .setFromRotationMatrix(basis)
      .multiply(new THREE.Quaternion().setFromRotationMatrix(modelBasis).invert());

    this.rig.rootObject.position.copy(position);
    this.rig.rootObject.quaternion.copy(orientation);
    this.rig.rootObject.updateMatrixWorld(true);
    this.bodyPosition.copy(position);
    this.previousPosition.copy(position);

    // Plant, settle the body onto what we planted, then plant again against the
    // pose she actually ended up in.
    //
    // One pass is not enough and the reason is easy to miss: the first pass picks
    // footholds around a *provisional* placement, then applying the body pose
    // moves her somewhere else entirely — so those perfectly good footholds are
    // suddenly behind and across her, and she starts life with legs at 130 degrees
    // off. Two passes converge; the second sees the real pose.
    let planted = this.plantAllFeet();
    if (planted >= this.config.minimumPlantedFeet) {
      this.refreshContacts();
      this.updateSupportFrame();
      this.applyBody(0);
      planted = this.plantAllFeet();
    }

    if (planted < this.config.minimumPlantedFeet) {
      return false;
    }

    this.refreshContacts();
    this.updateSupportFrame();
    this.applyBody(0);
    this.solveLegs();
    if (this.config.cinematicLocomotion) {
      this.initializeCinematicFeet();
    }
    return true;
  }

  /** Gives every leg the best real foothold available from the current pose. */
  private plantAllFeet(): number {
    let planted = 0;
    for (const legId of SPIDER_LEG_IDS) {
      const leg = this.rig.legs[legId];
      leg.footHome.getWorldPosition(this.aim);
      leg.chain[0].getWorldPosition(this.coxa);

      const foothold = this.footholds.find({
        aim: this.aim,
        reachOrigin: this.coxa,
        reach: leg.reach,
        // Slightly generous on the first placement only; after this she walks.
        searchRadius: this.config.footholdSearchRadius * 1.4,
        occupied: this.claimedAddresses(legId),
        restDirection: this.restDirection(legId),
        sweepCos: Math.cos(THREE.MathUtils.degToRad(this.config.legSweepDegrees)),
        bodyCentre: this.bodyPosition,
        outward: this.outward(legId),
        midlineTolerance: this.config.midlineTolerance * leg.reach.max,
      });
      if (!foothold) {
        continue;
      }
      this.contacts.get(legId)!.plant(foothold.address);
      planted += 1;
    }
    return planted;
  }

  update(dt: number): void {
    if (!(dt > 0)) {
      return;
    }
    this.poseDelta = dt;

    const mood = moodFor(this.intent);
    const wantsToMove = this.speed > 1e-3 || mood.speed > 0;
    this.personality.update(dt, mood, wantsToMove);
    this.searchPhase += dt * 6;

    for (const [legId, remaining] of this.stepCooldown) {
      if (remaining > 0) {
        this.stepCooldown.set(legId, Math.max(0, remaining - dt));
      }
    }

    this.planRouteIfNeeded();
    this.advanceIntention(dt, mood);

    if (this.config.cinematicLocomotion) {
      this.updateCinematicLocomotion(dt);
      return;
    }

    // The body moves first, carrying the FootHome references with it. Everything
    // after this point is the legs reacting to a body that already committed —
    // which is exactly the order that makes a walk look driven rather than pushed.
    this.updateSupportFrame();
    this.applyBody(dt);

    this.refreshContacts();
    this.chooseSteps();
    this.advanceSwings(dt);
    this.solveLegs();

    this.loads.applyFixedStep(dt, this.bodyPose.frame.center);
  }

  // ---------------------------------------------------------------- intention

  private planRouteIfNeeded(): void {
    if (!this.intentDirty) {
      return;
    }
    this.intentDirty = false;

    const destination = destinationOf(this.intent);
    if (!destination) {
      this.route.clear();
      return;
    }
    const start = this.bodyAddress;
    if (!start) {
      this.route.clear();
      return;
    }
    const planned: PlannedRoute | null = this.planner.plan(start, destination);
    if (planned) {
      this.route.setRoute(planned);
    } else {
      this.route.clear();
    }
  }

  private advanceIntention(dt: number, mood: ReturnType<typeof moodFor>): void {
    const target = this.config.travelSpeed * this.personality.speedScale(mood);
    this.speed += (target - this.speed) * Math.min(1, dt * this.config.speedResponse);
    if (this.speed < 1e-4) {
      this.speed = 0;
    }

    if (!this.route.hasRoute || this.route.arrived) {
      return;
    }

    // How far intention has run ahead of the actual body, along travel only.
    // Straight-line distance would include the sideways offset of a body
    // straddling neighbouring strands, which is just standing posture.
    if (this.route.positionAt(this.traversal, 0, this.travelPoint)) {
      this.scratch.copy(this.travelPoint).sub(this.bodyPosition);
      this.leash = Math.max(0, this.scratch.dot(this.desiredForward));
    }

    // The cursor eases off as the body falls behind, and stops at the limit.
    //
    // This is safe to make a hard stop only because the loop is no longer
    // circular: the body always chases the cursor, so a stopped cursor is caught
    // up to, the leash falls, and travel resumes on its own. The one state that
    // holds is a body the legs physically cannot carry further — which is a
    // spider that has genuinely run out of web, and should stop.
    const brake = this.config.cinematicLocomotion
      ? 1
      : THREE.MathUtils.clamp(1 - this.leash / this.config.maximumLeash, 0, 1);
    this.route.advance(this.speed * dt * brake);
  }

  // ---------------------------------------------------------- cinematic gait

  private initializeCinematicFeet(): void {
    this.cinematicFeet.clear();
    this.rig.rootObject.updateMatrixWorld(true);
    for (const legId of SPIDER_LEG_IDS) {
      const position = this.rig.legs[legId].footTip.getWorldPosition(new THREE.Vector3());
      this.cinematicFeet.set(legId, {
        position,
        start: position.clone(),
        destination: position.clone(),
        address: this.contacts.get(legId)?.address ?? null,
        elapsed: 0,
        duration: 0.2,
        moving: false,
      });
    }
    this.cinematicGaitIndex = 0;
    this.cinematicStepClock = 0;
  }

  /**
   * Showcase locomotion: the route owns body travel, a fixed gait owns the feet,
   * and silk is consulted as a suggestion. Nothing in this method may stall the
   * body because a foothold is missing or one planted address reached a limit.
   */
  private updateCinematicLocomotion(dt: number): void {
    if (this.cinematicFeet.size === 0) {
      this.initializeCinematicFeet();
    }

    // Cinematic travel still needs a real walking surface. Refresh the semantic
    // contacts before moving the body so their transported normals and support
    // geometry can turn her onto steep silk instead of leaving dorsal as world-up.
    this.refreshContacts();
    this.updateSupportFrame();
    this.updateCinematicBody(dt);
    // The body has moved since the first refresh. Resolve reach and strand frames
    // again before choosing the next cinematic step and distributing its load.
    this.refreshContacts();
    this.updateCinematicFeet(dt);
    this.loads.applyFixedStep(dt, this.bodyPosition);
    this.stranded = false;
  }

  private updateCinematicBody(dt: number): void {
    const frame = this.bodyPose.frame;
    if (!frame.valid) return;

    const hasTravelPoint =
      this.route.hasRoute && this.route.positionAt(this.traversal, 0, this.travelPoint);
    if (this.route.hasRoute && this.route.positionAt(this.traversal, 0.28, this.aheadPoint)) {
      this.scratch.copy(this.aheadPoint).sub(this.travelPoint);
      if (this.scratch.lengthSq() > 1e-7) this.desiredForward.copy(this.scratch);
    }

    this.alignBodyFrame(frame.up, dt);

    if (hasTravelPoint) {
      this.target.copy(this.travelPoint).addScaledVector(this.bodyUp, this.config.bodyStandoff);
      const follow = 1 - Math.exp(-dt * 11);
      this.bodyPosition.lerp(this.target, follow);
    }

    this.scratch.copy(this.bodyPosition).sub(this.previousPosition).divideScalar(Math.max(dt, 1e-4));
    this.velocity.lerp(this.scratch, Math.min(1, dt * 9));
    this.previousPosition.copy(this.bodyPosition);
    const forwardSpeed = this.velocity.dot(this.bodyForward);

    this.scratch.copy(this.bodyPosition).sub(frame.center);
    this.bodyPose.apply({
      worldFrame: { forward: this.bodyForward, up: this.bodyUp },
      thoraxHeight: 0,
      worldOffset: this.scratch,
      pitch: THREE.MathUtils.clamp(-forwardSpeed * 0.06, -0.08, 0.08),
    });
    this.swayAbdomen(forwardSpeed);
    this.rig.rootObject.updateMatrixWorld(true);
  }

  private updateCinematicFeet(dt: number): void {
    this.cinematicStepClock = Math.max(0, this.cinematicStepClock - dt);
    const travelling = this.speed > 0.035 && this.route.hasRoute && !this.route.arrived;
    let movingFeet = 0;
    let worstLag = 0;

    for (const legId of SPIDER_LEG_IDS) {
      const state = this.cinematicFeet.get(legId)!;
      if (state.moving) movingFeet += 1;
      this.rig.legs[legId].footHome.getWorldPosition(this.aim);
      worstLag = Math.max(worstLag, state.position.distanceTo(this.aim));
    }

    if (movingFeet === 0 && this.cinematicStepClock <= 0 && (travelling || worstLag > 0.24)) {
      const group = CINEMATIC_GAIT[this.cinematicGaitIndex % CINEMATIC_GAIT.length];
      this.cinematicGaitIndex += 1;
      this.cinematicStepClock = travelling ? 0.025 : 0.08;
      for (const legId of group) this.beginCinematicStep(legId, travelling);
    }

    for (const legId of SPIDER_LEG_IDS) {
      const state = this.cinematicFeet.get(legId)!;
      if (state.moving) {
        state.elapsed += dt;
        const p = THREE.MathUtils.clamp(state.elapsed / state.duration, 0, 1);
        const eased = p * p * (3 - 2 * p);
        state.position.copy(state.start).lerp(state.destination, eased);
        state.position.addScaledVector(this.bodyUp, Math.sin(Math.PI * p) * 0.075);
        if (p >= 1) {
          state.position.copy(state.destination);
          state.moving = false;
          if (state.address) {
            this.contacts.get(legId)!.plant(state.address);
            this.onFootPlant?.(legId, state.address);
          }
        }
      }
      // The procedural target is already continuous; bypass the extra contact
      // filter so each leg follows the authored arc precisely — but never feed
      // the solver a point outside the leg's radial workspace. Past maximum
      // reach the solver stretches into a fold to chase the point; *inside*
      // minimum reach it must fold the chain double to shorten it, which is
      // where the front legs used to dislocate as footholds passed beneath
      // the body. (solveLeg applies the same clamp for the lab path.)
      const leg = this.rig.legs[legId];
      leg.chain[0].getWorldPosition(this.coxa);
      this.scratch.copy(state.position).sub(this.coxa);
      const targetDistance = this.scratch.length();
      const maximumReach = leg.reach.max * REACH_LIMIT;
      const minimumReach = leg.reach.min;
      if (targetDistance > maximumReach && targetDistance > 1e-6) {
        this.target.copy(this.coxa).addScaledVector(this.scratch, maximumReach / targetDistance);
        this.ik.solve(legId, this.target);
      } else if (targetDistance < minimumReach && targetDistance > 1e-6) {
        this.target.copy(this.coxa).addScaledVector(this.scratch, minimumReach / targetDistance);
        this.ik.solve(legId, this.target);
      } else {
        this.ik.solve(legId, state.position);
      }
    }
  }

  private beginCinematicStep(legId: SpiderLegId, travelling: boolean): void {
    const state = this.cinematicFeet.get(legId)!;
    const leg = this.rig.legs[legId];
    state.start.copy(state.position);
    leg.footHome.getWorldPosition(state.destination);

    const index = Number(legId[1]);
    if (travelling) {
      state.destination.addScaledVector(this.desiredForward, 0.18 + (4 - index) * 0.025);
    }
    state.destination.addScaledVector(this.outward(legId), 0.055);

    // Nearby silk attracts the performance target, but only partially. The
    // authored stance wins if exact contact would fold a leg under the body.
    const hit = this.traversal.findClosestPoint(state.destination, {
      maximumDistance: 0.72,
      traversableOnly: true,
    });
    state.address = hit?.address ?? null;
    if (hit) {
      this.aim.set(hit.position.x, hit.position.y, hit.position.z);
      state.destination.lerp(this.aim, hit.distance < 0.18 ? 0.58 : 0.28);
    }

    // Keep the target comfortably solvable. IK shapes the leg; it never gets a
    // vote on whether the body may continue along the route.
    leg.chain[0].getWorldPosition(this.coxa);
    this.scratch.copy(state.destination).sub(this.coxa);
    const maximum = leg.reach.max * 0.93;
    if (this.scratch.length() > maximum) {
      state.destination.copy(this.coxa).add(this.scratch.setLength(maximum));
    }

    const contact = this.contacts.get(legId)!;
    if (contact.isPlanted) {
      contact.beginRelease();
      contact.release();
      this.loads.releaseFootLoad(legId);
    }
    state.elapsed = 0;
    state.duration = 0.17 + index * 0.008;
    state.moving = true;
  }

  // -------------------------------------------------------------------- body

  private updateSupportFrame(): void {
    this.supportSamples.length = 0;
    for (const legId of SPIDER_LEG_IDS) {
      const contact = this.contacts.get(legId)!;
      if (!contact.isPlanted || !contact.contactValid) {
        continue;
      }
      this.supportSamples.push({
        worldPosition: contact.worldPosition,
        referenceUp: contact.frame.normal,
        weight: Math.max(0.15, contact.carriedLoadNewtons),
        valid: true,
      });
    }
    this.bodyPose.updateSupport(this.supportSamples, { forward: this.desiredForward });
  }

  private applyBody(dt: number): void {
    const frame = this.bodyPose.frame;
    if (!frame.valid) {
      return;
    }

    // The body owns its own position. It is tempting to define it as the support
    // centroid plus an offset, and that quietly poisons everything: the centroid
    // jitters with every step and every sway of the silk, and because invalid
    // contacts drop out of it, one over-stretched leg shifts the centroid toward
    // the remaining legs, which over-stretches the next one. The centroid is a
    // fine source of *orientation* and a terrible source of position.
    if (this.route.hasRoute && this.route.positionAt(this.traversal, 0, this.travelPoint)) {
      this.target.copy(this.travelPoint);
    } else {
      this.target.copy(frame.center);
    }
    const standoff =
      this.config.bodyStandoff * (0.72 + this.personality.confidence * 0.28) +
      this.personality.breath;
    this.target.addScaledVector(this.bodyUp, standoff);

    const follow = dt > 0 ? Math.min(1, dt * this.config.bodyFollowRate) : 1;
    this.scratch.copy(this.target).sub(this.bodyPosition).multiplyScalar(follow);
    this.limitByReach(this.scratch);
    this.bodyPosition.add(this.scratch);

    // Facing: along the route if we have one, otherwise keep the support frame's.
    if (this.route.hasRoute && this.route.positionAt(this.traversal, 0.22, this.aheadPoint)) {
      this.scratch.copy(this.aheadPoint).sub(this.travelPoint);
      if (this.scratch.lengthSq() > 1e-8) {
        this.desiredForward.copy(this.scratch).normalize();
      }
    } else if (frame.forward.lengthSq() > 1e-8) {
      this.desiredForward.copy(frame.forward);
    }

    this.alignBodyFrame(frame.up, dt);

    // Real body velocity drives the lean and the abdomen lag.
    if (dt > 0) {
      this.scratch.copy(this.bodyPosition).sub(this.previousPosition).divideScalar(dt);
      this.velocity.lerp(this.scratch, Math.min(1, dt * 6));
      this.previousPosition.copy(this.bodyPosition);
    }
    const forwardSpeed = this.velocity.dot(this.bodyForward);
    const lean = THREE.MathUtils.clamp(forwardSpeed * this.config.bodyLean, -0.25, 0.25);

    // SpiderBodyPose always places the root at the support centre plus offsets, so
    // cancel the centre out and hand it the position the body decided on. We want
    // its orientation maths and its frame, not its opinion about where we are.
    this.scratch.copy(this.bodyPosition).sub(frame.center);
    this.bodyPose.apply({
      worldFrame: { forward: this.bodyForward, up: this.bodyUp },
      thoraxHeight: 0,
      worldOffset: this.scratch,
      pitch: -lean,
    });

    this.swayAbdomen(forwardSpeed);
    this.rig.rootObject.updateMatrixWorld(true);
  }

  /**
   * Advances the complete body frame toward the route tangent and the dorsal
   * side of the current support surface.
   *
   * Treating forward and up as unrelated lerps works on a floor, but not on a
   * climb: forward can acquire a normal component, roll lags behind pitch, and
   * an equivalent contact normal can flip the spider over. Building two proper
   * frames and slerping them keeps all three axes orthogonal through the turn.
   */
  private alignBodyFrame(supportUp: Vec3Like, dt: number): void {
    this.desiredUp.set(supportUp.x, supportUp.y, supportUp.z);
    if (this.desiredUp.lengthSq() <= 1e-8) {
      this.desiredUp.copy(this.bodyUp);
    } else {
      this.desiredUp.normalize();
    }

    // A surface normal has two valid signs. Stay on the side of the silk she is
    // already occupying instead of taking the numerically equivalent upside-down
    // frame at a junction.
    if (this.desiredUp.dot(this.bodyUp) < 0) this.desiredUp.negate();

    // Anterior follows travel, but travel must be tangent to the support plane.
    this.desiredForward.addScaledVector(
      this.desiredUp,
      -this.desiredForward.dot(this.desiredUp),
    );
    if (this.desiredForward.lengthSq() <= 1e-8) {
      this.desiredForward
        .copy(this.bodyForward)
        .addScaledVector(this.desiredUp, -this.bodyForward.dot(this.desiredUp));
    }
    if (this.desiredForward.lengthSq() <= 1e-8) {
      const frameForward = this.bodyPose.frame.forward;
      this.desiredForward
        .set(frameForward.x, frameForward.y, frameForward.z)
        .addScaledVector(this.desiredUp, -this.desiredForward.dot(this.desiredUp));
    }
    if (this.desiredForward.lengthSq() <= 1e-8) {
      // This should only be reachable for corrupt/degenerate support data. Keep
      // the last valid complete orientation instead of snapping to a world axis.
      return;
    }
    this.desiredForward.normalize();
    this.desiredRight.crossVectors(this.desiredForward, this.desiredUp).normalize();
    this.desiredUp.crossVectors(this.desiredRight, this.desiredForward).normalize();

    // Re-orthonormalize the held frame before turning it into a quaternion.
    this.bodyRight.crossVectors(this.bodyForward, this.bodyUp);
    if (this.bodyRight.lengthSq() <= 1e-8) return;
    this.bodyRight.normalize();
    this.bodyUp.crossVectors(this.bodyRight, this.bodyForward).normalize();
    this.bodyForward.crossVectors(this.bodyUp, this.bodyRight).normalize();

    this.currentFrameMatrix.makeBasis(
      this.bodyRight,
      this.bodyUp,
      this.scratch.copy(this.bodyForward).negate(),
    );
    this.desiredFrameMatrix.makeBasis(
      this.desiredRight,
      this.desiredUp,
      this.scratch.copy(this.desiredForward).negate(),
    );
    this.currentFrameOrientation.setFromRotationMatrix(this.currentFrameMatrix);
    this.desiredFrameOrientation.setFromRotationMatrix(this.desiredFrameMatrix);

    const turn = dt > 0 ? 1 - Math.exp(-dt * this.config.bodyTurnRate) : 1;
    this.currentFrameOrientation.slerp(this.desiredFrameOrientation, turn).normalize();
    this.bodyForward.set(0, 0, -1).applyQuaternion(this.currentFrameOrientation).normalize();
    this.bodyUp.set(0, 1, 0).applyQuaternion(this.currentFrameOrientation).normalize();
  }

  /**
   * Shortens a proposed body movement until no planted leg is pulled past its
   * reach, rewriting `delta` in place.
   *
   * This is the constraint that actually matters, and it is the one a scalar
   * "distance from the support centre" cap silently fails to express: the centroid
   * can be well within its limit while one trailing leg is stretched half again
   * past its anatomical maximum. The body is only allowed to go where the legs
   * can still hold it — so if the feet cannot follow, the spider strains and
   * stops instead of dragging its legs behind it like string.
   *
   * For each planted foot: given a reach vector v from coxa to contact, find the
   * largest s where |v - s*u| stays within reach. Take the smallest s over all
   * feet. That is the whole reach budget.
   */
  private limitByReach(delta: THREE.Vector3): void {
    const proposed = delta.length();
    if (proposed <= 1e-6) {
      return;
    }
    this.direction.copy(delta).divideScalar(proposed);

    let allowed = proposed;
    for (const legId of SPIDER_LEG_IDS) {
      const contact = this.contacts.get(legId)!;
      if (!contact.isPlanted || !contact.hasResolvedWorldPosition) {
        continue;
      }
      const limit = this.rig.legs[legId].reach.max * REACH_LIMIT;
      this.reachVector
        .set(contact.worldPosition.x, contact.worldPosition.y, contact.worldPosition.z)
        .sub(contact.reachOriginWorldPosition as THREE.Vector3);

      const along = this.reachVector.dot(this.direction);
      const discriminant = along * along + limit * limit - this.reachVector.lengthSq();
      // Already past the limit and the move makes it worse: refuse entirely.
      const room = discriminant < 0 ? 0 : Math.max(0, along + Math.sqrt(discriminant));
      allowed = Math.min(allowed, room);
    }

    if (allowed < proposed) {
      delta.copy(this.direction).multiplyScalar(allowed);
    }
  }

  /**
   * The abdomen lags behind the thorax. This is one bone, one slerp, and it is
   * probably the highest ratio of "looks alive" to "lines of code" in the project
   * — a black widow is mostly abdomen, and a rigid one reads as a prop.
   */
  private swayAbdomen(forwardSpeed: number): void {
    const lag = THREE.MathUtils.clamp(-forwardSpeed * this.config.abdomenLag, -0.3, 0.3);
    this.abdomenLagTarget += (lag - this.abdomenLagTarget) * 0.12;
    this.abdomenSwing.setFromAxisAngle(this.rig.axes.boneBend, this.abdomenLagTarget);
    this.rig.abdomen.quaternion.copy(this.abdomenRest).multiply(this.abdomenSwing);
  }

  // -------------------------------------------------------------------- legs

  private refreshContacts(): void {
    for (const legId of SPIDER_LEG_IDS) {
      const leg = this.rig.legs[legId];
      leg.footHome.getWorldPosition(this.aim);
      leg.chain[0].getWorldPosition(this.scratch);
      this.contacts.get(legId)!.update(this.traversal, {
        footHomeWorldPosition: this.aim,
        reachOriginWorldPosition: this.scratch,
        referenceUp: this.bodyUp,
      });
    }
  }

  private chooseSteps(): void {
    this.desires.length = 0;
    const footless: SpiderLegId[] = [];
    const pinned: SpiderLegId[] = [];
    let planted = 0;

    for (const legId of SPIDER_LEG_IDS) {
      const contact = this.contacts.get(legId)!;
      if (this.swings.has(legId) || (this.stepCooldown.get(legId) ?? 0) > 0) {
        continue;
      }
      if (this.isHolding(legId)) {
        continue;
      }
      if (!contact.isPlanted) {
        // A leg with no foothold is already in the air. It is not asking for
        // permission to lift, so the gait must not gate it — otherwise a spider
        // that loses a foot on sparse silk can never get it back and limps forever.
        footless.push(legId);
        continue;
      }
      planted += 1;

      // How far this foot sits from where the body currently wants it.
      //
      // It is tempting to measure how far the contact has slid since it was
      // planted instead, and that is subtly fatal: it is zero at equilibrium by
      // construction, so it reads zero in exactly the pose where a step is most
      // needed — body straining forward, feet trailing, nothing asking to move.
      // Distance from FootHome stays large in that pose, which is the point.
      const leg = this.rig.legs[legId];
      leg.footHome.getWorldPosition(this.aim);
      const lag = contact.hasResolvedWorldPosition
        ? this.aim.distanceTo(contact.worldPosition)
        : 0;

      // A stretched leg also wants a step even if the body has not moved at all.
      // The span runs comfortable -> REACH_LIMIT, the same limit the body clamps
      // against, so strain reaches 1 exactly when this leg starts holding the
      // body back: the leg that is limiting the spider is, by definition, the leg
      // asking to move. (Deriving the span from any other fraction of max reach
      // lets it collapse or invert on legs whose comfortable reach sits above it.)
      const reach = leg.reach;
      const strainSpan = Math.max(1e-3, reach.max * REACH_LIMIT - reach.comfortable);
      const strain = (contact.currentReachDistance - reach.comfortable) / strainSpan;

      // And a leg that has ended up across the midline wants a step badly.
      //
      // Gating the *choice* of foothold is only half the job: the body keeps
      // moving and turning after the foot is down, so a contact planted properly
      // on its own side quietly ends up under and past her as she walks over it.
      const breach = this.midlineBreach(legId, contact.worldPosition);
      const allowance = this.config.midlineTolerance * reach.max;
      const crossing = Math.max(0, breach - allowance) / Math.max(1e-3, reach.max * 0.25);

      // A contact that has gone invalid — broken silk, past its limit — is an
      // emergency regardless of anything else.
      const urgent =
        lag >= this.config.stepUrgentDistance ||
        !contact.contactValid ||
        contact.reachStatus === "too-far" ||
        crossing > 1.5;
      this.desires.push({
        legId,
        desire: Math.max(lag / this.config.stepTriggerDistance, strain, crossing),
        urgent,
      });

      // A leg stretched to its limit is holding the body back in every direction;
      // a leg reaching across the body looks broken. Both must get a turn even
      // when the gait has no lift budget left — the gait's budget is a look-good
      // rule, and these are correctness rules.
      if (strain >= 1 || crossing >= 1) {
        pinned.push(legId);
      }
    }

    const chosen = this.gait.select(this.desires, {
      plantedCount: planted,
      swinging: new Set(this.swings.keys()),
      minimumPlanted: this.config.minimumPlantedFeet,
      maximumSwinging: this.config.maximumSwingingFeet,
    });

    // Footless legs are already in the air, so the gait does not gate them — but
    // the swing cap still does, or a spider on sparse silk flails with every leg.
    const room = Math.max(0, this.config.maximumSwingingFeet - this.swings.size);
    // The old lab allowed every simultaneously pinned leg to bypass the visual
    // swing cap. Correct on paper, but it produces the exact multi-leg burst the
    // eye reads as a rig glitch. A pinned leg can wait for the current careful
    // placement to finish; the body reach limiter already keeps that wait safe.
    const attempts = [...new Set([...footless, ...pinned, ...chosen])].slice(0, room);

    let denied = 0;
    for (const legId of attempts) {
      if (this.beginStep(legId)) {
        this.stepFailures.delete(legId);
        this.holdAnchors.delete(legId);
        continue;
      }
      denied += 1;

      // Back this leg off briefly so it stops out-ranking every other leg and
      // starving them of their turn — one unlucky leg must not freeze the spider.
      this.stepCooldown.set(legId, this.personality.rng.range(0.2, 0.45));

      // And if it keeps finding nothing, stop asking.
      //
      // Re-searching every frame from a body that is not moving re-searches the
      // same unchanged web and fails the same way, which reads as a leg jittering
      // against nothing. A widow with a leg over a gap simply holds it up and
      // leaves it there. So park it, and only look again once the body has
      // actually moved somewhere the answer could be different.
      const failures = (this.stepFailures.get(legId) ?? 0) + 1;
      this.stepFailures.set(legId, failures);
      if (failures >= HOLD_AFTER_FAILURES && !this.holdAnchors.has(legId)) {
        this.holdAnchors.set(legId, this.bodyPosition.clone());
      }
    }
    // Only interesting if she wanted to move and the web offered nothing at all.
    this.stranded = attempts.length > 0 && denied === attempts.length && this.speed > 0;
  }

  private beginStep(legId: SpiderLegId): boolean {
    const leg = this.rig.legs[legId];
    const contact = this.contacts.get(legId)!;

    // The gait's own budget covers voluntary steps, but pinned and footless legs
    // bypass it — so the floor has to be enforced here too, or those bypasses
    // stack and she ends up hanging by two feet.
    if (contact.isPlanted && this.plantedCount() <= EMERGENCY_PLANTED_FLOOR) {
      return false;
    }

    // Aim ahead of the foot's home, so the spider steps into its stride rather
    // than under itself. The lead scales with how fast it is actually going.
    leg.footHome.getWorldPosition(this.aim);
    const lead = this.config.stepLead * THREE.MathUtils.clamp(this.speed / this.config.travelSpeed, 0, 1.4);
    this.aim.addScaledVector(this.desiredForward, lead);
    this.aim.addScaledVector(this.bodyUp, this.personality.rng.jitter(0.01));

    leg.chain[0].getWorldPosition(this.coxa);
    const foothold = this.footholds.find({
      aim: this.aim,
      reachOrigin: this.coxa,
      reach: leg.reach,
      searchRadius: this.config.footholdSearchRadius,
      occupied: this.claimedAddresses(legId),
      restDirection: this.restDirection(legId),
      sweepCos: Math.cos(THREE.MathUtils.degToRad(this.config.legSweepDegrees)),
      bodyCentre: this.bodyPosition,
      outward: this.outward(legId),
      midlineTolerance: this.config.midlineTolerance * leg.reach.max,
    });
    if (!foothold) {
      // Nowhere to stand. Two kinds of contact are worse than no contact at all:
      // one stretched to the limit, which vetoes every direction of travel while
      // having nothing to step to; and one folded back across the body, which
      // simply looks wrong. Reach distance alone does not catch the second — a leg
      // wrapped 170 degrees around her can sit at a perfectly comfortable distance
      // and so never qualifies as pinned, and it stays there.
      //
      // So let it go. A real widow reaching into a gap lifts that leg and holds it
      // up; she does not keep a foot somewhere absurd because it was reachable.
      const crossed =
        this.midlineBreach(legId, contact.worldPosition) >
        this.config.midlineTolerance * leg.reach.max + leg.reach.max * 0.375;
      if (
        contact.isPlanted &&
        this.plantedCount() > EMERGENCY_PLANTED_FLOOR &&
        (contact.currentReachDistance >= leg.reach.max * REACH_LIMIT || crossed)
      ) {
        contact.beginRelease();
        contact.release();
        this.loads.releaseFootLoad(legId);
      }
      return false;
    }

    const from = new THREE.Vector3();
    if (contact.hasResolvedWorldPosition) {
      from.copy(contact.worldPosition);
    } else {
      leg.footTip.getWorldPosition(from);
    }

    contact.beginRelease();
    contact.release();
    this.loads.releaseFootLoad(legId);

    this.swings.set(
      legId,
      new Swing({
        legId,
        target: foothold.address,
        from,
        to: foothold.position,
        up: this.bodyUp,
        baseDuration: this.config.swingDuration * (1.25 - this.personality.confidence * 0.35),
        liftHeight: this.config.swingLift * (0.6 + this.personality.confidence * 0.6),
      }),
    );
    return true;
  }

  private advanceSwings(dt: number): void {
    for (const [legId, swing] of this.swings) {
      const position = swing.advance(dt, this.traversal);

      if (swing.lost) {
        // The silk we were reaching for is gone. Put the foot down where it is
        // and let the next frame's desire find somewhere real.
        this.swings.delete(legId);
        continue;
      }

      if (swing.landed) {
        this.contacts.get(legId)!.plant(swing.target);
        this.onFootPlant?.(legId, swing.target);
        this.stepCooldown.set(legId, this.personality.rng.range(0.14, 0.26));
        this.swings.delete(legId);
        continue;
      }

      // Mid-flight feet are driven straight at the IK; they hold no address.
      this.solveLeg(legId, position);
    }
  }

  private solveLegs(): void {
    for (const legId of SPIDER_LEG_IDS) {
      if (this.swings.has(legId)) {
        continue;
      }
      const contact = this.contacts.get(legId)!;
      if (contact.isPlanted && contact.hasResolvedWorldPosition) {
        this.solveLeg(legId, contact.worldPosition);
        continue;
      }

      // A leg with no foothold reaches toward where the body wants it. Without
      // this it would keep its last solved pose, which reads as a broken limb.
      const leg = this.rig.legs[legId];
      leg.footHome.getWorldPosition(this.aim);

      if (this.holdAnchors.has(legId)) {
        // Given up: drawn in slightly and held still. Not a wave — a leg that
        // keeps casting about while the spider stands still reads as a glitch,
        // and a widow with a leg over a gap just holds it there.
        leg.chain[0].getWorldPosition(this.coxa);
        this.aim.sub(this.coxa).multiplyScalar(0.82).add(this.coxa);
        this.aim.addScaledVector(this.bodyUp, 0.045);
      } else {
        // Still hunting: feel around a little.
        const wave = this.searchPhase + leg.anatomicalIndex;
        this.aim.addScaledVector(this.bodyForward, Math.sin(wave * 2.7) * 0.016);
        this.aim.addScaledVector(this.bodyUp, Math.sin(wave * 3.9) * 0.012 - 0.015);
      }
      this.solveLeg(legId, this.aim);
    }
  }

  private solveLeg(legId: SpiderLegId, target: THREE.Vector3 | { x: number; y: number; z: number }): void {
    const leg = this.rig.legs[legId];
    let visualTarget = this.visualFootTargets.get(legId);
    if (!visualTarget) {
      visualTarget = new THREE.Vector3(target.x, target.y, target.z);
      this.visualFootTargets.set(legId, visualTarget);
    } else {
      // Exponential damping is frame-rate independent. Roughly 30 ms of visual
      // give is enough to remove a pop without making a planted foot look loose.
      const alpha = 1 - Math.exp(-this.poseDelta * 32);
      visualTarget.lerp(this.target.set(target.x, target.y, target.z), alpha);
    }

    // A swing arc can leave the leg's workspace even when both silk contacts
    // are valid. Feeding that point straight to IK is what produced the elevator
    // stretch: the solver tried to preserve the foot path by folding adjacent
    // hinges against one another. Keep every intermediate target inside the
    // authored radial workspace. Planted contacts that reach this boundary are
    // already marked strained by the gait and scheduled for replacement.
    leg.chain[0].getWorldPosition(this.coxa);
    this.target.copy(visualTarget).sub(this.coxa);
    const targetDistance = this.target.length();
    const minimumReach = leg.reach.min;
    const maximumReach = leg.reach.max * REACH_LIMIT;
    if (targetDistance > maximumReach && targetDistance > 1e-6) {
      visualTarget.copy(this.target.multiplyScalar(maximumReach / targetDistance)).add(this.coxa);
    } else if (targetDistance < minimumReach && targetDistance > 1e-6) {
      visualTarget.copy(this.target.multiplyScalar(minimumReach / targetDistance)).add(this.coxa);
    }
    this.ik.solve(legId, visualTarget);
  }

  /**
   * The direction this leg naturally points right now: coxa -> FootHome.
   *
   * No precomputation needed — FootHome is the authored rest target and rides
   * with the body, so this is already the leg's sector in the current pose.
   */
  /**
   * True while a leg has given up looking and is simply held in the air.
   *
   * The hold breaks as soon as the body has carried the leg somewhere the web
   * might actually differ. A parked spider therefore holds the leg indefinitely,
   * which is what a parked spider does.
   */
  private isHolding(legId: SpiderLegId): boolean {
    const anchor = this.holdAnchors.get(legId);
    if (!anchor) {
      return false;
    }
    if (anchor.distanceToSquared(this.bodyPosition) > HOLD_RELEASE_DISTANCE ** 2) {
      this.holdAnchors.delete(legId);
      this.stepFailures.delete(legId);
      return false;
    }
    return true;
  }

  /**
   * Unit vector pointing away from the midline on this leg's side.
   * `bodyForward x bodyUp` runs positive toward the right legs.
   */
  private outward(legId: SpiderLegId): THREE.Vector3 {
    this.bodyRight.crossVectors(this.bodyForward, this.bodyUp).normalize();
    return legId[0] === "R" ? this.bodyRight : this.bodyRight.negate();
  }

  /**
   * How far a contact has strayed past the midline onto the wrong side, in model
   * units. Zero or negative means the foot is where it belongs.
   */
  private midlineBreach(legId: SpiderLegId, contact: Vec3Like): number {
    const outward = this.outward(legId);
    this.contactDir.set(contact.x, contact.y, contact.z).sub(this.bodyPosition);
    return -this.contactDir.dot(outward);
  }

  private restDirection(legId: SpiderLegId): THREE.Vector3 {
    const leg = this.rig.legs[legId];
    leg.footHome.getWorldPosition(this.sweep);
    leg.chain[0].getWorldPosition(this.sweepScratch);
    this.sweep.sub(this.sweepScratch);
    if (this.sweep.lengthSq() < 1e-8) {
      this.sweep.copy(this.bodyForward);
    }
    return this.sweep.normalize();
  }

  private claimedAddresses(exclude?: SpiderLegId): StrandAddress[] {
    this.occupied.length = 0;
    for (const legId of SPIDER_LEG_IDS) {
      if (legId === exclude) {
        continue;
      }
      const swing = this.swings.get(legId);
      if (swing) {
        this.occupied.push(swing.target);
        continue;
      }
      const address = this.contacts.get(legId)!.address;
      if (address) {
        this.occupied.push(address);
      }
    }
    return this.occupied;
  }
}
