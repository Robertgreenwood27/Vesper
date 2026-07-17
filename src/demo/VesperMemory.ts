/**
 * Vesper's long-term memory of her keeper.
 *
 * Everything in here is deliberately hidden state: the UI never shows a number
 * from this file. The relationship is supposed to be *inferred* — a spider that
 * freezes less readily, investigates a touch she once fled from, or rests near
 * a strand her keeper favors. All calculations are pure and DOM-free so the
 * habitat can drive them and the numbers stay testable.
 *
 * Design constraints, in order:
 *  - progression is slow and farm-resistant (per-event, per-session, per-day caps)
 *  - absence never erodes the relationship; only stress resolves while away
 *  - temperament varies per save but must never make her frustrating
 */

// ------------------------------------------------------------------ constants

export const VESPER_STORAGE_KEY = "pet-black-widow:vesper:v2";
export const LEGACY_STORAGE_KEY = "pet-black-widow:vesper:v1";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A reload within this window is the same sitting, not a new visit. */
const SESSION_GAP_HOURS = 0.75;

/** Hard daily ceilings. Nothing the keeper does can move faster than this. */
const DAILY_FAMILIARITY_CAP = 0.045;
const DAILY_TRUST_CAP = 0.035;

/** Per-session credit ceilings for repeatable events. */
const SESSION_GENTLE_CREDITS = 3;
const SESSION_CALM_CREDITS = 3;
const SESSION_MEAL_CREDITS = 2;

const MAX_LOCATIONS = 8;
/** Two observations on one strand this close merge into one memory. */
const LOCATION_MERGE_SPAN = 0.22;
/** Location weights e-fold over roughly ten days of absence. */
const LOCATION_DECAY_HOURS = 240;

/** In-session stress half-life, seconds. */
const STRESS_HALFLIFE_ACTIVE = 300;
/** Offline stress half-life, hours — a night away resolves nearly all of it. */
const STRESS_HALFLIFE_AWAY = 1.5;

// ---------------------------------------------------------------------- types

export interface Temperament {
  /** Willingness to stay exposed and approach. 0.3..0.7. */
  readonly boldness: number;
  /** How strongly web disturbance registers. 0.3..0.7. */
  readonly vibrationSensitivity: number;
  /** How much prey pulls her attention. 0.3..0.7. */
  readonly foodMotivation: number;
}

export interface LocationMemory {
  strandId: string;
  t: number;
  /** Accumulated gentle-touch weight. */
  gentle: number;
  /** Accumulated disruptive-touch weight. */
  disruptive: number;
  /** Completed keeper-meal captures near here. */
  catches: number;
  /** Rest/patrol visits of her own. */
  calm: number;
  updatedAt: number;
}

export type LocationEventKind = "gentle" | "disruptive" | "catch" | "calm";

export interface VesperState {
  version: 2;
  name: string;
  hunger: number;
  feedings: number;
  /** Raw page loads. Legacy; never displayed. */
  visits: number;
  autonomousActs: number;
  silkMemories: string[];
  lastVisit: number;

  /** 0..1 — slow recognition of this keeper's recurring presence. */
  familiarity: number;
  /** 0..1 — history of calm versus persistently disruptive interaction. */
  trust: number;
  /** 0..1 — temporary sensitivity from recent disturbance. Decays fast. */
  stress: number;

  temperamentSeed: number;
  /** Distinct days on which a meaningful session happened. */
  visitDays: number;
  /** Day stamp (floor(epoch/day)) of the last counted visit day. */
  lastVisitDayStamp: number;
  /** Decaying per-hour-of-day presence counts, 24 entries. */
  visitHours: number[];

  locations: LocationMemory[];

  /** Last few autonomous behavior ids, newest first. */
  recentBehaviors: string[];
  /** Behavior id -> epoch ms when it becomes eligible again. */
  behaviorCooldowns: Record<string, number>;

  /** Daily progression bookkeeping. */
  dayStamp: number;
  familiarityGainToday: number;
  trustGainToday: number;
}

export interface SessionBudget {
  gentleCredits: number;
  calmCredits: number;
  mealCredits: number;
}

