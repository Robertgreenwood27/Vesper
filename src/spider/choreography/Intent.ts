import type { RouteDestination, Vec3Like } from "../../traversal/index";

/**
 * The player's entire vocabulary. Every one of these is a wish, not a command.
 * Nothing here names a leg, a joint, a strand, or a maneuver — the spider owns
 * all of that. The player supplies intention; the spider supplies competence.
 */
export type SpiderIntent =
  | { readonly kind: "rest" }
  /** Go there. The spider finds its own way and its own footing. */
  | { readonly kind: "travel"; readonly to: RouteDestination; readonly urgency?: number }
  /** Something is worth attending to; face it and approach carefully. */
  | { readonly kind: "attend"; readonly at: Vec3Like }
  /** Get away from here, quickly, back the way we came. */
  | { readonly kind: "retreat"; readonly to?: RouteDestination }
  /** Hold still and low. Prey, threat, or patience. */
  | { readonly kind: "freeze" };

export interface IntentMood {
  /** Multiplies travel speed. */
  readonly speed: number;
  /** 0 crouched and cautious, 1 tall and bold. Drives standoff and step height. */
  readonly confidence: number;
  /** Multiplies the chance of a micro-pause. */
  readonly hesitancy: number;
}

const MOODS: Record<SpiderIntent["kind"], IntentMood> = {
  rest: { speed: 0, confidence: 0.75, hesitancy: 1 },
  travel: { speed: 1, confidence: 0.85, hesitancy: 1 },
  attend: { speed: 0.55, confidence: 0.5, hesitancy: 2.4 },
  retreat: { speed: 1.7, confidence: 1, hesitancy: 0.15 },
  freeze: { speed: 0, confidence: 0.12, hesitancy: 0 },
};

export function moodFor(intent: SpiderIntent): IntentMood {
  const mood = MOODS[intent.kind];
  if (intent.kind === "travel" && intent.urgency !== undefined) {
    const urgency = Math.max(0, Math.min(2, intent.urgency));
    return {
      speed: mood.speed * (0.55 + urgency * 0.7),
      confidence: Math.min(1, mood.confidence * (0.7 + urgency * 0.4)),
      hesitancy: mood.hesitancy / (0.5 + urgency),
    };
  }
  return mood;
}

/** Where the spider is trying to get to, if anywhere. */
export function destinationOf(intent: SpiderIntent): RouteDestination | null {
  switch (intent.kind) {
    case "travel":
      return intent.to;
    case "retreat":
      return intent.to ?? null;
    case "attend":
      return { kind: "world", position: intent.at, maximumSnapDistance: 0.6 };
    default:
      return null;
  }
}
