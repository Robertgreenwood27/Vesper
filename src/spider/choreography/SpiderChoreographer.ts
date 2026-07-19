import * as THREE from "three";
import {
  DirectTerrainPlanner,
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
import {
  SPIDER_LEG_IDS,
  type SpiderLegId,
  type SpiderLegSegmentName,
} from "../SpiderRigSpec";
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
 * The repaired front chains are about 9.5% shorter than the original rig while
 * their FootHome references stayed at the old distance. Without a stance
 * correction L1/R1 sit at 89% reach before gait offsets and about 93% live,
 * flattening their knee arch into a crab-spider silhouette.
 */
const FRONT_STANCE_REACH = 0.81;
const FRONT_WORKING_REACH = 0.86;
const FRONT_OUTWARD_STEP = 0.015;
const DEFAULT_OUTWARD_STEP = 0.055;

/** Pair II rests only about 13 degrees from a straight distal hinge. */
export const PAIR_II_METATARSUS_MAX_EXTENSION_DEGREES = 5;
/** Pair III has a broader authored bend and can safely retain more extension. */
export const PAIR_III_METATARSUS_MAX_EXTENSION_DEGREES = 15;
/** L1's Patella crosses straight near +29.5 degrees in its corrected rest frame. */
export const L1_PATELLA_MAX_EXTENSION_DEGREES = 15;

/** Returns the scaled rig limit with the corrected rig's local safety caps. */
export function effectiveBendMaximumDegrees(
  legId: SpiderLegId,
  segmentName: SpiderLegSegmentName,
  scaledMaximum: number,
): number {
  if (segmentName === "Metatarsus") {
    if (legId[1] === "2") {
      return Math.min(scaledMaximum, PAIR_II_METATARSUS_MAX_EXTENSION_DEGREES);
    }
    if (legId[1] === "3") {
      return Math.min(scaledMaximum, PAIR_III_METATARSUS_MAX_EXTENSION_DEGREES);
    }
  }
  if (legId === "L1" && segmentName === "Patella") {
    return Math.min(scaledMaximum, L1_PATELLA_MAX_EXTENSION_DEGREES);
  }
  return scaledMaximum;
}

/**
 * Plan-view leg sectors measured away from forward toward each leg's own side.
 * The authored L2/R2 and L3/R3 homes are almost perpendicular to the body
 * (about 75 and 107 degrees), which makes the resting silhouette laterigrade --
 * the radial, hand-like stance of a crab spider. Pull the middle pairs toward
 * the longitudinal axis while leaving the already-correct leading and trailing
 * pairs essentially unchanged.
 */
const LEG_SECTOR_DEGREES: Readonly<Record<"1" | "2" | "3" | "4", number>> = {
  "1": 15,
  "2": 55,
  "3": 125,
  "4": 150,
};

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
  ["L2", "R4"],
  ["R1", "L3"],
  ["R2", "L4"],
  ["L1", "R3"],
];

/**
 * Maximum heading change that one planted cinematic pair may authorize.
 *
 * The feet advance this hidden support frame first; the thorax only follows it
 * after that pair has landed. Keeping the increment below the angular spread of
 * a relaxed stance prevents a sharp route corner from winding six planted legs
 * around a body that has already completed the turn.
 */
const CINEMATIC_TURN_PER_STEP = THREE.MathUtils.degToRad(28);
const CINEMATIC_TURN_DEADBAND = THREE.MathUtils.degToRad(2);
/**
 * Heading error below which a turn is absorbed by the flowing overlapped gait
 * instead of dropping into careful sequential stepping. Web routes corner at
 * every node; treating each few-degree polyline kink as a "turn" toggled the
 * gait mode at every junction, and the mode switch itself was a visible hitch.
 * Only genuine corners beyond this get the deliberate land-then-authorize walk.
 */
const CINEMATIC_TURN_FLOW_LIMIT = THREE.MathUtils.degToRad(14);
/**
 * Fraction of a careful turn slice granted even when the turning pair found no
 * silk. The stepping gesture itself sells the turn — legs posed into the new
 * heading read as planted — and a corner with poor silk must never strand the
 * heading, because a stranded heading is a stalled spider.
 */
const CINEMATIC_TURN_MISS_AUTHORITY = 0.75;
/** Let the thorax catch the planted support frame before authorizing more yaw. */
const CINEMATIC_MAX_BODY_SUPPORT_LAG = THREE.MathUtils.degToRad(16);
/** Normalized IK error at which anatomy outranks the ordinary pair sequence. */
const CINEMATIC_IK_URGENCY_THRESHOLD = 0.08;
/** Makes a visibly joint-limited pair win without starving every other pair. */
const CINEMATIC_IK_URGENCY_WEIGHT = 5;

/**
 * Minimum route speed retained while the spider prepares a sharp corner. She
 * knows her web; a corner is a lean, not a negotiation.
 */
const CINEMATIC_CORNER_SPEED_FLOOR = 0.45;

/**
 * Cinematic travel is still permissive, but it may not pull a planted leg past
 * the same workspace used to choose an exact silk landing.
 */
const CINEMATIC_BODY_REACH_LIMIT = 0.9;

/**
 * The hybrid governor: the body moves continuously — never waiting on any
 * individual footfall — while its speed is throttled by a smooth signal of how
 * well the legs are actually doing. Dense silk and successful searches hold the
 * signal at 1 and she flows; sparse silk degrades it and she visibly slows and
 * picks her way.
 *
 * Truth is weighted here, deliberately: smooth body movement carries more of
 * the illusion than perfect leg placement. Six well-placed feet sell a spider;
 * a stalled or lurching body breaks her instantly. Placement failures may
 * therefore change her pace and posture, but never her continuity.
 */
/** Feet that are healthy (valid silk or mid-swing) beyond this count as support. */
const CINEMATIC_QUALITY_HEALTHY_FLOOR = 4;
/** Healthy feet above the floor needed to count as fully supported. */
const CINEMATIC_QUALITY_HEALTHY_SPAN = 4;
/** Response rate of the smoothed quality signal. Slow enough not to pulse. */
const CINEMATIC_QUALITY_RESPONSE = 3.5;
/**
 * Speed factor at zero quality. Even a fully silk-blind stretch only slows her
 * to this fraction — she picks her way, she does not stall.
 */
const CINEMATIC_QUALITY_SPEED_FLOOR = 0.4;
/** Per-attempt blend of the foothold-search success average. */
const CINEMATIC_SEARCH_EMA_ALPHA = 0.12;

/**
 * Per-pair scales applied to config.swingDuration and config.swingLift.
 *
 * The front pair explores: long, high, deliberate reaches that read as feeling
 * out the silk ahead. The remaining pairs assist locomotion with quicker,
 * lower strokes, pair IV lowest of all — it holds and pushes. The old
 * hardcoded profile gave pair I the *fastest, flattest* swing, which is
 * backwards for a web spider and a large part of why travel read as a scoot.
 */
const CINEMATIC_SWING_DURATION_SCALE: Readonly<
  Record<"1" | "2" | "3" | "4", number>
> = { "1": 1, "2": 0.72, "3": 0.74, "4": 0.8 };
const CINEMATIC_SWING_LIFT_SCALE: Readonly<
  Record<"1" | "2" | "3" | "4", number>
> = { "1": 1.5, "2": 1, "3": 0.9, "4": 0.8 };

/** Extra prograde reach for pair I only: the explore-and-pull stride. */
const FRONT_EXPLORE_LEAD = 0.055;

/**
 * Overlapped stepping, the other half of the hybrid: on straight confident
 * travel the next pair launches while the current pair is still finishing its
 * swing, so there is always a leg reaching — the visual signature of a fluid
 * spider. Turning keeps the strict sequential land-then-authorize machinery:
 * corners are exactly where care reads as intelligence rather than hesitance.
 */
/** Fraction of a moving pair's swing that must elapse before the next lifts. */
const CINEMATIC_OVERLAP_PROGRESS = 0.5;
/** Launch-to-launch period as a fraction of the launched pair's swing time. */
const CINEMATIC_OVERLAP_CADENCE = 0.75;
/** Feet already airborne beyond which no overlap launch is considered. */
const CINEMATIC_MAX_OVERLAP_FEET = 2;

/** Remaining travel room below which a planted foot counts as pinning the body. */
const CINEMATIC_PINNED_ROOM = 0.01;
/** Valid supports that must remain before a pinning foot may be released. */
const CINEMATIC_PINNED_SUPPORT_FLOOR = 4;

/** Tuck progress under this distance counts as the settled rest standoff. */
const REST_TUCK_EPSILON = 0.012;
/** An unreachable ideal tuck may not defer the rest snapshot forever. */
const REST_TUCK_TIME_LIMIT = 2.5;

/**
 * Stance displacement that justifies a replant while paused mid-route.
 *
 * Must sit clearly above the longest legitimate stride lead (front pair:
 * stepLead + FRONT_EXPLORE_LEAD), or a foot that just planted a proper
 * exploring stride would immediately qualify to step "back into place" the
 * moment a micro-pause drops the travel flag — a backwards fidget the old
 * 0.24 threshold produced once strides grew past it.
 */
const CINEMATIC_STANCE_REPLANT_LAG = 0.45;

/**
 * A balanced priority for unsupported resting legs.
 *
 * Anatomical order is all left then all right, so slicing SPIDER_LEG_IDS would
 * park three neighbouring feet on one side. This order spreads the first three
 * choices fore/aft and across the body while remaining deterministic.
 */
const REST_RAISE_PRIORITY: readonly SpiderLegId[] = [
  "L1",
  "R3",
  "L4",
  "R2",
  "R1",
  "L3",
  "R4",
  "L2",
];

/** Maximum normalized solve miss tolerated once a rest target reaches silk. */
const REST_CONTACT_IK_RESIDUAL_LIMIT = 0.045;
/** One initial evaluation plus one delayed recheck, then the rest pose is final. */
const REST_CONTACT_CHECK_LIMIT = 2;
/** Lets the web answer the first load change before the final rest snapshot. */
const REST_CONTACT_RECHECK_DELAY = 0.12;
/** Rest targets stop easing after this long even if tiny IK noise remains. */
const REST_POSE_SETTLE_LIMIT = 1.25;
/** A foot this close to its fixed rest target is visually stationary. */
const REST_POSE_SETTLE_EPSILON = 0.0025;

