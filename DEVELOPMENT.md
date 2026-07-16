# Bothria Silk Lab — Development Notes

## Current status

The current Phase 8 milestone replaces the fully emergent transition-policy experiment with a hybrid locomotion model. Ordinary travel and simple junctions remain generic. Difficult topology changes use one small procedural transition strategy selected from route and local support-plane geometry: `ordinary-traverse`, `junction-forward`, or `roll-under`.

A strategy supplies only leg-band, support-region/contact, and body-goal preferences. The exact leg and continuous `{ strandId, t }` foothold are still selected dynamically from live hard-valid candidates. Semantic addressing, procedural IK, physical silk loading, route topology, support minimums, hard reach, secure-before-release, probe-before-load, cancellation restoration, and the standalone Phase 7 transaction remain authoritative. There is no baked animation, foot teleport, planted-contact slide, fixed leg sequence, or scenario-name strategy selection. Scenario buttons and tuning controls remain development fixtures rather than player controls.

## Architectural boundary

The source-of-truth layers remain separate:

1. `WebNetwork` and `WebPhysicsSolver` own semantic topology, particles, constraints, and fixed-step dynamics.
2. `StrandTraversal` resolves durable `{ strandId, t }` material addresses and local frames.
3. `SpiderFootContact` owns semantic foot state but no web particles.
4. `SpiderLoadDistributor` translates eligible feet into temporary forces on the web.
5. `SpiderRig`, `SpiderIKSolver`, and `SpiderBodyPose` own renderer-facing skeleton state but no web topology.
6. `SpiderDebugRenderer` and `SpiderDebugPanel` observe or command the fixture but do not become simulation authorities.
7. `SpiderIntentResolver` turns one address, junction, or nearby world query into a short semantic route and local travel direction.
8. `FootholdGenerator`, `FootholdScorer`, and `LegSelector` own one-shot policy decisions over semantic `{ strandId, t }` candidates.
9. `SpiderStepController` coordinates the explicit step states; it does not absorb route planning, IK, contact physics, or web simulation.
10. `LocomotionDebugRenderer` and `LocomotionDebugPanel` expose the decision without becoming policy authorities.
11. `DestinationBranchFrameEstimator` owns the sign-continuous local route/companion-silk frame; it never derives posture from world-up or mutates the body.
12. `TransitionStrategyController` selects and advances `ordinary-traverse`, `junction-forward`, or `roll-under` from route geometry and a small progress observation. It cannot choose an exact foothold or mutate contacts, IK, body transforms, or physics.
13. `SupportEstimator` and the deterministic body-motion fraction search provide hard support, reach, and clearance evidence; they are execution gates rather than a high-level transition score.
14. `CoupledTransferTransaction` is the opt-in Phase 8 wrapper around `SpiderStepController`; it owns partial-load/body-motion sequencing and transaction restoration evidence.
15. `JunctionProgressEstimator` supplies alignment, old/new support counts, worst reach, body progress, and trailing support count. `BodyOrientationPlanner` converts a strategy body goal into a bounded proposal.
16. `LocalRecoveryPlanner` owns the one finite same-strand/explicitly-connected invalid-contact recovery used by Scenario D.
17. `JunctionTraversalCoordinator` owns route resolution, strategy scheduling, coupled execution, settlement, arrival, cancellation, and explicit restore-or-fail terminal reasons.
18. The Phase 7 and Phase 8 renderers/panels remain observers and development controls.

This separation lets locomotion consume route and contact services without moving physics particles directly, using particle indices as navigation identities, or repeatedly searching a Three.js hierarchy by name.

## 1. Imported rig and assets

Runtime files are copied, byte-for-byte, from the supplied authored deliverables:

```text
public/assets/spider/
  black_widow_procedural_rig.glb
  SPIDER_RIG_SPEC.json
```

The `.blend` file under `Spider/` is source material only. It is not loaded, modified, or re-exported by this project.

`SpiderRigLoader` loads the GLB and JSON concurrently. `SpiderRigSpec` validates schema version 1.0, required fields, axis tokens, exact leg set/order, five- versus six-segment chain coherence, FootTip/FootHome coherence, reach ordering, segment sums, joint-limit ranges, declared counts, and uniqueness of the complete 85-bone contract.

`SpiderRig` then traverses the loaded hierarchy once and builds a name index. Resolution fails with a detailed report for:

- Missing required bones.
- Duplicate required names.
- Required names that resolve to non-bone objects.
- Invalid direct-parent relationships.
- A missing, duplicate, or non-skinned mesh object.

No guessed fallback name is accepted.

### Raw GLB audit

| Property | Result |
| --- | --- |
| Container | Valid GLB 2; declared and actual length 4,066,084 bytes |
| Nodes | 87 |
| Meshes / skins | 1 / 1 |
| Skin joints | 85 |
| Required names | 85/85 present, unique, and included as joints |
| FootTip / FootHome | 8 / 8 |
| Spinnerets | Center, left, and right resolved |
| Animations / cameras / lights | 0 / 0 / 0 |
| Duplicate named nodes | 0 |

The resolved structural hierarchy is:

```text
Armature
├── Black_widow_04 (SkinnedMesh)
└── SpiderRoot
    ├── Thorax
    │   ├── Head → fangs
    │   ├── Leg_L1 ... Leg_L4 → FootTip
    │   ├── Leg_R1 ... Leg_R4 → FootTip
    │   ├── left/right pedipalps
    │   ├── HeadReference, SupportReference, BodyCenter
    │   ├── ForwardReference, DorsalReference
    │   └── FootHome_L1 ... FootHome_R4
    └── Pedicel
        └── Abdomen
            └── Spinneret_Center, Spinneret_L, Spinneret_R
```

