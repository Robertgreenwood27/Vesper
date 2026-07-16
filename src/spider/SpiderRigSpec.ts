export const SPIDER_LEG_IDS = [
  "L1",
  "L2",
  "L3",
  "L4",
  "R1",
  "R2",
  "R3",
  "R4",
] as const;

export type SpiderLegId = (typeof SPIDER_LEG_IDS)[number];
export type SpiderLegSide = "left" | "right";
export type SpiderAxisToken = "+X" | "-X" | "+Y" | "-Y" | "+Z" | "-Z";
export type SpiderLegSegmentName =
  | "Coxa"
  | "Femur"
  | "Patella"
  | "Tibia"
  | "Metatarsus"
  | "Tarsus";

export interface SpiderRigLegSpec {
  readonly side: SpiderLegSide;
  readonly index: number;
  readonly chain: readonly string[];
  readonly foottip: string;
  readonly foothome: string;
  readonly deform_segments: number;
}

export interface SpiderReachSpec {
  readonly max: number;
  readonly comfortable: number;
  readonly min: number;
}

export interface SpiderJointLimitSpec {
  readonly bend_x: readonly [number, number];
  readonly swing_z: readonly [number, number];
  readonly twist_y: readonly [number, number];
}

export interface SpiderRigSpec {
  readonly schema_version: "1.0";
  readonly generated_for: string;
  readonly source_model: string;
  readonly export_file: string;
  readonly blender_version: string;
  readonly units: {
    readonly system: string;
    readonly unit_scale: number;
    readonly note: string;
    readonly object_scale: readonly [number, number, number];
    readonly object_rotation_applied: boolean;
    readonly object_location_applied: boolean;
  };
  readonly coordinate_conventions: {
    readonly description: string;
    readonly blender_space: {
      readonly forward: SpiderAxisToken;
      readonly up_dorsal: SpiderAxisToken;
      readonly right: SpiderAxisToken;
      readonly left: SpiderAxisToken;
    };
    readonly gltf_threejs_space: {
      readonly forward: SpiderAxisToken;
      readonly up_dorsal: SpiderAxisToken;
      readonly right: SpiderAxisToken;
      readonly left: SpiderAxisToken;
      readonly note: string;
    };
    readonly bone_local_axes: {
      readonly primary_axis: string;
      readonly dorsal_axis: string;
      readonly bend_axis: string;
      readonly mirror: string;
    };
  };
  readonly root_bone: string;
  readonly thorax_bone: string;
  readonly pedicel_bone: string;
  readonly abdomen_bone: string;
  readonly head_bone: string;
  readonly reference_bones: {
    readonly HeadReference: string;
    readonly SupportReference: string;
    readonly BodyCenter: string;
    readonly ForwardReference: string;
    readonly DorsalReference: string;
  };
  readonly spinnerets: {
    readonly Spinneret_Center: string;
    readonly Spinneret_L: string;
    readonly Spinneret_R: string;
    readonly note: string;
  };
  readonly legs: {
    readonly numbering: string;
    readonly order_front_to_rear: readonly string[];
    readonly list: readonly SpiderLegId[];
    readonly chain_order_5seg: readonly string[];
    readonly chain_order_6seg: readonly string[];
    readonly per_leg: Readonly<Record<SpiderLegId, SpiderRigLegSpec>>;
  };
  readonly foot_tips: readonly string[];
  readonly foot_homes: readonly string[];
  readonly pedipalps: {
    readonly left: readonly string[];
    readonly left_tip: string;
    readonly right: readonly string[];
    readonly right_tip: string;
  };
  readonly fangs: {
    readonly left: readonly string[];
    readonly right: readonly string[];
    readonly note: string;
  };
  readonly reach_units: {
    readonly note: string;
    readonly per_leg: Readonly<Record<SpiderLegId, SpiderReachSpec>>;
    readonly aggregate: {
      readonly max_reach: number;
      readonly comfortable_reach: number;
      readonly min_compressed_reach: number;
    };
  };
  readonly segment_lengths_model_units: Readonly<
    Record<SpiderLegId, Readonly<Partial<Record<SpiderLegSegmentName, number>>>>
  >;
  readonly neutral_pose: {
    readonly is_rest_pose: boolean;
    readonly description: string;
    readonly rest_knee_angle_deg: Readonly<Record<SpiderLegId, number>>;
    readonly body_clearance_above_foot_plane: number;
    readonly note: string;
  };
  readonly recommended_joint_limits_deg: {
    readonly note: string;
    readonly Coxa: SpiderJointLimitSpec;
    readonly Femur: SpiderJointLimitSpec;
    readonly Patella: SpiderJointLimitSpec;
    readonly Tibia: SpiderJointLimitSpec;
    readonly Metatarsus: SpiderJointLimitSpec;
    readonly Tarsus: SpiderJointLimitSpec;
  };
  readonly deform_bone_count: number;
  readonly reference_bone_count: number;
  readonly total_bone_count: number;
  readonly mesh_object: string;
  readonly mesh_vertex_count: number;
  readonly max_skin_influences_per_vertex: number;
  readonly notes_asymmetry_and_limitations: readonly string[];
}

