import { Group, LoadingManager } from "three";
import {
  GLTFLoader,
  type GLTF,
} from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  SpiderRig,
  SpiderRigResolutionError,
  type SpiderRigResolutionReport,
} from "./SpiderRig";
import {
  parseSpiderRigSpecJson,
  type SpiderRigSpec,
} from "./SpiderRigSpec";

export const DEFAULT_SPIDER_MODEL_URL = "/assets/spider/black_widow_procedural_rig.glb";
export const DEFAULT_SPIDER_RIG_SPEC_URL = "/assets/spider/SPIDER_RIG_SPEC.json";

export type SpiderRigAssetKind = "model" | "specification";

export class SpiderRigAssetLoadError extends Error {
  readonly assetKind: SpiderRigAssetKind;
  readonly url: string;

  constructor(assetKind: SpiderRigAssetKind, url: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Failed to load spider rig ${assetKind} from ${url}: ${detail}`, { cause });
    this.name = "SpiderRigAssetLoadError";
    this.assetKind = assetKind;
    this.url = url;
  }
}

export interface LoadSpiderRigOptions {
  readonly modelUrl?: string;
  readonly specUrl?: string;
  readonly loadingManager?: LoadingManager;
  readonly placementRoot?: Group;
  readonly placementRootName?: string;
  readonly requestInit?: RequestInit;
  readonly onModelProgress?: (event: ProgressEvent<EventTarget>) => void;
  readonly configureLoader?: (loader: GLTFLoader) => void;
  readonly onValidationReport?: (report: SpiderRigResolutionReport) => void;
}

export async function loadSpiderRigSpec(
  url = DEFAULT_SPIDER_RIG_SPEC_URL,
  requestInit?: RequestInit,
): Promise<SpiderRigSpec> {
  let response: Response;
  try {
    response = await fetch(url, requestInit);
  } catch (error) {
    throw new SpiderRigAssetLoadError("specification", url, error);
  }
  if (!response.ok) {
    throw new SpiderRigAssetLoadError(
      "specification",
      url,
      new Error(`HTTP ${response.status} ${response.statusText}`),
    );
  }

  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw new SpiderRigAssetLoadError("specification", url, error);
  }
  return parseSpiderRigSpecJson(text);
}

export async function loadSpiderRigGltf(
  url = DEFAULT_SPIDER_MODEL_URL,
  options: Pick<
    LoadSpiderRigOptions,
    "loadingManager" | "onModelProgress" | "configureLoader"
  > = {},
): Promise<GLTF> {
  const loader = new GLTFLoader(options.loadingManager);
  options.configureLoader?.(loader);
  try {
    return await loader.loadAsync(url, options.onModelProgress);
  } catch (error) {
    throw new SpiderRigAssetLoadError("model", url, error);
  }
}

/**
 * Loads both runtime assets, validates the schema, indexes the GLB hierarchy
 * exactly once, and returns retained bone references. No authored GLB transform
 * is reset: callers position the returned rig through `rig.rootObject`.
 */
export async function loadSpiderRig(options: LoadSpiderRigOptions = {}): Promise<SpiderRig> {
  const modelUrl = options.modelUrl ?? DEFAULT_SPIDER_MODEL_URL;
  const specUrl = options.specUrl ?? DEFAULT_SPIDER_RIG_SPEC_URL;
  const [spec, gltf] = await Promise.all([
    loadSpiderRigSpec(specUrl, options.requestInit),
    loadSpiderRigGltf(modelUrl, options),
  ]);

  try {
    const rig = SpiderRig.resolve(gltf.scene, spec, {
      placementRoot: options.placementRoot,
      placementRootName: options.placementRootName,
    });
    options.onValidationReport?.(rig.validationReport);
    return rig;
  } catch (error) {
    if (error instanceof SpiderRigResolutionError) {
      options.onValidationReport?.(error.report);
    }
    throw error;
  }
}
