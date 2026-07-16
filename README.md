# Silk Lab

A black widow that knows her own web.

**Silk Lab is not Bothria.** Bothria is the shipped v1.0 game. This is the R&D lab
where the spider and her silk are worked out; when it is done, its results get
ported over to upgrade Bothria. Nothing here should be called Bothria, and nothing
here imports from it.

The goal is one thing: a spider that a person watches and says *"that looks alive"*
about. An arachnologist finding small inaccuracies after five minutes is a price we
happily pay.

Priorities, in order: **beautiful movement, believable behaviour, stable code,
physical consistency, biological accuracy.** Where realism and elegance conflict,
elegance wins.

```powershell
npm install
npm run dev     # http://localhost:5173
```

Click the silk to send her there. `R` retreat · `F` freeze · `G` go far · `space` rest.

## The one rule

> **Fake decisions. Never fake contact.**

| Faked, deliberately | Real, always |
| --- | --- |
| Which foot moves, and when | Foot attachment to semantic silk |
| Which way she's "decided" to go | `{ strandId, t }` addresses |
| Posture, lean, abdomen sway | Web deformation under her weight |
| Confidence, hesitation, pauses | Vibration and force transfer |
| Step timing and rhythm | IK, reach limits, support |

Feet hold durable `{ strandId, t }` addresses on real strands. The IK solves to
wherever that silk actually is *this frame*, so a foot reaching for a thread that
is swaying under her own weight tracks it and lands on it. Her 2.4 N goes back into
the web and visibly moves it. None of that is decoration.

Everything else is stagecraft, and cheap on purpose.

## Architecture

```text
intent  ->  route (semantic, real)
        ->  route cursor: a { strandId, t } that walks the route
        ->  body chases the cursor, clamped by real leg reach
        ->  feet fall behind their FootHome -> they ask to step
        ->  gait grants permission (two anatomical rules)
        ->  foothold search finds REAL silk, or she goes without
        ->  swing tracks the live address -> plants
        ->  IK solves to real contacts -> load returns to the web
```

`src/spider/choreography/` — the whole thing, ~1,400 lines, portable. It imports
only the rig, the semantic web, and the contact/IK/load layer, so it can be lifted
into the game as-is.

| Module | Does |
| --- | --- |
| `SpiderChoreographer` | The conductor. Owns the body, drives everything below. |
| `Intent` | The player's entire vocabulary: travel, attend, retreat, freeze, rest. |
| `Gait` | Which foot moves next. Desire from real geometry, permission from two rules. |
| `FootholdSearch` | The part not allowed to invent anything. Real silk or null. |
| `StepMotion` | One leg in flight, tracking a live address. |
| `RouteFollower` | A cursor that walks a route as a semantic address. |
| `Personality` | Confidence, pauses, breathing. Entirely invented. |
| `ChoreographyConfig` | Every tunable, in one place. |

The soul it stands on is unchanged and was already good: `WebNetwork`,
`WebPhysicsSolver`, `StrandTraversal`, `SpiderRig`, `SpiderFootContact`,
`SpiderIKSolver`, `SpiderBodyPose`, `SpiderLoadDistributor`.

### Decisions worth keeping

**The gait is emergent, not scheduled.** Desire comes from real geometry (how far a
foot sits from where the body wants it, how stretched it is, whether it has ended
up across the midline). Permission comes from two rules a spider obeys anyway:
never lift the neighbour of a leg already in the air, and leave enough feet down.
Alternating tetrapod falls out on its own — and *irregularly*, because drift depends
on real terrain. The old architecture spent thousands of lines manufacturing that.

**The body owns its position; the support frame owns its orientation.** Defining
the body as "support centroid + offset" is the tempting version and it poisons
everything: the centroid jitters with every step, and invalid contacts drop out of
it, so one over-stretched leg shifts the centroid and over-stretches the next.

**Reach is a per-leg constraint, not a scalar leash.** The body may only go where
the legs can still hold it — solved per foot, in ~20 lines. A "distance from the
centroid" cap cannot express this: the centroid sits well inside its limit while a
trailing leg is stretched half again past its maximum. Replaces the old
`ReachBudgetController` (32 KB) outright.

**Crossing is a midline question.** A left foot belongs on the left; that is the
whole rule, and it is the only thing constraining leg direction. Constraining each
leg to a cone around its own rest direction sounds equivalent and is a trap — see
below.

Roll-under, junction crossing and hanging inverted are not implemented. They
emerge, because the body's orientation comes from real contact normals. There is no
`TransitionStrategyController` and no maneuver list.

## Traps found the hard way

Each of these looked right, measured wrong, and cost real time. They are recorded
because the next person will be tempted by every one of them.

**Never measure the web in normalized `t`.** `t` is a fraction of one strand, so a
fixed `t` is a different real distance on every strand — and silently wrong the
moment strand lengths change. Foot spacing of "0.075 t" was fine at sub-legspan
spans and became half a unit of dead zone at room scale; her feet crowded each
other off the only silk there was and she walked a long span on four legs. All
distances in `FootholdSearch` are model units, converted per strand.

**Don't constrain a leg to a cone around its rest direction.** A leg's rest
direction points out to the side, but a spider walking a single long strand can only
put her feet fore and aft along it — ~90° off rest. A 72° cone rejected the only
silk in existence: `avgPlanted` fell from 6.7 to 3.9 and arrivals from 8/8 to 1/4.
The midline rule forbids exactly the bad thing and nothing else.

**Don't trigger steps on "body movement since the foot planted."** It is zero at
equilibrium by construction, so it reads zero in exactly the pose where a step is
most needed — body straining forward, feet trailing, nothing asking to move. She
wedged solid. Distance from FootHome stays large in that pose.