export interface SpiderRigSpecValidationIssue {
  readonly path: string;
  readonly message: string;
}

export class SpiderRigSpecValidationError extends Error {
  readonly issues: readonly SpiderRigSpecValidationIssue[];

  constructor(issues: readonly SpiderRigSpecValidationIssue[]) {
    const detail = issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n");
    super(`Invalid spider rig specification (${issues.length} issue${issues.length === 1 ? "" : "s"}).\n${detail}`);
    this.name = "SpiderRigSpecValidationError";
    this.issues = [...issues];
  }
}

const AXIS_TOKENS = new Set<SpiderAxisToken>([
  "+X",
  "-X",
  "+Y",
  "-Y",
  "+Z",
  "-Z",
]);
const LEG_SEGMENTS = ["Coxa", "Femur", "Patella", "Tibia", "Metatarsus", "Tarsus"] as const;
const REFERENCE_BONE_NAMES = [
  "HeadReference",
  "SupportReference",
  "BodyCenter",
  "ForwardReference",
  "DorsalReference",
] as const;
const SPINNERET_NAMES = ["Spinneret_Center", "Spinneret_L", "Spinneret_R"] as const;

type JsonObject = Record<string, unknown>;

class SpecValidator {
  readonly issues: SpiderRigSpecValidationIssue[] = [];

  object(value: unknown, path: string): JsonObject {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      this.add(path, "expected an object");
      return {};
    }
    return value as JsonObject;
  }

  string(value: unknown, path: string): string {
    if (typeof value !== "string" || value.length === 0) {
      this.add(path, "expected a non-empty string");
      return "";
    }
    return value;
  }

  boolean(value: unknown, path: string): boolean {
    if (typeof value !== "boolean") {
      this.add(path, "expected a boolean");
      return false;
    }
    return value;
  }

  finiteNumber(value: unknown, path: string): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      this.add(path, "expected a finite number");
      return Number.NaN;
    }
    return value;
  }

  positiveNumber(value: unknown, path: string): number {
    const result = this.finiteNumber(value, path);
    if (Number.isFinite(result) && result <= 0) {
      this.add(path, "expected a number greater than zero");
    }
    return result;
  }

  nonNegativeNumber(value: unknown, path: string): number {
    const result = this.finiteNumber(value, path);
    if (Number.isFinite(result) && result < 0) {
      this.add(path, "expected a non-negative number");
    }
    return result;
  }

  positiveInteger(value: unknown, path: string): number {
    const result = this.positiveNumber(value, path);
    if (Number.isFinite(result) && !Number.isInteger(result)) {
      this.add(path, "expected an integer");
    }
    return result;
  }

  stringArray(value: unknown, path: string): string[] {
    if (!Array.isArray(value)) {
      this.add(path, "expected an array of strings");
      return [];
    }
    return value.map((entry, index) => this.string(entry, `${path}[${index}]`));
  }

  finiteTuple(value: unknown, length: number, path: string): number[] {
    if (!Array.isArray(value) || value.length !== length) {
      this.add(path, `expected an array containing exactly ${length} finite numbers`);
      return [];
    }
    return value.map((entry, index) => this.finiteNumber(entry, `${path}[${index}]`));
  }

  axis(value: unknown, path: string): SpiderAxisToken | "" {
    const token = this.string(value, path);
    if (token && !AXIS_TOKENS.has(token as SpiderAxisToken)) {
      this.add(path, `expected one of ${[...AXIS_TOKENS].join(", ")}`);
      return "";
    }
    return token as SpiderAxisToken | "";
  }

  exactSet(actual: readonly string[], expected: readonly string[], path: string): void {
    const actualSet = new Set(actual);
    const duplicateValues = actual.filter((entry, index) => actual.indexOf(entry) !== index);
    const missing = expected.filter((entry) => !actualSet.has(entry));
    const unexpected = [...actualSet].filter((entry) => !expected.includes(entry));
    if (duplicateValues.length > 0) {
      this.add(path, `contains duplicate values: ${[...new Set(duplicateValues)].join(", ")}`);
    }
    if (missing.length > 0) {
      this.add(path, `is missing: ${missing.join(", ")}`);
    }
    if (unexpected.length > 0) {
      this.add(path, `contains unexpected values: ${unexpected.join(", ")}`);
    }
  }

  exactArray(actual: readonly string[], expected: readonly string[], path: string): void {
    this.exactSet(actual, expected, path);
    if (
      actual.length === expected.length &&
      actual.some((entry, index) => entry !== expected[index])
    ) {
      this.add(path, `must be ordered as: ${expected.join(", ")}`);
    }
  }

  documentedLocalAxis(value: unknown, path: string): void {
    const description = this.string(value, path);
    if (!description) {
      return;
    }
    const match = description.match(/\blocal\s+([+-]?)([XYZ])\b/i);
    if (!match) {
      this.add(path, "must contain a machine-readable local X, Y, or Z axis");
    }
  }

  add(path: string, message: string): void {
    this.issues.push({ path, message });
  }
}

