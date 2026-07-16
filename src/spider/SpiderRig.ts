import {
  Bone,
  Group,
  Object3D,
  SkinnedMesh,
  Vector3,
} from "three";
import {
  SPIDER_LEG_IDS,
  getRequiredSpiderBoneNames,
  type SpiderAxisToken,
  type SpiderJointLimitSpec,
  type SpiderLegId,
  type SpiderLegSegmentName,
  type SpiderLegSide,
  type SpiderReachSpec,
  type SpiderRigSpec,
} from "./SpiderRigSpec";

export interface SpiderRigAxes {
  readonly forwardToken: SpiderAxisToken;
  readonly upToken: SpiderAxisToken;
  readonly rightToken: SpiderAxisToken;
  readonly leftToken: SpiderAxisToken;
  readonly forward: Vector3;
  readonly up: Vector3;
  readonly right: Vector3;
  readonly left: Vector3;
  readonly bonePrimaryToken: SpiderAxisToken;
  readonly boneDorsalToken: SpiderAxisToken;
  readonly boneBendToken: SpiderAxisToken;
  readonly bonePrimary: Vector3;
  readonly boneDorsal: Vector3;
  readonly boneBend: Vector3;
}

export interface SpiderRigReferences {
  readonly head: Bone;
  readonly support: Bone;
  readonly bodyCenter: Bone;
  readonly forward: Bone;
  readonly dorsal: Bone;
}

export interface SpiderRigSpinnerets {
  readonly center: Bone;
  readonly left: Bone;
  readonly right: Bone;
}

export interface SpiderLegChain {
  readonly id: SpiderLegId;
  readonly side: SpiderLegSide;
  readonly anatomicalIndex: number;
  /** Ordered Coxa -> ... -> FootTip exactly as authored by the rig spec. */
  readonly chain: readonly Bone[];
  /** The rotatable/deforming portion of chain; FootTip is excluded. */
  readonly joints: readonly Bone[];
  readonly segmentNames: readonly SpiderLegSegmentName[];
  readonly footTip: Bone;
  readonly footHome: Bone;
  readonly reach: SpiderReachSpec;
  readonly segmentLengths: Readonly<Partial<Record<SpiderLegSegmentName, number>>>;
  readonly jointLimits: readonly SpiderJointLimitSpec[];
}

export interface DuplicateRigName {
  readonly name: string;
  readonly count: number;
}

export interface RigHierarchyMismatch {
  readonly childName: string;
  readonly expectedParentName: string;
  readonly actualParentName: string | null;
}

export interface SpiderRigResolutionReport {
  readonly valid: boolean;
  readonly traversedObjectCount: number;
  readonly discoveredBoneCount: number;
  readonly requiredBoneCount: number;
  readonly resolvedRequiredBoneCount: number;
  readonly missingRequiredBones: readonly string[];
  readonly duplicateRequiredBones: readonly DuplicateRigName[];
  readonly nonBoneRequiredObjects: readonly string[];
  readonly duplicateNamedObjects: readonly DuplicateRigName[];
  readonly hierarchyMismatches: readonly RigHierarchyMismatch[];
  readonly meshObjectName: string;
  readonly meshObjectCount: number;
  readonly meshIsSkinnedMesh: boolean;
}

export interface ResolveSpiderRigOptions {
  /**
   * Optional caller-owned placement pivot. The loaded GLB scene is parented
   * beneath it without changing any authored Armature or SpiderRoot transform.
   */
  readonly placementRoot?: Group;
  readonly placementRootName?: string;
}

export class SpiderRigResolutionError extends Error {
  readonly report: SpiderRigResolutionReport;

  constructor(report: SpiderRigResolutionReport) {
    super(formatSpiderRigResolutionReport(report));
    this.name = "SpiderRigResolutionError";
    this.report = report;
  }
}

interface HierarchyIndex {
  readonly objectsByName: ReadonlyMap<string, readonly Object3D[]>;
  readonly objectCount: number;
  readonly boneCount: number;
}

