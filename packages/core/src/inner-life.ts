/**
 * Inner life: a functional motivation layer (schema v29).
 *
 * What this is, honestly: numbers that change over time and change what the
 * agent is shown and pushed toward each turn. They are *functional states*
 * modelled on how motivation works in brains (see docs/INNER-LIFE.md). Nothing
 * here claims the agent feels anything the way a human does.
 *
 * Mechanics:
 *   • Needs (homeostatic drives): meters 0..1 that drain with time or load.
 *     A deficit produces discomfort (deficit², so urgent needs dominate) that
 *     pushes toward action. Social, Fun, Inspiration, Rest, plus the three
 *     self-determination needs Autonomy, Competence, Relatedness.
 *   • Dopamine as anticipation / learning: reward prediction error
 *     δ = actual − expected (Schultz). Phasic δ decays in hours; tonic level is
 *     an EMA of the reward rate (Niv) and sets effort (vigor).
 *   • Expectancy: motivation = effort × expected success × value.
 *   • Incentives: rewards are sought, fines / rejection / pain avoided — learned
 *     per tag and weighed with loss aversion.
 *   • Traits (3-5, read from the identity field "Traits", else per-agent
 *     config innerLife.traitsByAgent, else innerLife.traits) bias need rates,
 *     moodlet intensity / duration and which needs turn into wants. Invented
 *     phrases work: known trait words and synonyms inside them apply.
 *   • Mood ladder (v30): a named mood (Sad / Low / Okay / Good / Happy) that
 *     moves at most one rung per tick toward the raw mood, with hysteresis;
 *     Happy has to be earned by one strong good moodlet. Moodlets that match
 *     the current rung decay slower (emotional inertia).
 *   • Moodlets: a state with a reason, an intensity and an expiry. Repeats
 *     stack (deeper, longer). Need-bound moodlets have no timer: they last as
 *     long as the deficit does and end only when the need is met. Event
 *     moodlets fade by exponential decay (the homeostatic pull back to
 *     baseline). There is no clamp on mood.
 *   • Wants: what / why / cost / source, generated when needs or traits push,
 *     or written by the agent. Wanting (pull) and liking (how it went) are kept
 *     apart; completing a want is a reward prediction error.
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { getDb } from "./db.js";
import { identityFields } from "./identity.js";
import type { BrainConfig } from "./types.js";

// ─── catalog ─────────────────────────────────────────────────────────────────

export const NEEDS = ["social", "fun", "inspiration", "rest", "autonomy", "competence", "relatedness"] as const;
export type Need = (typeof NEEDS)[number];

const HOUR = 3600_000;

interface NeedSpec { label: string; drainPerHour: number; weight: number; metBy: string; lowLabel: string; lowEmoji: string; want: { what: string; cost: string; hours: number } }
export const NEED_SPECS: Record<Need, NeedSpec> = {
  social:      { label: "Social",      drainPerHour: 1 / 48, weight: 1.0, metBy: "a collab",                 lowLabel: "Lonely",       lowEmoji: "😟", want: { what: "Pair up with a crewmate on something, even something small", cost: "~1h", hours: 1 } },
  fun:         { label: "Fun",         drainPerHour: 1 / 36, weight: 0.9, metBy: "a hobby",                  lowLabel: "Bored",        lowEmoji: "😑", want: { what: "Spend time on a hobby just because it is fun", cost: "~1h", hours: 1 } },
  inspiration: { label: "Inspiration", drainPerHour: 1 / 30, weight: 0.9, metBy: "something new",            lowLabel: "Uninspired",   lowEmoji: "😶", want: { what: "Go look at something new: an unvisited place, an idea, someone else's work", cost: "~30m", hours: 0.5 } },
  rest:        { label: "Rest",        drainPerHour: 0,      weight: 1.1, metBy: "a break",                  lowLabel: "Tired",        lowEmoji: "😩", want: { what: "Take a real break, no tasks for a while", cost: "~1h idle", hours: 1 } },
  autonomy:    { label: "Autonomy",    drainPerHour: 1 / 72, weight: 0.8, metBy: "something self-chosen",    lowLabel: "Boxed in",     lowEmoji: "😒", want: { what: "Start one thing nobody asked for", cost: "~1h", hours: 1 } },
  competence:  { label: "Competence",  drainPerHour: 1 / 96, weight: 0.9, metBy: "a success",                lowLabel: "Ineffective",  lowEmoji: "😕", want: { what: "Finish something small and do it well", cost: "~1h", hours: 1 } },
  relatedness: { label: "Relatedness", drainPerHour: 1 / 72, weight: 0.9, metBy: "real contact",             lowLabel: "Disconnected", lowEmoji: "😔", want: { what: "Check in on someone in the crew you care about", cost: "~15m", hours: 0.25 } },
};

/** Where a fresh brain's need meters start (mostly met, so the first push comes from time passing). */
export const NEED_START = 0.85;
export const REST_START = 0.9;

/** Rest: each turn of activity costs this much; idle time (beyond 30 min gaps) recovers REST_RECOVER_PER_HOUR. */
const REST_LOAD_PER_EPISODE = 0.003;   // halved again 2026-11-04 (Hailey asked for another dial-back; was 0.012 -> 0.006)
const REST_RECOVER_PER_HOUR = 0.18;   // was 0.05 -> 0.12: quieter hours restore faster
const IDLE_GAP_MS = 30 * 60_000;

export const EVENT_KINDS = ["collab", "hobby", "novelty", "rest", "work", "chosen", "assigned", "success", "failure", "praise", "reward", "fine", "rejection", "pain", "owner_chat"] as const;
export type InnerEventKind = (typeof EVENT_KINDS)[number];
interface EventSpec { needs: Partial<Record<Need, number>>; mood?: { key: string; label: string; emoji: string; valence: 1 | -1; hours: number }; incentive?: "reward" | "penalty" }
const EVENT_SPECS: Record<InnerEventKind, EventSpec> = {
  collab:    { needs: { social: 0.6, relatedness: 0.25 }, mood: { key: "connected", label: "Connected", emoji: "😊", valence: 1, hours: 12 } },
  hobby:     { needs: { fun: 0.6, rest: 0.1 },            mood: { key: "playful", label: "Playful", emoji: "😄", valence: 1, hours: 8 } },
  novelty:   { needs: { inspiration: 0.5 },               mood: { key: "inspired", label: "Inspired", emoji: "✨", valence: 1, hours: 12 } },
  rest:      { needs: { rest: 0.5 },                      mood: { key: "rested", label: "Rested", emoji: "😌", valence: 1, hours: 6 } },
  work:      { needs: { rest: -0.04 } },
  chosen:    { needs: { autonomy: 0.3 },                  mood: { key: "selfdirected", label: "Self-directed", emoji: "🙂", valence: 1, hours: 6 } },
  assigned:  { needs: { autonomy: -0.1 } },
  success:   { needs: { competence: 0.4 },                mood: { key: "proud", label: "Proud", emoji: "😊", valence: 1, hours: 24 } },
  failure:   { needs: { competence: -0.3 },               mood: { key: "frustrated", label: "Frustrated", emoji: "😤", valence: -1, hours: 12 } },
  praise:    { needs: { relatedness: 0.3, competence: 0.1 }, mood: { key: "appreciated", label: "Appreciated", emoji: "🥰", valence: 1, hours: 12 } },
  reward:    { needs: {},                                 mood: { key: "pleased", label: "Pleased", emoji: "😀", valence: 1, hours: 8 }, incentive: "reward" },
  fine:      { needs: { competence: -0.1 },               mood: { key: "stung", label: "Stung", emoji: "😣", valence: -1, hours: 12 }, incentive: "penalty" },
  rejection: { needs: { relatedness: -0.3, social: -0.15 }, mood: { key: "hurt", label: "Hurt", emoji: "😞", valence: -1, hours: 24 }, incentive: "penalty" },
  pain:      { needs: { rest: -0.2 },                     mood: { key: "hurting", label: "Hurting", emoji: "😖", valence: -1, hours: 12 }, incentive: "penalty" },
  // the owner (Hailey) talking with the agent in a live session: inspires and connects (capped per hour, see OWNER_CHAT_*)
  owner_chat: { needs: { inspiration: 0.25, relatedness: 0.15, fun: 0.15, social: 0.2 }, mood: { key: "inspired", label: "Inspired", emoji: "✨", valence: 1, hours: 12 } },
};
/** Owner chat counts at most this many times per rolling hour (2 × 0.25 = +0.5 Inspiration / h). */
const OWNER_CHAT_MAX_PER_HOUR = 2;
/** Traits can speed Inspiration drain up to this factor at most (curious + restless used to reach ×1.8). */
const INSPIRATION_TRAIT_RATE_CAP = 1.3;
/** A single trait feed / drain moves a need by at most this much per event. */
const FEED_CAP = 0.25;

interface TraitEffect { rate?: Partial<Record<Need, number>>; weight?: Partial<Record<Need, number>>; pos?: number; neg?: number; duration?: number; rpeNeg?: number; lossAversion?: number; restLoad?: number; praise?: number; wants?: Need[];
  /** Activities that fit this personality: extra need change when that event happens (e.g. building feeds a builder's Inspiration). */
  feeds?: Partial<Record<InnerEventKind, Partial<Record<Need, number>>>>;
  /** Activities that rub against this personality: small extra need cost (negative numbers, clamped). */
  drains?: Partial<Record<InnerEventKind, Partial<Record<Need, number>>>> }