L1–L3 and R1–R3 contain Coxa, Femur, Patella, Tibia, and Metatarsus before FootTip. Rear legs L4/R4 also contain Tarsus. Runtime chain construction follows the specification rather than assuming a uniform bone count.

### Placement transforms

The actual GLB differs from the prose claim that every object transform is identity. The `Armature` node has translation approximately `(0.388878, 0.076315, -0.002188)` and a small non-identity quaternion; `SpiderRoot` also contains the exporter basis quaternion.

These rest transforms must not be zeroed. `SpiderRig` exposes three distinct levels:

- `rootObject`: a new outer placement pivot used by the body fixture.
- `assetRoot`: the unmodified scene returned by `GLTFLoader`.
- `spiderRoot`: the exact named skeleton joint.

The resolver and loader preserve all authored asset and joint transforms.

## 2. Coordinate and reach conventions

All conventions come from `SPIDER_RIG_SPEC.json`:

| Meaning | glTF / Three.js axis |
| --- | --- |
| Model forward | `-X` |
| Dorsal up | `+Y` |
| Model right | `-Z` |
| Model left | `+Z` |
| Bone primary/head-to-tail | local `+Y` |
| Bone dorsal | local `+Z` |
| Primary bend hinge | local `+X` |

Aggregate reach guidance is `0.32` minimum compressed, `0.72` comfortable, and `0.97` maximum model units. Each `SpiderLegChain` retains its own minimum/comfortable/maximum values, segment lengths, and approximate joint limits from the spec. Runtime scale is applied separately when evaluating world-space reach.

The source mesh has small natural left/right asymmetry. The rig's normalized rolls provide mirror-consistent local frames; procedural code preserves those rest-local frames instead of inventing a side-specific convention.

## 3. Phase 6 support fixture

`createPhaseSixFixture` creates an ordinary data-driven `WebNetwork` with:

- Eight semantic support strands.
- Eight fixed outer anchors.
- One shared movable center junction.
- Eight explicit initial `{ strandId, t }` addresses.
- One semantic disturbance address.

The spoke directions and material coordinates are derived from the actual neutral FootHome positions relative to BodyCenter. The fixture is deliberately local and readable; it does not use the full Phase 5 traversal course and does not introduce decorative or particle-authored contacts.

The fixture continues to use the existing fixed `1/120 s` simulation step, Verlet integration, XPBD distance constraints, and material-coordinate force interpolation.

## 4. Phase 7 locomotion fixture and one-step policy

Phase 7 is additive. `createPhaseSevenFixture` builds a separate, asymmetric semantic course containing:

- A primary support rail and a nearby angled support rail.
- A movable three-strand Y junction and a second fixed junction.
- Upper and lower Y branches plus a lower/behind strand with meaningful depth and height variation.
- One explicitly inactive weak candidate strand used to prove rejection behavior.
- Eight initial continuous contacts, all initially planted and loaded; left feet begin on the primary rail and right feet on the angled rail.

Only shared `WebNode` endpoints define connectivity. Screen-space intersections, close points, and projected crossings never add topology. The course remains an ordinary `WebNetwork`; its addresses are independent of particle resolution.

The new implementation is split by responsibility:

```text
src/spider/locomotion/
  LocomotionTypes.ts          shared semantic planning records
  LocomotionConfig.ts         tunable policy, timing, support, and debug values
  SpiderIntent.ts             nearby destination and short-route resolution
  FootholdGenerator.ts        one-shot continuous candidate sampling
  FootholdScorer.ts           additive score and component diagnostics
  LegSelector.ts              one-leg eligibility and deterministic selection
  SpiderStepState.ts          explicit state/failure vocabulary
  SupportEstimator.ts         remaining-support approximation
  FootSwingTrajectory.ts      local-frame cubic swing
  FootOrientationPolicy.ts    continuous tangent/reference alignment
  ContactTestController.ts    temporary semantic probe
  BodyAdvancePlanner.ts       reach-clamped discrete body translation
  JointLimitFeasibilityProbe.ts detached constrained-IK candidate probe
  LocomotionDiagnostics.ts    inspectable plan and execution snapshot
  SpiderStepController.ts     one-step coordinator

src/rendering/LocomotionDebugRenderer.ts
src/ui/LocomotionDebugPanel.ts
```

### Intent and one-shot candidate generation

One request accepts a semantic address, junction ID, or bounded world-space query. `SpiderIntentResolver` asks the existing route planner for a short route, computes a local look-ahead target and desired direction, and explicitly reports when additional steps would be required. It does not execute that longer route.

Candidate generation runs only when planning is requested, never every render or physics frame. For each eligible planted leg, it retains the current contact as a score baseline and inspects nearby active and inactive semantic strands around FootHome. It includes the route target when relevant, the closest continuous point, and configurable `t` samples. Every candidate retains leg ID, `{ strandId, t }`, source, world position, contact frame, material velocity, approximate tension, reach measurements, destination progress, FootHome distance, support estimates, score terms, and rejection details.

Minimum/maximum reach, search radius, inactive/broken state, non-finite traversal data, supplied joint feasibility, and crowding/support constraints remain explicit. `JointLimitFeasibilityProbe` copies each live leg into a detached mirror chain and runs the production IK solver with authored limits enabled. Grossly infeasible samples are rejected; approximate constrained solutions retain a weighted violation without mutating the rendered skeleton. Rejected candidates are retained for diagnostics. Connectivity scoring reads only explicit endpoint adjacency, so a projection-only crossing can neither gain a branch score nor become a route transition. No candidate identity contains a simulation-particle index.

### Inspectable foothold score