interface ParentExpectation {
  readonly childName: string;
  readonly expectedParentName: string;
}

function axisTokenToVector(token: SpiderAxisToken): Vector3 {
  switch (token) {
    case "+X":
      return new Vector3(1, 0, 0);
    case "-X":
      return new Vector3(-1, 0, 0);
    case "+Y":
      return new Vector3(0, 1, 0);
    case "-Y":
      return new Vector3(0, -1, 0);
    case "+Z":
      return new Vector3(0, 0, 1);
    case "-Z":
      return new Vector3(0, 0, -1);
  }
}

function documentedLocalAxis(description: string, fieldName: string): SpiderAxisToken {
  const match = description.match(/\blocal\s+([+-]?)([XYZ])\b/i);
  if (!match) {
    throw new Error(`Rig spec ${fieldName} does not contain a machine-readable local axis.`);
  }
  const sign = match[1] === "-" ? "-" : "+";
  return `${sign}${match[2].toUpperCase()}` as SpiderAxisToken;
}

function buildAxes(spec: SpiderRigSpec): SpiderRigAxes {
  const coordinates = spec.coordinate_conventions;
  const world = coordinates.gltf_threejs_space;
  const local = coordinates.bone_local_axes;
  const bonePrimaryToken = documentedLocalAxis(local.primary_axis, "bone_local_axes.primary_axis");
  const boneDorsalToken = documentedLocalAxis(local.dorsal_axis, "bone_local_axes.dorsal_axis");
  const boneBendToken = documentedLocalAxis(local.bend_axis, "bone_local_axes.bend_axis");
  return {
    forwardToken: world.forward,
    upToken: world.up_dorsal,
    rightToken: world.right,
    leftToken: world.left,
    forward: axisTokenToVector(world.forward),
    up: axisTokenToVector(world.up_dorsal),
    right: axisTokenToVector(world.right),
    left: axisTokenToVector(world.left),
    bonePrimaryToken,
    boneDorsalToken,
    boneBendToken,
    bonePrimary: axisTokenToVector(bonePrimaryToken),
    boneDorsal: axisTokenToVector(boneDorsalToken),
    boneBend: axisTokenToVector(boneBendToken),
  };
}

function indexHierarchyOnce(assetRoot: Object3D): HierarchyIndex {
  const mutableIndex = new Map<string, Object3D[]>();
  let objectCount = 0;
  let boneCount = 0;
  assetRoot.traverse((object) => {
    objectCount += 1;
    if (object instanceof Bone) {
      boneCount += 1;
    }
    if (!object.name) {
      return;
    }
    const existing = mutableIndex.get(object.name);
    if (existing) {
      existing.push(object);
    } else {
      mutableIndex.set(object.name, [object]);
    }
  });
  return { objectsByName: mutableIndex, objectCount, boneCount };
}

function buildParentExpectations(spec: SpiderRigSpec): ParentExpectation[] {
  const expectations: ParentExpectation[] = [
    { childName: spec.thorax_bone, expectedParentName: spec.root_bone },
    { childName: spec.pedicel_bone, expectedParentName: spec.root_bone },
    { childName: spec.abdomen_bone, expectedParentName: spec.pedicel_bone },
    { childName: spec.head_bone, expectedParentName: spec.thorax_bone },
  ];

  for (const referenceName of Object.keys(spec.reference_bones)) {
    expectations.push({ childName: referenceName, expectedParentName: spec.thorax_bone });
  }
  for (const footHome of spec.foot_homes) {
    expectations.push({ childName: footHome, expectedParentName: spec.thorax_bone });
  }
  for (const spinneretName of ["Spinneret_Center", "Spinneret_L", "Spinneret_R"] as const) {
    expectations.push({ childName: spinneretName, expectedParentName: spec.abdomen_bone });
  }

  for (const legId of SPIDER_LEG_IDS) {
    const chain = spec.legs.per_leg[legId].chain;
    if (chain.length > 0) {
      expectations.push({ childName: chain[0], expectedParentName: spec.thorax_bone });
    }
    appendChainExpectations(expectations, chain);
  }

  for (const chain of [
    [...spec.pedipalps.left, spec.pedipalps.left_tip],
    [...spec.pedipalps.right, spec.pedipalps.right_tip],
  ]) {
    if (chain.length > 0) {
      expectations.push({ childName: chain[0], expectedParentName: spec.thorax_bone });
    }
    appendChainExpectations(expectations, chain);
  }
  for (const chain of [spec.fangs.left, spec.fangs.right]) {
    if (chain.length > 0) {
      expectations.push({ childName: chain[0], expectedParentName: spec.head_bone });
    }
    appendChainExpectations(expectations, chain);
  }
  return expectations;
}