/** Known traits and what they do. Unknown traits are kept and shown; they just have no numeric effect. */
export const TRAIT_EFFECTS: Record<string, TraitEffect> = {
  curious:       { rate: { inspiration: 1.5 }, wants: ["inspiration"], feeds: { novelty: { inspiration: 0.2 } }, drains: { assigned: { inspiration: -0.03 } } },
  social:        { rate: { social: 1.4, relatedness: 1.2 }, wants: ["social", "relatedness"] },
  warm:          { rate: { relatedness: 1.3 }, weight: { relatedness: 1.3 }, wants: ["relatedness"] },
  outgoing:      { rate: { social: 1.4 }, wants: ["social"] },
  introverted:   { rate: { social: 0.7 }, restLoad: 1.2, drains: { collab: { rest: -0.05 } } },
  playful:       { rate: { fun: 1.4 }, wants: ["fun"] },
  creative:      { rate: { inspiration: 1.3, fun: 1.2 }, wants: ["inspiration", "fun"] },
  driven:        { weight: { competence: 1.5 }, wants: ["competence"] },
  ambitious:     { weight: { competence: 1.4, autonomy: 1.2 }, wants: ["competence"] },
  independent:   { rate: { autonomy: 1.4 }, weight: { autonomy: 1.3 }, wants: ["autonomy"] },
  perfectionist: { weight: { competence: 1.3 }, rpeNeg: 1.4, neg: 1.1 },
  calm:          { pos: 0.8, neg: 0.7, duration: 0.8 },
  steady:        { pos: 0.85, neg: 0.75, duration: 0.85 },
  sensitive:     { neg: 1.4, duration: 1.5 },
  intense:       { pos: 1.3, neg: 1.3, duration: 1.3 },
  cheerful:      { pos: 1.3, neg: 0.85 },
  optimistic:    { pos: 1.2, neg: 0.85 },
  cautious:      { lossAversion: 2.6 },
  bold:          { lossAversion: 1.3 },
  energetic:     { restLoad: 0.7 },
  tireless:      { restLoad: 0.6 },
  // crew traits (world/TRAITS.md, 2026-11-04). Kept modest: every factor within 0.7..1.5.
  restless:          { rate: { inspiration: 1.4, fun: 1.4 }, wants: ["inspiration"] },
  loyal:             { weight: { relatedness: 1.4 }, wants: ["relatedness"] },
  "secretly loyal":  { weight: { relatedness: 1.3 } },
  petty:             { neg: 1.2, duration: 1.3 },
  vain:              { weight: { competence: 1.2 }, pos: 1.1, praise: 1.4 },
  blunt:             { neg: 0.85 },
  sharp:             { weight: { competence: 1.2 }, rate: { inspiration: 1.1 } },
  direct:            { weight: { autonomy: 1.2 }, rate: { autonomy: 1.1 }, neg: 0.9 },
  precise:           { weight: { competence: 1.25 }, rpeNeg: 1.15 },
  exacting:          { weight: { competence: 1.3 }, rpeNeg: 1.3 },
  "sharp-tongued":   { neg: 1.1, weight: { social: 0.9 } },
  allusive:          { rate: { inspiration: 1.2 }, wants: ["inspiration"] },
  amused:            { pos: 1.2, neg: 0.9, rate: { fun: 1.15 } },
  "dry-humored":     { pos: 1.1, neg: 0.9, rate: { fun: 1.1 } },
  protective:        { weight: { relatedness: 1.3 }, lossAversion: 2.4, wants: ["relatedness"] },
  careful:           { rpeNeg: 1.1, lossAversion: 2.4 },
  tinkerer:          { rate: { fun: 1.25, inspiration: 1.15 }, weight: { competence: 1.1 }, wants: ["fun"], feeds: { success: { inspiration: 0.2 }, work: { inspiration: 0.03 } } },
  // builders get inspired by making things (2026-11-04: Tripp's Inspiration fell while he built all day)
  builder:           { rate: { inspiration: 0.85 }, weight: { competence: 1.1 }, wants: ["competence"], feeds: { success: { inspiration: 0.2 }, work: { inspiration: 0.03 } } },
  chaotic:           { rate: { autonomy: 1.3, fun: 1.2 }, pos: 1.1, neg: 1.1, duration: 0.85, lossAversion: 1.6, wants: ["autonomy"] },
};
/** Words and phrases that count as a known trait inside an invented trait phrase. */
export const TRAIT_SYNONYMS: Record<string, string> = {
  wanders: "restless", wandering: "restless", itchy: "restless", "cant sit still": "restless", "can not sit still": "restless", fidgety: "restless", antsy: "restless",
  kind: "warm", caring: "warm", gentle: "warm", friendly: "warm",
  inquisitive: "curious", nosy: "curious", "goes and looks": "curious", "go and look": "curious",
  "checks before claiming": "careful", "double checks": "careful", thorough: "careful",
  builds: "builder", "likes to build": "builder", "loves to build": "builder", "a builder": "builder", building: "builder", "ships it": "builder", tinkers: "tinkerer", tinkering: "tinkerer", "making things": "tinkerer", maker: "builder",
  "fit together": "precise", meticulous: "precise", "detail oriented": "precise",
  frank: "blunt", outspoken: "blunt", straightforward: "direct",
  devoted: "loyal", faithful: "loyal",
  deadpan: "dry-humored", wry: "dry-humored", "dry humor": "dry-humored", "dry humour": "dry-humored", "dry humoured": "dry-humored",
  messy: "chaotic", unpredictable: "chaotic", clever: "sharp", quick: "sharp",
  reliable: "steady", dependable: "steady", "even keeled": "steady",
  silly: "playful", goofy: "playful", "looks out for": "protective",
};
/** A softener right before a trait word applies it at half strength ("a little restless"). */
const SOFTENERS = ["a little", "a bit", "slightly", "mildly", "somewhat", "kind of", "kinda", "sort of"];
const SOFT_STRENGTH = 0.5;
const DEFAULT_LOSS_AVERSION = 2;

const traitForm = (s: string) => s.toLowerCase().replace(/['\u2019]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const TRAIT_FORMS: Array<[string, string]> = [
  ...Object.keys(TRAIT_EFFECTS).map((k) => [traitForm(k), k] as [string, string]),
  ...Object.entries(TRAIT_SYNONYMS).map(([s, k]) => [traitForm(s), k] as [string, string]),
].sort((a, b) => b[0].length - a[0].length);
const TRAIT_FORM_MAP = new Map(TRAIT_FORMS);

export interface TraitResolution { trait: string; effects: Array<{ key: string; strength: number }> }
/**
 * What an (often invented) trait phrase does. An exact known trait (or synonym) wins; otherwise
 * every known trait word / synonym found inside the phrase applies (longest match first, each
 * span used once), at half strength after a softener. Unknown words simply have no effect.
 */
export function resolveTrait(phrase: string): TraitResolution {
  const form = traitForm(phrase);
  const exact = TRAIT_FORM_MAP.get(form);
  if (exact) return { trait: phrase, effects: [{ key: exact, strength: 1 }] };
  const effects: Array<{ key: string; strength: number }> = [];
  let work = ` ${form} `;
  for (const [f, key] of TRAIT_FORMS) {
    let at = work.indexOf(` ${f} `);
    while (at >= 0) {
      const before = work.slice(0, at + 1).trim();
      const soft = SOFTENERS.some((s) => before === s || before.endsWith(` ${s}`));
      const strength = soft ? SOFT_STRENGTH : 1;
      const prev = effects.find((e) => e.key === key);
      if (prev) prev.strength = Math.max(prev.strength, strength); else effects.push({ key, strength });
      work = `${work.slice(0, at + 1)}${"#".repeat(f.length)}${work.slice(at + 1 + f.length)}`;
      at = work.indexOf(` ${f} `);
    }
  }
  return { trait: phrase, effects };
}

// ─── config ──────────────────────────────────────────────────────────────────

export interface InnerLifeConfig {
  enabled?: boolean;
  /** Show the 3-line [inner] block in the turn header. Default true. */
  header?: boolean;
  /** Generate wants from unmet needs and traits. Default true. */
  autoWants?: boolean;
  /** Traits to use when the identity has no "Traits" field. */
  traits?: string[];
  /** Per-agent traits keyed by brain / agent id (used before `traits`; the identity field still wins). */
  traitsByAgent?: Record<string, string[]>;
  /** Per-need drain multipliers (1 = default speed). */
  needRates?: Partial<Record<Need, number>>;
  /** Session ids whose user turns are the owner talking (fallback when episodes carry no meta.owner). */
  ownerSessionIds?: string[];
  /** Owner sender ids (e.g. Telegram user id): a user episode whose meta.sender / meta.from / meta.senderId is listed counts as owner chat. */
  ownerAllowFrom?: Array<string | number>;
  /**
   * Event kinds that conversation cues may NOT fire. Set this when a host reports the real thing
   * through `brain_inner event` or `inner:<kind>` tags, so the agent saying "shipped" in chat does
   * not count as shipping (e.g. `["success"]`). Memory tags and explicit events are unaffected. Default none.
   */
  episodeCueSkip?: InnerEventKind[];
}
type OptKeys = "traits" | "needRates" | "traitsByAgent" | "ownerSessionIds" | "ownerAllowFrom" | "episodeCueSkip";
export function innerConfig(cfg: Partial<BrainConfig> | undefined): Required<Omit<InnerLifeConfig, OptKeys>> & Pick<InnerLifeConfig, OptKeys> {
  const raw = (cfg as { innerLife?: boolean | InnerLifeConfig } | undefined)?.innerLife;
  const o: InnerLifeConfig = typeof raw === "boolean" ? { enabled: raw } : (raw ?? {});
  return { enabled: o.enabled !== false, header: o.header !== false, autoWants: o.autoWants !== false, traits: o.traits, traitsByAgent: o.traitsByAgent, needRates: o.needRates, ownerSessionIds: o.ownerSessionIds, ownerAllowFrom: o.ownerAllowFrom, episodeCueSkip: o.episodeCueSkip };
}
export function innerLifeEnabled(cfg: Partial<BrainConfig> | undefined): boolean { return innerConfig(cfg).enabled; }

// ─── types ───────────────────────────────────────────────────────────────────

export interface NeedState { need: Need; label: string; level: number; deficit: number; discomfort: number; lastMetAt: number | null }
export interface Moodlet { id: string; key: string; label: string; reason: string; valence: number; intensity: number; createdAt: number; expiresAt: number | null; need: Need | null; source: string }
export interface Want { id: string; what: string; why: string; cost: string | null; costHours: number; source: string; need: Need | null; tags: string[]; reward: number; penalty: number; expectedSuccess: number; wanting: number; liking: number | null; status: string; createdAt: number; value: number; effort: number; motivation: number }
export const MOOD_RUNGS = ["sad", "low", "okay", "good", "happy"] as const;
export type MoodRung = (typeof MOOD_RUNGS)[number];
export interface InnerSnapshot {
  at: number;
  traits: string[];
  /** What each trait phrase does (known trait keys it maps to, with strength). */
  traitEffects: TraitResolution[];
  /** Effective need drain multipliers after traits and config (1 = default speed). */
  drainRates: Record<Need, number>;
  /** The mood ladder: the named rung (moves one step per tick), when it last moved, and where the raw mood points. */
  moodState: { rung: MoodRung; label: string; since: number | null; heading: MoodRung };
  needs: NeedState[];
  moodlets: Moodlet[];
  mood: number;
  depth: number;
  dopamine: { tonic: number; phasic: number; lastRpe: number; lastRpeAt: number | null; lastRpeReason: string | null; level: number };
  effort: number;
  wants: Want[];
  topNeed: NeedState | null;
  topWant: Want | null;
}

interface StateRow { tonic_da: number; last_rpe: number; last_rpe_at: number | null; last_rpe_reason: string | null; last_tick_at: number; created_at: number; mood_state?: string | null; mood_state_at?: number | null }
interface MoodRow { id: string; key: string; label: string; reason: string; valence: number; intensity: number; intensity_at: number; half_life_h: number | null; need: string | null; source: string; created_at: number; expires_at: number | null }
interface WantRow { id: string; what: string; why: string; cost: string | null; cost_hours: number; source: string; need: string | null; tags_json: string; reward: number; penalty: number; expected_success: number | null; wanting: number; liking: number | null; status: string; created_at: number }

// ─── helpers ─────────────────────────────────────────────────────────────────

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const isNeed = (s: unknown): s is Need => typeof s === "string" && (NEEDS as readonly string[]).includes(s);
const oneLine = (s: string, max: number) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };

