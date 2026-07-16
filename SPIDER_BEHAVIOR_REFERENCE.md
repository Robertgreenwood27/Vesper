# Spider Behavior Reference

## Purpose

This document turns the supplied black-widow observations into a staged design target for Bothria. It is a behavioral reference, not a claim that every biological action must become a mandatory player-facing mechanic.

The player should provide a destination or behavioral intention. The spider, not the player, should eventually choose the route, body orientation, and sequence of footholds:

```text
player intent
  -> semantic route
  -> body-path planning
  -> body orientation
  -> gait decision
  -> foot-contact selection
  -> procedural IK
  -> weight transferred into the web
```

Phase 6 supplies the stationary mechanical foundation. Phase 7 proves one autonomous secure-before-release step. Phase 8 now repeats that unchanged atomic transaction to deliberately cross one explicit true-Y route, with per-step reassessment, support-driven body orientation, bounded local recovery, and explicit terminal states.

Phase 8 is still not unrestricted roaming, autonomous destination choice, or a general biological gait system.

## Status definitions

- **Implemented now:** a validated Phase 5–8 capability exists in the runtime. Phase 8 scope means one bounded multi-step traverse of the authored true-Y fixture.
- **Planned next:** generalizes bounded traversal to larger routes, arbitrary junctions, broader recovery, and higher-level cadence without weakening secure-before-release guarantees.
- **Long-term behavioral target:** informs architecture now but remains outside local traversal development.
- **Deliberately simplified:** represented with a readable game abstraction rather than exhaustive biological procedure.

## Principle traceability

Every traversal and construction principle supplied for this phase is retained below.

| Supplied principle | Status | Current interpretation |
| --- | --- | --- |
| Maintain awareness of the destination and retreat direction. | Implemented now / long-term | Phase 8 retains the full destination route, current short route, next explicit transition, branch, body progress, and arrival state through several steps. Persistent retreat direction and retreat memory remain long-term. |
| Sense and evaluate silk through current contacts. | Implemented now | Each foot and candidate resolves position/frame, material velocity, approximate tension, validity, reach, support side, and carried load after every settled step. |
| Identify reachable strands using exploratory legs. | Implemented now | Phase 7 supplies continuous per-leg foothold candidates; Phase 8 adds an explicit connected-branch test and bounded nearby recovery candidates when expected contact is missing. |
| Prefer strands based on direction, stability, familiarity, and connectivity. | Implemented now / long-term | Direction/progress, tension/motion stability, reach, support layout, explicit topology, recent-leg history, trailing urgency, and future flexibility influence selection. Persistent familiarity still requires long-term memory. |
| Secure a new foothold before releasing an old one. | Implemented now | Every Phase 8 move is an unchanged Phase 7 atomic transaction: one foot unloads, the target is probed and planted, full load returns, and only then may body or subsequent-foot motion proceed. |
| Reorient the body around the selected support geometry. | Implemented now | A sign-continuous support-relative frame blends route direction and destination-contact normals, then clamps translation and rotation by held-leg reach and sampled silk clearance. |
| Transfer the remaining legs after a secure contact exists. | Implemented now | The coordinator establishes a counted, spread, bilateral destination-side support set before body commitment, then schedules trailing-leg catch-up as separate secure atomic steps. |
| Deliberately test branches at junctions. | Implemented now | A bounded junction test enumerates only strands explicitly attached to the true-Y node and selects the branch retained by the semantic route. Projection-only crossings are excluded. |
| Perform localized searching when an expected contact is missing. | Implemented now | A finite recovery search samples nearby continuous addresses on the same and explicitly connected strands, with visible candidates, attempt limits, and stable failure on exhaustion. |
| Use broader reorientation if the local web no longer matches expectations. | Planned next / long-term | Phase 8 can clamp a local body proposal and retry locally; broad whole-body search or global route replanning after exhausted recovery remains future work. |
| Maintain a safety dragline during risky movement. | Long-term behavioral target | Spinneret references already exist, but dragline creation, attachment, payout, and recovery do not. |
| Explore while laying a dragline. | Long-term behavioral target | Couple future exploration to optional safety-silk creation rather than the bounded traversal fixture. |
| Create environmental frame lines. | Long-term behavioral target | Requires construction planning, environmental anchors, and topology mutation. |
| Establish a central working mesh and retreat connection. | Long-term behavioral target | Requires persistent spatial/topological memory and a construction objective. |
| Expand a sloping locomotion sheet. | Long-term behavioral target | Requires material placement and structural evaluation beyond route traversal. |
| Add irregular three-dimensional support lines. | Long-term behavioral target | The data model represents these lines, but no behavior creates them. |
| Build gumfoot capture lines through controlled descent, tensioning, adhesion, cutting, replacement, and silk manipulation. | Long-term behavioral target | This is a multi-stage construction system, intentionally far beyond local traversal milestones. |
| Reinforce, repair, and reorganize the web over time. | Long-term behavioral target | Requires damage/history sensing, topology edits, material budgets, and persistent goals. |
| Make deliberate rather than perfectly periodic choices. | Implemented now | Geometry, route progress, support, score improvement, recent-leg history, trailing urgency, and side balance influence the next foot. There is no fixed repeating leg order. |

