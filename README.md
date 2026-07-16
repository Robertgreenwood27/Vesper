# Vesper

An autonomous pet black widow living in a taut, responsive three-dimensional web.

The application favors a convincing creature over strict simulation. Semantic
silk addresses guide routes, suggested contacts return a little weight and
vibration to the web, and a cinematic gait keeps Vesper moving quickly and
elegantly when exact contact would look worse.

## Run

```powershell
npm install
npm run dev
```

Open `http://localhost:5173`.

## Interactions

- Click a strand to suggest a destination.
- Offer a moth to trigger a hunt.
- Touch the web to send a recognizable vibration.
- Send Vesper to her retreat.
- Toggle camera tracking or the red observation light.
- Keyboard: `R` retreat, `F` freeze, `G` travel far, `Space` rest.

Her name, appetite, familiarity, visits, and feedings are stored locally in the
browser.

## Autonomous life

Vesper does not wait for input. Her dominant instinct shifts with appetite,
familiarity, recent contact, and the local time of day. Left alone, she patrols
anchors, seeks shadow, listens through the silk, grooms, repairs the open web,
and can hunt wild gnats that blunder into it. Fresh safety lines remain visible
for a while before fading into the older web.

The **silk memory** records her latest self-directed choices across visits. If
you return after time away, the habitat also recalls what she did while the room
belonged to her.

## Architecture

```text
src/demo/             habitat, pet behavior, presentation, silk rendering
src/spider/           rig loading, body pose, IK, suggested contact and load
src/spider/choreography/
                      cinematic intent, routes, gait, and personality
src/traversal/        semantic strand addresses and route planning
src/web/              compact taut web topology and particles
src/physics/          fixed-step web response
public/assets/spider/ runtime rig and specification
Spider/               editable Blender source and rig development notes
```

`npm run build` type-checks the complete production source before creating the
static Vite build.

## History and recovery

The repository was initialized immediately before the old research lab was
removed. Commit `eec8164` contains the complete pre-cleanup project, including
the Phase 7/8 locomotion experiments, debug UI, fixtures, tests, and notes.