function validateAxisSpace(validator: SpecValidator, value: unknown, path: string, hasNote: boolean): void {
  const object = validator.object(value, path);
  validator.axis(object.forward, `${path}.forward`);
  validator.axis(object.up_dorsal, `${path}.up_dorsal`);
  validator.axis(object.right, `${path}.right`);
  validator.axis(object.left, `${path}.left`);
  if (hasNote) {
    validator.string(object.note, `${path}.note`);
  }
}

function validateLegMap(validator: SpecValidator, value: unknown): void {
  const perLeg = validator.object(value, "$.legs.per_leg");
  validator.exactSet(Object.keys(perLeg), SPIDER_LEG_IDS, "$.legs.per_leg keys");

  for (const legId of SPIDER_LEG_IDS) {
    const path = `$.legs.per_leg.${legId}`;
    const leg = validator.object(perLeg[legId], path);
    const side = validator.string(leg.side, `${path}.side`);
    const index = validator.positiveInteger(leg.index, `${path}.index`);
    const chain = validator.stringArray(leg.chain, `${path}.chain`);
    const footTip = validator.string(leg.foottip, `${path}.foottip`);
    validator.string(leg.foothome, `${path}.foothome`);
    const deformSegments = validator.positiveInteger(leg.deform_segments, `${path}.deform_segments`);

    const expectedSide = legId.startsWith("L") ? "left" : "right";
    const expectedIndex = Number(legId[1]);
    if (side && side !== expectedSide) {
      validator.add(`${path}.side`, `must be ${expectedSide} for ${legId}`);
    }
    if (Number.isFinite(index) && index !== expectedIndex) {
      validator.add(`${path}.index`, `must be ${expectedIndex} for ${legId}`);
    }
    if (chain.length > 0 && chain.at(-1) !== footTip) {
      validator.add(`${path}.chain`, "must end with the declared foottip");
    }
    if (Number.isFinite(deformSegments) && chain.length !== deformSegments + 1) {
      validator.add(`${path}.chain`, "must contain deform_segments bones followed by one FootTip");
    }
    if (Number.isFinite(deformSegments) && deformSegments !== 5 && deformSegments !== 6) {
      validator.add(`${path}.deform_segments`, "schema 1.0 supports only five or six deform segments");
    }
    if (new Set(chain).size !== chain.length) {
      validator.add(`${path}.chain`, "must not repeat a bone name");
    }
  }
}

function validateReachMap(validator: SpecValidator, value: unknown): void {
  const perLeg = validator.object(value, "$.reach_units.per_leg");
  validator.exactSet(Object.keys(perLeg), SPIDER_LEG_IDS, "$.reach_units.per_leg keys");
  for (const legId of SPIDER_LEG_IDS) {
    const path = `$.reach_units.per_leg.${legId}`;
    const reach = validator.object(perLeg[legId], path);
    const minimum = validator.positiveNumber(reach.min, `${path}.min`);
    const comfortable = validator.positiveNumber(reach.comfortable, `${path}.comfortable`);
    const maximum = validator.positiveNumber(reach.max, `${path}.max`);
    if (Number.isFinite(minimum) && Number.isFinite(comfortable) && minimum > comfortable) {
      validator.add(path, "min must not exceed comfortable");
    }
    if (Number.isFinite(comfortable) && Number.isFinite(maximum) && comfortable > maximum) {
      validator.add(path, "comfortable must not exceed max");
    }
  }
}

