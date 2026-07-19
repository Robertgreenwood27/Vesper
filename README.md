# Vesper

An autonomous pet black widow living in a taut, responsive three-dimensional web.

The application favors a convincing creature over strict simulation. Semantic
silk addresses guide routes, planted contacts earn body travel and return a
little weight and vibration to the web, and a cinematic gait keeps Vesper moving
quickly and elegantly across sparse silk.

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

## Living weather

In production, the room quietly borrows the visitor's current conditions from
[Open-Meteo](https://open-meteo.com/). Vercel supplies coarse IP-derived
coordinates to the server function; only those coordinates are sent to
Open-Meteo, and the browser receives conditions without a place name or
location. Nothing is stored.

Weather is never named in the interface. High humidity slowly beads the glass
and can settle dew on the silk, cloud cover softens the cool room light, rain
deepens those wet-weather cues without rendering raindrops, and a thunderstorm
occasionally throws silent light from somewhere beyond the enclosure.

Review URLs:

- `?humidity=1` - heavy, slow-building condensation on glass and silk
- `?rain=1` - humid glass with cooler, cloud-muted daylight; no visible rain
- `?storm=1` - the rain treatment plus repeating exterior lightning
- `?lightning=1` - alias for `?storm=1`
- `?clouds=1` - fully overcast daylight
- `?clear=1` - clear dry daytime light
- `?dew=1` - the original silk-only dew treatment
- `?firefly=1` - the original nocturnal visitor
- `?weather=0` - disable the live Open-Meteo request (forced review effects
  can still be combined with it)

Flags can be combined, for example `?weather=0&rain=1` for repeatable local
review without a weather response.

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

## Private engagement analytics

The habitat records a small set of anonymous engagement signals in a private
Vercel Blob store. Events are counted at most once per browser tab, batched to
limit Blob operations, and contain no IP address, fingerprint, persistent
visitor ID, or raw interaction history. Preview and local deployments accept
the client calls without storing them. The tracker also honors browser Do Not
Track and Global Privacy Control signals.

Required Vercel configuration:

- Connect a private Blob store with the `BLOB` prefix and enable its read/write
  token, which creates `BLOB_READ_WRITE_TOKEN`.
- Add a secret `ANALYTICS_ADMIN_TOKEN` environment variable to Production. Use
  a long random value and never commit it.
- Redeploy after adding or changing either variable.

Visit `/stats/`, enter `ANALYTICS_ADMIN_TOKEN`, and choose a reporting window to
view the private aggregate dashboard. The token is retained only in that tab's
session storage. The dashboard API returns aggregate counters and never exposes
stored event batches.

## History and recovery

The repository was initialized immediately before the old research lab was
removed. Commit `eec8164` contains the complete pre-cleanup project, including
the Phase 7/8 locomotion experiments, debug UI, fixtures, tests, and notes.