All signals are normalized and combined additively:

```text
score = Σ(positive signal × positive weight)
      - Σ(penalty signal × penalty weight)
```

The Phase 7 default weights are:

| Positive term | Weight | Penalty term | Weight |
| --- | ---: | --- | ---: |
| Progress toward destination | 5.00 | Reach boundary | 1.60 |
| Comfortable reach | 1.35 | Joint-limit violation | 2.50 |
| FootHome preference | 1.00 | Body rotation | 0.75 |
| Strand stability | 1.00 | Foot crowding | 1.60 |
| Future explicit connectivity | 0.65 | Leg crossing | 1.00 |
| Support spacing | 1.40 | Weak or moving strand | 1.40 |
|  |  | Reduced support stability | 1.80 |

Every signal, weight, signed contribution, positive subtotal, penalty subtotal, and total stays on the candidate for inspection. A rejected candidate receives a non-winning total regardless of otherwise attractive signals. The panel edits the same weights used by the next planning request.

### Explicit one-step state machine

`SpiderStepController` exposes every phase instead of hiding the maneuver inside one interpolation:

| State | Entry condition and work | Exit condition |
| --- | --- | --- |
| `idle` | Initial or explicitly reset controller; no moving foot or probe. | A destination request enters `planning`. |
| `planning` | Resolve the local intent once, generate/score candidates, estimate remaining support, and select at most one leg. | Execute enters `lifting`; plan-only/freeze remains inspectable; invalid intent or no safe winner enters `failed`. |
| `lifting` | Save all stable addresses, set the moving foot's load factor to zero, keep every other support planted, and start the local-frame curve. | At 24% of swing duration, enter `swinging`; any support, reach, strand, or IK failure enters `failed`. |
| `swinging` | Follow the remainder of the curved trajectory while the target address re-resolves with moving silk. | Curve completion plus successful temporary-probe attachment enters `testing`. |
| `testing` | Hold the moving foot at zero load and apply a small temporary force at the exact target address. | A finite, traversable response held for the testing duration plants at zero load and enters `planting`; invalid response fails. |
| `planting` | Establish the durable `SpiderFootContact` while its load factor remains zero. | The planting hold duration enters `loading`. |
| `loading` | Smoothly ramp the new contact from load factor 0 to 1 while the other contacts share the remaining requested weight. | Full load plus a valid reach-clamped body plan enters `body-advance`; an unsafe plan fails. |
| `body-advance` | Apply one eased, bounded body offset with all semantic foot addresses fixed. | A fresh render-side IK generation must validate every planted support at the final offset before entering `complete`. |
| `complete` | Record the moved leg, completed count, and whether another step would be needed. Nothing repeats automatically. | Reset returns to `idle`; a new explicit request can start a separate one-shot plan. |
| `failed` | Release the probe, report the exact reason, restore the moving foot's original address/load and body offset when execution had begun, and leave unrelated feet untouched. | Reset returns to `idle`; a later explicit request may plan again. |

The controller continuously guards target traversability, target reach, moving-leg IK finiteness, preservation of all non-moving semantic addresses, and the configured support minimum. Cancellation uses the same restoration path; the browser acceptance check restored all eight stable feet.

### Support, swing, secure contact, and body advance

The support minimum defaults to five. With the eight-foot fixture, lifting one leg leaves seven loaded supports. Before lift, `SupportEstimator` projects the remaining contacts into the local support frame, checks count, spread, body margin, and reach validity. `LegSelector` also rejects a move whose predicted body advance would put another loaded leg above the configured reach reserve.

`FootSwingTrajectory` is a cubic Bézier expressed relative to support-frame up and projected travel-forward, not world up. Departure and approach controls provide lift, forward clearance, and controlled descent. Planning samples the curve against active semantic strands (never particle IDs), raises local-up lift when needed, and rejects a path that cannot meet the clearance envelope. A quintic time warp gives zero velocity and acceleration at both endpoints. The moving FootTip orientation is a separate continuity-tracked policy: it is seeded from the live FootTip world quaternion, then its distal axis follows the strand tangent while the contact normal/binormal fixes roll, with sign continuity and a per-update angular clamp preventing sudden 180-degree flips.

At the target, `ContactTestController` uses `TemporaryStrandContact`; its small force deforms the two bracketing physical points without creating a permanent node. Only a finite response permits planting. `SpiderLoadDistributor` then ramps that foot's factor from 0 to 1 while continuing to normalize the requested total across eligible feet.

`BodyAdvancePlanner` clamps the requested translation first to the configured 0.10-unit maximum and then against the minimum and maximum reach spheres of every held contact, using the 0.97 maximum-reach safety factor. It reports the limiting foot/address and whether another step would be required. It never starts that next step.

## 5. Phase 8 hybrid true-Y traversal

The Phase 8 hybrid layer is additive. `createPhaseEightFixture` still creates the same compact three-dimensional course containing:

- Approach, forward, and angled main strands joined at exactly one movable degree-three Y.
- Nearby approach, forward, and angled companion strands that can carry feet without becoming extra Y branches.
- Fixed approach, forward, and angled anchors.
- Two deliberately weak optional strands connected through another movable node.
- A separate active strand that crosses the route in projection while remaining in a different connected component.
- Eight continuous initial foot contacts, a semantic route origin, explicit branch metadata, and deterministic A–F validation/fault metadata.

The fixture is still an ordinary data-driven `WebNetwork`. Only a shared `WebNode` endpoint creates connectivity. The false crossing is active and queryable, but its authored projection proximity cannot create a junction, branch-test candidate, or route transition.

The traversal layer is split by responsibility:

```text
src/spider/traversal/
  TraversalTypes.ts                 shared progress and stop records
  TraversalConfig.ts                detached validated scheduler/policy defaults
  JunctionProgressEstimator.ts      live contact/body classification around the Y
  DestinationBranchFrameEstimator.ts sign-continuous semantic branch frame and arrival projection
  TransitionStrategyController.ts   geometry-selected hybrid strategy and bounded stages
  BodyOrientationPlanner.ts         bounded reach/clearance-checked support frame
  LocalRecoveryPlanner.ts           one finite invalid-contact alternative set
  CoupledTransferTransaction.ts     Phase 7 foot transfer + partial load + body increment
  ReachBudgetController.ts          deterministic hard-safe body-motion fractions
  JunctionTraversalCoordinator.ts   high-level scheduler above SpiderStepController

src/rendering/JunctionTraversalDebugRenderer.ts
src/ui/JunctionTraversalDebugPanel.ts
```

### Coupled transaction and Phase 7 boundary

`JunctionTraversalCoordinator` requests `CoupledTransferTransaction` through the same narrow atomic-step port. The wrapper drives these observable stages:

```text
planning-foot
  -> transferring-foot
  -> partial-load-held
  -> moving-body
  -> finishing-load
  -> complete
```

`transferring-foot` delegates the validated Phase 7 lift, swing, probe, and zero-load semantic plant. At `partial-load-held`, the selected contact carries `0.35` of its normal participation while the other eligible contacts continue carrying the normalized total load. `moving-body` applies only the accepted coupled translation/rotation. The wrapper then releases the hold so Phase 7 completes its normal ramp to full load. `restoring`, `failed`, and `cancelled` are explicit restoration/terminal paths.

Full-load validation is independent of strategy success. The actual pose must pass hard support, physical reach (`1 + 1e-6`, numerical epsilon only), body clearance, topology, contact validity, and a fresh IK observation. A strategy stage cannot trade one of those gates for progress.

Restoration is one bounded transaction path rather than a policy mode. The coupled wrapper restores the saved body pose while Phase 7 restores the original semantic foot address and load, then waits for fresh contact/IK evidence. Failure to stabilize within the restoration timeout is terminal and diagnostic.

Standalone Phase 7 does not opt into the load hold and therefore retains its original full-load-before-body-motion sequence. Neither coordinator nor wrapper may bypass Phase 7 contact restoration, mutate web particles directly, or schedule a second moving foot.

The high-level scheduler follows this mechanical flow:

```text
idle
  → resolving-route
  → selecting-strategy
  → planning-step
  → executing-step
  → settling
  → repeat-stage | resume-generic | restoring
  → arrived | failed | cancelled
```

The selected strategy is latched for the semantic transition. After each settled transaction it emits the next leg-band/contact/body preference or resumes generic travel. The scheduler can run until arrival or pause only after a completed transaction and its settle interval; continuing advances exactly one more transaction.

Hard bounds include the global transaction count, per-stage transaction/stagnation limits, at most three distinct strategy alternatives, local invalid-contact attempts, body-motion/restoration duration, physical reach, support, topology, translation/rotation, and trailing reach. Terminal diagnostics distinguish destination arrival, route invalidity, planning/atomic failure, support instability, exhausted strategy/local alternatives, maximum step count, and user cancellation.

### Geometry-selected strategies and small progress model

The full semantic route from the approach through the explicit true-Y transition is retained for traversal meaning. Before each atomic plan, the current short route is re-resolved from live contacts rather than assuming the previous strand geometry stayed fixed. Route identities remain main nodes and strand IDs; simulation particles never become waypoints.

`DestinationBranchFrameEstimator` derives forward from the semantic destination route and up/right from the live route-plus-companion support plane. Parallel transport and prior-frame sign checks preserve continuity when the silk moves; no world-up vector defines the local branch frame.

`selectTransitionStrategy` reads route geometry, not scenario identity. No junction selects `ordinary-traverse`; a simple plane turn selects `junction-forward`; a plane turn at or above the configured local threshold selects `roll-under`. The authored forward and underside destinations therefore differ through their semantic support-plane geometry even if their fixture labels are renamed.

`TransitionStrategyController` consumes only branch-frame alignment, old/new-plane contact counts, worst reach ratio, body progress, and trailing support count. Junction encounter and body crossing are separate phase gates, not progress credit, and the measurements are not collapsed into a composite utility.

`ordinary-traverse` emits the normal route-progress/body-advance preference. `junction-forward` approaches the junction, favors front/middle destination-side support during the transfer, then resumes generic travel after the body crosses. `roll-under` uses `establish-new-plane`, `rotate-and-build`, `advance-under`, `clear-old-plane`, and `resume-generic`. When worst reach crosses the warning in either junction strategy, the same stage holds the body and requests a dynamically selected reach-improving rear/middle/front contact; this is one explicit safety goal, not a separate recovery subsystem. If every limiting leg is temporarily non-removable, the candidate objective accepts only a hard-valid support-building foothold that makes at least one limiting leg removable before strict relief resumes.

Each directive contains only preferred leg regions, `route-progress`/`new-plane`/`trailing-relief`, and `hold`/`rotate`/`advance` with bounded translation and rotation scales. The adapter ranks currently removable legs and creates destination-frame semantic neighborhoods. `SpiderStepController` still chooses the exact leg and address. No strategy names `L1`-`L4` or `R1`-`R4`, edits a planted address, or bypasses atomic eligibility, topology, reach, IK, support, spacing, probing, or clearance.

### Hard support, reach, and body execution

