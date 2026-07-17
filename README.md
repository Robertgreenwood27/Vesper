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

## Put Vesper on your phone

The habitat is phone-first, safe-area aware, and installable as a standalone
web app. On iPhone, open the deployed site in Safari and choose **Share → Add to
Home Screen**. On Android, use **Install app** from the browser menu.

The included `vercel.json` makes the repository ready for a standard Vercel
import: build with `npm run build` and publish `dist`. The service worker keeps
previously visited habitat assets available when the connection gets spotty.

Phone controls:

- Drag to orbit and spin the habitat immediately; pinch to zoom.
- Tap silk to suggest a destination without interrupting camera gestures.
- Use the eye button whenever you want the camera to follow Vesper automatically.
- Open the **Info** and **Care** tabs only when you need them. Their state is
  remembered, and closing both leaves an unobstructed habitat view.

## Interactions

- Click a strand to suggest a destination.
- Offer a moth — it lands somewhere new and visible each time — to trigger a
  hunt, wrapping, a long still-parcel meal, and occasional prey caching.
- Touch the web to send a recognizable vibration.
- With the follow camera on, drag across the silk to brush it directly. She
  feels it, and sometimes turns toward the touch or comes to investigate.
- Send Vesper to her retreat.
- Toggle camera tracking or the red observation light.
- Keyboard: `R` retreat, `F` freeze, `G` travel far, `Space` rest.

Her own footfalls press into the silk as she walks, each landing ringing
briefly through the nearby web.

Her name, appetite, feedings, and a quiet history of how you treat her web are
stored locally in the browser. Nothing about that history is displayed — it
shows up only in how she behaves, and only slowly, across many calm visits.

## Autonomous life

Vesper does not wait for input. Her dominant instinct shifts with appetite,
temperament, recent contact, and the local time of day. Left alone, she patrols
anchors, seeks shadow, listens through the silk, grooms, repairs the open web,
and can hunt wild gnats that blunder into it. Fresh safety lines remain visible
for a while before fading into the older web.

The **silk memory** records her latest self-directed choices across visits. If
you return after time away, the habitat also recalls what she did while the room
belonged to her.

## Details worth waiting for

- **Dew.** In the small hours of the morning the web beads with condensation.
  Each drop rides a live physics segment, so her footfalls shake it, and it
  evaporates slowly once the day warms. (`?dew=1` forces it.)
- **A firefly.** Some nights, something small and luminous crosses the room in
  slow pulses. She tracks it the way she tracks everything: through stillness.
  (`?firefly=1` forces it.)
- **Eye shine.** Under the red observation light, her eyes catch and throw the
  light straight back — turn the lamp on her and the dark looks back.

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