## Implemented now — secure support, atomic stepping, and one true-Y traverse

Phase 6 remains the mechanical foundation:

- **Secure contacts:** eight independent feet own continuous `{ strandId, t }` addresses, remain attached as silk moves, release cleanly, and report validity. Security is explicit state, not an inferred nearest particle.
- **Support geometry:** contact frames and a weighted support center provide stable local tangent/normal/binormal and body support axes.
- **Body placement:** the controlled fixture can translate, rotate 90 degrees, and turn upside down while targets remain semantic web contacts.
- **Load:** equal or position-weighted per-foot force is returned to the physical web, with total/mismatch diagnostics.
- **Probing signals:** every planted foot exposes silk velocity, approximate tension, reach, FootHome preference, and validity.
- **Stable articulation:** variable-length procedural IK compensates for target and body movement while preserving a rest-derived bend convention.

Phase 7 supplies the atomic transaction reused unchanged by Phase 8:

- **One exploratory secure-before-release step:** a nearby semantic destination produces one selected leg and continuous foothold, while all non-moving feet retain their addresses.
- **Inspectable local scoring:** progress, reach, FootHome, stability, connectivity, support spacing, joint feasibility, rotation, crowding, crossing, weak/moving silk, and reduced support stay visible per candidate.
- **Probe and transfer:** a local-frame swing reaches a temporary semantic probe; successful testing creates a zero-load plant, then load ramps to full before body advance.
- **Safe completion/restoration:** reach, support, contact, and IK guards remain active throughout; failure or cancellation restores the atomic foot/body state.

Phase 8 adds a deliberate bounded sequence above that atomic authority:

- **Explicit true-3D route:** approach, forward, and angled main strands meet at one authored Y. Companion and weak optional supports remain distinct from route transitions. A visible crossing in another connected component stays non-navigable.
- **Settle and reassess:** after every completed step, the coordinator waits for a bounded settle interval, then re-reads route, contacts, support, reach, body progress, and history before requesting anything else.
- **Non-periodic history:** recent repeats are discouraged while trailing reach, side balance, support breadth, and future flexibility can bias the next safe Phase 7 choice.
- **Branch establishment:** approach/junction/destination/trailing classification, bilateral support, world spread, and trailing reach determine whether another foot must transfer or the body may commit.
- **Bounded body orientation:** support-relative translation and rotation ease toward the selected branch only to the reach- and clearance-accepted fraction.
- **Local missing-contact recovery:** a finite semantic neighborhood is explored; exhaustion stops explicitly rather than snapping a foot or searching the world indefinitely.
- **Inspectable scheduling:** run-to-arrival and pause-after-step modes share maximum-step, failure, recovery, branch-test, and body-commit bounds. Arrival, failure, and cancellation are terminal.