interface CinematicFootState {
  readonly position: THREE.Vector3;
  readonly start: THREE.Vector3;
  readonly destination: THREE.Vector3;
  readonly up: THREE.Vector3;
  address: StrandAddress | null;
  elapsed: number;
  duration: number;
  moving: boolean;
}

type StationaryPoseKind = "rest" | "freeze" | "arrival";

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
  /** Smoothed 0..1 measure of how well the legs are finding and holding silk. */
  readonly supportQuality: number;
  readonly hasRoute: boolean;
  /** Body guide in use: free movement over web terrain or strict strand topology. */
  readonly routeKind: "terrain" | "strand" | null;
  readonly routeRemaining: number;
  readonly arrived: boolean;
  /** Set when the spider wanted to move a foot and the web offered nowhere to put it. */
  readonly stranded: boolean;
  /** Unsupported feet currently held in the high resting pose. */
  readonly raisedRestCount: number;
  /** True once rest feet have stopped evaluating and reached their fixed pose. */
  readonly restPoseSettled: boolean;
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
  private readonly terrainPlanner: DirectTerrainPlanner | null;
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
  /** Orthonormalized scratch direction used to build the desired body frame. */
  private readonly frameForward = new THREE.Vector3(1, 0, 0);
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
  /** Smoothed 0..1 leg-truth signal that throttles continuous body travel. */
  private cinematicSupportQuality = 1;
  /** Running average of recent travelling foothold searches that found silk. */
  private footholdSearchEma = 1;
  /** Landing accounting for the sequential turn machinery only. */
  private cinematicStepExpectedLandings = 0;
  private cinematicStepRealLandings = 0;
  /** Heading already earned by landed feet; the body is not allowed ahead of it. */
  private readonly cinematicSupportForward = new THREE.Vector3(1, 0, 0);
  /** Heading targeted by the pair currently in flight. */
  private readonly cinematicStepForward = new THREE.Vector3(1, 0, 0);
  /** Sign-stable support normal used by every part of the next landing plan. */
  private readonly cinematicPlanningUp = new THREE.Vector3(0, 1, 0);
  private cinematicStepFramePending = false;
  /** A landed pair must support at least one other lift before it can repeat. */
  private cinematicLastGroupIndex = -1;
  /** Stable membership for one rest interval; never inferred afresh each frame. */
  private readonly raisedRestFeet = new Set<SpiderLegId>();
  /** Fixed world targets captured after the bounded rest-contact evaluations. */
  private readonly lockedRestTargets = new Map<SpiderLegId, THREE.Vector3>();
  /**
   * A planted rest captures the solved foot tips after IK, not the controller's
   * requested positions before IK. This flag bridges those two phases.
   */
  private capturePlantedRestAfterSolve = false;
  /**
   * Feet keep their planted-rest anchors until their ordinary gait turn lifts
   * them. Without this handoff, all eight chase newly transported contacts on
   * the first travel frame and the quiet pose ends in a simultaneous shuffle.
   */
  private readonly plantedRestDepartureFeet = new Set<SpiderLegId>();
  /** Feet just recovered from the high pose cannot be the next ordinary lift. */
  private readonly cinematicRecoveryCooldown = new Set<SpiderLegId>();
  private restPoseClock = 0;
  private restContactCheckClock = 0;
  private restContactChecks = 0;
  private restPoseSettleClock = 0;
  private restPoseActive = false;
  private restPoseSettled = false;
  /** True once the slow draw toward the reduced rest standoff has finished. */
  private restTuckSettled = false;
  private restTuckClock = 0;
  /** 0..1 ease of the rest arch multiplier currently pushed into the solver. */
  private restArchBlend = 0;
  /** Which stationary intent owns the current lock; prevents stale early-outs. */
  private stationaryPoseKind: StationaryPoseKind | null = null;

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
    const terrainSupportDistance = Math.min(
      this.config.footholdSearchRadius * 0.65,
      this.rig.aggregateReach.comfortable * 0.78,
    );
    this.terrainPlanner = this.config.cinematicLocomotion
      ? new DirectTerrainPlanner(options.traversal, {
        maximumSupportDistance: terrainSupportDistance,
        sampleSpacing: Math.max(0.12, terrainSupportDistance * 0.5),
      })
      : null;
    this.footholds = new FootholdSearch(options.traversal);
    this.personality = new Personality(this.config);

    const reachByLeg = Object.fromEntries(
      SPIDER_LEG_IDS.map((id) => [id, this.rig.legs[id].reach]),
    ) as Record<SpiderLegId, (typeof this.rig.legs)[SpiderLegId]["reach"]>;
    this.contacts = createBlackWidowFootContacts(reachByLeg);

    // Constrain every joint relative to the repaired rest pose, including the
    // coxa at the body. The old rig needed a completely free coxa to absorb its
    // misplaced rest bones; with the repaired rig that freedom lets a front leg
    // choose a 90-110 degree sideways root turn even while every distal hinge is
    // legal. A coxa is multi-axis, but it still has an anatomical sector, and the
    // authored bend/twist/swing ranges preserve that sector symmetrically.
    const scale = this.config.jointLimitScale;
    this.ik = new SpiderIKSolver(
      SPIDER_LEG_IDS.map((id) => ({
        id,
        bones: this.rig.legs[id].chain,
        // The middle pairs are nearly straight at rest, so preserve their
        // authored arch instead of amplifying it before FABRIK solves.
        preferredArchGain: id[1] === "2" || id[1] === "3" ? 1 : undefined,
        reach: {
          minimum: this.rig.legs[id].reach.min,
          comfortable: this.rig.legs[id].reach.comfortable,
          maximum: this.rig.legs[id].reach.max,
        },
        jointLimits:
          scale > 0
            ? this.rig.legs[id].jointLimits.map((limit, jointIndex) => {
                const segmentName = this.rig.legs[id].segmentNames[jointIndex];
                return {
                  bendX: {
                    min: limit.bend_x[0] * scale,
                    max: effectiveBendMaximumDegrees(
                      id,
                      segmentName,
                      limit.bend_x[1] * scale,
                    ),
                  },
                  swingZ: { min: limit.swing_z[0] * scale, max: limit.swing_z[1] * scale },
                  twistY: { min: limit.twist_y[0] * scale, max: limit.twist_y[1] * scale },
                  unit: "degrees" as const,
                };
              })
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

  private cinematicMovingFeetCount(): number {
    let moving = 0;
    for (const foot of this.cinematicFeet.values()) {
      if (foot.moving) moving += 1;
    }
    return moving;
  }

  get state(): ChoreographerState {
    const planted = this.plantedCount();
    let cinematicSwinging = 0;
    if (this.config.cinematicLocomotion) {
      for (const foot of this.cinematicFeet.values()) {
        if (foot.moving) cinematicSwinging += 1;
      }
    }
    return {
      intent: this.intent.kind,
      plantedCount: planted,
      swingingCount: this.config.cinematicLocomotion ? cinematicSwinging : this.swings.size,
      speed: this.speed,
      confidence: this.personality.confidence,
      paused: this.personality.isPaused,
      leash: this.leash,
      supportQuality: this.cinematicSupportQuality,
      hasRoute: this.route.hasRoute,
      routeKind: this.route.guideKind,
      routeRemaining: this.route.remaining,
      arrived: this.config.cinematicLocomotion
        ? (this.stationaryPoseKind === "arrival" && this.restPoseSettled)
          || this.cinematicArrivalComplete()
        : this.route.arrived,
      stranded: this.stranded,
      raisedRestCount: this.restPoseActive ? this.raisedRestFeet.size : 0,
      restPoseSettled: this.restPoseActive && this.restPoseSettled,
    };
  }

  /** Presentation diagnostic used by the development harness. */
  isRestLegRaised(legId: SpiderLegId): boolean {
    return this.restPoseActive && this.raisedRestFeet.has(legId);
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
    const leavingLockedStationaryPose =
      this.config.cinematicLocomotion
      && this.config.maximumRaisedRestFeet <= 0
      && this.restPoseActive
      && this.restPoseSettled
      && this.stationaryPoseKind !== null
      && destinationOf(intent) !== null;
    if (leavingLockedStationaryPose) {
      for (const legId of SPIDER_LEG_IDS) this.plantedRestDepartureFeet.add(legId);
    } else if (intent.kind === "rest" || intent.kind === "freeze") {
      this.plantedRestDepartureFeet.clear();
    }
    this.intent = intent;
    this.intentDirty = true;
    this.stranded = false;
    // Turn authorization belongs to the route that earned it; a new instruction
    // starts from the currently landed support frame.
    this.cinematicStepFramePending = false;
    this.cinematicStepExpectedLandings = 0;
    this.cinematicStepRealLandings = 0;
    // Each rest interval earns its own tuck from wherever travel ends.
    this.restTuckSettled = false;
    this.restTuckClock = 0;
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
    this.frameForward.copy(this.bodyForward);
    this.cinematicSupportForward.copy(this.bodyForward);
    this.cinematicStepForward.copy(this.bodyForward);
    this.cinematicPlanningUp.copy(this.bodyUp);
    this.cinematicStepFramePending = false;
    this.cinematicSupportQuality = 1;
    this.footholdSearchEma = 1;
    this.cinematicStepExpectedLandings = 0;
    this.cinematicStepRealLandings = 0;
    this.cinematicLastGroupIndex = -1;
    this.raisedRestFeet.clear();
    this.lockedRestTargets.clear();
    this.capturePlantedRestAfterSolve = false;
    this.plantedRestDepartureFeet.clear();
    this.cinematicRecoveryCooldown.clear();
    this.restPoseClock = 0;
    this.restContactCheckClock = 0;
    this.restContactChecks = 0;
    this.restPoseSettleClock = 0;
    this.restPoseActive = false;
    this.restPoseSettled = false;
    this.restTuckSettled = false;
    this.restTuckClock = 0;
    this.stationaryPoseKind = null;

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
      this.stanceHome(legId, this.aim);
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
      this.resetCinematicHeading();
      return;
    }
    const start = this.bodyAddress;
    if (!start) {
      this.route.clear();
      this.resetCinematicHeading();
      return;
    }
    const direct = this.terrainPlanner?.plan(start, destination);
    if (direct) {
      this.route.setDirectTerrainRoute(direct);
      if (!this.route.hasRoute) this.resetCinematicHeading();
      return;
    }
    const planned: PlannedRoute | null = this.planner.plan(start, destination);
    if (planned) {
      this.route.setRoute(planned);
      if (!this.route.hasRoute) this.resetCinematicHeading();
    } else {
      this.route.clear();
      this.resetCinematicHeading();
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
    const hasTravelPoint = this.route.positionAt(this.traversal, 0, this.travelPoint);
    if (hasTravelPoint) {
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
    let brake: number;
    if (this.config.cinematicLocomotion) {
      // A body that races through a route corner while the feet are still
      // changing stance reads as a skid even if every individual pose is legal.
      // Keep enough motion to avoid a dead stop, but let heading alignment own
      // most of the speed until the support frame has come around.
      let alignment = 1;
      if (hasTravelPoint && this.route.positionAt(this.traversal, 0.28, this.aheadPoint)) {
        this.direction.copy(this.aheadPoint).sub(this.travelPoint);
        this.direction.addScaledVector(this.bodyUp, -this.direction.dot(this.bodyUp));
        if (this.direction.lengthSq() > 1e-8) {
          this.direction.normalize();
          this.sweep
            .copy(this.bodyForward)
            .addScaledVector(this.bodyUp, -this.bodyForward.dot(this.bodyUp))
            .normalize();
          alignment = THREE.MathUtils.clamp(this.direction.dot(this.sweep), 0, 1);
        }
      }
      brake = THREE.MathUtils.lerp(
        CINEMATIC_CORNER_SPEED_FLOOR,
        1,
        alignment * alignment,
      );
      // The route steers a continuously moving body; the legs' aggregate truth
      // throttles it. Support quality is a smooth signal with a hard speed
      // floor, so sparse silk changes her pace and character — never her
      // continuity. Smoothness outranks placement by design.
      brake *= THREE.MathUtils.clamp(
        1 - this.leash / Math.max(1e-3, this.config.maximumLeash),
        0,
        1,
      );
      brake *= THREE.MathUtils.lerp(
        CINEMATIC_QUALITY_SPEED_FLOOR,
        1,
        this.cinematicSupportQuality,
      );
    } else {
      brake = THREE.MathUtils.clamp(1 - this.leash / this.config.maximumLeash, 0, 1);
    }
    this.route.advance(this.speed * dt * brake);
  }

  /**
   * Distills the legs' recent truth into one smooth 0..1 signal: how many feet
   * are healthy right now, and how often travelling foothold searches have been
   * finding silk. A mid-swing foot is healthy — it is airborne by choice — so
   * the rhythmic overlap of the gait cannot pulse this signal. Only feet that
   * are held with nowhere to stand, or planted on invalid silk, count against
   * her. Neither term reacts to a single step, which is the point: individual
   * footfalls must never gate a fluid body.
   */
  private updateSupportQuality(dt: number): void {
    let healthy = 0;
    for (const [legId, contact] of this.contacts) {
      if (this.cinematicFeet.get(legId)?.moving) {
        healthy += 1;
        continue;
      }
      if (
        contact.isPlanted &&
        contact.contactValid &&
        contact.hasResolvedWorldPosition
      ) {
        healthy += 1;
      }
    }
    const healthyTerm = THREE.MathUtils.clamp(
      (healthy - CINEMATIC_QUALITY_HEALTHY_FLOOR) / CINEMATIC_QUALITY_HEALTHY_SPAN,
      0,
      1,
    );
    const target = Math.min(healthyTerm, this.footholdSearchEma);
    this.cinematicSupportQuality +=
      (target - this.cinematicSupportQuality)
      * Math.min(1, dt * CINEMATIC_QUALITY_RESPONSE);
  }

  // ---------------------------------------------------------- cinematic gait

  private initializeCinematicFeet(): void {
    this.cinematicFeet.clear();
    this.rig.rootObject.updateMatrixWorld(true);
    this.cinematicSupportForward.copy(this.bodyForward);
    this.cinematicStepForward.copy(this.bodyForward);
    this.cinematicPlanningUp.copy(this.bodyUp);
    this.cinematicStepFramePending = false;
    this.cinematicStepExpectedLandings = 0;
    this.cinematicStepRealLandings = 0;
    this.cinematicLastGroupIndex = -1;
    for (const legId of SPIDER_LEG_IDS) {
      // settle() has just solved every available foot to real silk. Capture the
      // actual visible result instead of replacing it with FootHome while keeping
      // the semantic contact -- that old split was the initial floating-foot pop.
      const position = new THREE.Vector3();
      this.rig.legs[legId].footTip.getWorldPosition(position);
      this.cinematicFeet.set(legId, {
        position,
        start: position.clone(),
        destination: position.clone(),
        up: this.bodyUp.clone(),
        address: this.contacts.get(legId)?.address ?? null,
        elapsed: 0,
        duration: 0.2,
        moving: false,
      });
    }
    this.cinematicGaitIndex = 0;
    this.cinematicStepClock = 0;
    this.raisedRestFeet.clear();
    this.lockedRestTargets.clear();
    this.capturePlantedRestAfterSolve = false;
    this.plantedRestDepartureFeet.clear();
    this.cinematicRecoveryCooldown.clear();
    this.restPoseClock = 0;
    this.restContactCheckClock = 0;
    this.restContactChecks = 0;
    this.restPoseSettleClock = 0;
    this.restPoseActive = false;
    this.restPoseSettled = false;
    this.restTuckSettled = false;
    this.restTuckClock = 0;
    this.stationaryPoseKind = null;
  }

  /** Cancels any unearned turn when travel is interrupted or cannot be planned. */
  private resetCinematicHeading(): void {
    if (!this.config.cinematicLocomotion) return;
    this.desiredForward.copy(this.bodyForward);
    this.cinematicSupportForward.copy(this.bodyForward);
    this.cinematicStepForward.copy(this.bodyForward);
    this.cinematicStepFramePending = false;
    this.cinematicStepExpectedLandings = 0;
    this.cinematicStepRealLandings = 0;
    this.cinematicLastGroupIndex = -1;
    this.cinematicRecoveryCooldown.clear();
  }

  /**
   * Showcase locomotion, hybrid form: the route steers a continuously moving
   * body, an overlapping gait reaches for real silk beneath it, and the legs'
   * aggregate success — not any individual footfall — throttles the speed.
   * Sparse silk therefore slows her smoothly instead of gating her forward in
   * landing-sized packets.
   */
  private updateCinematicLocomotion(dt: number): void {
    if (this.cinematicFeet.size === 0) {
      this.initializeCinematicFeet();
    }

    // Cinematic travel still needs a real walking surface. Refresh the semantic
    // contacts before moving the body so their transported normals and support
    // geometry can turn her onto steep silk instead of leaving dorsal as world-up.
    this.refreshContacts();
    this.updateSupportQuality(dt);

    // A completed stationary pose is a true hold, not another controller
    // chasing a moving equilibrium. Keep semantic contacts fresh so invalid
    // silk stops accepting load, but freeze body and leg transforms until a new
    // movement intent actually owns an unfinished route.
    const stationaryKind = this.requestedStationaryPoseKind();
    if (
      this.restPoseActive &&
      this.restPoseSettled &&
      this.stationaryPoseKind === stationaryKind
    ) {
      this.loads.applyFixedStep(dt, this.bodyPosition);
      return;
    }

    const hasTravelPoint = this.updateCinematicTravelDirection();
    // Foot state advances first. A turning pair lands into the next support
    // heading before that heading is handed to the body, so the legs visibly
    // initiate and brace the corner instead of spiralling after it.
    const movingFeet = this.advanceCinematicFeet(dt);
    // Rebuild from the pair that just landed before planning the next lift. The
    // landing frame, support normal, and heading authorization now describe the
    // same physical set of feet.
    this.refreshContacts();
    this.updateSupportFrame();
    this.updateCinematicPlanningUp();
    this.scheduleCinematicStep(movingFeet);
    // Scheduling may have released the next pair. The body must turn on the
    // support set that is actually still planted this frame.
    this.refreshContacts();
    this.updateSupportFrame();
    this.updateCinematicBody(dt, hasTravelPoint);
    // The body has moved since the first refresh. Resolve reach and strand frames
    // again before solving the visual legs and distributing their semantic load.
    this.refreshContacts();
    this.updateCinematicRestPose(dt);
    this.updateRestArch(dt);
    this.solveCinematicFeet();
    this.finalizePlantedRestSnapshot();
    this.loads.applyFixedStep(dt, this.bodyPosition);
  }

  /**
   * Eases the rest arch multiplier into the solver: as she tucks, the knees
   * rise until the femora read near-vertical and the patellae nearly meet
   * above the body. Walking eases it back to the authored arch.
   */
  private updateRestArch(dt: number): void {
    const gain = this.config.restArchGain;
    if (gain === 1 && this.restArchBlend === 0) return;
    const target = this.intent.kind === "rest" && !this.route.hasRoute ? 1 : 0;
    this.restArchBlend += (target - this.restArchBlend) * Math.min(1, dt * 3);
    if (Math.abs(this.restArchBlend - target) < 1e-3) this.restArchBlend = target;
    const scale = THREE.MathUtils.lerp(1, gain, this.restArchBlend);
    for (const legId of SPIDER_LEG_IDS) {
      this.ik.setArchGainScale(legId, scale);
    }
  }

  /** Returns the stationary presentation that currently owns the rig, if any. */
  private requestedStationaryPoseKind(): StationaryPoseKind | null {
    if (this.intent.kind === "rest" || this.intent.kind === "freeze") {
      return this.intent.kind;
    }
    return this.cinematicArrivalComplete() ? "arrival" : null;
  }

  /**
   * Reconciles the cinematic presentation with real silk, then locks it.
   *
   * True rest may park unsupported feet high. Freeze and completed routes keep
   * every released foot low, but use the same bounded two-check snapshot so no
   * visually stationary mode can chase the web indefinitely.
   */
  private updateCinematicRestPose(dt: number): void {
    let movingFeet = false;
    for (const state of this.cinematicFeet.values()) {
      if (state.moving) {
        movingFeet = true;
        break;
      }
    }

    const requestedKind = this.requestedStationaryPoseKind();
    if (
      this.restPoseActive &&
      this.stationaryPoseKind !== requestedKind
    ) {
      // A rest-to-freeze transition is a new pose, while departure keeps the
      // raised set intact so the ordinary gait can recover those feet.
      this.restPoseActive = false;
      this.restPoseSettled = false;
      this.stationaryPoseKind = null;
      this.lockedRestTargets.clear();
      this.capturePlantedRestAfterSolve = false;
      this.restContactCheckClock = 0;
      this.restContactChecks = 0;
      this.restPoseSettleClock = 0;
      this.restPoseClock = 0;
      if (requestedKind) this.raisedRestFeet.clear();
    }

    const ready = requestedKind !== null && !movingFeet && (
      requestedKind === "arrival"
        ? this.route.arrived
        : !this.route.hasRoute && this.speed <= 0.015
    ) &&
      // True rest first draws the body up to its tucked standoff, so the
      // snapshot below captures folded legs instead of the walking splay.
      (requestedKind !== "rest" || this.restTuckSettled);

    if (!ready) {
      this.restPoseClock = 0;
      if (requestedKind === null) {
        // Travel owns the recovery in scheduleCinematicStep: raised feet get
        // first use of the ordinary swing path. A failed route has no recovery
        // path, so lower the presentation pose here instead.
        if (!this.route.hasRoute) {
          this.lowerRaisedRestFeet(dt);
        }
        this.restPoseActive = false;
        this.stationaryPoseKind = null;
        this.lockedRestTargets.clear();
        this.capturePlantedRestAfterSolve = false;
        this.restContactCheckClock = 0;
        this.restContactChecks = 0;
        this.restPoseSettleClock = 0;
        this.restPoseSettled = false;
        this.restTuckSettled = false;
        this.restTuckClock = 0;
      }
      return;
    }

    if (!this.restPoseActive) {
      this.restPoseClock += dt;
      if (this.restPoseClock < this.config.restPoseDelay) return;
      if (requestedKind === "rest") {
        if (this.config.maximumRaisedRestFeet <= 0) {
          // A planted rest means the feet have chosen their places. Their
          // cinematic world targets already stayed fixed through the body tuck;
          // capture those exact visible positions and stop. Rechecking live silk
          // and easing toward a second target reads as continual foot hunting.
          this.raisedRestFeet.clear();
          this.lockedRestTargets.clear();
          this.restContactChecks = REST_CONTACT_CHECK_LIMIT;
          this.restContactCheckClock = 0;
          this.restPoseSettleClock = 0;
          this.restPoseActive = true;
          this.restPoseSettled = false;
          this.stationaryPoseKind = requestedKind;
          this.capturePlantedRestAfterSolve = true;
          return;
        }
        this.selectRaisedRestFeet();
      } else {
        this.raisedRestFeet.clear();
        this.reconcileRestContacts(false);
      }
      // The selection/reconciliation above is the first full evaluation. Give
      // the web one short response window, evaluate once more, then never let
      // this stationary interval renegotiate its pose again.
      this.restContactChecks = 1;
      this.restContactCheckClock = 0;
      this.restPoseSettleClock = 0;
      this.restPoseSettled = false;
      this.lockedRestTargets.clear();
      this.restPoseActive = true;
      this.stationaryPoseKind = requestedKind;
    }

    if (this.lockedRestTargets.size === 0) {
      this.restContactCheckClock += dt;
      if (
        this.restContactChecks < REST_CONTACT_CHECK_LIMIT &&
        this.restContactCheckClock >= REST_CONTACT_RECHECK_DELAY
      ) {
        this.reconcileRestContacts(this.stationaryPoseKind === "rest");
        this.restContactChecks += 1;
        this.restContactCheckClock = 0;
      }
      if (this.restContactChecks < REST_CONTACT_CHECK_LIMIT) return;
      this.captureRestTargets();
    }

    // Once every foot reaches this one fixed snapshot, do absolutely nothing to
    // the feet until rest ends. This breaks the foot -> load -> web -> foot
    // feedback loop that otherwise makes a quiet spider continually rebalance.
    if (this.restPoseSettled) return;

    const poseAlpha = 1 - Math.exp(-dt * this.config.restPoseResponse);
    const contactAlpha = 1 - Math.exp(-dt * this.config.restContactResponse);
    let allSettled = true;
    this.restPoseSettleClock += dt;
    for (const legId of SPIDER_LEG_IDS) {
      const state = this.cinematicFeet.get(legId)!;
      const contact = this.contacts.get(legId)!;
      const target = this.lockedRestTargets.get(legId)!;
      const alpha =
        !this.raisedRestFeet.has(legId) && contact.isPlanted
          ? contactAlpha
          : poseAlpha;
      state.position.lerp(target, alpha);
      if (
        state.position.distanceToSquared(target) >
        REST_POSE_SETTLE_EPSILON ** 2
      ) {
        allSettled = false;
      }
    }

    if (allSettled || this.restPoseSettleClock >= REST_POSE_SETTLE_LIMIT) {
      for (const [legId, target] of this.lockedRestTargets) {
        this.cinematicFeet.get(legId)!.position.copy(target);
      }
      if (this.stationaryArchSettled()) this.restPoseSettled = true;
    }
  }

  /** Captures the final targets once; no live silk positions are read afterward. */
  private captureRestTargets(): void {
    this.lockedRestTargets.clear();
    for (const legId of SPIDER_LEG_IDS) {
      const state = this.cinematicFeet.get(legId)!;
      const contact = this.contacts.get(legId)!;
      if (this.raisedRestFeet.has(legId)) {
        this.raisedRestTarget(legId, this.target);
      } else if (this.isRestContactUsable(legId)) {
        this.target.copy(contact.worldPosition);
      } else if (state.address && contact.isPlanted) {
        // Preserve one of the last necessary supports exactly where it already
        // appears rather than pulling the mesh away from its semantic contact.
        this.target.copy(state.position);
      } else {
        // Unsupported feet beyond the three-leg high-pose cap fold quietly at
        // FootHome, but this target is just as fixed as every other rest target.
        this.stanceHome(legId, this.target);
      }
      this.lockedRestTargets.set(legId, this.target.clone());
    }
  }

  /** Ordinary rest keeps the exact places the solved, visible feet chose. */
  private captureSolvedRestTargets(): void {
    this.rig.rootObject.updateMatrixWorld(true);
    this.lockedRestTargets.clear();
    for (const legId of SPIDER_LEG_IDS) {
      this.rig.legs[legId].footTip.getWorldPosition(this.target);
      this.cinematicFeet.get(legId)!.position.copy(this.target);
      this.lockedRestTargets.set(legId, this.target.clone());
    }
  }

  /** Completes the post-IK planted snapshot once its stationary arch is final. */
  private finalizePlantedRestSnapshot(): void {
    if (!this.capturePlantedRestAfterSolve) return;
    // Seed the lock once. While the arch converges, IK keeps solving toward this
    // same world-space anchor instead of ratcheting tiny residuals into drift.
    if (this.lockedRestTargets.size === 0) this.captureSolvedRestTargets();
    if (!this.stationaryArchSettled()) return;
    // Publish the actual final solved tips, eliminating any clamp-sized gap
    // between the controller target and the mesh before the hard hold begins.
    this.captureSolvedRestTargets();
    this.capturePlantedRestAfterSolve = false;
    this.restPoseSettled = true;
  }

  private stationaryArchSettled(): boolean {
    if (this.config.restArchGain === 1) return true;
    const target = this.stationaryPoseKind === "rest" ? 1 : 0;
    return Math.abs(this.restArchBlend - target) < 1e-3;
  }

  private selectRaisedRestFeet(): void {
    this.raisedRestFeet.clear();
    this.reconcileRestContacts();

    // When configured, show the characteristic black-widow resting gesture by
    // letting go of the weakest nonessential support on otherwise dense silk.
    const minimum = Math.min(
      this.raisedRestLimit(),
      Math.max(0, Math.floor(this.config.minimumRaisedRestFeet)),
    );
    const supportFloor = Math.max(5, this.config.minimumPlantedFeet);
    while (
      this.raisedRestFeet.size < minimum &&
      this.validRestSupportCount() > supportFloor
    ) {
      let weakest: SpiderLegId | null = null;
      let weakestScore = -Infinity;
      for (const legId of REST_RAISE_PRIORITY) {
        if (this.raisedRestFeet.has(legId) || !this.isRestContactUsable(legId)) {
          continue;
        }
        const contact = this.contacts.get(legId)!;
        const leg = this.rig.legs[legId];
        this.stanceHome(legId, this.target);
        const stanceMiss = this.target.distanceTo(contact.worldPosition);
        const reachStrain = contact.currentReachDistance / Math.max(1e-3, leg.reach.max);
        const score = stanceMiss + reachStrain * 0.2;
        if (score > weakestScore) {
          weakest = legId;
          weakestScore = score;
        }
      }
      if (!weakest) break;
      this.releaseRestFoot(weakest);
      this.raisedRestFeet.add(weakest);
    }
  }

  /** Releases newly unusable addresses; only true rest may fill high-pose roles. */
  private reconcileRestContacts(allowRaisedPose = true): void {
    const limit = this.raisedRestLimit();
    for (const legId of REST_RAISE_PRIORITY) {
      if (this.raisedRestFeet.has(legId)) continue;
      if (this.isRestContactUsable(legId)) continue;

      const contact = this.contacts.get(legId)!;
      const wasValidSupport =
        contact.isPlanted &&
        contact.contactValid &&
        contact.hasResolvedWorldPosition;
      if (
        wasValidSupport &&
        this.validRestSupportCount() <= Math.max(5, this.config.minimumPlantedFeet)
      ) {
        // Exact conformance loses to stability when the web supplies fewer than
        // five alternatives. Keep this rare outlier where it was rather than
        // manufacture the high pose by removing a necessary support.
        continue;
      }
      this.releaseRestFoot(legId);
      if (allowRaisedPose && this.raisedRestFeet.size < limit) {
        this.raisedRestFeet.add(legId);
      }
    }
  }

  private raisedRestLimit(): number {
    return THREE.MathUtils.clamp(
      Math.floor(this.config.maximumRaisedRestFeet),
      0,
      3,
    );
  }

  private validRestSupportCount(): number {
    let count = 0;
    for (const contact of this.contacts.values()) {
      if (
        contact.isPlanted &&
        contact.contactValid &&
        contact.hasResolvedWorldPosition
      ) {
        count += 1;
      }
    }
    return count;
  }

  /** Raised and neutral unsupported feet must own neither address nor load. */
  private releaseRestFoot(legId: SpiderLegId): void {
    const state = this.cinematicFeet.get(legId)!;
    const contact = this.contacts.get(legId)!;
    state.address = null;
    if (contact.isPlanted || contact.address) {
      contact.beginRelease();
      contact.release();
      this.loads.releaseFootLoad(legId);
    }
  }

  /** True only when the visible chain can actually reach its semantic contact. */
  private isRestContactUsable(legId: SpiderLegId): boolean {
    const state = this.cinematicFeet.get(legId);
    const leg = this.rig.legs[legId];
    const contact = this.contacts.get(legId)!;
    if (!state || !this.isCinematicContactTrackable(legId)) {
      return false;
    }

    // Once the eased target is close enough to test the actual constrained IK,
    // reject contacts the joints still cannot reach. During the ease-in, the
    // previous solve describes the old target and is not evidence either way.
    const dx = state.position.x - contact.worldPosition.x;
    const dy = state.position.y - contact.worldPosition.y;
    const dz = state.position.z - contact.worldPosition.z;
    if (dx * dx + dy * dy + dz * dz <= 0.03 ** 2) {
      const result = this.ik.getResult(legId);
      if (
        result &&
        Number.isFinite(result.residual) &&
        result.residual / Math.max(1e-3, leg.reach.max) >
          REST_CONTACT_IK_RESIDUAL_LIMIT
      ) {
        return false;
      }
    }
    return true;
  }

  /** A semantic contact is useful only while the visible leg can remain on it. */
  private isCinematicContactTrackable(legId: SpiderLegId): boolean {
    const state = this.cinematicFeet.get(legId);
    const contact = this.contacts.get(legId)!;
    const leg = this.rig.legs[legId];
    if (
      !state?.address ||
      !contact.isPlanted ||
      !contact.contactValid ||
      !contact.hasResolvedWorldPosition ||
      contact.currentReachDistance > this.maximumVisualReach(legId) * 0.995 ||
      this.midlineBreach(legId, contact.worldPosition) >
        this.config.midlineTolerance * leg.reach.max
    ) {
      return false;
    }

    leg.chain[0].getWorldPosition(this.coxa);
    this.direction.copy(contact.worldPosition).sub(this.coxa);
    return (
      this.direction.lengthSq() > 1e-8 &&
      this.direction.normalize().dot(this.restDirection(legId)) >=
        Math.cos(THREE.MathUtils.degToRad(this.config.legSweepDegrees))
    );
  }

  /** Builds one reachable foot target high toward the web above the spider. */
  private raisedRestTarget(legId: SpiderLegId, target: THREE.Vector3): void {
    const leg = this.rig.legs[legId];
    this.stanceHome(legId, target);
    leg.chain[0].getWorldPosition(this.coxa);

    // Preserve the leg's authored sector in the support plane, then fold it in.
    this.direction
      .copy(target)
      .sub(this.coxa)
      .addScaledVector(this.bodyUp, -this.direction.dot(this.bodyUp));
    if (this.direction.lengthSq() <= 1e-8) {
      this.direction.copy(this.outward(legId));
    } else {
      this.direction.normalize();
    }
    target
      .copy(this.coxa)
      .addScaledVector(
        this.direction,
        leg.reach.max * this.config.raisedRestPlanarReach,
      )
      // Vesper hangs dorsal-side down, so -bodyUp points webward/high on screen.
      .addScaledVector(
        this.bodyUp,
        -leg.reach.max * this.config.raisedRestLift,
      );
  }

  /** Lowers a high rest pose smoothly when rest changes directly to freeze. */
  private lowerRaisedRestFeet(dt: number): void {
    if (this.raisedRestFeet.size === 0) return;
    const alpha = 1 - Math.exp(-dt * this.config.restPoseResponse);
    let settled = true;
    for (const legId of this.raisedRestFeet) {
      const state = this.cinematicFeet.get(legId);
      if (!state || state.moving) continue;
      this.stanceHome(legId, this.target);
      state.position.lerp(this.target, alpha);
      if (state.position.distanceToSquared(this.target) > 1e-4) settled = false;
    }
    if (settled) this.raisedRestFeet.clear();
  }

  /** Resolves the route cursor and its longer lookahead into a landing heading. */
  private updateCinematicTravelDirection(): boolean {
    if (!this.route.hasRoute) return false;
    const hasTravelPoint = this.route.positionAt(this.traversal, 0, this.travelPoint);
    if (!hasTravelPoint) {
      // The current silk address vanished. This is a broken route, not an
      // arrival; release autonomy and preserve an explicit stranded signal.
      this.route.clear();
      this.resetCinematicHeading();
      this.stranded = true;
      return false;
    }
    this.stranded = false;
    if (
      this.route.positionAt(this.traversal, 0.28, this.aheadPoint)
    ) {
      this.scratch.copy(this.aheadPoint).sub(this.travelPoint);
      if (this.scratch.lengthSq() > 1e-7) {
        this.desiredForward.copy(this.scratch).normalize();
      }
    }
    return hasTravelPoint;
  }

  private updateCinematicBody(dt: number, hasTravelPoint: boolean): void {
    const frame = this.bodyPose.frame;
    if (!frame.valid) return;

    // Follow only the heading that landed feet have earned. The route can look
    // arbitrarily far around a bend; it informs the next footfall, not an
    // unsupported instantaneous thorax turn.
    this.alignBodyFrame(frame.up, dt, this.cinematicSupportForward);

    if (hasTravelPoint) {
      this.target.copy(this.travelPoint).addScaledVector(this.bodyUp, this.config.bodyStandoff);
      const follow = 1 - Math.exp(-dt * this.config.bodyFollowRate);
      this.scratch.copy(this.target).sub(this.bodyPosition).multiplyScalar(follow);
      // Smoothness outranks placement: a foot about to pin the body lets go
      // and re-steps, rather than the body stopping. Feet that remain planted
      // still keep the hard veto — they can never be dragged past the
      // workspace their landing was chosen in.
      this.releasePinnedCinematicContacts(this.scratch);
      this.limitByReach(this.scratch, CINEMATIC_BODY_REACH_LIMIT);
      this.bodyPosition.add(this.scratch);
    } else if (
      this.intent.kind === "rest" &&
      !this.restPoseActive &&
      this.cinematicMovingFeetCount() === 0
    ) {
      // A resting widow does not park at walking standoff: she draws herself up
      // toward her contacts until the legs fold high, the femora stand nearly
      // vertical, and the patellae converge over the midline. The feet stay
      // exactly where they are — the shrinking coxa-to-contact distance is what
      // folds the legs. Once the rest pose activates and locks its snapshot the
      // body holds still, so this ease runs only during the approach.
      this.restTuckClock += dt;
      this.target
        .copy(frame.center)
        .addScaledVector(
          this.bodyUp,
          this.config.bodyStandoff * this.config.restStandoffScale,
        );
      const follow = 1 - Math.exp(-dt * this.config.restTuckRate);
      this.scratch.copy(this.target).sub(this.bodyPosition);
      const remaining = this.scratch.length();
      this.scratch.multiplyScalar(follow);
      this.limitByReach(this.scratch, CINEMATIC_BODY_REACH_LIMIT);
      this.bodyPosition.add(this.scratch);
      // The web may never allow the exact tuck; the clock keeps an unreachable
      // ideal from deferring the rest snapshot forever.
      if (remaining < REST_TUCK_EPSILON || this.restTuckClock > REST_TUCK_TIME_LIMIT) {
        this.restTuckSettled = true;
      }
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
      pitch: THREE.MathUtils.clamp(
        -forwardSpeed * this.config.bodyLean,
        -0.08,
        0.08,
      ),
    });
    this.swayAbdomen(forwardSpeed);
    this.rig.rootObject.updateMatrixWorld(true);
  }

  /**
   * Releases any planted contact that leaves the body essentially no room to
   * move along its intended direction, provided enough supports remain for the
   * stance to stay believable. The released foot holds its pose, reports mild
   * urgency, and is re-stepped by the ordinary gait within a cycle — while the
   * body never stops. This is the smoothness-over-placement rule made literal:
   * without it, one stretched leg on silk-poor web pinned the whole spider.
   */
  private releasePinnedCinematicContacts(delta: THREE.Vector3): void {
    const proposed = delta.length();
    if (proposed <= 1e-6) return;
    this.direction.copy(delta).divideScalar(proposed);

    let planted = this.plantedCount();
    for (const legId of SPIDER_LEG_IDS) {
      if (planted <= CINEMATIC_PINNED_SUPPORT_FLOOR) return;
      const contact = this.contacts.get(legId)!;
      if (!contact.isPlanted || !contact.hasResolvedWorldPosition) continue;
      const state = this.cinematicFeet.get(legId);
      if (!state || state.moving) continue;

      const limit = this.rig.legs[legId].reach.max * CINEMATIC_BODY_REACH_LIMIT;
      this.reachVector
        .set(contact.worldPosition.x, contact.worldPosition.y, contact.worldPosition.z)
        .sub(contact.reachOriginWorldPosition as THREE.Vector3);
      const along = this.reachVector.dot(this.direction);
      const discriminant =
        along * along + limit * limit - this.reachVector.lengthSq();
      const room =
        discriminant < 0 ? 0 : Math.max(0, along + Math.sqrt(discriminant));
      if (room > CINEMATIC_PINNED_ROOM) continue;

      state.address = null;
      contact.beginRelease();
      contact.release();
      this.loads.releaseFootLoad(legId);
      planted -= 1;
    }
  }

  private advanceCinematicFeet(dt: number): number {
    this.cinematicStepClock = Math.max(0, this.cinematicStepClock - dt);
    let movingFeet = 0;

    for (const legId of SPIDER_LEG_IDS) {
      const state = this.cinematicFeet.get(legId)!;
      if (!state.moving) {
        // Stationary modes own a bounded settle-and-lock pass. Letting walking's
        // live silk tracker run after the route arrives recreates the exact
        // feedback loop that pass is designed to stop.
        if (
          this.route.hasRoute &&
          !this.route.arrived &&
          !this.plantedRestDepartureFeet.has(legId) &&
          this.isCinematicContactTrackable(legId)
        ) {
          const contact = this.contacts.get(legId)!;
          const alpha = 1 - Math.exp(-dt * this.config.cinematicContactResponse);
          state.position.lerp(contact.worldPosition, alpha);
        }
        continue;
      }

      state.elapsed += dt;
      const p = THREE.MathUtils.clamp(state.elapsed / state.duration, 0, 1);
      const eased = p * p * (3 - 2 * p);
      state.position.copy(state.start).lerp(state.destination, eased);
      state.position.addScaledVector(
        state.up,
        Math.sin(Math.PI * p)
          * this.config.swingLift
          * CINEMATIC_SWING_LIFT_SCALE[legId[1] as "1" | "2" | "3" | "4"],
      );
      if (p >= 1) {
        state.position.copy(state.destination);
        state.moving = false;
        if (state.address) {
          this.contacts.get(legId)!.plant(state.address);
          this.onFootPlant?.(legId, state.address);
          if (this.cinematicStepFramePending) {
            this.cinematicStepRealLandings += 1;
          }
        }
      } else {
        movingFeet += 1;
      }
    }

    // A turning pair lands before its heading is handed to the thorax. Real
    // silk earns the full slice; misses still earn most of it — the stepping
    // gesture sells the turn, and a heading that can only advance on perfect
    // landings strands the spider in silk-poor corners.
    if (movingFeet === 0 && this.cinematicStepFramePending) {
      const landingRatio = this.cinematicStepExpectedLandings > 0
        ? THREE.MathUtils.lerp(
            CINEMATIC_TURN_MISS_AUTHORITY,
            1,
            this.cinematicStepRealLandings / this.cinematicStepExpectedLandings,
          )
        : 1;
      this.cinematicSupportForward
        .lerp(this.cinematicStepForward, landingRatio)
        .addScaledVector(
          this.cinematicPlanningUp,
          -this.cinematicSupportForward.dot(this.cinematicPlanningUp),
        )
        .normalize();
      this.cinematicStepFramePending = false;
      this.cinematicStepExpectedLandings = 0;
      this.cinematicStepRealLandings = 0;
    }

    return movingFeet;
  }

  private scheduleCinematicStep(movingFeet: number): void {
    // Rest/freeze clears the route. Do not let stale lag or a stale lookahead
    // start another lift after the caller has asked the spider to hold still.
    if (!this.route.hasRoute) return;

    const arrivalBodyLag = this.route.arrived
      && this.bodyPosition.distanceTo(
        this.target
          .copy(this.travelPoint)
          .addScaledVector(this.bodyUp, this.config.bodyStandoff),
      ) > 0.035;
    const travelling = this.speed > 0.035
      && this.route.hasRoute
      && (!this.route.arrived || arrivalBodyLag);

    // Raised rest feet were already unsupported, so give them the first swings
    // on departure without releasing any of the grounded support set. Keeping
    // this inside the existing cinematic swing machinery preserves the cadence,
    // live target planning, and turn authorization used by ordinary locomotion.
    if (
      movingFeet === 0 &&
      this.cinematicStepClock <= 0 &&
      this.raisedRestFeet.size > 0
    ) {
      // Recovery lowers a formerly unsupported foot into the current support
      // frame. It cannot earn a route turn; the next ordinary planted pair does.
      this.cinematicStepForward.copy(this.cinematicSupportForward);
      // One at a time keeps an arbitrary sparse-web set from lowering two
      // neighbouring legs together. Ordinary travel returns to paired cadence.
      const recoveryLimit = Math.min(
        1,
        Math.max(0, Math.floor(this.config.maximumSwingingFeet)),
      );
      let recovering = 0;
      for (const legId of REST_RAISE_PRIORITY) {
        if (recovering >= recoveryLimit) break;
        if (!this.raisedRestFeet.has(legId)) continue;
        this.beginCinematicStep(legId, travelling, this.cinematicStepForward);
        this.raisedRestFeet.delete(legId);
        this.cinematicRecoveryCooldown.add(legId);
        recovering += 1;
      }
      if (recovering > 0) {
        this.cinematicStepClock = travelling ? 0.025 : 0.08;
        return;
      }
    }

    if (this.cinematicStepClock > 0) return;

    let worstLag = 0;
    for (const legId of SPIDER_LEG_IDS) {
      const state = this.cinematicFeet.get(legId)!;
      this.stanceHome(legId, this.aim);
      worstLag = Math.max(worstLag, state.position.distanceTo(this.aim));
    }

    const turnError = this.planCinematicStepForward();
    // Any residual turn keeps the gait willing to step; only a genuine corner
    // demands the careful sequential mode. Splitting these is what stops the
    // fluid gait from hitching at every few-degree polyline kink of the route.
    const turnPending = turnError > CINEMATIC_TURN_DEADBAND;
    const careful = turnError > CINEMATIC_TURN_FLOW_LIMIT;

    if (movingFeet > 0) {
      // Overlapped stepping: on confident travel the next pair may launch
      // while the current pair finishes its swing, so a reaching leg is always
      // on screen. Anything careful — a real corner, an unresolved turn frame —
      // waits for a fully landed support set instead.
      if (!travelling || careful || this.cinematicStepFramePending) return;
      if (movingFeet > CINEMATIC_MAX_OVERLAP_FEET) return;
      for (const foot of this.cinematicFeet.values()) {
        if (
          foot.moving &&
          foot.elapsed < foot.duration * CINEMATIC_OVERLAP_PROGRESS
        ) {
          return;
        }
      }
    }

    // Once the cursor has arrived, silk movement may leave an exact footfall
    // away from authored FootHome forever. Finish any outstanding turn, but
    // never interpret that static mismatch as permission to replant again.
    if (
      !(travelling
        || (!this.route.arrived && worstLag > CINEMATIC_STANCE_REPLANT_LAG)
        || turnPending)
    ) {
      return;
    }

    // Each planted pair earns at most one turn slice. Give the thorax time to
    // consume that slice before aiming another pair farther around the corner;
    // otherwise the planned coxa sector can outrun its repaired ±34.5° range.
    const bodySupportLag = this.cinematicPlanarAngle(
      this.bodyForward,
      this.cinematicSupportForward,
    );
    if (careful && bodySupportLag > CINEMATIC_MAX_BODY_SUPPORT_LAG) return;

    const group = this.selectCinematicStepGroup(turnError, travelling);
    if (!group) return;

    if (careful) {
      // Sequential land-then-authorize machinery: the turn is only handed to
      // the thorax once this pair has stepped into it.
      this.cinematicStepFramePending = true;
      this.cinematicStepExpectedLandings = group.length;
      this.cinematicStepRealLandings = 0;
    } else {
      // The flowing gait carries small heading changes continuously: each
      // launch eases the support frame toward the planned stance instead of
      // waiting for a per-pair handoff.
      this.cinematicSupportForward
        .lerp(this.cinematicStepForward, 0.5)
        .addScaledVector(
          this.cinematicPlanningUp,
          -this.cinematicSupportForward.dot(this.cinematicPlanningUp),
        )
        .normalize();
    }

    if (travelling && !careful) {
      // Rhythmic cadence: the launch-to-launch period is a fixed fraction of
      // the swing, which yields a steady walking duty factor instead of a
      // land-everything-then-burst cycle.
      let longestSwing = 0;
      for (const legId of group) {
        longestSwing = Math.max(
          longestSwing,
          this.config.swingDuration
            * CINEMATIC_SWING_DURATION_SCALE[legId[1] as "1" | "2" | "3" | "4"],
        );
      }
      this.cinematicStepClock = longestSwing * CINEMATIC_OVERLAP_CADENCE;
    } else {
      this.cinematicStepClock = travelling ? 0.03 : 0.08;
    }
    for (const legId of group) {
      this.beginCinematicStep(legId, travelling, this.cinematicStepForward);
    }
  }

  /** Captures one sign-stable support normal for every part of a landing plan. */
  private updateCinematicPlanningUp(): void {
    const supportUp = this.bodyPose.frame.up;
    this.cinematicPlanningUp.set(supportUp.x, supportUp.y, supportUp.z);
    if (this.cinematicPlanningUp.lengthSq() <= 1e-8) {
      this.cinematicPlanningUp.copy(this.bodyUp);
    } else {
      this.cinematicPlanningUp.normalize();
    }
    if (this.cinematicPlanningUp.dot(this.bodyUp) < 0) {
      this.cinematicPlanningUp.negate();
    }
  }

  /** Unsigned heading angle after both directions are made tangent to support. */
  private cinematicPlanarAngle(a: Vec3Like, b: Vec3Like): number {
    this.contactDir
      .set(a.x, a.y, a.z)
      .addScaledVector(this.cinematicPlanningUp, -(
        a.x * this.cinematicPlanningUp.x
        + a.y * this.cinematicPlanningUp.y
        + a.z * this.cinematicPlanningUp.z
      ));
    this.target
      .set(b.x, b.y, b.z)
      .addScaledVector(this.cinematicPlanningUp, -(
        b.x * this.cinematicPlanningUp.x
        + b.y * this.cinematicPlanningUp.y
        + b.z * this.cinematicPlanningUp.z
      ));
    if (this.contactDir.lengthSq() <= 1e-8 || this.target.lengthSq() <= 1e-8) {
      return 0;
    }
    this.contactDir.normalize();
    this.target.normalize();
    return Math.acos(THREE.MathUtils.clamp(this.contactDir.dot(this.target), -1, 1));
  }

  /**
   * Route distance reaches zero before the physical turn is finished. Keep the
   * public travel state active until the last feet, thorax, and body position
   * have all caught the destination, or autonomy clears the route too early.
   */
  private cinematicArrivalComplete(): boolean {
    if (!this.route.arrived || this.cinematicStepFramePending) return false;
    for (const foot of this.cinematicFeet.values()) {
      if (foot.moving) return false;
    }
    // A successfully planned no-op means the body was already at the requested
    // address. resetCinematicHeading() has also cancelled any stale route yaw.
    if (!this.route.hasRoute) return true;
    if (
      this.cinematicPlanarAngle(this.cinematicSupportForward, this.desiredForward)
        > CINEMATIC_TURN_DEADBAND
      || this.cinematicPlanarAngle(this.bodyForward, this.cinematicSupportForward)
        > CINEMATIC_TURN_DEADBAND
    ) {
      return false;
    }
    // A route whose endpoint disappeared is not an arrival. Keep ownership of
    // the intent instead of letting autonomy freeze short of broken silk.
    if (!this.route.positionAt(this.traversal, 0, this.travelPoint)) return false;
    this.target
      .copy(this.travelPoint)
      .addScaledVector(this.bodyUp, this.config.bodyStandoff);
    if (this.bodyPosition.distanceTo(this.target) > 0.035) return false;
    return true;
  }

  /** Advances the foot-placement heading by one supportable increment. */
  private planCinematicStepForward(): number {
    this.sweep
      .copy(this.cinematicSupportForward)
      .addScaledVector(
        this.cinematicPlanningUp,
        -this.cinematicSupportForward.dot(this.cinematicPlanningUp),
      );
    if (this.sweep.lengthSq() <= 1e-8) this.sweep.copy(this.bodyForward);
    this.sweep.normalize();

    this.sweepScratch
      .copy(this.desiredForward)
      .addScaledVector(
        this.cinematicPlanningUp,
        -this.desiredForward.dot(this.cinematicPlanningUp),
      );
    if (this.sweepScratch.lengthSq() <= 1e-8) this.sweepScratch.copy(this.sweep);
    this.sweepScratch.normalize();

    const cosine = THREE.MathUtils.clamp(this.sweep.dot(this.sweepScratch), -1, 1);
    this.direction.crossVectors(this.sweep, this.sweepScratch);
    const signedTurn = Math.atan2(this.direction.dot(this.cinematicPlanningUp), cosine);
    const supportedTurn = THREE.MathUtils.clamp(
      signedTurn,
      -CINEMATIC_TURN_PER_STEP,
      CINEMATIC_TURN_PER_STEP,
    );
    this.cinematicStepForward
      .copy(this.sweep)
      .applyAxisAngle(this.cinematicPlanningUp, supportedTurn)
      .normalize();
    return Math.abs(signedTurn);
  }

  /** A pair is unavailable while recovering from the rest pose or mid-swing. */
  private cinematicGroupBlocked(index: number): boolean {
    return CINEMATIC_GAIT[index].some(
      (legId) =>
        this.cinematicRecoveryCooldown.has(legId) ||
        this.cinematicFeet.get(legId)?.moving === true,
    );
  }

  /** During a turn, move the pair furthest from the planned stance first. */
  private selectCinematicStepGroup(
    turnError: number,
    travelling: boolean,
  ): readonly SpiderLegId[] | null {
    let worstNormalizedResidual = 0;
    let worstContactUrgency = 0;
    for (const legId of SPIDER_LEG_IDS) {
      const result = this.ik.getResult(legId);
      if (result && Number.isFinite(result.residual)) {
        worstNormalizedResidual = Math.max(
          worstNormalizedResidual,
          result.residual / Math.max(1e-3, this.rig.legs[legId].reach.max),
        );
      }
      worstContactUrgency = Math.max(
        worstContactUrgency,
        this.cinematicContactUrgency(legId),
      );
    }

    // Preserve the clean authored alternating gait through ordinary travel,
    // including the small heading drift the flowing mode absorbs. Once a
    // joint-limited leg is visibly missing its target, however, waiting for a
    // full four-pair cycle is exactly what winds it behind the thorax.
    const urgentAnatomy = worstNormalizedResidual > CINEMATIC_IK_URGENCY_THRESHOLD
      || worstContactUrgency >= 1.15;
    if (turnError <= CINEMATIC_TURN_FLOW_LIMIT && !urgentAnatomy) {
      const start = this.cinematicGaitIndex % CINEMATIC_GAIT.length;
      let index = -1;
      for (let offset = 0; offset < CINEMATIC_GAIT.length; offset += 1) {
        const candidate = (start + offset) % CINEMATIC_GAIT.length;
        if (!this.cinematicGroupBlocked(candidate)) {
          index = candidate;
          break;
        }
      }
      // Every pair is either mid-swing or cooling down; launch nothing rather
      // than double-book a foot that is already in the air.
      if (index < 0) return null;
      const group = CINEMATIC_GAIT[index];
      this.cinematicGaitIndex = index + 1;
      this.cinematicLastGroupIndex = index;
      this.cinematicRecoveryCooldown.clear();
      return group;
    }

    const start = this.cinematicGaitIndex % CINEMATIC_GAIT.length;
    let bestIndex = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let offset = 0; offset < CINEMATIC_GAIT.length; offset += 1) {
      const index = (start + offset) % CINEMATIC_GAIT.length;
      // The last pair may ask again after one other pair has carried the body,
      // but never in two consecutive lifts. This supplies a real support swap
      // without forcing an unhappy leg to wait through all eight feet.
      if (index === this.cinematicLastGroupIndex && CINEMATIC_GAIT.length > 1) continue;
      if (this.cinematicGroupBlocked(index)) continue;
      let score = 0;
      for (const legId of CINEMATIC_GAIT[index]) {
        this.planCinematicLanding(
          legId,
          travelling,
          this.cinematicStepForward,
          this.cinematicPlanningUp,
          this.aim,
        );
        score += this.cinematicFeet.get(legId)!.position.distanceTo(this.aim)
          / Math.max(1e-3, this.rig.legs[legId].reach.max);
        score += CINEMATIC_IK_URGENCY_WEIGHT * this.cinematicContactUrgency(legId);

        const result = this.ik.getResult(legId);
        if (result && Number.isFinite(result.residual)) {
          score += CINEMATIC_IK_URGENCY_WEIGHT
            * result.residual
            / Math.max(1e-3, this.rig.legs[legId].reach.max);
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }

    // Every candidate pair is blocked; wait a frame rather than force one.
    if (bestIndex < 0) return null;
    this.cinematicLastGroupIndex = bestIndex;
    this.cinematicGaitIndex = bestIndex + 1;
    this.cinematicRecoveryCooldown.clear();
    return CINEMATIC_GAIT[bestIndex];
  }

  /**
   * Contact strain must remain visible to gait ranking even when presentation IK
   * has clamped its target and therefore reports a deceptively small residual.
   *
   * A planted contact gone invalid (broken or vanished silk) is an emergency.
   * A foot that simply has no address is not: it is already held in a plausible
   * pose, and treating it as urgent let one silk-poor leg monopolize the gait —
   * the same unlucky pairs stepped over and over while every planted leg
   * strained in place and vetoed the body. Mild pressure keeps it re-searching
   * through the ordinary rotation without hijacking it.
   */
  private cinematicContactUrgency(legId: SpiderLegId): number {
    const contact = this.contacts.get(legId)!;
    if (!contact.isPlanted) {
      return 0.35;
    }
    if (!contact.contactValid || !contact.hasResolvedWorldPosition) {
      return 1.5;
    }
    const limit = this.rig.legs[legId].reach.max * CINEMATIC_BODY_REACH_LIMIT;
    const safe = limit * 0.84;
    return Math.max(0, (contact.currentReachDistance - safe) / Math.max(1e-3, limit - safe));
  }

  /** Solves visual legs without ever rewriting their planted world anchors. */
  private solveCinematicFeet(): void {
    for (const legId of SPIDER_LEG_IDS) {
      const state = this.cinematicFeet.get(legId)!;
      // The clamp belongs only to this frame's IK request. Mutating the
      // persistent position here drags a planted foot around the moving coxa's
      // reach sphere — the literal spiral this state is meant to prevent.
      const leg = this.rig.legs[legId];
      leg.chain[0].getWorldPosition(this.coxa);
      this.scratch.copy(state.position).sub(this.coxa);
      const targetDistance = this.scratch.length();
      const maximumReach = this.maximumVisualReach(legId);
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

  /** Builds the exact target used by both turn ranking and the eventual swing. */
  private planCinematicLanding(
    legId: SpiderLegId,
    travelling: boolean,
    landingForward: THREE.Vector3,
    landingUp: THREE.Vector3,
    target: THREE.Vector3,
  ): StrandAddress | null {
    const leg = this.rig.legs[legId];
    this.stanceHome(legId, target, landingForward, landingUp);

    const index = Number(legId[1]);
    if (travelling) {
      // The posterior pairs need a full prograde stroke so they can extend and
      // push after planting. The old descending lead gave pair IV the shortest
      // step and left it trailing for most of each gait cycle.
      const posteriorLead = Math.max(0, index - 2) * 0.0125;
      // Pair I reaches beyond everyone: the exploring stride that probes the
      // silk ahead and then pulls the body onto it.
      const exploreLead = index === 1 ? FRONT_EXPLORE_LEAD : 0;
      target.addScaledVector(
        landingForward,
        this.config.stepLead + posteriorLead + exploreLead,
      );
    }
    target.addScaledVector(
      this.outwardForFrame(legId, landingForward, landingUp),
      legId[1] === "1" ? FRONT_OUTWARD_STEP : DEFAULT_OUTWARD_STEP,
    );

    // Search several nearby strands and accept only a genuinely reachable,
    // uncrowded point. The visible destination and semantic address are now the
    // same point; a miss remains honestly unsupported instead of pretending a
    // loosely attracted authored target is attached to silk.
    leg.chain[0].getWorldPosition(this.coxa);
    const maximum = this.maximumVisualReach(legId, 0.93);
    this.stanceHome(legId, this.sweep, landingForward, landingUp);
    this.sweep.sub(this.coxa).normalize();
    this.direction.copy(this.outwardForFrame(legId, landingForward, landingUp));
    const foothold = this.footholds.find({
      aim: target,
      reachOrigin: this.coxa,
      reach: {
        min: leg.reach.min,
        comfortable: Math.min(leg.reach.comfortable, maximum),
        // FootholdSearch keeps a 0.92 safety margin internally.
        max: maximum / 0.92,
      },
      searchRadius: this.config.footholdSearchRadius,
      occupied: this.claimedCinematicAddresses(legId),
      restDirection: this.sweep,
      sweepCos: Math.cos(THREE.MathUtils.degToRad(this.config.legSweepDegrees)),
      bodyCentre: this.bodyPosition,
      outward: this.direction,
      midlineTolerance: this.config.midlineTolerance * leg.reach.max,
    });
    if (foothold) {
      target.copy(foothold.position);
      return foothold.address;
    }

    // Keep an unsupported authored target comfortably solvable. IK shapes the
    // leg; it never gets a vote on whether the body may continue along the route.
    this.scratch.copy(target).sub(this.coxa);
    if (this.scratch.length() > maximum) {
      target.copy(this.coxa).add(this.scratch.setLength(maximum));
    }
    return null;
  }

  private beginCinematicStep(
    legId: SpiderLegId,
    travelling: boolean,
    landingForward: THREE.Vector3,
  ): void {
    this.plantedRestDepartureFeet.delete(legId);
    const state = this.cinematicFeet.get(legId)!;
    state.start.copy(state.position);
    state.address = this.planCinematicLanding(
      legId,
      travelling,
      landingForward,
      this.cinematicPlanningUp,
      state.destination,
    );
    state.up.copy(this.cinematicPlanningUp);

    // The legs' recent search record is the body's throttle. Only travelling
    // searches count: rest recoveries lowering a parked foot say nothing about
    // whether the silk ahead can be walked.
    if (travelling) {
      this.footholdSearchEma = THREE.MathUtils.lerp(
        this.footholdSearchEma,
        state.address ? 1 : 0,
        CINEMATIC_SEARCH_EMA_ALPHA,
      );
    }

    const contact = this.contacts.get(legId)!;
    if (contact.isPlanted) {
      contact.beginRelease();
      contact.release();
      this.loads.releaseFootLoad(legId);
    }
    state.elapsed = 0;
    state.duration = this.config.swingDuration
      * CINEMATIC_SWING_DURATION_SCALE[legId[1] as "1" | "2" | "3" | "4"];
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
    // The contact-driven gait consumes desiredForward for leash and step lead.
    // Preserve its historical meaning as the normalized surface-tangent travel
    // direction; cinematic locomotion keeps the raw route direction separately.
    this.desiredForward.copy(this.frameForward);

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
  private alignBodyFrame(
    supportUp: Vec3Like,
    dt: number,
    targetForward: Vec3Like = this.desiredForward,
  ): void {
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

    // A widow travels her web dorsal-side down, or occasionally standing on
    // top — never rolled sideways along a strand. Contact normals are seeded
    // from the body's own up axis, so nothing external ever re-anchors roll to
    // gravity: a sideways roll acquired while traversing would be permanent.
    // Bias the desired dorsal toward world-vertical — hanging by default,
    // upright only while she is already clearly on top — and fade the bias out
    // on steep travel so a vertical climb keeps its pitch: only the roll
    // freedom perpendicular to the path is negotiated away.
    const dorsalPreference = this.config.dorsalPreference;
    if (dorsalPreference > 0) {
      this.scratch.set(targetForward.x, targetForward.y, targetForward.z);
      const forwardLengthSq = this.scratch.lengthSq();
      const steepness = forwardLengthSq > 1e-8
        ? Math.abs(this.scratch.y) / Math.sqrt(forwardLengthSq)
        : 0;
      const bias = dorsalPreference * (1 - steepness * steepness);
      if (bias > 1e-3) {
        const hemisphere = this.bodyUp.y > 0.35 ? 1 : -1;
        this.desiredUp.lerp(this.scratch.set(0, hemisphere, 0), bias);
        if (this.desiredUp.lengthSq() <= 1e-8) {
          this.desiredUp.copy(this.bodyUp);
        } else {
          this.desiredUp.normalize();
        }
      }
    }

    // Anterior follows travel, but travel must be tangent to the support plane.
    this.frameForward.set(targetForward.x, targetForward.y, targetForward.z);
    this.frameForward.addScaledVector(
      this.desiredUp,
      -this.frameForward.dot(this.desiredUp),
    );
    if (this.frameForward.lengthSq() <= 1e-8) {
      this.frameForward
        .copy(this.bodyForward)
        .addScaledVector(this.desiredUp, -this.bodyForward.dot(this.desiredUp));
    }
    if (this.frameForward.lengthSq() <= 1e-8) {
      const frameForward = this.bodyPose.frame.forward;
      this.frameForward
        .set(frameForward.x, frameForward.y, frameForward.z)
        .addScaledVector(this.desiredUp, -this.frameForward.dot(this.desiredUp));
    }
    if (this.frameForward.lengthSq() <= 1e-8) {
      // This should only be reachable for corrupt/degenerate support data. Keep
      // the last valid complete orientation instead of snapping to a world axis.
      return;
    }
    this.frameForward.normalize();
    this.desiredRight.crossVectors(this.frameForward, this.desiredUp).normalize();
    this.desiredUp.crossVectors(this.desiredRight, this.frameForward).normalize();

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
      this.scratch.copy(this.frameForward).negate(),
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
  private limitByReach(delta: THREE.Vector3, reachRatio = REACH_LIMIT): void {
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
      const limit = this.rig.legs[legId].reach.max * reachRatio;
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
      this.stanceHome(legId, this.aim);
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
      this.stanceHome(legId, this.aim);
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
    this.stanceHome(legId, this.aim);
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
      this.stanceHome(legId, this.aim);

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
    const maximumReach = this.maximumVisualReach(legId);
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
    return this.outwardForFrame(legId, this.bodyForward, this.bodyUp);
  }

  /** Unit outward vector for an explicit planned landing frame. */
  private outwardForFrame(
    legId: SpiderLegId,
    forward: THREE.Vector3,
    up: THREE.Vector3,
  ): THREE.Vector3 {
    this.bodyRight.crossVectors(forward, up).normalize();
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
    this.stanceHome(legId, this.sweep);
    leg.chain[0].getWorldPosition(this.sweepScratch);
    this.sweep.sub(this.sweepScratch);
    if (this.sweep.lengthSq() < 1e-8) {
      this.sweep.copy(this.bodyForward);
    }
    return this.sweep.normalize();
  }

  /** Returns the procedural home target in a prograde black-widow sector. */
  private stanceHome(
    legId: SpiderLegId,
    target: THREE.Vector3,
    forward: THREE.Vector3 = this.bodyForward,
    up: THREE.Vector3 = this.bodyUp,
  ): THREE.Vector3 {
    const leg = this.rig.legs[legId];
    leg.footHome.getWorldPosition(target);
    leg.chain[0].getWorldPosition(this.coxa);
    this.scratch.copy(target).sub(this.coxa);

    // Keep the authored height and radial distance, but rotate the plan-view
    // component into the leg's anatomical fore/aft sector. This changes stance,
    // not anatomy: IK still follows the repaired rest arch and exact lengths.
    const vertical = this.scratch.dot(up);
    const planarLength = Math.sqrt(Math.max(0, this.scratch.lengthSq() - vertical * vertical));
    const sector = THREE.MathUtils.degToRad(LEG_SECTOR_DEGREES[legId[1] as "1" | "2" | "3" | "4"]);
    this.contactDir
      .copy(forward)
      .addScaledVector(up, -forward.dot(up))
      .normalize()
      .multiplyScalar(Math.cos(sector))
      .addScaledVector(this.outwardForFrame(legId, forward, up), Math.sin(sector))
      .normalize();
    target
      .copy(this.coxa)
      .addScaledVector(this.contactDir, planarLength)
      .addScaledVector(up, vertical);

    if (legId[1] !== "1") return target;
    this.scratch.copy(target).sub(this.coxa);
    const desiredReach = leg.reach.max * FRONT_STANCE_REACH;
    if (this.scratch.lengthSq() > 1e-8) {
      target.copy(this.coxa).add(this.scratch.setLength(desiredReach));
    }
    return target;
  }

  /** Front legs keep visible knee clearance instead of using near-full extension. */
  private maximumVisualReach(legId: SpiderLegId, defaultRatio = REACH_LIMIT): number {
    return this.rig.legs[legId].reach.max
      * (legId[1] === "1" ? Math.min(defaultRatio, FRONT_WORKING_REACH) : defaultRatio);
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

  /** Cinematic swings reserve their newly planned addresses immediately. */
  private claimedCinematicAddresses(exclude?: SpiderLegId): StrandAddress[] {
    this.occupied.length = 0;
    for (const legId of SPIDER_LEG_IDS) {
      if (legId === exclude) continue;
      const address = this.cinematicFeet.get(legId)?.address;
      if (address) this.occupied.push(address);
    }
    return this.occupied;
  }
}