function validateSegmentLengths(validator: SpecValidator, value: unknown): void {
  const lengths = validator.object(value, "$.segment_lengths_model_units");
  validator.exactSet(Object.keys(lengths), SPIDER_LEG_IDS, "$.segment_lengths_model_units keys");
  for (const legId of SPIDER_LEG_IDS) {
    const path = `$.segment_lengths_model_units.${legId}`;
    const legLengths = validator.object(lengths[legId], path);
    for (const [segmentName, segmentLength] of Object.entries(legLengths)) {
      if (!LEG_SEGMENTS.includes(segmentName as SpiderLegSegmentName)) {
        validator.add(`${path}.${segmentName}`, "is not a supported leg segment name");
        continue;
      }
      validator.positiveNumber(segmentLength, `${path}.${segmentName}`);
    }
    for (const requiredSegment of ["Coxa", "Femur", "Patella", "Tibia", "Metatarsus"] as const) {
      if (!(requiredSegment in legLengths)) {
        validator.add(path, `is missing ${requiredSegment}`);
      }
    }
    const shouldHaveTarsus = legId === "L4" || legId === "R4";
    if (shouldHaveTarsus !== ("Tarsus" in legLengths)) {
      validator.add(path, shouldHaveTarsus ? "is missing Tarsus" : "must not declare a Tarsus");
    }
  }
}

function validatePerLegNumbers(validator: SpecValidator, value: unknown, path: string): void {
  const object = validator.object(value, path);
  validator.exactSet(Object.keys(object), SPIDER_LEG_IDS, `${path} keys`);
  for (const legId of SPIDER_LEG_IDS) {
    validator.finiteNumber(object[legId], `${path}.${legId}`);
  }
}

function validateJointLimits(validator: SpecValidator, value: unknown): void {
  const limits = validator.object(value, "$.recommended_joint_limits_deg");
  validator.string(limits.note, "$.recommended_joint_limits_deg.note");
  for (const segmentName of LEG_SEGMENTS) {
    const path = `$.recommended_joint_limits_deg.${segmentName}`;
    const segment = validator.object(limits[segmentName], path);
    for (const axis of ["bend_x", "swing_z", "twist_y"] as const) {
      const range = validator.finiteTuple(segment[axis], 2, `${path}.${axis}`);
      if (range.length === 2 && range[0] > range[1]) {
        validator.add(`${path}.${axis}`, "minimum must not exceed maximum");
      }
    }
  }
}

function collectExpectedBoneNames(spec: SpiderRigSpec): string[] {
  const names = [
    spec.root_bone,
    spec.thorax_bone,
    spec.pedicel_bone,
    spec.abdomen_bone,
    spec.head_bone,
    ...Object.keys(spec.reference_bones),
    "Spinneret_Center",
    "Spinneret_L",
    "Spinneret_R",
    ...spec.foot_homes,
    ...spec.pedipalps.left,
    spec.pedipalps.left_tip,
    ...spec.pedipalps.right,
    spec.pedipalps.right_tip,
    ...spec.fangs.left,
    ...spec.fangs.right,
  ];
  for (const legId of SPIDER_LEG_IDS) {
    names.push(...spec.legs.per_leg[legId].chain);
  }
  return names;
}