function appendChainExpectations(
  expectations: ParentExpectation[],
  chain: readonly string[],
): void {
  for (let index = 1; index < chain.length; index += 1) {
    expectations.push({ childName: chain[index], expectedParentName: chain[index - 1] });
  }
}

function createResolution(
  assetRoot: Object3D,
  spec: SpiderRigSpec,
): {
  readonly report: SpiderRigResolutionReport;
  readonly bones: ReadonlyMap<string, Bone>;
  readonly mesh: SkinnedMesh | null;
} {
  const index = indexHierarchyOnce(assetRoot);
  const requiredBoneNames = getRequiredSpiderBoneNames(spec);
  const missingRequiredBones: string[] = [];
  const duplicateRequiredBones: DuplicateRigName[] = [];
  const nonBoneRequiredObjects: string[] = [];
  const resolvedBones = new Map<string, Bone>();

  for (const name of requiredBoneNames) {
    const matches = index.objectsByName.get(name) ?? [];
    if (matches.length === 0) {
      missingRequiredBones.push(name);
    } else if (matches.length > 1) {
      duplicateRequiredBones.push({ name, count: matches.length });
    } else if (!(matches[0] instanceof Bone)) {
      nonBoneRequiredObjects.push(name);
    } else {
      resolvedBones.set(name, matches[0]);
    }
  }

  const duplicateNamedObjects: DuplicateRigName[] = [];
  for (const [name, objects] of index.objectsByName) {
    if (objects.length > 1) {
      duplicateNamedObjects.push({ name, count: objects.length });
    }
  }
  duplicateNamedObjects.sort((a, b) => a.name.localeCompare(b.name));

  const hierarchyMismatches: RigHierarchyMismatch[] = [];
  for (const expectation of buildParentExpectations(spec)) {
    const child = resolvedBones.get(expectation.childName);
    const expectedParent = resolvedBones.get(expectation.expectedParentName);
    if (child && expectedParent && child.parent !== expectedParent) {
      hierarchyMismatches.push({
        childName: child.name,
        expectedParentName: expectedParent.name,
        actualParentName: child.parent?.name || null,
      });
    }
  }

  const meshMatches = index.objectsByName.get(spec.mesh_object) ?? [];
  const mesh = meshMatches.length === 1 && meshMatches[0] instanceof SkinnedMesh
    ? meshMatches[0]
    : null;
  const report: SpiderRigResolutionReport = {
    valid:
      missingRequiredBones.length === 0 &&
      duplicateRequiredBones.length === 0 &&
      nonBoneRequiredObjects.length === 0 &&
      hierarchyMismatches.length === 0 &&
      mesh !== null,
    traversedObjectCount: index.objectCount,
    discoveredBoneCount: index.boneCount,
    requiredBoneCount: requiredBoneNames.length,
    resolvedRequiredBoneCount: resolvedBones.size,
    missingRequiredBones,
    duplicateRequiredBones,
    nonBoneRequiredObjects,
    duplicateNamedObjects,
    hierarchyMismatches,
    meshObjectName: spec.mesh_object,
    meshObjectCount: meshMatches.length,
    meshIsSkinnedMesh: mesh !== null,
  };
  return { report, bones: resolvedBones, mesh };
}