This is multi-step locomotion through one deliberate junction course. It is not a free-roaming route executor or full gait library.

## Planned next — general bounded traversal

The next milestone should preserve the Phase 7 atomic contract and Phase 8 stop discipline while broadening scope:

1. Follow longer explicit semantic routes across several arbitrary junctions.
2. Add a route-local spatial index so candidate search scales beyond a compact fixture.
3. Escalate exhausted local recovery into a visible broader body reorientation or route-replan stage.
4. Validate moving, damaged, and changing silk before introducing persistent cadence or autonomous destination selection.
5. Retain per-step history, support, reach, topology, restoration, and terminal diagnostics throughout.

That next layer still should not silently add retreat memory, safety silk, prey behavior, or construction.

## Long-term behavioral target

### Traversal resilience

- Replan routes and perform broader body reorientation when local silk differs from expectation.
- Maintain retreat memory beyond the immediate previous step.
- Use spinneret references to maintain a safety dragline during risky traversal.
- Explore new space while paying out that dragline.
- Select destinations and cadence from a higher-level behavior goal without sacrificing bounded recovery and explicit stops.

### Construction progression

- Select environmental anchors and create frame lines.
- Establish a central working mesh with a deliberate retreat connection.
- Grow a sloping locomotion sheet.
- Add irregular three-dimensional support lines.
- Execute a readable gumfoot sequence: controlled descent, tensioning, adhesion, cutting, replacement, and silk manipulation.
- Reinforce, repair, and reorganize existing topology over time.

The construction architecture should reuse semantic nodes, strands, continuous addresses, spinneret references, and explicit topology edits. It must not author navigation by simulation-particle index.

## Deliberately simplified for fun and usability

- **Intent over micromanagement:** direct eight-leg control is not a gameplay requirement. The spider interprets a destination or behavioral goal.
- **Readable decisions:** scoring and history compress local sensory complexity into inspectable direction, reach, stability, connectivity, support, and recent-movement values.
- **Stable balance model:** equal or position-weighted load plus conservative support checks is acceptable until a richer frictional balance model materially improves motion.
- **Practical IK:** rest-biased FABRIK and approximate joint guards prioritize stable silhouettes over exhaustive arachnid biomechanics.
- **Contact abstraction:** a planted material address stands in for microscopic claws, adhesion, friction, and silk handling until those details support a clear mechanic.
- **Bounded search:** missing-contact recovery uses an understandable finite local stage, not an unbounded biological simulation.
- **Compressed construction:** frame, sheet, support, gumfoot, repair, and reinforcement actions may be grouped or assisted. Every observed sub-action need not become a separate player command.
- **Optional biological texture:** safety, retreat, probing, and construction behaviors should enrich animation and strategy without turning every observation into a compulsory procedure.

## Milestone boundary

Phase 8 has now established the following runtime contracts:

- Several explicit Phase 7 atomic transactions can be scheduled without allowing two feet to move at once or bypassing secure load transfer.
- A retained semantic route can cross an authored true Y through approach, branch-support, body-commit, and trailing-clearance stages.
- A second angled/underside branch uses the same generic policy and support-relative frame rather than a scripted limb sequence.
- Movement history can influence safe selection while Phase 7 remains the authority for reach, support, IK, and candidate validity.
- A projection-only crossing cannot become a route transition or branch even when visually close.
- A missing expected interval can trigger bounded semantic exploration; repeated failure stops stably after finite retries.
- Cancellation during a later transaction restores and terminates without scheduling another step.

Stop after that bounded junction traverse. Unrestricted roaming, autonomous destination choice, broader recovery, retreat memory, safety draglines, prey behavior, web construction, gumfoot construction, and repair remain future work.