function validateCoherence(validator: SpecValidator, spec: SpiderRigSpec): void {
  validator.exactArray(spec.legs.list, SPIDER_LEG_IDS, "$.legs.list");
  validator.exactArray(spec.legs.order_front_to_rear, ["1", "2", "3", "4"], "$.legs.order_front_to_rear");
  validator.exactArray(
    spec.legs.chain_order_5seg,
    ["Coxa", "Femur", "Patella", "Tibia", "Metatarsus", "FootTip"],
    "$.legs.chain_order_5seg",
  );
  validator.exactArray(
    spec.legs.chain_order_6seg,
    ["Coxa", "Femur", "Patella", "Tibia", "Metatarsus", "Tarsus", "FootTip"],
    "$.legs.chain_order_6seg",
  );

  const declaredFootTips = SPIDER_LEG_IDS.map((legId) => spec.legs.per_leg[legId].foottip);
  const declaredFootHomes = SPIDER_LEG_IDS.map((legId) => spec.legs.per_leg[legId].foothome);
  validator.exactSet(spec.foot_tips, declaredFootTips, "$.foot_tips");
  validator.exactSet(spec.foot_homes, declaredFootHomes, "$.foot_homes");

  for (const legId of SPIDER_LEG_IDS) {
    const segmentSum = Object.values(spec.segment_lengths_model_units[legId]).reduce(
      (sum, length) => sum + (length ?? 0),
      0,
    );
    const maximum = spec.reach_units.per_leg[legId].max;
    if (Math.abs(segmentSum - maximum) > 0.03) {
      validator.add(
        `$.segment_lengths_model_units.${legId}`,
        `segment sum ${segmentSum.toFixed(3)} disagrees with max reach ${maximum.toFixed(3)}`,
      );
    }
  }

  const aggregate = spec.reach_units.aggregate;
  if (
    aggregate.min_compressed_reach > aggregate.comfortable_reach ||
    aggregate.comfortable_reach > aggregate.max_reach
  ) {
    validator.add("$.reach_units.aggregate", "reach values must be ordered min <= comfortable <= max");
  }
  if (spec.deform_bone_count + spec.reference_bone_count !== spec.total_bone_count) {
    validator.add("$.total_bone_count", "must equal deform_bone_count + reference_bone_count");
  }

  const expectedBoneNames = collectExpectedBoneNames(spec);
  const duplicateBoneNames = expectedBoneNames.filter(
    (name, index) => expectedBoneNames.indexOf(name) !== index,
  );
  if (duplicateBoneNames.length > 0) {
    validator.add(
      "$",
      `the required bone contract reuses names: ${[...new Set(duplicateBoneNames)].join(", ")}`,
    );
  }
  if (expectedBoneNames.length !== spec.total_bone_count) {
    validator.add(
      "$.total_bone_count",
      `declares ${spec.total_bone_count}, but the named hierarchy describes ${expectedBoneNames.length}`,
    );
  }
}