function requireResolvedBone(bones: ReadonlyMap<string, Bone>, name: string): Bone {
  const bone = bones.get(name);
  if (!bone) {
    throw new Error(`Internal rig resolution error: ${name} was not retained.`);
  }
  return bone;
}

function buildLegs(
  spec: SpiderRigSpec,
  bones: ReadonlyMap<string, Bone>,
): Readonly<Record<SpiderLegId, SpiderLegChain>> {
  const entries = SPIDER_LEG_IDS.map((id): readonly [SpiderLegId, SpiderLegChain] => {
    const legSpec = spec.legs.per_leg[id];
    const chain = legSpec.chain.map((name) => requireResolvedBone(bones, name));
    const semanticOrder = legSpec.deform_segments === 6
      ? spec.legs.chain_order_6seg
      : spec.legs.chain_order_5seg;
    const segmentNames = semanticOrder.slice(0, -1) as SpiderLegSegmentName[];
    const jointLimits = segmentNames.map(
      (segmentName) => spec.recommended_joint_limits_deg[segmentName],
    );
    const leg: SpiderLegChain = {
      id,
      side: legSpec.side,
      anatomicalIndex: legSpec.index,
      chain,
      joints: chain.slice(0, -1),
      segmentNames,
      footTip: requireResolvedBone(bones, legSpec.foottip),
      footHome: requireResolvedBone(bones, legSpec.foothome),
      reach: spec.reach_units.per_leg[id],
      segmentLengths: spec.segment_lengths_model_units[id],
      jointLimits,
    };
    return [id, leg];
  });
  return Object.fromEntries(entries) as Record<SpiderLegId, SpiderLegChain>;
}

export class SpiderRig {
  /** Add this outer pivot to the Three.js scene and transform it for body placement. */
  readonly rootObject: Group;
  /** The unmodified scene returned by GLTFLoader, including its Armature transform. */
  readonly assetRoot: Object3D;
  /** The named SpiderRoot joint. This is distinct from rootObject and assetRoot. */
  readonly spiderRoot: Bone;
  readonly thorax: Bone;
  readonly pedicel: Bone;
  readonly abdomen: Bone;
  readonly head: Bone;
  readonly mesh: SkinnedMesh;
  readonly references: SpiderRigReferences;
  readonly spinnerets: SpiderRigSpinnerets;
  readonly legs: Readonly<Record<SpiderLegId, SpiderLegChain>>;
  readonly footTips: Readonly<Record<SpiderLegId, Bone>>;
  readonly footHomes: Readonly<Record<SpiderLegId, Bone>>;
  readonly axes: SpiderRigAxes;
  readonly aggregateReach: {
    readonly minimum: number;
    readonly comfortable: number;
    readonly maximum: number;
  };
  readonly spec: SpiderRigSpec;
  readonly validationReport: SpiderRigResolutionReport;

