export interface LabConfig {
  gravity: number;
  damping: number;
  stiffness: number;
  solverIterations: number;
  pointCount: number;
  slack: number;
  appliedForce: number;
  contactLoad: number;
  visualScale: number;
  showPoints: boolean;
  showNodeLabels: boolean;
  showDebugLines: boolean;
  showTension: boolean;
  showStrandIds: boolean;
  showNodeIds: boolean;
  showCrossings: boolean;
  showRoute: boolean;
  showClosestQuery: boolean;
  showTangent: boolean;
  showNormal: boolean;
  showBinormal: boolean;
  showContact: boolean;
  showVelocity: boolean;
}

export const labConfig: LabConfig = {
  gravity: -7.2,
  // Exponential velocity decay rate in 1/seconds. Higher means faster settling.
  damping: 1.65,
  stiffness: 0.94,
  solverIterations: 10,
  pointCount: 20,
  slack: 1.08,
  appliedForce: 5,
  contactLoad: 2.4,
  visualScale: 1.15,
  showPoints: false,
  showNodeLabels: true,
  showDebugLines: false,
  showTension: true,
  showStrandIds: false,
  showNodeIds: false,
  showCrossings: true,
  showRoute: true,
  showClosestQuery: true,
  showTangent: true,
  showNormal: true,
  showBinormal: true,
  showContact: true,
  showVelocity: true,
};

export const FIXED_TIME_STEP = 1 / 120;
export const MAX_FRAME_DELTA = 0.1;
// 12 × 1/120 s exactly covers the clamped 100 ms frame delta.
export const MAX_SUBSTEPS = 12;