export function validateSpiderRigSpec(value: unknown): SpiderRigSpec {
  const validator = new SpecValidator();
  const root = validator.object(value, "$");

  const schemaVersion = validator.string(root.schema_version, "$.schema_version");
  if (schemaVersion && schemaVersion !== "1.0") {
    validator.add("$.schema_version", `unsupported schema version ${schemaVersion}`);
  }
  validator.string(root.generated_for, "$.generated_for");
  validator.string(root.source_model, "$.source_model");
  validator.string(root.export_file, "$.export_file");
  validator.string(root.blender_version, "$.blender_version");

  const units = validator.object(root.units, "$.units");
  validator.string(units.system, "$.units.system");
  validator.positiveNumber(units.unit_scale, "$.units.unit_scale");
  validator.string(units.note, "$.units.note");
  validator.finiteTuple(units.object_scale, 3, "$.units.object_scale");
  validator.boolean(units.object_rotation_applied, "$.units.object_rotation_applied");
  validator.boolean(units.object_location_applied, "$.units.object_location_applied");

  const coordinates = validator.object(root.coordinate_conventions, "$.coordinate_conventions");
  validator.string(coordinates.description, "$.coordinate_conventions.description");
  validateAxisSpace(validator, coordinates.blender_space, "$.coordinate_conventions.blender_space", false);
  validateAxisSpace(
    validator,
    coordinates.gltf_threejs_space,
    "$.coordinate_conventions.gltf_threejs_space",
    true,
  );
  const localAxes = validator.object(coordinates.bone_local_axes, "$.coordinate_conventions.bone_local_axes");
  validator.documentedLocalAxis(localAxes.primary_axis, "$.coordinate_conventions.bone_local_axes.primary_axis");
  validator.documentedLocalAxis(localAxes.dorsal_axis, "$.coordinate_conventions.bone_local_axes.dorsal_axis");
  validator.documentedLocalAxis(localAxes.bend_axis, "$.coordinate_conventions.bone_local_axes.bend_axis");
  validator.string(localAxes.mirror, "$.coordinate_conventions.bone_local_axes.mirror");

  for (const field of ["root_bone", "thorax_bone", "pedicel_bone", "abdomen_bone", "head_bone", "mesh_object"] as const) {
    validator.string(root[field], `$.${field}`);
  }

  const references = validator.object(root.reference_bones, "$.reference_bones");
  validator.exactSet(Object.keys(references), REFERENCE_BONE_NAMES, "$.reference_bones keys");
  for (const name of REFERENCE_BONE_NAMES) {
    validator.string(references[name], `$.reference_bones.${name}`);
  }

  const spinnerets = validator.object(root.spinnerets, "$.spinnerets");
  validator.exactSet(
    Object.keys(spinnerets).filter((key) => key !== "note"),
    SPINNERET_NAMES,
    "$.spinnerets keys",
  );
  for (const name of SPINNERET_NAMES) {
    validator.string(spinnerets[name], `$.spinnerets.${name}`);
  }
  validator.string(spinnerets.note, "$.spinnerets.note");

  const legs = validator.object(root.legs, "$.legs");
  validator.string(legs.numbering, "$.legs.numbering");
  validator.stringArray(legs.order_front_to_rear, "$.legs.order_front_to_rear");
  validator.stringArray(legs.list, "$.legs.list");
  validator.stringArray(legs.chain_order_5seg, "$.legs.chain_order_5seg");
  validator.stringArray(legs.chain_order_6seg, "$.legs.chain_order_6seg");
  validateLegMap(validator, legs.per_leg);
  validator.stringArray(root.foot_tips, "$.foot_tips");
  validator.stringArray(root.foot_homes, "$.foot_homes");

  const pedipalps = validator.object(root.pedipalps, "$.pedipalps");
  validator.stringArray(pedipalps.left, "$.pedipalps.left");
  validator.string(pedipalps.left_tip, "$.pedipalps.left_tip");
  validator.stringArray(pedipalps.right, "$.pedipalps.right");
  validator.string(pedipalps.right_tip, "$.pedipalps.right_tip");
  const fangs = validator.object(root.fangs, "$.fangs");
  validator.stringArray(fangs.left, "$.fangs.left");
  validator.stringArray(fangs.right, "$.fangs.right");
  validator.string(fangs.note, "$.fangs.note");

  const reach = validator.object(root.reach_units, "$.reach_units");
  validator.string(reach.note, "$.reach_units.note");
  validateReachMap(validator, reach.per_leg);
  const aggregate = validator.object(reach.aggregate, "$.reach_units.aggregate");
  validator.positiveNumber(aggregate.max_reach, "$.reach_units.aggregate.max_reach");
  validator.positiveNumber(aggregate.comfortable_reach, "$.reach_units.aggregate.comfortable_reach");
  validator.positiveNumber(aggregate.min_compressed_reach, "$.reach_units.aggregate.min_compressed_reach");
  validateSegmentLengths(validator, root.segment_lengths_model_units);

  const neutral = validator.object(root.neutral_pose, "$.neutral_pose");
  validator.boolean(neutral.is_rest_pose, "$.neutral_pose.is_rest_pose");
  validator.string(neutral.description, "$.neutral_pose.description");
  validatePerLegNumbers(validator, neutral.rest_knee_angle_deg, "$.neutral_pose.rest_knee_angle_deg");
  validator.nonNegativeNumber(
    neutral.body_clearance_above_foot_plane,
    "$.neutral_pose.body_clearance_above_foot_plane",
  );
  validator.string(neutral.note, "$.neutral_pose.note");
  validateJointLimits(validator, root.recommended_joint_limits_deg);

  validator.positiveInteger(root.deform_bone_count, "$.deform_bone_count");
  validator.positiveInteger(root.reference_bone_count, "$.reference_bone_count");
  validator.positiveInteger(root.total_bone_count, "$.total_bone_count");
  validator.positiveInteger(root.mesh_vertex_count, "$.mesh_vertex_count");
  validator.positiveInteger(root.max_skin_influences_per_vertex, "$.max_skin_influences_per_vertex");
  validator.stringArray(root.notes_asymmetry_and_limitations, "$.notes_asymmetry_and_limitations");

  if (validator.issues.length === 0) {
    validateCoherence(validator, value as SpiderRigSpec);
  }
  if (validator.issues.length > 0) {
    throw new SpiderRigSpecValidationError(validator.issues);
  }
  return value as SpiderRigSpec;
}

export function parseSpiderRigSpecJson(json: string): SpiderRigSpec {
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SpiderRigSpecValidationError([{ path: "$", message: `invalid JSON: ${message}` }]);
  }
  return validateSpiderRigSpec(value);
}

/** The complete exact-name bone contract represented by a validated schema v1 rig spec. */
export function getRequiredSpiderBoneNames(spec: SpiderRigSpec): readonly string[] {
  return collectExpectedBoneNames(spec);
}