  private constructor(
    rootObject: Group,
    assetRoot: Object3D,
    spec: SpiderRigSpec,
    report: SpiderRigResolutionReport,
    bones: ReadonlyMap<string, Bone>,
    mesh: SkinnedMesh,
  ) {
    this.rootObject = rootObject;
    this.assetRoot = assetRoot;
    this.spec = spec;
    this.validationReport = report;
    this.spiderRoot = requireResolvedBone(bones, spec.root_bone);
    this.thorax = requireResolvedBone(bones, spec.thorax_bone);
    this.pedicel = requireResolvedBone(bones, spec.pedicel_bone);
    this.abdomen = requireResolvedBone(bones, spec.abdomen_bone);
    this.head = requireResolvedBone(bones, spec.head_bone);
    this.mesh = mesh;
    this.references = {
      head: requireResolvedBone(bones, "HeadReference"),
      support: requireResolvedBone(bones, "SupportReference"),
      bodyCenter: requireResolvedBone(bones, "BodyCenter"),
      forward: requireResolvedBone(bones, "ForwardReference"),
      dorsal: requireResolvedBone(bones, "DorsalReference"),
    };
    this.spinnerets = {
      center: requireResolvedBone(bones, "Spinneret_Center"),
      left: requireResolvedBone(bones, "Spinneret_L"),
      right: requireResolvedBone(bones, "Spinneret_R"),
    };
    this.legs = buildLegs(spec, bones);
    this.footTips = Object.fromEntries(
      SPIDER_LEG_IDS.map((id) => [id, this.legs[id].footTip]),
    ) as Record<SpiderLegId, Bone>;
    this.footHomes = Object.fromEntries(
      SPIDER_LEG_IDS.map((id) => [id, this.legs[id].footHome]),
    ) as Record<SpiderLegId, Bone>;
    this.axes = buildAxes(spec);
    this.aggregateReach = {
      minimum: spec.reach_units.aggregate.min_compressed_reach,
      comfortable: spec.reach_units.aggregate.comfortable_reach,
      maximum: spec.reach_units.aggregate.max_reach,
    };
  }

  static resolve(
    assetRoot: Object3D,
    spec: SpiderRigSpec,
    options: ResolveSpiderRigOptions = {},
  ): SpiderRig {
    const resolution = createResolution(assetRoot, spec);
    if (!resolution.report.valid || !resolution.mesh) {
      throw new SpiderRigResolutionError(resolution.report);
    }

    if (assetRoot.parent) {
      throw new Error(
        `Cannot create SpiderRig placement pivot because asset root ${assetRoot.name || "<unnamed>"} is already parented. Resolve the rig before adding the GLB scene to another object.`,
      );
    }
    const rootObject = options.placementRoot ?? new Group();
    if (rootObject.children.length > 0) {
      throw new Error("SpiderRig placementRoot must be empty before resolution.");
    }
    rootObject.name = options.placementRootName ?? (rootObject.name || "SpiderRigPlacement");
    rootObject.add(assetRoot);

    return new SpiderRig(
      rootObject,
      assetRoot,
      spec,
      resolution.report,
      resolution.bones,
      resolution.mesh,
    );
  }
}

export function formatSpiderRigResolutionReport(report: SpiderRigResolutionReport): string {
  const lines = [
    report.valid ? "Spider rig validation passed." : "Spider rig validation failed.",
    `Resolved ${report.resolvedRequiredBoneCount}/${report.requiredBoneCount} required bones from ${report.traversedObjectCount} objects (${report.discoveredBoneCount} bones).`,
  ];
  if (report.missingRequiredBones.length > 0) {
    lines.push(`Missing required bones: ${report.missingRequiredBones.join(", ")}.`);
  }
  if (report.duplicateRequiredBones.length > 0) {
    lines.push(
      `Duplicate required bones: ${report.duplicateRequiredBones.map(({ name, count }) => `${name} x${count}`).join(", ")}.`,
    );
  }
  if (report.nonBoneRequiredObjects.length > 0) {
    lines.push(`Required names that are not bones: ${report.nonBoneRequiredObjects.join(", ")}.`);
  }
  if (report.hierarchyMismatches.length > 0) {
    lines.push(
      `Hierarchy mismatches: ${report.hierarchyMismatches.map((entry) => `${entry.childName} expected under ${entry.expectedParentName}, found under ${entry.actualParentName ?? "<none>"}`).join("; ")}.`,
    );
  }
  if (report.meshObjectCount !== 1 || !report.meshIsSkinnedMesh) {
    lines.push(
      `Mesh ${report.meshObjectName}: found ${report.meshObjectCount}, unique SkinnedMesh=${report.meshIsSkinnedMesh}.`,
    );
  }
  if (report.duplicateNamedObjects.length > 0) {
    lines.push(
      `All duplicate named objects: ${report.duplicateNamedObjects.map(({ name, count }) => `${name} x${count}`).join(", ")}.`,
    );
  }
  return lines.join("\n");
}
