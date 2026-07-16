import type { WebNetwork } from "../web/WebNetwork";
import { StrandTraversal } from "./StrandTraversal";

/** Typed convenience adapter; the core traversal classes remain simulation-agnostic. */
export function createWebNetworkTraversal(
  network: WebNetwork,
  fixedStepSeconds = 1 / 120,
): StrandTraversal {
  return new StrandTraversal(network, fixedStepSeconds);
}
