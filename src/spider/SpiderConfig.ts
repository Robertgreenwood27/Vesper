import type { SpiderLegId } from "./SpiderRigSpec";

export type SpiderLoadMode = "equal" | "position-weighted";

export interface SpiderLabConfig {
  totalWeight: number;
  bodyOffsetX: number;
  bodyOffsetY: number;
  bodyOffsetZ: number;
  bodyPitchDegrees: number;
  bodyYawDegrees: number;
  bodyRollDegrees: number;
  thoraxHeight: number;
  loadMode: SpiderLoadMode;
  selectedFoot: SpiderLegId;
  selectedContactT: number;
  showSkeleton: boolean;
  showBoneAxes: boolean;
  showFootTargets: boolean;
  showPlantedContacts: boolean;
  showFootHomes: boolean;
  showReachRanges: boolean;
  showReachRatio: boolean;
  showContactFrames: boolean;
  showPerFootLoad: boolean;
  showSupportCenter: boolean;
  showBodyAxes: boolean;
  showInvalidContacts: boolean;
  showRigValidation: boolean;
}

export const spiderConfig: SpiderLabConfig = {
  totalWeight: 2.4,
  bodyOffsetX: 0,
  bodyOffsetY: 0,
  bodyOffsetZ: 0,
  bodyPitchDegrees: 0,
  bodyYawDegrees: 0,
  bodyRollDegrees: 0,
  thoraxHeight: 0.2,
  loadMode: "equal",
  selectedFoot: "L1",
  selectedContactT: 0.3361,
  showSkeleton: false,
  showBoneAxes: false,
  showFootTargets: true,
  showPlantedContacts: true,
  showFootHomes: false,
  showReachRanges: false,
  showReachRatio: false,
  showContactFrames: false,
  showPerFootLoad: true,
  showSupportCenter: false,
  showBodyAxes: false,
  showInvalidContacts: true,
  showRigValidation: true,
};