export interface LoadResult {
  state: VesperState;
  /** Hours since the previous save was written. 0 for a brand-new pet. */
  hoursAway: number;
  /** True when this load starts a genuinely new sitting, not a quick reload. */
  newSession: boolean;
  /** Fresh per-session credit budget. */
  budget: SessionBudget;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

// -------------------------------------------------------------------- helpers

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clampedNumber(value: unknown, fallback: number, min: number, max: number): number {
  return clamp(finite(value, fallback), min, max);
}

/** xorshift32 — the same generator the rest of the project uses. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

export function deriveTemperament(seed: number): Temperament {
  const rng = makeRng(seed);
  // Centered and narrow on purpose: temperament flavors her, it never gates her.
  return {
    boldness: 0.3 + rng() * 0.4,
    vibrationSensitivity: 0.3 + rng() * 0.4,
    foodMotivation: 0.3 + rng() * 0.4,
  };
}

export function freshSessionBudget(): SessionBudget {
  return {
    gentleCredits: SESSION_GENTLE_CREDITS,
    calmCredits: SESSION_CALM_CREDITS,
    mealCredits: SESSION_MEAL_CREDITS,
  };
}

// ------------------------------------------------------- creation & migration

function defaultState(now: number): VesperState {
  return {
    version: 2,
    name: "Vesper",
    hunger: 42,
    feedings: 0,
    visits: 0,
    autonomousActs: 0,
    silkMemories: [],
    lastVisit: 0,
    familiarity: 0.05,
    trust: 0.12,
    stress: 0.08,
    temperamentSeed: (Math.floor(Math.random() * 0xffffffff) ^ now) >>> 0,
    visitDays: 0,
    lastVisitDayStamp: 0,
    visitHours: new Array<number>(24).fill(0),
    locations: [],
    recentBehaviors: [],
    behaviorCooldowns: {},
    dayStamp: Math.floor(now / DAY),
    familiarityGainToday: 0,
    trustGainToday: 0,
  };
}

function sanitizeLocations(raw: unknown, now: number): LocationMemory[] {
  if (!Array.isArray(raw)) return [];
  const cleaned: LocationMemory[] = [];
  for (const entry of raw.slice(0, MAX_LOCATIONS)) {
    if (!entry || typeof entry !== "object") continue;
    const loc = entry as Partial<LocationMemory>;
    if (typeof loc.strandId !== "string" || !loc.strandId) continue;
    cleaned.push({
      strandId: loc.strandId,
      t: clampedNumber(loc.t, 0.5, 0, 1),
      gentle: clampedNumber(loc.gentle, 0, 0, 24),
      disruptive: clampedNumber(loc.disruptive, 0, 0, 24),
      catches: clampedNumber(loc.catches, 0, 0, 24),
      calm: clampedNumber(loc.calm, 0, 0, 24),
      updatedAt: clampedNumber(loc.updatedAt, now, 0, now + DAY),
    });
  }
  return cleaned;
}

function sanitizeState(raw: unknown, now: number): VesperState {
  const base = defaultState(now);
  if (!raw || typeof raw !== "object") return base;
  const saved = raw as Record<string, unknown>;

  const visitHours = Array.isArray(saved.visitHours)
    ? Array.from({ length: 24 }, (_, i) => clampedNumber(saved.visitHours?.[i as never], 0, 0, 8))
    : base.visitHours;

  const cooldowns: Record<string, number> = {};
  if (saved.behaviorCooldowns && typeof saved.behaviorCooldowns === "object") {
    for (const [id, at] of Object.entries(saved.behaviorCooldowns as Record<string, unknown>)) {
      const value = finite(at, 0);
      if (value > now - 7 * DAY && value < now + 7 * DAY) cooldowns[id] = value;
    }
  }

  return {
    version: 2,
    name:
      typeof saved.name === "string" && saved.name.trim()
        ? saved.name.trim().slice(0, 18)
        : base.name,
    hunger: clampedNumber(saved.hunger, base.hunger, 0, 100),
    feedings: Math.floor(clampedNumber(saved.feedings, 0, 0, 1e6)),
    visits: Math.floor(clampedNumber(saved.visits, 0, 0, 1e7)),
    autonomousActs: Math.floor(clampedNumber(saved.autonomousActs, 0, 0, 1e7)),
    silkMemories: Array.isArray(saved.silkMemories)
      ? saved.silkMemories.filter((item): item is string => typeof item === "string").slice(0, 3)
      : [],
    lastVisit: clampedNumber(saved.lastVisit, 0, 0, now + DAY),
    familiarity: clampedNumber(saved.familiarity, base.familiarity, 0, 1),
    trust: clampedNumber(saved.trust, base.trust, 0, 1),
    stress: clampedNumber(saved.stress, base.stress, 0, 1),
    temperamentSeed: Math.floor(clampedNumber(saved.temperamentSeed, base.temperamentSeed, 1, 0xffffffff)),
    visitDays: Math.floor(clampedNumber(saved.visitDays, 0, 0, 1e5)),
    lastVisitDayStamp: Math.floor(clampedNumber(saved.lastVisitDayStamp, 0, 0, 1e7)),
    visitHours,
    locations: sanitizeLocations(saved.locations, now),
    recentBehaviors: Array.isArray(saved.recentBehaviors)
      ? saved.recentBehaviors.filter((id): id is string => typeof id === "string").slice(0, 5)
      : [],
    behaviorCooldowns: cooldowns,
    dayStamp: Math.floor(clampedNumber(saved.dayStamp, base.dayStamp, 0, 1e7)),
    familiarityGainToday: clampedNumber(saved.familiarityGainToday, 0, 0, DAILY_FAMILIARITY_CAP),
    trustGainToday: clampedNumber(saved.trustGainToday, 0, 0, DAILY_TRUST_CAP),
  };
}

/** Builds a v2 state from a v1 save, preserving everything the keeper earned. */
function migrateLegacy(raw: unknown, now: number): VesperState {
  const state = defaultState(now);
  if (!raw || typeof raw !== "object") return state;
  const legacy = raw as Record<string, unknown>;

  if (typeof legacy.name === "string" && legacy.name.trim()) {
    state.name = legacy.name.trim().slice(0, 18);
  }
  state.hunger = clampedNumber(legacy.hunger, state.hunger, 0, 100);
  state.feedings = Math.floor(clampedNumber(legacy.feedings, 0, 0, 1e6));
  state.visits = Math.floor(clampedNumber(legacy.visits, 0, 0, 1e7));
  state.autonomousActs = Math.floor(clampedNumber(legacy.autonomousActs, 0, 0, 1e7));
  state.silkMemories = Array.isArray(legacy.silkMemories)
    ? legacy.silkMemories.filter((item): item is string => typeof item === "string").slice(0, 3)
    : [];
  state.lastVisit = clampedNumber(legacy.lastVisit, 0, 0, now + DAY);

  // The old single bond number seeds both slow axes, conservatively: an
  // established v1 pet starts recognisable, not devoted.
  const bond = clampedNumber(legacy.bond, 12, 0, 100) / 100;
  state.familiarity = clamp(bond * 0.55, 0, 0.55);
  state.trust = clamp(0.1 + bond * 0.45, 0, 0.55);
  // A rough visit history: assume every ~2 legacy visits was a distinct day.
  state.visitDays = Math.min(60, Math.floor(state.visits / 2));
  return state;
}

/**
 * Applies elapsed real time to a loaded state. Cheap by design: a handful of
 * closed-form adjustments, not a simulation of the hours away.
 */
function reconcileTimeAway(state: VesperState, now: number, hoursAway: number): void {
  if (hoursAway <= 0) return;
  state.hunger = clamp(state.hunger + hoursAway * 1.8, 0, 100);
  // Stress largely resolves while the app is closed.
  state.stress = clamp(
    state.stress * Math.pow(0.5, hoursAway / STRESS_HALFLIFE_AWAY),
    0,
    1,
  );
  // Old location observations gently lose weight. Familiarity and trust do not.
  const locationDecay = Math.exp(-hoursAway / LOCATION_DECAY_HOURS);
  for (const location of state.locations) {
    location.gentle *= locationDecay;
    location.disruptive *= locationDecay;
    location.catches *= locationDecay;
    location.calm *= locationDecay;
  }
  state.locations = state.locations.filter(
    (location) => location.gentle + location.disruptive + location.catches + location.calm > 0.05,
  );
  void now;
}

function rollDailyCaps(state: VesperState, now: number): void {
  const today = Math.floor(now / DAY);
  if (today !== state.dayStamp) {
    state.dayStamp = today;
    state.familiarityGainToday = 0;
    state.trustGainToday = 0;
  }
}

/**
 * Loads, migrates, validates, and time-reconciles the persisted state.
 * Corrupt or missing data recovers to sensible defaults without throwing.
 */
export function loadVesperState(storage: StorageLike, now = Date.now()): LoadResult {
  let state: VesperState | null = null;

  try {
    const rawV2 = storage.getItem(VESPER_STORAGE_KEY);
    if (rawV2) state = sanitizeState(JSON.parse(rawV2), now);
  } catch {
    state = null;
  }
  if (!state) {
    try {
      const rawV1 = storage.getItem(LEGACY_STORAGE_KEY);
      state = rawV1 ? migrateLegacy(JSON.parse(rawV1), now) : null;
    } catch {
      state = null;
    }
  }
  if (!state) state = defaultState(now);

  const hoursAway = state.lastVisit > 0 ? Math.max(0, (now - state.lastVisit) / HOUR) : 0;
  const newSession = state.lastVisit === 0 || hoursAway >= SESSION_GAP_HOURS;

  reconcileTimeAway(state, now, hoursAway);
  rollDailyCaps(state, now);

  if (newSession) {
    const hour = new Date(now).getHours();
    state.visitHours[hour] = clamp(state.visitHours[hour] * 0.98 + 1, 0, 8);

    const today = Math.floor(now / DAY);
    if (today !== state.lastVisitDayStamp) {
      state.lastVisitDayStamp = today;
      state.visitDays += 1;
    }

    // Showing up again, after real time away, is itself meaningful — and the
    // only progression a reload cannot farm, because reloads are not sessions.
    const hourFamiliar = state.visitHours[hour] >= 2 ? 0.004 : 0;
    grantFamiliarity(state, 0.012 + hourFamiliar);
  }

  state.visits += 1;
  state.lastVisit = now;
  return { state, hoursAway, newSession, budget: freshSessionBudget() };
}

export function saveVesperState(storage: StorageLike, state: VesperState, now = Date.now()): void {
  state.lastVisit = now;
  try {
    storage.setItem(VESPER_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Private browsing may refuse storage; the pet still works for this visit.
  }
}

// ------------------------------------------------------------ event updates

function grantFamiliarity(state: VesperState, amount: number): void {
  const room = Math.max(0, DAILY_FAMILIARITY_CAP - state.familiarityGainToday);
  const granted = Math.min(amount, room);
  if (granted <= 0) return;
  state.familiarityGainToday += granted;
  state.familiarity = clamp(state.familiarity + granted, 0, 1);
}

function grantTrust(state: VesperState, amount: number): void {
  const room = Math.max(0, DAILY_TRUST_CAP - state.trustGainToday);
  const granted = Math.min(amount, room);
  if (granted <= 0) return;
  state.trustGainToday += granted;
  state.trust = clamp(state.trust + granted, 0, 1);
}

export type GestureKind = "gentle" | "moderate" | "disruptive";

/**
 * Classifies one completed touch gesture from its aggregate measurements.
 * `recentEnergy` is decayed energy from the last ~30 s, so sustained forceful
 * brushing escalates even when each individual stroke is modest.
 */
export function classifyGesture(
  energy: number,
  durationSeconds: number,
  recentEnergy: number,
): GestureKind {
  if (energy > 6.5 || recentEnergy > 10 || (energy > 4 && durationSeconds > 6)) {
    return "disruptive";
  }
  if (energy > 2.8) return "moderate";
  return "gentle";
}

/** Records one completed, classified gesture. Never called per pointermove. */
export function recordGesture(
  state: VesperState,
  budget: SessionBudget,
  kind: GestureKind,
  energy: number,
): void {
  if (kind === "gentle") {
    if (budget.gentleCredits > 0) {
      budget.gentleCredits -= 1;
      grantFamiliarity(state, 0.003);
      grantTrust(state, 0.002);
    }
    return;
  }
  if (kind === "moderate") {
    state.stress = clamp(state.stress + 0.03, 0, 1);
    return;
  }
  // Disruptive: stress spikes with energy; trust erodes, slowly and floored.
  state.stress = clamp(state.stress + 0.12 + Math.min(0.18, energy * 0.015), 0, 1);
  state.trust = clamp(state.trust - 0.004, 0, 1);
}

/** She answered a disturbance and nothing forceful followed. */
export function recordCalmResponse(state: VesperState, budget: SessionBudget): void {
  if (budget.calmCredits <= 0) return;
  budget.calmCredits -= 1;
  grantTrust(state, 0.006);
}

/** A keeper-provided moth meal actually finished — the only feeding credit. */
export function recordKeeperMealCompleted(state: VesperState, budget: SessionBudget): void {
  state.feedings += 1;
  if (budget.mealCredits <= 0) return;
  budget.mealCredits -= 1;
  grantFamiliarity(state, 0.02);
  grantTrust(state, 0.012);
}

/** In-session stress decay. Call from the frame loop with real dt. */
export function tickStress(state: VesperState, dtSeconds: number): void {
  if (state.stress <= 0) return;
  state.stress = clamp(
    state.stress * Math.pow(0.5, dtSeconds / STRESS_HALFLIFE_ACTIVE),
    0,
    1,
  );
}

// --------------------------------------------------------- derived quantities

export interface BehaviorContext {
  hunger: number;
  hourOfDay: number;
  stress: number;
  familiarity: number;
  trust: number;
}

/** Runtime-derived pull toward engaging with the world. Never persisted. */
export function curiosityOf(state: VesperState, temperament: Temperament): number {
  return clamp(
    0.2 +
      (temperament.boldness - 0.5) * 0.5 +
      state.familiarity * 0.45 +
      state.trust * 0.3 -
      state.stress * 0.55,
    0,
    1,
  );
}

/** Runtime-derived pull toward cover and stillness. Never persisted. */
export function cautionOf(state: VesperState, temperament: Temperament, hourOfDay: number): number {
  const daylight = hourOfDay >= 7 && hourOfDay < 19 ? 0.08 : 0;
  return clamp(
    0.5 -
      (temperament.boldness - 0.5) * 0.4 +
      state.stress * 0.6 +
      (1 - state.trust) * 0.25 -
      state.familiarity * 0.2 +
      daylight,
    0,
    1,
  );
}

// ----------------------------------------------------------- location memory

/**
 * Folds one observation into the location memories, merging with an existing
 * memory on the same strand when close, evicting the least meaningful entry
 * when the table is full.
 */
export function recordLocationEvent(
  state: VesperState,
  strandId: string,
  t: number,
  kind: LocationEventKind,
  now: number,
  weight = 1,
): void {
  if (!strandId || !Number.isFinite(t)) return;
  const clampedT = clamp(t, 0, 1);

  let target = state.locations.find(
    (location) => location.strandId === strandId && Math.abs(location.t - clampedT) <= LOCATION_MERGE_SPAN,
  );

  if (!target) {
    target = {
      strandId,
      t: clampedT,
      gentle: 0,
      disruptive: 0,
      catches: 0,
      calm: 0,
      updatedAt: now,
    };
    if (state.locations.length >= MAX_LOCATIONS) {
      // Evict the entry with the least total meaning, oldest first on ties.
      let worst = 0;
      let worstScore = Infinity;
      for (let i = 0; i < state.locations.length; i += 1) {
        const l = state.locations[i];
        const score = l.gentle + l.disruptive + l.catches * 1.5 + l.calm + l.updatedAt / (now + 1) * 0.5;
        if (score < worstScore) {
          worstScore = score;
          worst = i;
        }
      }
      state.locations.splice(worst, 1);
    }
    state.locations.push(target);
  } else {
    // Blend position toward the newer observation, weighted by history.
    const mass = target.gentle + target.disruptive + target.catches + target.calm + 1;
    target.t = clamp(target.t + (clampedT - target.t) / mass, 0, 1);
  }

  if (kind === "gentle") target.gentle = clamp(target.gentle + weight, 0, 24);
  else if (kind === "disruptive") target.disruptive = clamp(target.disruptive + weight, 0, 24);
  else if (kind === "catch") target.catches = clamp(target.catches + weight, 0, 24);
  else target.calm = clamp(target.calm + weight, 0, 24);
  target.updatedAt = now;
}

/** Drops memories whose strands no longer exist (defensive; the web is seeded). */
export function pruneInvalidLocations(
  state: VesperState,
  isValidStrand: (strandId: string) => boolean,
): void {
  state.locations = state.locations.filter((location) => isValidStrand(location.strandId));
}

export type LocationQuery = "touched" | "calmSpot" | "catchSpot";

/** Best-scoring location for a purpose, or null when nothing qualifies. */
export function pickLocation(state: VesperState, query: LocationQuery): LocationMemory | null {
  let best: LocationMemory | null = null;
  let bestScore = 0;
  for (const location of state.locations) {
    let score = 0;
    if (query === "touched") {
      score = location.gentle - location.disruptive * 0.6;
      if (location.gentle < 1.2) score = 0;
    } else if (query === "calmSpot") {
      score = location.calm + location.gentle * 0.4 - location.disruptive;
      if (score < 1) score = 0;
    } else {
      score = location.catches;
      if (location.catches < 0.8) score = 0;
    }
    if (score > bestScore) {
      bestScore = score;
      best = location;
    }
  }
  return best;
}

/** How stressful a world position's neighbourhood is, 0..1, by stored memory. */
export function disruptionNear(state: VesperState, strandId: string | null): number {
  if (!strandId) return 0;
  let worst = 0;
  for (const location of state.locations) {
    if (location.strandId !== strandId) continue;
    worst = Math.max(worst, clamp((location.disruptive - location.gentle * 0.5) / 6, 0, 1));
  }
  return worst;
}

// ------------------------------------------------------- weighted selection

export interface WeightedOption<Id extends string = string> {
  id: Id;
  weight: number;
}

/** Standard roulette pick. Zero/negative weights are excluded. */
export function selectWeighted<Id extends string>(
  options: readonly WeightedOption<Id>[],
  random: number,
): Id | null {
  let total = 0;
  for (const option of options) total += Math.max(0, option.weight);
  if (total <= 0) return null;
  let cursor = random * total;
  for (const option of options) {
    cursor -= Math.max(0, option.weight);
    if (cursor <= 0) return option.id;
  }
  return options[options.length - 1]?.id ?? null;
}

// ------------------------------------------------------------ touch response

export type TouchResponse = "ignore" | "freeze" | "attend" | "approach" | "retreat";

export interface TouchResponseContext {
  gesture: GestureKind;
  /** Distance from her to the disturbance, model units. */
  distance: number;
  /** Gestures completed in the last ~30 s, including this one. */
  recentGestures: number;
  /** Stored disruption memory near the touched strand, 0..1. */
  placeStress: number;
  hunger: number;
  hourOfDay: number;
}

export interface TouchDecision {
  response: TouchResponse;
  weights: WeightedOption<TouchResponse>[];
}

/**
 * Weighs how she answers a felt disturbance. Early, unfamiliar, or stressed:
 * ignore, freeze, or retreat dominate. Familiar and calm: attending and
 * approaching become likely — but ignoring never disappears entirely, and
 * approach never becomes certain. She is a spider, not a dog.
 */
export function chooseTouchResponse(
  state: VesperState,
  temperament: Temperament,
  ctx: TouchResponseContext,
  random: number,
): TouchDecision {
  const curiosity = curiosityOf(state, temperament);
  const caution = cautionOf(state, temperament, ctx.hourOfDay);
  const disruptive = ctx.gesture === "disruptive" ? 1 : 0;
  const crowded = clamp((ctx.recentGestures - 2) / 4, 0, 1);
  const far = clamp((ctx.distance - 3) / 6, 0, 1);

  const weights: WeightedOption<TouchResponse>[] = [
    {
      id: "ignore",
      weight: Math.max(
        0.18,
        1.0 - state.familiarity * 0.55 - temperament.vibrationSensitivity * 0.35 + crowded * 0.4,
      ),
    },
    {
      id: "freeze",
      weight:
        0.65 +
        caution * 0.85 +
        temperament.vibrationSensitivity * 0.45 +
        crowded * 0.3 -
        state.familiarity * 0.35,
    },
    {
      id: "attend",
      weight:
        0.35 +
        state.familiarity * 0.85 +
        state.trust * 0.5 +
        curiosity * 0.4 -
        state.stress * 0.45 -
        disruptive * 0.3,
    },
    {
      id: "approach",
      weight:
        ctx.distance > 9
          ? 0
          : 0.1 +
            curiosity * 0.75 +
            state.trust * 0.5 +
            ctx.hunger / 260 -
            state.stress * 0.7 -
            ctx.placeStress * 0.5 -
            disruptive * 0.6 -
            far * 0.4,
    },
    {
      id: "retreat",
      weight:
        state.stress * 1.3 +
        disruptive * 0.7 +
        caution * 0.35 +
        crowded * 0.35 -
        state.trust * 0.7,
    },
  ];

  return { response: selectWeighted(weights, random) ?? "ignore", weights };
}

// --------------------------------------------------------- autonomy selection

export type AutonomousBehaviorId =
  | "rest"
  | "listen"
  | "groom"
  | "patrol"
  | "repair"
  | "shelter"
  | "visitTouched"
  | "restFamiliar"
  | "inspectCatch";

export interface AutonomyContext {
  hunger: number;
  hourOfDay: number;
  isNight: boolean;
  secondsSinceUserAction: number;
  hasTouchedSpot: boolean;
  hasCalmSpot: boolean;
  hasCatchSpot: boolean;
}

const BEHAVIOR_COOLDOWN_SECONDS: Record<AutonomousBehaviorId, number> = {
  rest: 0,
  listen: 25,
  groom: 40,
  patrol: 45,
  repair: 120,
  shelter: 60,
  visitTouched: 300,
  restFamiliar: 420,
  inspectCatch: 360,
};

export interface AutonomyDecision {
  id: AutonomousBehaviorId;
  weights: WeightedOption<AutonomousBehaviorId>[];
}

/**
 * The idle-choice table. Everything routes through existing intents; this only
 * decides which one, shaped by the hidden relationship. Rare location-memory
 * behaviors carry long cooldowns and eligibility gates so they read as
 * occasional habits rather than tricks performed on demand.
 */
export function chooseAutonomousBehavior(
  state: VesperState,
  temperament: Temperament,
  ctx: AutonomyContext,
  now: number,
  random: number,
): AutonomyDecision {
  const curiosity = curiosityOf(state, temperament);
  const caution = cautionOf(state, temperament, ctx.hourOfDay);
  const quiet = ctx.secondsSinceUserAction;

  const eligible = (id: AutonomousBehaviorId): boolean =>
    (state.behaviorCooldowns[id] ?? 0) <= now;
  const repetition = (id: AutonomousBehaviorId): number =>
    state.recentBehaviors.slice(0, 3).includes(id) ? 0.35 : 1;

  const raw: WeightedOption<AutonomousBehaviorId>[] = [
    { id: "rest", weight: 0.9 + state.stress * 0.3 },
    {
      id: "listen",
      weight: 0.6 + temperament.vibrationSensitivity * 0.4 + (quiet < 30 ? 0.35 : 0),
    },
    { id: "groom", weight: 0.5 + (ctx.hunger < 25 ? 0.35 : 0) + state.trust * 0.15 },
    {
      id: "patrol",
      weight: 0.7 + curiosity * 0.6 + (ctx.isNight ? 0.25 : 0) - state.stress * 0.5,
    },
    { id: "repair", weight: 0.35 + (ctx.isNight ? 0.2 : 0) + curiosity * 0.2 },
    {
      id: "shelter",
      weight: 0.3 + caution * 0.85 + (ctx.isNight ? 0 : 0.15) - state.familiarity * 0.25,
    },
    {
      id: "visitTouched",
      weight:
        ctx.hasTouchedSpot && quiet >= 30 && state.stress < 0.35 && state.familiarity >= 0.25
          ? 0.3 + state.familiarity * 0.4
          : 0,
    },
    {
      id: "restFamiliar",
      weight:
        ctx.hasCalmSpot && state.stress < 0.3 && state.trust >= 0.3
          ? 0.26 + state.trust * 0.3
          : 0,
    },
    {
      id: "inspectCatch",
      weight:
        ctx.hasCatchSpot && ctx.hunger >= 40
          ? 0.24 + temperament.foodMotivation * 0.35
          : 0,
    },
  ];

  const weights = raw.map((option) => ({
    id: option.id,
    weight: eligible(option.id) ? Math.max(0, option.weight) * repetition(option.id) : 0,
  }));

  const id = selectWeighted(weights, random) ?? "rest";
  return { id, weights };
}

/** Marks a behavior as taken: cooldown stamped, recent list updated. */
export function noteBehaviorTaken(
  state: VesperState,
  id: AutonomousBehaviorId,
  now: number,
): void {
  const cooldown = BEHAVIOR_COOLDOWN_SECONDS[id];
  if (cooldown > 0) state.behaviorCooldowns[id] = now + cooldown * 1000;
  state.recentBehaviors = [id, ...state.recentBehaviors.filter((b) => b !== id)].slice(0, 5);
}