**Don't penalise only reach *beyond* comfortable.** Of two candidates equally far
from the aim, the one tucked under the body then scores free while the properly
extended one pays, so every foot creeps inward and she walks permanently crouched.
The rig authors FootHome at exactly the comfortable reach; deviation either way is
equally wrong.

**Don't measure ring-down by when displacement first goes small.** A ringing string
passes through rest every half period, so that measures the period and calls a
lively web dead. Track the envelope.

## Rig findings (these are rig work, not runtime work)

**The GLB has no material.** It ships an untextured pure-white `MeshStandard`
material at roughness 1 — a rig deliverable, not an art asset — so she renders as a
pale plastic model. The lab applies a near-black glossy material at runtime
(`dressAsWidow`). The gloss does most of the work: the moving specular across the
abdomen is what sells wet chitin.

**The authored joint limits are unusable as-is, and this is the Blender work.** The
spec's own note calls them "APPROXIMATE ... Validate/tune in engine". Enforced
verbatim the solver clamps ~3.75 joints per solve and reports `joint-limited` on
981 of 1011 solves, and the feet float an average of **0.19** model units off the
silk they claim to hold (worst 0.98 — most of a leg's reach). A foot visibly not
touching its strand is a worse lie than a leg bending oddly, so limits lose.
Widening to 2.5× still detaches by 0.19.

The cause is that the limits are authored relative to the GLB bind pose, and a
walking pose is nowhere near it. `jointLimitScale` is wired and defaults to **0**;
set it above 0 once the ranges are re-authored against a real stance. Until then leg
direction is kept honest by the midline rule, which costs no contact fidelity.

## Behaviour under stress

She is allowed to fail, and says so (`state.stranded`). But she does not wedge:

- A leg with **nowhere to stand lets go** and holds itself up, rather than freezing
  the spider. A leg stretched to its limit vetoes body motion in every direction; if
  it also may not release, she is stuck in a pose where nothing is wrong.
- A leg that **keeps finding nothing stops asking** and simply holds in the air.
  Re-searching from a body that is not moving re-searches the same unchanged web and
  fails the same way, which reads as a leg jittering against nothing. It looks again
  once the body has moved somewhere the answer could differ. A parked spider holds
  the leg indefinitely — which is what a parked spider does.
- The body is kinematic and cannot fall, so hanging by three feet for a moment is a
  fine price for getting unstuck.

## The test web

`createCobweb` builds a taut, springy, irregular cobweb in the corner of a room:
fixed anchors on a floor, two walls, a ceiling and a crate; a sparse tangle; gumfoot
lines to the floor; a retreat knot in the corner. It is a *fixture*, not the game's
web builder — in the game **the spider builds the web**, and it will lose tension
over time for the player to command repairs. `setTautness(strandId, x)` exists to
prove the model carries per-strand tension for that loop to drive.

Two properties matter, and both were got wrong first:

**Scale is measured in legspans, because a web is built by a spider.** She is 1.63
units across. The first version put nodes a median of **0.32 legspans** apart —
three times finer than she is wide. She straddled six at once, every foothold landed
on a junction, and the IK spent its life resolving a knot: she got stuck in her own
web. Now nodes are ≥2.1 legspans apart and spans run 2–5 legspans, so she walks a
real stretch of silk between junctions.

**Taut and bouncy are not opposites — a guitar string is both.** What kills bounce
is short segments and heavy silk. Deflection under a point load goes as `W·L/(4T)`,
so long spans and light tension keep her able to move her own web. The first taut
version used the old `linearDensity` of 0.14, which at room-scale spans made every
strand weigh ~4 N against a 2.4 N spider — **she was lighter than the web she stood
on** and could not stir it (silk near her moved 0.04 legspans). Silk is now nearly
massless (0.012), tension fell from 13.8 to ~1.9, and a ping rings for ~1.1 s over
6–9 oscillations. She pulls on the web; the web pulls back.

Spans are laid **doubled and bowed apart** by a fraction of a legspan. A lone thread
through open space leaves the middle legs nothing within reach on either side.

Web tuning is reachable from the query string for sweeps:
`?tautness=0.997&damping=0.3&density=0.02&stiffness=0.8&seed=7`

## Measured

Six journeys across the room-scale cobweb, four of them full ~17-unit traverses,
driven through the ordinary fixed-step loop:

| | |
| --- | --- |
| Arrivals | 5 / 6 |
| Feet planted, average | 6.43 of 8 |
| Stance vs. comfortable reach | 0.80 |
| Worst reach vs. anatomical max | 1.05 (transient; the web pulls her) |
| Feet across the midline | 0.64% of samples |
| Weight returned to silk | 2.4 N across 8 feet |
| Ring-down after a ping | ~1.1 s over 6–9 oscillations |

The remaining stall is a long retreat route across sparse silk. She reports it
(`stranded`) rather than wedging.

## The old lab

The Phase 8 instrument still lives at **`/lab.html`** — untouched, still building,
still driving `src/main.ts` and `src/spider/{locomotion,traversal}`. That is ~12,200
lines of decision machinery, none of which the showcase loads. It is not on the path
to the illusion, but it is the only place the internals are visible, and this
repository is not under version control, so nothing was deleted.

```text
src/
  spider/choreography/   The new layer. Start here.
  spider/                Rig, contacts, IK, body pose, load  (the soul)
  web/, physics/         Semantic web + fixed-step silk       (the soul)
  traversal/             Addresses, frames, routes            (the soul)
  demo/                  Showcase scene and silk renderer
  spider/locomotion/     Superseded — Phase 7 machinery
  spider/traversal/      Superseded — Phase 8 machinery
  main.ts                Superseded — the Phase 8 lab
```

`DEVELOPMENT.md` and `SPIDER_BEHAVIOR_REFERENCE.md` describe the superseded
architecture.