`SupportEstimator` multiplies each valid contact's anatomical weight by its load factor. Moving, invalid, unreachable, or zero-load contacts remain visible in diagnostics but do not count as full support. It reports effective/full/partial support counts, weighted center and broadness, and body-edge margin. A leg is eligible to move only when removing it leaves a hard-valid support set above the configured minimum.

`BodyOrientationPlanner` blends the stable current support frame toward the strategy's route or sign-continuous destination-frame goal. Deterministic fractions clamp each transaction's translation and rotation and predict every planted leg's reach. Candidate body poses must pass hard reach, weighted support across the partial-to-full load ramp, and silk clearance. The search compares only the active stage metric (advance, alignment, or requested reach relief); it does not run a general multi-term transition policy.

If a real foothold satisfies the active contact goal but no additional body increment is safe or needed, the contact-only transaction may complete with the thorax held. Otherwise the accepted frame is eased while planted semantic addresses remain fixed. Live support, reach, and clearance are checked throughout, followed by hard full-load support/reach/clearance and a fresh IK observation.

### Bounded alternatives, recovery, and failure

The roll-under controller permits a finite stage transaction count and fails after the configured consecutive stagnant observations. An atomic failure may try at most three distinct hard-valid legs or continuous foothold neighborhoods for the current strategy stage. Those alternatives do not change the strategy, weaken validation, or introduce another correction mode.

Scenario D retains one bounded local invalid-contact recovery. `LocalRecoveryPlanner` samples nearby continuous addresses on the same strand and then explicitly connected strands, filters traversability, spacing, route scope, distance, IK, and the active strategy goal, and returns no more than the configured attempt set.

When local or stage alternatives are exhausted, the coupled transaction restores the saved body pose while Phase 7 restores the semantic foot address and load, then traversal stops with the exact failure reason. There is no body-only posture recovery, reach-reserve episode, support-builder loop, global exploration, foot snap, or silent fallback.

Arrival keeps all safety predicates separate. The direct world-distance rule is unchanged for coplanar routes. For a non-coplanar transition whose semantic route is complete, raw point distance may remain large because the thorax keeps its normal underside standoff; only then may a valid sign-continuous destination frame use absolute local forward separation against the unchanged destination tolerance. Stable destination support, junction clearance, spread/trailing policy, and hard reach must still pass independently.

### Phase 8 validation scenarios

The fixture encodes six deterministic contracts:

| Scenario | Destination / injected condition | Required outcome |
| --- | --- | --- |
| A — forward branch | Stable address beyond the mostly forward Y branch. | Geometry selects `junction-forward`; secure dynamic transfers establish support, clear trailing legs, and arrive. |
| B — angled / underside branch | Stable address down and around the angled branch. | Geometry selects `roll-under`; bounded stages use dynamic real contacts, clear the old plane, and arrive without an exact leg script. |
| C — false crossing | World query that snaps only to the disconnected projection crossing. | `route-invalid` before any step; the crossing never appears in Y connectivity. |
| D — missing expected contact | A forward interval becomes temporarily invalid after earlier completed steps. | The single bounded same-strand/connected local search is visible and traversal continues when a safe alternative exists. |
| E — repeated failure | Forward candidate intervals are blocked after several successful steps. | Strategy alternatives exhaust; traversal restores and stops `failed` with the diagnostic reason preserved. |
| F — cancellation | Cancellation is injected during a later coupled transaction. | Atomic/body restoration completes, traversal stops `cancelled`, and no later step is scheduled. |

### Phase 8 debug surface

`JunctionTraversalDebugPanel` is mounted above the retained Phase 7 panel. It exposes scenario execution, run-until-arrival, pause-after-step, continue-one-step, cancel-and-restore, reset, scheduler/settle/look-ahead bounds, destination support count/spread, body translation/rotation limits, and local-recovery radius/attempts.

Independent Phase 8 overlays show the full/current route, next transition, destination branch, contact-side classification, proposed/accepted body frames, predicted reach, local recovery candidates, body progress, and final stop reason. Compact metrics add strategy/stage and its leg-band/contact/body directive, old/new/trailing support counts, coupled stage, partial load, accepted translation/rotation, limiting foot, worst reach, hard support class, bounded alternatives, restoration, and terminal reason.

Each transaction records the dynamically selected leg and semantic contact, initial/partial/final load, accepted translation and rotation, body progress, worst/trailing reach, support before/after, limiting hard constraint, stage transitions, and restoration outcome. Diagnostics remain observers; they do not select a foot or authorize motion.

## 6. Foot-contact state model

One persistent `SpiderFootContact` exists for each of `L1–L4` and `R1–R4`. Its explicit state vocabulary is:

```text
unassigned → seeking → approaching → planted → loaded → releasing → released
                                        ↘ invalid ↗
```

Phase 7 uses `approaching` for the unloaded moving target and `planted`/`loaded` after testing. The remaining vocabulary still lets later repeated stepping expand behavior without replacing the data model.

Each foot retains or derives:

- Leg ID and current state.
- Planted/released status.
- Assigned strand ID and normalized material `t`.
- Current world position.
- Stable tangent, normal, and binormal through a private `ContactFrameTracker`.
- Local strand velocity and approximate local tension.
- Current carried load.
- Current FootHome world position and coxa/reach origin.
- Reach distance, normalized reach ratio, and comfortable/strained/too-close/too-far state.
- Contact validity and a specific invalid reason.

Every update resolves the same semantic address against the current strand shape. A planted foot does not snap to the nearest particle. Missing, inactive, broken, non-finite, compressed, and overextended contacts are isolated to that foot and reported instead of corrupting the remaining skeleton.

## 7. Procedural IK

`SpiderIKSolver` is bone-name-independent. `SpiderRig` supplies each exact ordered chain once; the solver captures:

- Rest-local bone quaternions.
- Child directions and current segment lengths.
- Rest offsets in the root-parent frame.
- A dominant neutral-bend pole from the authored stance.
- Optional X-bend, Y-twist, and Z-swing limits.

The runtime uses allocation-stable FABRIK for arbitrary chain length. A rest-derived pole correction biases each solve toward the authored bend side, preventing ordinary left/right mirror inversions. Solved directions are applied sequentially as local quaternions so authored roll conventions remain intact.

The solver reports reached, unreachable, joint-limited, invalid-target, invalid-chain, and non-finite-result states. It records iterations, residual, reach ratio, joint clamps, bend agreement, and non-uniform scale. An invalid quaternion rolls the affected chain back to its previous finite pose.

Approximate joint limits are opt-in. When enabled they are local Euler clamps, useful as guards and diagnostics but not a final biological articulation model. IK remains positional; Phase 7 adds a separate orientation policy for the moving FootTip rather than embedding orientation in FABRIK.

Synthetic five- and six-segment rotating-target sweeps ran 80 targets per chain. Maximum reached-target residual was `9.72e-5` world units, minimum preferred-bend dot was `0.9999999999999996`, and invalid-target/overreach guards passed.

## 8. Body support and pose fixture

`SpiderBodyPose` computes a weighted center from valid planted supports. The local fixture uses symmetric anatomical pair weights of `0.4 / 0.7 / 1.0 / 1.8` from front to rear. The supplied neutral stance is fore-heavy in model space; equal centroid weights incorrectly pull BodyCenter toward L1/R1 and overextend L4/R4. These pair-symmetric weights keep BodyCenter between all four leg pairs without introducing left/right bias. Load distribution remains independently equal or position-weighted.

Orientation uses, in order:

1. A supplied stable up hint.
2. Sign-consistent averaged contact normals.
3. The widest valid support triangle as a geometric-normal fallback.
4. The last valid frame or current model frame when geometry is temporarily insufficient.

Forward and up are orthonormalized and sign-stabilized against the previous frame. The rig-spec `-X` forward and `+Y` up basis is mapped onto that support frame. The controlled fixture can then apply world/support offsets, thorax clearance, pitch, yaw, roll, and a 180-degree upside-down transform.

When all contacts temporarily disappear, the last valid frame is held instead of snapping to a world axis. Anchor placement and 180-degree inversion passed the module acceptance harness. Non-uniform ancestor scale is diagnosed but not fully compensated.

## 9. Weight distribution and web feedback

`SpiderLoadDistributor` owns one `TemporaryStrandContact` per registered foot. Only planted, valid, traversable contacts are eligible for load.

Two simple modes exist:

- **Equal:** every eligible foot receives the same fraction.
- **Position-weighted:** a bounded inverse distance to the supplied support center favors nearer supports.

The configured total is force in newtons. The distributor normalizes eligible weights, applies each downward force at that foot's exact material address, and reports total requested weight, eligible/loaded foot counts, mean load, distributed load, applied web load, absolute mismatch, relative mismatch, and per-foot allocation.

Phase 7 adds a backward-compatible per-foot load factor. Existing Phase 6 behavior remains factor 1. The selected foot is factor 0 through lift, swing, test, and plant, then ramps continuously to factor 1 during `loading`; normalization redistributes the same configured total over the remaining eligible feet throughout the transfer.

Releasing four feet therefore redistributes the same requested total across the remaining four eligible contacts. A failed or invalid foot is excluded cleanly; it cannot poison another foot's load. This is a stable validation model, not a complete biological balance or grip/friction model.

## 10. Debug rendering and controls

`SpiderDebugRenderer` is presentation-only. Independent toggles cover:

- Skeleton and bone axes.
- Foot targets and planted-contact rings.
- FootHome references.
- Comfortable and maximum reach ranges.
- Reach ratio and explicit invalid/unreachable states.
- Contact tangent/normal/binormal.
- Per-foot load.
- Support center and body forward/up axes.
- Rig-name validation.

`SpiderDebugPanel` exposes total weight, body XYZ offsets, pitch/yaw/roll, thorax height, distribution mode, individual foot/address editing, scenario fixtures, disturbance strength, pause, fixed single-step, and reset.

The rig-validation error path is visible in the lab instead of silently hiding a bad asset.

The additive `LocomotionDebugRenderer` independently shows the requested destination, local travel direction, eligible/rejected legs, accepted and rejected candidate points, score labels, winner, current state, swing curve, moving foot, stable support set and polygon, probe force, load-transfer amount, body-advance vector, and exact failure. `LocomotionDebugPanel` can issue or only plan each validation scenario, execute a frozen plan, cancel, reset, adjust support/search/sampling/timing/probe/body values, edit every score weight, and toggle each overlay. `freezeAfterPlanning` deliberately leaves the controller in `planning` so the one-shot decision can be inspected before execution.

## 11. Validation status

### Completed module and asset checks

- TypeScript and Vite production build passes.
- Rig specification accepts the supplied document and rejects invalid reach ordering.
- Exact-name hierarchy fixture resolves 85/85 required bones and preserves non-identity asset transforms.
- Missing/duplicate/wrong-type/hierarchy reports are explicit; duplicate required-name rejection passed.
- Raw GLB audit matches the resolved hierarchy and contains no animation that can override the procedural pose.
- Contact/load acceptance covers semantic attachment, moving-strand re-resolution, clean release/rebind, invalid-foot isolation, equal and position-weighted distribution, and four-foot redistribution.
- Five- and six-segment IK sweeps, invalid target handling, overreach reporting, stable bend bias, body-anchor placement, and upside-down body pose pass.

### Integrated browser scenarios