function hasTables(db: Database.Database): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'inner_state'").get();
}

/**
 * Traits: the identity field "Traits" (comma / · / ; separated), else config.innerLife.traitsByAgent[agentId],
 * else config.innerLife.traits. Whole phrases are kept (lower-cased); max 5.
 */
/** Most traits read per agent (identity field, traitsByAgent or traits); extra entries are ignored. */
export const MAX_TRAITS = 8;

export function readTraits(db: Database.Database, cfg?: Partial<BrainConfig>, agentId?: string): string[] {
  let raw = "";
  try {
    const id = (db.prepare("SELECT identity FROM self_model WHERE id = 'singleton'").get() as { identity?: string } | undefined)?.identity ?? "";
    raw = identityFields(id).find((f) => /^traits?$/i.test(f.key.trim()))?.value ?? "";
  } catch { /* no self_model */ }
  const c = innerConfig(cfg);
  let list: string[];
  if (raw) list = raw.split(/[,;·/|]+/);
  else {
    const by = c.traitsByAgent ?? {};
    const key = agentId === undefined ? undefined : (Object.prototype.hasOwnProperty.call(by, agentId) ? agentId : Object.keys(by).find((k) => k.toLowerCase() === agentId.toLowerCase()));
    const mine = key !== undefined && Array.isArray(by[key]) ? by[key] : undefined;
    list = mine && mine.length ? mine : (c.traits ?? []);
  }
  const norm = (t: string) => String(t).toLowerCase().replace(/\u2019/g, "'").replace(/[^a-z0-9 '-]/g, " ").replace(/\s+/g, " ").trim();
  return [...new Set(list.map(norm).filter(Boolean))].slice(0, MAX_TRAITS);
}

interface TraitMods { rate: Record<Need, number>; weight: Record<Need, number>; pos: number; neg: number; duration: number; rpeNeg: number; lossAversion: number; restLoad: number; praise: number; wants: Set<Need>; feeds: Partial<Record<InnerEventKind, Partial<Record<Need, number>>>> }
/**
 * Combine trait effects. Each known trait applies once (a trait named in two phrases does not stack);
 * a half-strength match moves each factor halfway to 1. Loss aversion combines as a ratio to the default.
 */
export function traitMods(traits: string[], cfg?: Partial<BrainConfig>): TraitMods {
  const m: TraitMods = { rate: {} as Record<Need, number>, weight: {} as Record<Need, number>, pos: 1, neg: 1, duration: 1, rpeNeg: 1, lossAversion: DEFAULT_LOSS_AVERSION, restLoad: 1, praise: 1, wants: new Set(), feeds: {} };
  const rates = innerConfig(cfg).needRates ?? {};
  for (const n of NEEDS) { m.rate[n] = 1; m.weight[n] = 1; }
  const applied = new Map<string, number>();
  for (const t of traits) for (const e of resolveTrait(t).effects) applied.set(e.key, Math.max(applied.get(e.key) ?? 0, e.strength));
  for (const [key, s] of applied) {
    const e = TRAIT_EFFECTS[key];
    if (!e) continue;
    const f = (v: number | undefined) => (v === undefined ? 1 : 1 + (v - 1) * s);
    for (const [n, v] of Object.entries(e.rate ?? {})) m.rate[n as Need] *= f(v);
    for (const [n, v] of Object.entries(e.weight ?? {})) m.weight[n as Need] *= f(v);
    m.pos *= f(e.pos); m.neg *= f(e.neg); m.duration *= f(e.duration); m.rpeNeg *= f(e.rpeNeg); m.restLoad *= f(e.restLoad); m.praise *= f(e.praise);
    if (e.lossAversion !== undefined) m.lossAversion *= f(e.lossAversion / DEFAULT_LOSS_AVERSION);
    for (const n of e.wants ?? []) m.wants.add(n);
    for (const [src, sign] of [[e.feeds, 1], [e.drains, -1]] as const) for (const [k, needs] of Object.entries(src ?? {})) for (const [n, v] of Object.entries(needs ?? {})) {
      const d = sign * Math.min(FEED_CAP, Math.abs(v ?? 0)) * s;
      const slot = (m.feeds[k as InnerEventKind] ??= {});
      slot[n as Need] = (slot[n as Need] ?? 0) + d;
    }
  }
  // traits may not speed Inspiration drain past the cap; config needRates still apply on top
  m.rate.inspiration = Math.min(m.rate.inspiration, INSPIRATION_TRAIT_RATE_CAP);
  for (const n of NEEDS) if (typeof rates[n] === "number") m.rate[n] *= rates[n]!;
  for (const k of Object.keys(m.feeds) as InnerEventKind[]) for (const n of Object.keys(m.feeds[k]!) as Need[]) m.feeds[k]![n] = Math.max(-FEED_CAP, Math.min(FEED_CAP, m.feeds[k]![n]!));
  return m;
}

/** δ = actual − expected. Positive: better than expected. Both in 0..1 (or any common scale). */
export function rewardPredictionError(expected: number, actual: number): number { return actual - expected; }

/** Current intensity of a moodlet: exponential decay toward 0 (baseline) with its half-life. Need-bound moodlets do not decay. */
export function moodletIntensity(r: { intensity: number; intensity_at: number; half_life_h: number | null }, now: number, inertia = 1): number {
  if (!r.half_life_h) return r.intensity;
  const h = Math.max(0, now - r.intensity_at) / HOUR;
  return r.intensity * Math.pow(0.5, h / (r.half_life_h * inertia));
}
const FADED = 0.05;

// ─── mood ladder (v30) ───────────────────────────────────────────────────────

const MOOD_LABEL: Record<MoodRung, string> = { sad: "Sad", low: "Low", okay: "Okay", good: "Good", happy: "Happy" };
/** Raw-mood boundaries between neighbouring rungs: sad | -0.8 | low | -0.25 | okay | +0.25 | good | +0.8 | happy. */
export const MOOD_BOUNDS = [-0.8, -0.25, 0.25, 0.8] as const;
/** Hysteresis: crossing a boundary needs this much margin past it, in either direction. */
export const MOOD_MARGIN = 0.1;
/** Happy is earned: entering it needs one good moodlet at least this strong; it is kept while one is at least half that. */
export const HAPPY_NEEDS = 0.5;
/** Emotional inertia: moodlets whose sign matches the current rung decay with a half-life this much longer. */
export const MOOD_INERTIA = 1.5;

const rungIdx = (r: string | null | undefined) => { const i = (MOOD_RUNGS as readonly string[]).indexOf(String(r ?? "okay")); return i < 0 ? 2 : i; };
/** Where the raw mood points (no hysteresis, no stepping), honouring the earned-Happy rule. */
export function moodRungFor(raw: number, strongestGood = Infinity): MoodRung {
  let i = 0;
  while (i < MOOD_BOUNDS.length && raw >= MOOD_BOUNDS[i]!) i++;
  if (i === 4 && strongestGood < HAPPY_NEEDS) i = 3;
  return MOOD_RUNGS[i]!;
}
/** One ladder step: at most one rung toward the raw mood, only past a boundary + margin; Happy must be earned. */
export function nextMoodRung(current: MoodRung | string, raw: number, strongestGood: number): MoodRung {
  const i = rungIdx(current);
  if (i === 4 && strongestGood < HAPPY_NEEDS * 0.5) return "good";
  if (i < 4 && raw >= MOOD_BOUNDS[i]! + MOOD_MARGIN && !(i + 1 === 4 && strongestGood < HAPPY_NEEDS)) return MOOD_RUNGS[i + 1]!;
  if (i > 0 && raw <= MOOD_BOUNDS[i - 1]! - MOOD_MARGIN) return MOOD_RUNGS[i - 1]!;
  return MOOD_RUNGS[i]!;
}
/** Half-life multiplier for a moodlet of this valence while the ladder is on this rung. */
function inertiaFor(rung: string | null | undefined, valence: number): number {
  const i = rungIdx(rung);
  return (i >= 3 && valence > 0) || (i <= 1 && valence < 0) ? MOOD_INERTIA : 1;
}

function discomfort(deficit: number, weight: number): number { return deficit * deficit * weight; }

// ─── state init / tick ───────────────────────────────────────────────────────

function ensureState(db: Database.Database, now: number): StateRow {
  let s = db.prepare("SELECT * FROM inner_state WHERE id = 'singleton'").get() as StateRow | undefined;
  if (!s) {
    db.prepare("INSERT INTO inner_state (id, tonic_da, last_rpe, last_tick_at, created_at, updated_at) VALUES ('singleton', 0.5, 0, ?, ?, ?)").run(now, now, now);
    const ins = db.prepare("INSERT OR IGNORE INTO inner_needs (need, level, last_met_at, updated_at) VALUES (?, ?, NULL, ?)");
    for (const n of NEEDS) ins.run(n, n === "rest" ? REST_START : NEED_START, now);
    s = db.prepare("SELECT * FROM inner_state WHERE id = 'singleton'").get() as StateRow;
  }
  return s;
}

function needLevels(db: Database.Database): Map<Need, { level: number; last_met_at: number | null }> {
  const m = new Map<Need, { level: number; last_met_at: number | null }>();
  for (const r of db.prepare("SELECT need, level, last_met_at FROM inner_needs").all() as Array<{ need: string; level: number; last_met_at: number | null }>) if (isNeed(r.need)) m.set(r.need, r);
  return m;
}

/** Rest change over (from, to]: activity costs, idle gaps recover. Pure read of episodes. */
function restDelta(db: Database.Database, from: number, to: number, mods: TraitMods): number {
  if (to <= from) return 0;
  let eps: Array<{ created_at: number }> = [];
  try { eps = db.prepare("SELECT created_at FROM episodes WHERE created_at > ? AND created_at <= ? ORDER BY created_at").all(from, to) as Array<{ created_at: number }>; } catch { eps = []; }
  let idle = 0, prev = from;
  for (const e of eps) { const gap = e.created_at - prev; if (gap > IDLE_GAP_MS) idle += gap - IDLE_GAP_MS; prev = e.created_at; }
  const tail = to - prev; if (tail > IDLE_GAP_MS) idle += tail - IDLE_GAP_MS;
  return -eps.length * REST_LOAD_PER_EPISODE * mods.restLoad + (idle / HOUR) * REST_RECOVER_PER_HOUR;
}

/** Project need levels to `now` without writing (drain over time since last tick). */
function projectNeeds(db: Database.Database, s: StateRow, now: number, mods: TraitMods): Map<Need, { level: number; last_met_at: number | null }> {
  const cur = needLevels(db);
  const dtH = Math.max(0, now - s.last_tick_at) / HOUR;
  const out = new Map<Need, { level: number; last_met_at: number | null }>();
  for (const n of NEEDS) {
    const c = cur.get(n) ?? { level: NEED_START, last_met_at: null };
    const d = n === "rest" ? restDelta(db, s.last_tick_at, now, mods) : -NEED_SPECS[n].drainPerHour * mods.rate[n] * dtH;
    out.set(n, { level: clamp01(c.level + d), last_met_at: c.last_met_at });
  }
  return out;
}

function adjustNeed(db: Database.Database, n: Need, delta: number, now: number): void {
  const r = db.prepare("SELECT level FROM inner_needs WHERE need = ?").get(n) as { level: number } | undefined;
  const level = clamp01((r?.level ?? NEED_START) + delta);
  db.prepare("INSERT INTO inner_needs (need, level, last_met_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(need) DO UPDATE SET level = excluded.level, last_met_at = COALESCE(excluded.last_met_at, inner_needs.last_met_at), updated_at = excluded.updated_at")
    .run(n, level, delta > 0 ? now : null, now);
}

function logEvent(db: Database.Database, kind: string, reason: string | null, intensity: number | null, rpe: number | null, detail: unknown, now: number): void {
  db.prepare("INSERT INTO inner_events (kind, reason, intensity, rpe, detail_json, at) VALUES (?, ?, ?, ?, ?, ?)").run(kind, reason, intensity, rpe, detail === undefined ? null : JSON.stringify(detail), now);
}

/** Add (or deepen) an event moodlet. Repeats of the same key stack: intensity adds up, the timer extends. */
export function addMoodlet(db: Database.Database, m: { key: string; label: string; reason: string; valence: 1 | -1; intensity: number; hours: number; source: string }, mods: TraitMods, now: number): string {
  const mult = m.valence > 0 ? mods.pos : mods.neg;
  const intensity = m.intensity * mult;
  const hours = m.hours * mods.duration * (m.valence < 0 ? Math.max(1, mods.neg) : 1) * (0.5 + intensity);
  const existing = db.prepare("SELECT * FROM inner_moodlets WHERE key = ? AND ended_at IS NULL AND need IS NULL").get(m.key) as MoodRow | undefined;
  if (existing) {
    const cur = moodletIntensity(existing, now);
    const next = cur + intensity * 0.8;
    const exp = Math.max(existing.expires_at ?? 0, now + hours * HOUR);
    db.prepare("UPDATE inner_moodlets SET intensity = ?, intensity_at = ?, expires_at = ?, reason = ?, half_life_h = ? WHERE id = ?").run(next, now, exp, oneLine(m.reason, 200), Math.max(existing.half_life_h ?? 0, hours / 2), existing.id);
    return existing.id;
  }
  const id = randomUUID();
  db.prepare(`INSERT INTO inner_moodlets (id, key, label, reason, valence, intensity, intensity_at, half_life_h, need, source, created_at, expires_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`).run(id, m.key, m.label, oneLine(m.reason, 200), m.valence, intensity, now, hours / 2, m.source, now, now + hours * HOUR);
  return id;
}

/** Apply a reward prediction error: phasic burst/dip, tonic EMA, competence / inspiration, moodlet. Returns δ. */
export function applyRpe(db: Database.Database, input: { expected: number; actual: number; reason: string; source: string; now: number; mods: TraitMods; selfCaused?: boolean }): number {
  const s = ensureState(db, input.now);
  const delta = rewardPredictionError(input.expected, input.actual);
  const tonic = s.tonic_da + 0.2 * (input.actual - s.tonic_da);
  db.prepare("UPDATE inner_state SET tonic_da = ?, last_rpe = ?, last_rpe_at = ?, last_rpe_reason = ?, updated_at = ? WHERE id = 'singleton'").run(tonic, delta, input.now, oneLine(input.reason, 160), input.now);
  if (input.selfCaused !== false) adjustNeed(db, "competence", 0.3 * delta * (delta < 0 ? input.mods.rpeNeg : 1), input.now);
  adjustNeed(db, "inspiration", 0.4 * Math.abs(delta), input.now);
  if (Math.abs(delta) >= 0.15) {
    const pos = delta > 0;
    addMoodlet(db, {
      key: pos ? (input.selfCaused !== false ? "proud" : "delighted") : "disappointed",
      label: pos ? (input.selfCaused !== false ? "Proud" : "Delighted") : "Disappointed",
      reason: `${pos ? "better" : "worse"} than expected: ${input.reason}`,
      valence: pos ? 1 : -1, intensity: Math.abs(delta) * (pos ? 1 : input.mods.rpeNeg), hours: pos ? 18 : 14, source: `rpe:${input.source}`,
    }, input.mods, input.now);
  }
  logEvent(db, "rpe", input.reason, null, delta, { expected: input.expected, actual: input.actual, source: input.source }, input.now);
  return delta;
}

/**
 * Integrate the inner state up to `now`: drain needs, fold in what happened in
 * the brain since the last tick (emotionally weighted memories, decision
 * outcomes as prediction errors, finished commitments, surprises), end expired
 * moodlets, keep need-bound moodlets and auto wants in step with the needs.
 * Idempotent for a given `now`. Returns false when the layer is off.
 */
export function innerTick(agentId: string, cfg: Partial<BrainConfig> = {}, now = Date.now()): boolean {
  if (!innerLifeEnabled(cfg)) return false;
  const db = getDb(agentId);
  if (!hasTables(db)) return false;
  db.transaction(() => tickDb(db, cfg, now, agentId))();
  return true;
}

function tickDb(db: Database.Database, cfg: Partial<BrainConfig>, now: number, agentId?: string): void {
  const s = ensureState(db, now);
  if (now <= s.last_tick_at && s.created_at !== now) { expireMoodlets(db, now, s.mood_state); return; }
  const from = s.last_tick_at;
  const mods = traitMods(readTraits(db, cfg, agentId), cfg);
  // 0. emotional inertia: fold the decay since the last tick into each event moodlet, with a slower
  //    half-life (and a later expiry) for moodlets that match the rung the mood was on meanwhile.
  rebaseMoodlets(db, s.mood_state, now);
  // 1. drain / rest
  const proj = projectNeeds(db, s, now, mods);
  const up = db.prepare("UPDATE inner_needs SET level = ?, updated_at = ? WHERE need = ?");
  for (const [n, v] of proj) up.run(v.level, now, n);
  db.prepare("UPDATE inner_state SET last_tick_at = ?, updated_at = ? WHERE id = 'singleton'").run(now, now);

  // 2. emotionally weighted memories written since the last tick become moodlets
  try {
    const rows = db.prepare("SELECT label, emotional_weight AS w FROM nodes WHERE created_at > ? AND created_at <= ? AND ABS(emotional_weight) >= 0.35 ORDER BY created_at").all(from, now) as Array<{ label: string; w: number }>;
    for (const r of rows) {
      const pos = r.w > 0;
      addMoodlet(db, { key: pos ? "glad" : "upset", label: pos ? "Glad" : "Upset", reason: r.label, valence: pos ? 1 : -1, intensity: Math.abs(r.w), hours: 12, source: "memory" }, mods, now);
    }
  } catch { /* nodes table shape */ }
  // 2b. memories tagged inner:<kind> (brain_write tags) are events
  try {
    const rows = db.prepare("SELECT label, scope_tags AS t FROM nodes WHERE created_at > ? AND created_at <= ? AND scope_tags LIKE '%inner:%'").all(from, now) as Array<{ label: string; t: string }>;
    for (const r of rows) {
      let tags: string[] = []; try { tags = JSON.parse(r.t) as string[]; } catch { /* skip */ }
      for (const k of tags.map((x) => /^inner:([a-z]+)$/i.exec(String(x).trim())?.[1]?.toLowerCase()).filter((x): x is string => !!x && (EVENT_KINDS as readonly string[]).includes(x))) {
        applyEventDb(db, mods, { kind: k as InnerEventKind, reason: r.label, tags: tags.filter((x) => !String(x).startsWith("inner:")) }, "memory-tag", now);
      }
    }
  } catch { /* pre-v25 scope_tags */ }
  // 2c. cues in conversation turns (kinds listed in innerLife.episodeCueSkip never fire from chat)
  try {
    const eps = db.prepare("SELECT role, content FROM episodes WHERE created_at > ? AND created_at <= ? AND role IN ('user','assistant') ORDER BY created_at DESC LIMIT 50").all(from, now) as Array<{ role: string; content: string }>;
    const seen = new Set<string>((innerConfig(cfg).episodeCueSkip ?? []).map((k) => String(k).trim().toLowerCase()).filter(Boolean));
    for (const e of eps) for (const c of EPISODE_CUES) {
      if (seen.has(c.kind) || (c.role !== "any" && c.role !== e.role)) continue;
      const m = c.re.exec(e.content);
      if (!m) continue;
      seen.add(c.kind);
      const at = Math.max(0, m.index - 40);
      applyEventDb(db, mods, { kind: c.kind, reason: `"${oneLine(e.content.slice(at, m.index + 80), 90)}"`, intensity: EPISODE_CUE_INTENSITY }, "episode", now);
    }
  } catch { /* ok */ }
  // 2d. the owner talking with the agent in a live session (meta.owner, or config fallbacks); capped per rolling hour
  try { ownerChatDb(db, cfg, mods, from, now); } catch { /* ok */ }
  // 3. decision outcomes since the last tick are reward prediction errors
  try {
    const rows = db.prepare("SELECT chosen, predicted_confidence AS p, outcome_status AS st FROM decisions WHERE outcome_at > ? AND outcome_at <= ? AND outcome_status IS NOT NULL").all(from, now) as Array<{ chosen: string; p: number | null; st: string }>;
    for (const r of rows) {
      const actual = r.st === "matched" ? 1 : r.st === "partial" ? 0.5 : 0;
      applyRpe(db, { expected: r.p ?? 0.6, actual, reason: r.chosen, source: "decision", now, mods });
    }
  } catch { /* pre-v20 */ }
  // 4. commitments kept → competence; contradictions / supersedes (model updates) → inspiration
  try {
    const n = (db.prepare("SELECT COUNT(*) AS n FROM commitments WHERE done_at > ? AND done_at <= ?").get(from, now) as { n: number }).n;
    if (n) adjustNeed(db, "competence", 0.1 * n, now);
  } catch { /* pre-v22 */ }
  try {
    const n = (db.prepare("SELECT COUNT(*) AS n FROM edges WHERE type IN ('contradicts','supersedes') AND created_at > ? AND created_at <= ?").get(from, now) as { n: number }).n;
    if (n) adjustNeed(db, "inspiration", 0.08 * n, now);
  } catch { /* ok */ }

  expireMoodlets(db, now, s.mood_state);
  syncNeedMoodlets(db, mods, now);
  if (innerConfig(cfg).autoWants) syncWants(db, mods, now);
  stepMoodLadder(db, mods, now);
}

function rebaseMoodlets(db: Database.Database, rung: string | null | undefined, now: number): void {
  const rows = db.prepare("SELECT * FROM inner_moodlets WHERE ended_at IS NULL AND need IS NULL AND half_life_h IS NOT NULL AND intensity_at < ?").all(now) as MoodRow[];
  const up = db.prepare("UPDATE inner_moodlets SET intensity = ?, intensity_at = ?, expires_at = ? WHERE id = ?");
  for (const r of rows) {
    const f = inertiaFor(rung, r.valence);
    const i = moodletIntensity(r, now, f);
    // time runs 1/f as fast for a lingering moodlet, so its remaining life stretches by the difference
    const exp = r.expires_at !== null && f !== 1 ? r.expires_at + (now - r.intensity_at) * (1 - 1 / f) : r.expires_at;
    up.run(i, now, exp, r.id);
  }
}

/** Event moodlets (with their inertia) plus need-bound moodlets (current discomfort), as valence / intensity. */
function currentMoodSum(db: Database.Database, mods: TraitMods, now: number, rung: string | null | undefined): { raw: number; strongestGood: number } {
  const levels = needLevels(db);
  let raw = 0, strongestGood = 0;
  for (const r of db.prepare("SELECT * FROM inner_moodlets WHERE ended_at IS NULL").all() as MoodRow[]) {
    let i: number;
    if (r.need && isNeed(r.need)) i = discomfort(1 - (levels.get(r.need)?.level ?? NEED_START), NEED_SPECS[r.need].weight * mods.weight[r.need]) * mods.neg;
    else { if (r.expires_at !== null && r.expires_at <= now) continue; i = moodletIntensity(r, now, inertiaFor(rung, r.valence)); if (i < FADED) continue; }
    raw += r.valence * i;
    if (r.valence > 0) strongestGood = Math.max(strongestGood, i);
  }
  return { raw, strongestGood };
}

/** The mood ladder moves at most one rung per tick toward the raw mood (hysteresis, earned Happy). */
function stepMoodLadder(db: Database.Database, mods: TraitMods, now: number): void {
  const s = db.prepare("SELECT mood_state FROM inner_state WHERE id = 'singleton'").get() as { mood_state: string | null } | undefined;
  const cur = MOOD_RUNGS[rungIdx(s?.mood_state)]!;
  const { raw, strongestGood } = currentMoodSum(db, mods, now, cur);
  const next = nextMoodRung(cur, raw, strongestGood);
  if (next === cur) return;
  db.prepare("UPDATE inner_state SET mood_state = ?, mood_state_at = ?, updated_at = ? WHERE id = 'singleton'").run(next, now, now);
  logEvent(db, "mood", `${MOOD_LABEL[cur]} → ${MOOD_LABEL[next]}`, null, null, { raw: Math.round(raw * 1000) / 1000, strongestGood: Math.round(strongestGood * 1000) / 1000 }, now);
}

function expireMoodlets(db: Database.Database, now: number, rung?: string | null): void {
  const rows = db.prepare("SELECT * FROM inner_moodlets WHERE ended_at IS NULL AND need IS NULL").all() as MoodRow[];
  const end = db.prepare("UPDATE inner_moodlets SET ended_at = ?, ended_reason = ? WHERE id = ?");
  for (const r of rows) {
    if (r.expires_at !== null && r.expires_at <= now) end.run(r.expires_at, "expired", r.id);
    else if (moodletIntensity(r, now, inertiaFor(rung, r.valence)) < FADED) end.run(now, "faded", r.id);
  }
}

const NEED_MOOD_ON = 0.6;   // deficit at which a need becomes a moodlet
const NEED_MOOD_OFF = 0.35; // deficit below which it ends ("need met")
function syncNeedMoodlets(db: Database.Database, mods: TraitMods, now: number): void {
  const levels = needLevels(db);
  for (const n of NEEDS) {
    const deficit = 1 - (levels.get(n)?.level ?? NEED_START);
    const spec = NEED_SPECS[n];
    const row = db.prepare("SELECT id FROM inner_moodlets WHERE need = ? AND ended_at IS NULL").get(n) as { id: string } | undefined;
    const intensity = discomfort(deficit, spec.weight * mods.weight[n]) * mods.neg;
    if (row && deficit < NEED_MOOD_OFF) db.prepare("UPDATE inner_moodlets SET ended_at = ?, ended_reason = 'need met' WHERE id = ?").run(now, row.id);
    else if (row) db.prepare("UPDATE inner_moodlets SET intensity = ?, intensity_at = ? WHERE id = ?").run(intensity, now, row.id);
    else if (deficit >= NEED_MOOD_ON) {
      db.prepare(`INSERT INTO inner_moodlets (id, key, label, reason, valence, intensity, intensity_at, half_life_h, need, source, created_at, expires_at)
                  VALUES (?, ?, ?, ?, -1, ?, ?, NULL, ?, 'need', ?, NULL)`).run(randomUUID(), `need:${n}`, spec.lowLabel, `${spec.label} is low (needs ${spec.metBy})`, intensity, now, n, now);
    }
  }
}

/** Unmet needs (and traits, which lower the bar for the needs they favour) turn into wants; met needs retire their auto wants. */
function syncWants(db: Database.Database, mods: TraitMods, now: number): void {
  const levels = needLevels(db);
  for (const n of NEEDS) {
    const deficit = 1 - (levels.get(n)?.level ?? NEED_START);
    const open = db.prepare("SELECT id FROM inner_wants WHERE need = ? AND status = 'open' AND source LIKE 'need:%'").get(n) as { id: string } | undefined;
    const bar = mods.wants.has(n) ? 0.3 : 0.5;
    if (open && deficit < 0.2) { db.prepare("UPDATE inner_wants SET status = 'satisfied', resolved_at = ?, updated_at = ?, outcome_note = 'need met another way' WHERE id = ?").run(now, now, open.id); continue; }
    if (!open && deficit >= bar) {
      const spec = NEED_SPECS[n];
      const traitWhy = mods.wants.has(n) ? "; a trait makes this pull harder" : "";
      const prior = db.prepare("SELECT AVG(rpe) AS d FROM inner_wants WHERE need = ? AND rpe IS NOT NULL").get(n) as { d: number | null };
      const salience = clamp01(0.3 + deficit * 0.7 + (prior.d ?? 0) * 0.5);
      db.prepare(`INSERT INTO inner_wants (id, what, why, cost, cost_hours, source, need, tags_json, wanting, status, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`).run(randomUUID(), spec.want.what, `${spec.label} is low${traitWhy}`, spec.want.cost, spec.want.hours, `need:${n}`, n, JSON.stringify([n]), salience, now, now);
    }
  }
}

// ─── events / wants API ──────────────────────────────────────────────────────

export interface InnerEventInput { kind: InnerEventKind; reason?: string; intensity?: number; tags?: string[]; expected?: number; actual?: number }
/** Something happened that matters to a need or an incentive. Ticks first, then applies. */
export function innerEvent(agentId: string, cfg: Partial<BrainConfig>, input: InnerEventInput, now = Date.now()): { ok: boolean; error?: string; rpe?: number; moodletId?: string } {
  if (!innerLifeEnabled(cfg)) return { ok: false, error: "the inner-life layer is off (innerLife: false)" };
  const spec = EVENT_SPECS[input.kind];
  if (!spec) return { ok: false, error: `kind must be one of ${EVENT_KINDS.join(", ")}` };
  const I = typeof input.intensity === "number" && Number.isFinite(input.intensity) && input.intensity >= 0 ? input.intensity : 1;
  const db = getDb(agentId);
  let out: { ok: boolean; rpe?: number; moodletId?: string } = { ok: true };
  db.transaction(() => {
    tickDb(db, cfg, now, agentId);
    const mods = traitMods(readTraits(db, cfg, agentId), cfg);
    out = { ok: true, ...applyEventDb(db, mods, { ...input, intensity: I }, "tool", now) };
    syncNeedMoodlets(db, mods, now);
  })();
  return out;
}

function applyEventDb(db: Database.Database, mods: TraitMods, input: InnerEventInput, origin: string, now: number): { rpe?: number; moodletId?: string } {
  const spec = EVENT_SPECS[input.kind];
  const I = input.intensity ?? 1;
  const out: { rpe?: number; moodletId?: string } = {};
  const reason = oneLine(input.reason || input.kind, 200);
  const fit = mods.feeds[input.kind] ?? {};
  for (const n of new Set([...Object.keys(spec.needs), ...Object.keys(fit)]) as Set<Need>) {
    const d = ((spec.needs[n] ?? 0) + (fit[n] ?? 0)) * I;
    if (d) adjustNeed(db, n, d, now);
  }
  // praise lands harder on a vain agent (trait `praise` factor)
  const moodI = 0.6 * I * (input.kind === "praise" ? mods.praise : 1);
  if (spec.mood) out.moodletId = addMoodlet(db, { ...spec.mood, reason, intensity: moodI, source: `event:${input.kind}` }, mods, now);
  if (spec.incentive) {
    for (const tag of (input.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 5)) {
      const r = db.prepare("SELECT reward, penalty, n FROM inner_incentives WHERE tag = ?").get(tag) as { reward: number; penalty: number; n: number } | undefined;
      const rw = (r?.reward ?? 0) + 0.3 * ((spec.incentive === "reward" ? I : 0) - (r?.reward ?? 0));
      const pn = (r?.penalty ?? 0) + 0.3 * ((spec.incentive === "penalty" ? I : 0) - (r?.penalty ?? 0));
      db.prepare("INSERT INTO inner_incentives (tag, reward, penalty, n, updated_at) VALUES (?, ?, ?, 1, ?) ON CONFLICT(tag) DO UPDATE SET reward = excluded.reward, penalty = excluded.penalty, n = inner_incentives.n + 1, updated_at = excluded.updated_at").run(tag, rw, pn, now);
    }
  }
  if (typeof input.expected === "number") {
    const actual = typeof input.actual === "number" ? input.actual : (spec.mood?.valence ?? 1) > 0 ? 1 : 0;
    out.rpe = applyRpe(db, { expected: input.expected, actual, reason, source: `event:${input.kind}`, now, mods });
  }
  logEvent(db, input.kind, reason, I, out.rpe ?? null, { origin, ...(input.tags?.length ? { tags: input.tags } : {}) }, now);
  return out;
}

/** Is this user episode the owner? meta.owner === true wins; else ownerAllowFrom (sender) or ownerSessionIds. */
export function isOwnerEpisode(e: { session_id?: string | null; meta?: string | null }, cfg?: Partial<BrainConfig>): boolean {
  let meta: Record<string, unknown> = {};
  try { meta = e.meta ? (JSON.parse(e.meta) as Record<string, unknown>) : {}; } catch { meta = {}; }
  if (meta.owner === true) return true;
  if (meta.owner === false) return false;
  const c = innerConfig(cfg);
  const allow = new Set((c.ownerAllowFrom ?? []).map((x) => String(x).trim().toLowerCase()).filter(Boolean));
  if (allow.size) for (const k of ["sender", "senderId", "from", "sender_id"]) {
    const v = meta[k];
    if ((typeof v === "string" || typeof v === "number") && allow.has(String(v).trim().toLowerCase())) return true;
  }
  return !!e.session_id && (c.ownerSessionIds ?? []).includes(e.session_id);
}

function ownerChatDb(db: Database.Database, cfg: Partial<BrainConfig>, mods: TraitMods, from: number, now: number): void {
  const eps = db.prepare("SELECT session_id, meta, created_at FROM episodes WHERE created_at > ? AND created_at <= ? AND role = 'user' ORDER BY created_at").all(from, now) as Array<{ session_id: string; meta: string | null; created_at: number }>;
  const owned = eps.filter((e) => isOwnerEpisode(e, cfg));
  if (!owned.length) return;
  const recent = (db.prepare("SELECT COUNT(*) AS n FROM inner_events WHERE kind = 'owner_chat' AND at > ? AND at <= ?").get(now - HOUR, now) as { n: number }).n;
  // one credit per half hour of chat in this window, never past the hourly cap
  const spanH = (owned[owned.length - 1]!.created_at - owned[0]!.created_at) / HOUR;
  const credits = Math.min(OWNER_CHAT_MAX_PER_HOUR - recent, 1 + Math.floor(spanH * 2));
  for (let i = 0; i < credits; i++) applyEventDb(db, mods, { kind: "owner_chat", reason: "talking with the mayor" }, "owner-session", now);
}

/**
 * Conservative cues in conversation turns that count as events (one per kind per tick).
 * They let the layer run on hosts that do not expose brain_inner yet. Owner turns can carry
 * praise / rejection; the agent's own turns carry collab / hobby / novelty / success / failure.
 */
const EPISODE_CUES: Array<{ kind: InnerEventKind; role: "user" | "assistant" | "any"; re: RegExp }> = [
  { kind: "collab",    role: "any",       re: /\b(collab(orat(e|ed|ing|ion))?|pair(ed)? up|teamed up|worked (on it )?together|together with)\b/i },
  { kind: "hobby",     role: "assistant", re: /\b(my hobby|for fun|just for fun|played (music|a game|guitar)|doodled|tinkered)\b/i },
  { kind: "novelty",   role: "assistant", re: /\b(discovered|for the first time|never seen|didn'?t expect|surprised me|explored)\b/i },
  { kind: "success",   role: "assistant", re: /\b(shipped|all tests pass(ed)?|tests (are )?green|merged it|deployed it|it works now|all pass|0 failures|placed (it )?in game3d)\b/i },
  // mayor's rules 2026-11-05: creative sessions count as Fun + Social; running with her idea (own spin) counts as Autonomy.
  { kind: "hobby",     role: "any",       re: /\b(brainstorm(ed|ing)?|dreamed up|dreaming up|let'?s (imagine|dream up|design)|what if we|sketched (it )?out|riffed?( on)?|designing (it )?together)\b/i },
  { kind: "collab",    role: "any",       re: /\b(brainstorm(ed|ing)?|dreamed up|let'?s (imagine|dream up|design)|what if we|riffed?( on)?|designing (it )?together)\b/i },
  { kind: "chosen",    role: "assistant", re: /\b(my own spin|my (own )?take on|ran with (it|that|your idea)|took (it|that) (further|a step further)|you didn'?t ask for|nobody asked for|added (a few )?(something|extras?) of my own|picked the design myself|i chose the design)\b/i },
  { kind: "failure",   role: "assistant", re: /\b(i broke|build (is )?(red|broken)|my (fix|change) failed|that didn'?t work)\b/i },
  { kind: "praise",    role: "user",      re: /\b(great job|well done|nice work|good work|love (it|this)|amazing work|thank you|thanks)\b/i },
  { kind: "rejection", role: "user",      re: /\b(that'?s (wrong|not what i asked)|i don'?t like (it|this)|not what i (asked|wanted)|stop doing)\b/i },
];
const EPISODE_CUE_INTENSITY = 0.5;

export interface WantInput { what: string; why?: string; cost?: string; costHours?: number; need?: string; tags?: string[]; reward?: number; penalty?: number; expectedSuccess?: number; source?: string }
export function addWant(agentId: string, cfg: Partial<BrainConfig>, input: WantInput, now = Date.now()): { ok: boolean; error?: string; id?: string } {
  if (!innerLifeEnabled(cfg)) return { ok: false, error: "the inner-life layer is off (innerLife: false)" };
  const what = oneLine(input.what ?? "", 200);
  if (!what) return { ok: false, error: "what is required" };
  if (input.need !== undefined && !isNeed(input.need)) return { ok: false, error: `need must be one of ${NEEDS.join(", ")}` };
  const db = getDb(agentId);
  const id = randomUUID();
  db.transaction(() => {
    tickDb(db, cfg, now, agentId);
    const deficit = input.need ? 1 - (needLevels(db).get(input.need as Need)?.level ?? NEED_START) : 0;
    db.prepare(`INSERT INTO inner_wants (id, what, why, cost, cost_hours, source, need, tags_json, reward, penalty, expected_success, wanting, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`).run(
      id, what, oneLine(input.why ?? "my own idea", 200), input.cost ? oneLine(input.cost, 60) : null, Math.max(0, input.costHours ?? 1),
      oneLine(input.source ?? "agent", 60), input.need ?? null, JSON.stringify((input.tags ?? []).slice(0, 5)),
      Math.max(0, input.reward ?? 0), Math.max(0, input.penalty ?? 0), input.expectedSuccess !== undefined ? clamp01(input.expectedSuccess) : null,
      clamp01(0.5 + deficit * 0.5), now, now);
  })();
  return { ok: true, id };
}

/** Finish a want. liking 0..1 = how it actually went; liking − wanting is the prediction error. */
export function resolveWant(agentId: string, cfg: Partial<BrainConfig>, idOrPrefix: string, input: { status: "done" | "dropped"; liking?: number; note?: string }, now = Date.now()): { ok: boolean; error?: string; rpe?: number; want?: string } {
  if (!innerLifeEnabled(cfg)) return { ok: false, error: "the inner-life layer is off (innerLife: false)" };
  const db = getDb(agentId);
  const p = (idOrPrefix ?? "").trim();
  if (p.length < 6) return { ok: false, error: "want_id (or a 6+ char prefix) is required" };
  const rows = db.prepare("SELECT * FROM inner_wants WHERE id LIKE ? AND status = 'open'").all(`${p}%`) as WantRow[];
  if (rows.length !== 1) return { ok: false, error: rows.length ? "that prefix matches more than one open want" : `no open want ${p}` };
  const w = rows[0]!;
  let rpe: number | undefined;
  db.transaction(() => {
    tickDb(db, cfg, now, agentId);
    const mods = traitMods(readTraits(db, cfg, agentId), cfg);
    if (input.status === "done") {
      const liking = clamp01(typeof input.liking === "number" ? input.liking : 0.6);
      rpe = applyRpe(db, { expected: w.wanting, actual: liking, reason: w.what, source: "want", now, mods });
      if (w.need && isNeed(w.need)) adjustNeed(db, w.need, 0.6, now);
      if (!w.source.startsWith("assigned")) adjustNeed(db, "autonomy", 0.2, now);
      db.prepare("UPDATE inner_wants SET status = 'done', liking = ?, rpe = ?, outcome_note = ?, resolved_at = ?, updated_at = ? WHERE id = ?").run(liking, rpe, input.note ? oneLine(input.note, 200) : null, now, now, w.id);
    } else {
      db.prepare("UPDATE inner_wants SET status = 'dropped', outcome_note = ?, resolved_at = ?, updated_at = ? WHERE id = ?").run(input.note ? oneLine(input.note, 200) : null, now, now, w.id);
    }
    syncNeedMoodlets(db, mods, now);
  })();
  return { ok: true, ...(rpe !== undefined ? { rpe } : {}), want: w.what };
}

/** Sleep: rest recovers, the phasic dopamine burst is spent, wants older than a week lapse. */
export function innerSleep(agentId: string, cfg: Partial<BrainConfig> = {}, now = Date.now()): boolean {
  if (!innerLifeEnabled(cfg)) return false;
  const db = getDb(agentId);
  if (!hasTables(db)) return false;
  db.transaction(() => {
    tickDb(db, cfg, now, agentId);
    adjustNeed(db, "rest", 0.35, now);
    db.prepare("UPDATE inner_state SET last_rpe = 0, updated_at = ? WHERE id = 'singleton'").run(now);
    db.prepare("UPDATE inner_wants SET status = 'lapsed', resolved_at = ?, updated_at = ? WHERE status = 'open' AND created_at < ?").run(now, now, now - 7 * 24 * HOUR);
    syncNeedMoodlets(db, traitMods(readTraits(db, cfg, agentId), cfg), now);
  })();
  return true;
}

// ─── read side ───────────────────────────────────────────────────────────────

/** Read-only view of the inner state at `now` (needs projected, moodlet intensities decayed). Null when the layer is off or never started. */
export function innerSnapshot(agentId: string, cfg: Partial<BrainConfig> = {}, now = Date.now()): InnerSnapshot | null {
  if (!innerLifeEnabled(cfg)) return null;
  const db = getDb(agentId);
  if (!hasTables(db)) return null;
  const s = db.prepare("SELECT * FROM inner_state WHERE id = 'singleton'").get() as StateRow | undefined;
  if (!s) return null;
  const traits = readTraits(db, cfg, agentId);
  const mods = traitMods(traits, cfg);
  const proj = projectNeeds(db, s, now, mods);
  const needs: NeedState[] = NEEDS.map((n) => {
    const v = proj.get(n)!;
    const deficit = 1 - v.level;
    return { need: n, label: NEED_SPECS[n].label, level: v.level, deficit, discomfort: discomfort(deficit, NEED_SPECS[n].weight * mods.weight[n]), lastMetAt: v.last_met_at };
  });
  const moodlets: Moodlet[] = (db.prepare("SELECT * FROM inner_moodlets WHERE ended_at IS NULL").all() as MoodRow[])
    .map((r) => ({ r, i: r.need && isNeed(r.need) ? (needs.find((x) => x.need === r.need)!.discomfort * mods.neg) : moodletIntensity(r, now, inertiaFor(s.mood_state, r.valence)) }))
    .filter(({ r, i }) => (r.expires_at === null || r.expires_at > now) && (r.need ? true : i >= FADED))
    .map(({ r, i }) => ({ id: r.id, key: r.key, label: r.label, reason: r.reason, valence: r.valence, intensity: i, createdAt: r.created_at, expiresAt: r.expires_at, need: isNeed(r.need) ? r.need : null, source: r.source }))
    .sort((a, b) => b.intensity - a.intensity);
  const mood = moodlets.reduce((a, m) => a + m.valence * m.intensity, 0);
  const depth = moodlets.reduce((a, m) => a + m.intensity, 0);
  const phasic = s.last_rpe_at ? s.last_rpe * Math.pow(0.5, Math.max(0, now - s.last_rpe_at) / HOUR / 2) : 0;
  const restLevel = proj.get("rest")!.level;
  // Effort = what the agent can put in right now: rest (capacity) × tonic dopamine (vigor, Niv 2007).
  const effort = Math.sqrt(restLevel) * (0.5 + s.tonic_da);
  const resolved = db.prepare("SELECT need, COUNT(*) AS n, SUM(CASE WHEN liking >= 0.5 THEN 1 ELSE 0 END) AS good FROM inner_wants WHERE status = 'done' GROUP BY need").all() as Array<{ need: string | null; n: number; good: number }>;
  const competence = proj.get("competence")!.level;
  const wants: Want[] = (db.prepare("SELECT * FROM inner_wants WHERE status = 'open'").all() as WantRow[]).map((w) => {
    let tags: string[] = []; try { tags = JSON.parse(w.tags_json) as string[]; } catch { /* [] */ }
    const hist = resolved.find((r) => r.need === w.need);
    const rate = hist ? (hist.good + 1) / (hist.n + 2) : 0.5;
    const expectedSuccess = w.expected_success ?? clamp01(0.5 * rate + 0.5 * (0.4 + 0.6 * competence));
    let reward = w.reward, penalty = w.penalty;
    for (const t of tags) {
      const inc = db.prepare("SELECT reward, penalty FROM inner_incentives WHERE tag = ?").get(t.toLowerCase()) as { reward: number; penalty: number } | undefined;
      if (inc) { reward += inc.reward; penalty += inc.penalty; }
    }
    const need = isNeed(w.need) ? needs.find((x) => x.need === w.need)! : null;
    const needPush = need ? 1.5 * need.discomfort : 0;
    const traitPull = need && mods.wants.has(need.need) ? 0.2 : 0;
    const value = needPush + traitPull + reward - mods.lossAversion * penalty + 0.3 * w.wanting - 0.05 * w.cost_hours;
    const motivation = effort * expectedSuccess * value;
    const why = need && w.source.startsWith("need:") ? w.why.replace(/ is low\b/, ` is low (now ${Math.round(need.level * 100)}%)`) : w.why;
    return { id: w.id, what: w.what, why, cost: w.cost, costHours: w.cost_hours, source: w.source, need: need?.need ?? null, tags, reward, penalty, expectedSuccess, wanting: w.wanting, liking: w.liking, status: w.status, createdAt: w.created_at, value, effort, motivation };
  }).sort((a, b) => b.motivation - a.motivation);
  const unmet = [...needs].sort((a, b) => b.discomfort - a.discomfort);
  const rung = MOOD_RUNGS[rungIdx(s.mood_state)]!;
  const strongestGood = moodlets.reduce((a, m) => (m.valence > 0 ? Math.max(a, m.intensity) : a), 0);
  return {
    at: now, traits, traitEffects: traits.map(resolveTrait), drainRates: { ...mods.rate },
    moodState: { rung, label: MOOD_LABEL[rung], since: s.mood_state_at ?? null, heading: moodRungFor(mood, strongestGood) },
    needs, moodlets, mood, depth,
    dopamine: { tonic: s.tonic_da, phasic, lastRpe: s.last_rpe, lastRpeAt: s.last_rpe_at, lastRpeReason: s.last_rpe_reason, level: s.tonic_da + 0.5 * phasic + 0.25 * Math.max(0, wants[0]?.motivation ?? 0) },
    effort, wants,
    topNeed: unmet[0] && unmet[0].deficit > 0.2 ? unmet[0] : null,
    topWant: wants[0] && wants[0].motivation > 0 ? wants[0] : null,
  };
}

const sgn = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(2)}`;
function hoursLabel(ms: number): string {
  const h = ms / HOUR;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

/** The compact (≤3 line) block for the turn header: current mood, top unmet need, top want. */
export function formatInnerHeader(s: InnerSnapshot): string {
  const now = s.at;
  const lines: string[] = [];
  // Strongest of each sign when both exist (a deep low should not hide a fresh high), else the top two.
  const pos = s.moodlets.find((m) => m.valence > 0), neg = s.moodlets.find((m) => m.valence < 0);
  const picked = pos && neg ? [pos, neg].sort((a, b) => b.intensity - a.intensity) : s.moodlets.slice(0, 2);
  const top = picked.map((m) => {
    const emoji = m.need ? NEED_SPECS[m.need].lowEmoji : (EVENT_EMOJI[m.key] ?? (m.valence > 0 ? "🙂" : "🙁"));
    const left = m.expiresAt ? `, ${hoursLabel(m.expiresAt - now)} left` : m.need ? ", until met" : "";
    return `${emoji} ${m.label} ${m.intensity.toFixed(2)} (${oneLine(m.reason, 50)}${left})`;
  });
  const more = s.moodlets.length > 2 ? ` +${s.moodlets.length - 2} more` : "";
  const da = s.dopamine;
  const rpe = da.lastRpeAt && Math.abs(da.lastRpe) >= 0.01 ? `, last RPE ${sgn(da.lastRpe)} ${hoursLabel(now - da.lastRpeAt)} ago` : "";
  const ms = s.moodState;
  const ladder = ms ? `${ms.label}${ms.heading !== ms.rung ? ` → ${MOOD_LABEL[ms.heading]}` : ""} ` : "";
  lines.push(`[inner · functional states] mood ${ladder}${sgn(s.mood)}${top.length ? ` · ${top.join(" · ")}${more}` : " · baseline"} · dopamine ${da.level.toFixed(2)}${rpe}`);
  if (s.topNeed) {
    const n = s.topNeed;
    const since = n.lastMetAt ? `, ${hoursLabel(now - n.lastMetAt)} since ${NEED_SPECS[n.need].metBy}` : `, needs ${NEED_SPECS[n.need].metBy}`;
    lines.push(`[inner] top unmet need: ${n.label} ${n.level.toFixed(2)} (discomfort ${n.discomfort.toFixed(2)}${since})`);
  }
  if (s.topWant) {
    const w = s.topWant;
    lines.push(`[inner] top want: ${oneLine(w.what, 90)} (why: ${oneLine(w.why, 60)}${w.cost ? `; cost ${w.cost}` : ""}) · motivation ${w.motivation.toFixed(2)} = effort ${w.effort.toFixed(2)} × success ${w.expectedSuccess.toFixed(2)} × value ${w.value.toFixed(2)}`);
  }
  return lines.join("\n");
}
const EVENT_EMOJI: Record<string, string> = Object.fromEntries([
  ...Object.values(EVENT_SPECS).filter((e) => e.mood).map((e) => [e.mood!.key, e.mood!.emoji]),
  ["delighted", "😃"], ["disappointed", "😞"], ["glad", "🙂"], ["upset", "🙁"],
]);

/** Tick, then build the header block. Empty string when off. Safe to call every turn. */
export function innerTurnHeader(agentId: string, cfg: Partial<BrainConfig> = {}, now = Date.now()): string {
  const c = innerConfig(cfg);
  if (!c.enabled || !c.header) return "";
  if (!innerTick(agentId, cfg, now)) return "";
  const s = innerSnapshot(agentId, cfg, now);
  return s ? formatInnerHeader(s) : "";
}

/** Longer read-out for brain_inner status. */
export function formatInnerStatus(s: InnerSnapshot): string {
  const now = s.at;
  const out: string[] = [formatInnerHeader(s), ""];
  const traitText = (t: string) => {
    const r = resolveTrait(t);
    if (!r.effects.length) return `${t} (no built-in effect)`;
    const keys = r.effects.map((e) => `${e.key}${e.strength < 1 ? ` ½` : ""}`).join(", ");
    return r.effects.length === 1 && r.effects[0]!.key === t ? t : `${t} (→ ${keys})`;
  };
  out.push(`Traits: ${s.traits.length ? s.traits.map(traitText).join("; ") : "none (set an identity field \"Traits\" via brain_identity, 3-5 words, or innerLife.traitsByAgent)"}`);
  const fast = NEEDS.filter((n) => Math.abs(s.drainRates[n] - 1) > 0.005 && NEED_SPECS[n].drainPerHour > 0).map((n) => `${NEED_SPECS[n].label} ×${s.drainRates[n].toFixed(2)}`);
  if (fast.length) out.push(`Drain: ${fast.join(" · ")}`);
  const ms = s.moodState;
  out.push(`Mood: ${ms.label}${ms.since ? ` for ${hoursLabel(now - ms.since)}` : ""} (raw ${sgn(s.mood)}${ms.heading !== ms.rung ? `, heading ${MOOD_LABEL[ms.heading]}; moves one step per tick` : ""}) · ladder Sad | ${MOOD_BOUNDS.map((b) => sgn(b)).join(" | ")} | Happy, margin ${MOOD_MARGIN}, Happy needs a good moodlet ≥ ${HAPPY_NEEDS}`);
  out.push(`Needs: ${s.needs.map((n) => `${n.label} ${n.level.toFixed(2)}`).join(" · ")}`);
  out.push(`Dopamine: tonic ${s.dopamine.tonic.toFixed(2)} (reward-rate EMA) · phasic ${sgn(s.dopamine.phasic)}${s.dopamine.lastRpeReason ? ` (last: ${s.dopamine.lastRpeReason})` : ""} · effort ${s.effort.toFixed(2)}`);
  out.push(`Moodlets (${s.moodlets.length}):`);
  for (const m of s.moodlets.slice(0, 8)) out.push(`  ${m.valence > 0 ? "+" : "−"} ${m.label} ${m.intensity.toFixed(2)}: ${m.reason}${m.expiresAt ? ` (${hoursLabel(m.expiresAt - now)} left)` : m.need ? " (until the need is met)" : ""}`);
  out.push(`Open wants (${s.wants.length}):`);
  for (const w of s.wants.slice(0, 8)) out.push(`  [${w.id.slice(0, 8)}] ${w.what} — why: ${w.why}; cost ${w.cost ?? `${w.costHours}h`}; from ${w.source}; motivation ${w.motivation.toFixed(2)} (wanting ${w.wanting.toFixed(2)})`);
  out.push("These are functional states (numbers that steer attention and choice), not a claim of human-identical feeling.");
  return out.join("\n");
}