The composition-root integration was exercised in the in-app browser using the production defaults:

| Scenario | Acceptance condition | Result / measured value |
| --- | --- | --- |
| A — neutral suspended | 8/8 addresses valid; no foot-address drift; all legs at or below maximum reach | **Pass:** 8/8 loaded, max reach 86.1%, max IK residual 0.012 mm, 2.400 N applied, 0 mismatch |
| B — web disturbance | Disturbed silk moves; semantic address stays fixed; IK follows; load remains applied | **Pass:** all addresses unchanged; contacts moved 0.008–0.029 units with sampled velocity up to 0.312 units/s; max IK residual 0.050 mm; load stayed 2.400 N |
| C — small translation | Planted addresses stay fixed; leg articulation absorbs motion; invalid reach is visible | **Pass:** 8/8 addresses unchanged and valid, max reach 98.2%, max IK residual 0.956 mm. Manual L1 → `support-r4 @ 0.020` reported `extended-reach` at 178.1%, removed that foot from load and support-center fitting, and left the other seven finite |
| D — 90° and upside-down | Finite body/chain transforms; no convention-driven left/right inversion | **Pass:** 8/8 valid in both; body up resolved to `-Z` at 90° and `-Y` inverted; max reach 90.3%, max residual 0.252 mm, all preferred-bend dots positive |
| E — four-foot support | 4 loaded feet; total applied load approximately equals requested weight | **Pass:** L1/L3/R1/R3 each carried 0.600 N; total 2.400 N, 0 mismatch, contact displacement up to 0.0197 units, finite IK |

The optional position-weighted mode produced eight non-equal loads from 0.2228 N to 0.3470 N that summed to 2.400 N with zero reported mismatch. Pause, one fixed step, resume, and complete fixture reset were also verified; reset returned all eight canonical addresses and 8/8 valid contacts.

### Phase 7 integrated browser scenarios

The production composition was exercised in the in-app browser through the complete one-shot controller:

| Scenario | Measured regression result |
| --- | --- |
| Forward | **Pass:** completed the secure lift/swing/probe/plant/load/body sequence; all contacts finished valid and fully loaded, with local-frame planning retained. |
| Alternate strand | **Pass:** completed on explicitly connected alternate silk with probe-before-load and exact semantic addressing. |
| Unstable rejection | **Pass:** rejected the unsafe choice and completed on stable active main silk. |
| Upside down | **Pass:** completed in the inverted local frame. Support up was approximately `(0.162, -0.987, 0.004)` and body up `(0.167, -0.986, 0.006)`; all contacts remained valid/loaded and maximum physical reach was `0.970`. |
| No valid step | **Pass:** stopped `failed / no-valid-candidate` after 713 candidates: 45 geometrically accepted and 668 rejected. Body motion remained absent and all 8 contacts stayed planted, valid, and fully loaded. |

These are standalone Phase 7 runs: the probe still precedes planting, full load precedes standalone body motion, and no second step starts automatically. The Phase 8 hybrid layer's `0.35` hold is opt-in through `CoupledTransferTransaction`.

### Phase 8 hybrid integrated junction validation

The implementation must be validated through the in-app browser on a fully restarted Vite server at the normal fixed `1/120 s` physics cadence. Earlier measurements from the fully emergent generic-scoring policy are not results for this hybrid milestone.

| Scenario | Required terminal behavior | Fresh-server result |
| --- | --- | --- |
| A — forward branch | `junction-forward` and `arrived` | **Pending** |
| B — angled / underside | `roll-under` and `arrived` | **Pending** |
| C — false crossing | `route-invalid` before a step | **Pending** |
| D — local invalid contact | Bounded local recovery, then arrival when a valid alternative exists | **Pending** |
| E — repeated blockade | Bounded alternatives, restore, explicit safe failure | **Pending** |
| F — cancellation | Restored cancellation with no later transaction | **Pending** |

The browser-facing `data-phase8-diagnostics` snapshot and development QA hook expose fixture topology, routes, selected strategy/stage, its leg-band/contact/body directive, coordinator transitions, simplified strategy progress, recovery candidates, fault state, atomic controller status, support/load state, restoration, and the terminal reason without making those diagnostics authoritative.

## 12. Tuning defaults

| Setting | Default | Meaning |
| --- | ---: | --- |
| Spider total weight | 2.4 N | Requested load distributed over eligible planted feet |
| Thorax height | 0.2 units | Clearance along support-frame up |
| Load mode | Equal | Position-weighted mode is optional |
| IK iterations | 24 | Integrated Phase 6 FABRIK pass limit (module default is 18) |
| IK tolerance | `0.001` | Integrated world-space target tolerance (module default is `1e-4`) |
| IK bend bias | 0.5 | Integrated rest-pose pole correction strength (module default is 0.42) |
| Joint-limit enforcement | Render off / planning mirror on | Phase 6 animation is preserved; Phase 7 candidates use detached constrained solves |
| Web fixed step | `1/120 s` | Shared Phase 5–8 simulation cadence |

Phase 7 policy and motion defaults are:

| Setting | Default | Meaning |
| --- | ---: | --- |
| Minimum loaded support feet | 5 | Hard lower bound after excluding the moving foot |
| Candidate search radius | 0.78 units | Local FootHome-centered semantic search |
| Candidate samples per strand | 11 | One-shot density; closest/route/current samples are added separately |
| Minimum score / progress improvement | 0.08 / 0.08 | Required improvement over the current-contact baseline |
| Remaining-leg reach reserve | 0.97 | Maximum predicted normalized reach before lift/body advance |
| Minimum foot spacing | 0.13 units | Candidate and support-layout spacing guard |
| Swing duration / lift | 0.82 s / 0.18 units | Local-frame cubic trajectory |
| Approach angle | 34° | Converts the final descent clearance into approach distance |
| Test duration / probe force | 0.30 s / 0.18 N | Temporary-contact validation before planting |
| Plant hold / load transfer | 0.14 s / 0.48 s | Zero-load settle followed by smooth 0 → 1 transfer |
| Body advance duration / maximum distance | 0.55 s / 0.10 units | One eased, reach-clamped translation |
| Route look-ahead / local route limit | 0.52 / 1.45 units | Short intent only; longer travel is reported, not executed |
| Freeze after planning | Off | Plan-only mode or this toggle can hold the inspectable decision |

The existing web gravity, damping, stiffness, solver-pass, density, and strain-guard behavior remains documented by the Phase 5 implementation.

Phase 8 hybrid settings are detached, validated policy objects. The mounted panel edits scheduler, junction, body-motion, and local-recovery bounds. Branch metadata can tighten support, crossing, spread, and trailing-reach thresholds; no control bypasses Phase 7 eligibility, topology, the support minimum, or physical reach.

### Phase 8 hybrid integrated tuning

| Setting | Integrated value |
| --- | ---: |
| Maximum coupled transactions | `256` outer route bound; roll-under stages remain `12` each |
| Settle interval | `0.14 s` |
| Material/world arrival tolerance | `0.30 / 0.30` |
| Partial load hold | `0.35` |
| Partial-load/body-motion timeouts | `1.20 s / 1.25 s` |
| Maximum translation / rotation per transaction | `0.100 / π÷14` (`0.2244 rad`) |
| Runtime hard-reach tolerance | `1 + 1e-6` (numerical epsilon only) |
| Weighted support minimum / broadness | `5 / 0.045` |
| Roll-under geometry threshold | `π÷12` (`0.2618 rad`) support-plane turn |
| Strategy alignment / reach warning | `π÷18 / 0.90` |
| Roll-under new-plane contacts | `2` exploratory, `3` to finish rotation, `5` to resume generic |
| Body progress before clear stage | `0.30` |
| Maximum ordinary no-progress transactions | `8` (one complete secure leg cycle) |
| Maximum stagnant / total transactions per stage | `4 / 12` |
| Maximum distinct roll-under atomic alternatives | `3` |
| Maximum local semantic recovery attempts | `4` |
| Roll-under semantic seed neighborhood | `0.09` material distance |
| Normal candidate search | `0.78` radius, `11` samples/strand, `0.13` spacing |
| Phase 8 foot timings | `0.42` swing, `0.12` probe/test, `0.08` plant, `0.22` final load, `0.28` body ease |
| Forward branch gates | 3 destination supports, `0.30` spread, `0.90` trailing reach, `0.42` body crossing |
| Angled branch gates | 2 destination supports, `0.32` spread, `0.999` trailing reach, `0.40` body crossing |

## 13. Known limitations

- Phase 8 proves one authored true-Y fixture and two explicit branches; it does not generalize arbitrary-degree or multi-junction traversal.
- The hybrid strategy deliberately encodes a small decision structure for difficult plane changes; it is not a universal or fully emergent locomotion policy.
- Weighted support is a compliant-silk heuristic, not a rigid-body balance, friction, adhesion, or tension-optimization solver.
- Translation/rotation fraction search is deterministic and finite rather than a continuous global pose optimizer.
- Recovery is limited to one bounded same/explicitly-connected invalid-contact search. Other stage failures exhaust their finite alternatives, restore, and stop; there is no global exploration or fallback route.
- Foot and body motion remain discrete coupled transactions, not a continuous biological gait or whole-body dynamics solver.
- The candidate sampler still inspects every strand in this compact fixture. A production web will need a semantic spatial index before increasing density.
- Collision, self-collision, grip friction, unilateral detachment, and continuous moving-silk swing collision remain outside scope.
- FABRIK remains positional. The moving-foot orientation policy stabilizes tangent and roll, but active distal gripping and whole-body orientation control remain future work.
- Candidate feasibility uses detached constrained mirror chains, but the authored limits remain approximate Euler guidance; the validated render-side FABRIK pass remains unconstrained.
- Non-uniform ancestor scale is reported but not fully corrected by IK/body placement.
- The GLB excludes Blender fur; distal leg weights can soften at extreme bends; the analytic pedicel blend and asymmetric fangs remain source-rig limitations.
- A discontinuous topology edit or exact 180-degree strand-tangent reversal still requires caller-level contact-frame policy.
- Visual polish, retreat memory, safety draglines, prey behavior, silk manipulation, and web construction/repair remain later work.
- Three.js keeps the production entry chunk above Vite's default 500 kB informational warning threshold before gzip.

## 14. Next locomotion milestone

The next milestone should generalize this bounded coordinator without weakening its safety contracts:

1. Select and follow longer semantic routes across multiple arbitrary junctions, with an explicit destination and finite global bounds.
2. Add a spatial index and route-local candidate scope suitable for larger webs.
3. Add new geometry-selected strategies only when a distinct topology class requires one; keep each stage and failure bound inspectable.
4. Develop higher-level cadence and gait policy only after repeated junction traversal remains stable under moving, damaged, and changing silk.
5. Preserve per-step secure-before-release, restoration, topology, reach, support, and stop diagnostics throughout that generalization.

Retreat memory, safety draglines, prey behavior, and all web construction/repair remain later layers. See [SPIDER_BEHAVIOR_REFERENCE.md](./SPIDER_BEHAVIOR_REFERENCE.md).

The Phase 8 hybrid milestone stops here: **fake the transition decision structure, not the physical contact.**
