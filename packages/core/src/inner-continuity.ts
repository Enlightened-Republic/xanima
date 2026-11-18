/**
 * Inner life, continuity (schema v31). Four small additions to the functional
 * motivation layer in inner-life.ts, all of them about carrying something from
 * one wake to the next:
 *
 *   - Wants that persist: bulk import, and an own want that goes untouched comes
 *     back in the header on a widening schedule, with its "why".
 *   - Away notes: a short note about a gap ("away about 9 hours; this moved"),
 *     stored as a low-importance episodic memory and folded per day at sleep.
 *   - Mood weather: one or two plain sentences about the last few days, built at
 *     sleep from moodlet history and mood-ladder changes. No model call.
 *   - Bonds: one item per person with a running one-line description, a direction
 *     (warming / steady / cooling) derived from recent exchanges, and the last few
 *     exchanges that moved it.
 *
 * Same framing as the rest of the layer: these are functional states and records
 * that steer what the agent is shown. Nothing here claims human-identical feeling.
 *
 * Everything is a no-op when innerLife is off or the agent is in excludeAgents.
 *
 * Note on imports: inner-life.ts and this module import each other. Imported
 * names are only used inside function bodies, never at module load.
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { getDb } from "./db.js";
import { writeNode } from "./nodes.js";
import type { BrainConfig } from "./types.js";
import {
  innerLifeEnabled, INNER_OFF, MOOD_RUNGS, EVENT_KINDS, NEEDS,
  innerTickDb, innerHasTables, adjustNeedDb, logInnerEventDb, insertWantDb,
  type InnerLifeConfig, type WantInput, type Need,
} from "./inner-life.js";

const HOUR = 3600_000;
const DAY = 24 * HOUR;

// ─── config ──────────────────────────────────────────────────────────────────

export interface WantResurfaceConfig {
  /** Hours an own want may sit untouched before its first reminder. Default 24. */
  firstHours?: number;
  /** Each reminder multiplies the wait by this. Default 2 (1d, 2d, 4d, ...). */
  factor?: number;
  /** The wait never grows past this many days. Default 30. */
  maxDays?: number;
  /** At most one reminder (for any want) per this many hours. Default 6. */
  minGapHours?: number;
}
export interface AwayConfig {
  /** A gap shorter than this many hours is not "away". Default 4. */
  minHours?: number;
  /** Compose a minimal note from the brain's own records when the host supplies none. Default true. */
  auto?: boolean;
  /** Importance of the stored memory, 0..1. Default 0.25. */
  importance?: number;
}
export interface WeatherConfig {
  /** How many days back the sentence looks. Default 3. */
  days?: number;
  /** How many past weather entries to keep. Default 7. */
  keep?: number;
}
export interface BondsConfig {
  /** Window for "recent" exchanges, in days. Default 7. */
  recentDays?: number;
  /** A bond with no contact for this many days reads as cooling. Default 21. */
  coolAfterDays?: number;
  /** At sleep, this many turns naming a person count as contact (never as warmth). Default 3. */
  mentionMin?: number;
}
export interface ContinuityConfig {
  /** Lines the header may add beyond mood / need / want. */
  extraLines: number;
  wants: Required<WantResurfaceConfig> | null;
  away: Required<AwayConfig> | null;
  weather: Required<WeatherConfig> | null;
  bonds: Required<BondsConfig> | null;
}

const numIn = (v: unknown, d: number, min: number, max: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d);

/** Resolve the continuity switches under `innerLife`. Each feature is on by default once the layer is on; `false` turns one off. */
export function continuityConfig(cfg: Partial<BrainConfig> | undefined): ContinuityConfig {
  const raw = (cfg as { innerLife?: boolean | InnerLifeConfig } | undefined)?.innerLife;
  const o: InnerLifeConfig = raw && typeof raw === "object" ? raw : {};
  const sect = <T extends object>(v: boolean | T | undefined): T | null => (v === false ? null : v && typeof v === "object" ? v : ({} as T));
  const w = sect<WantResurfaceConfig>(o.wantResurface), a = sect<AwayConfig>(o.away), we = sect<WeatherConfig>(o.weather), b = sect<BondsConfig>(o.bonds);
  return {
    extraLines: Math.round(numIn(o.headerExtraLines, 2, 0, 4)),
    wants: w && { firstHours: numIn(w.firstHours, 24, 0.1, 24 * 365), factor: numIn(w.factor, 2, 1, 10), maxDays: numIn(w.maxDays, 30, 0.1, 365), minGapHours: numIn(w.minGapHours, 6, 0, 24 * 30) },
    away: a && { minHours: numIn(a.minHours, 4, 0, 24 * 365), auto: a.auto !== false, importance: numIn(a.importance, 0.25, 0, 1) },
    weather: we && { days: numIn(we.days, 3, 1, 30), keep: Math.round(numIn(we.keep, 7, 1, 60)) },
    bonds: b && { recentDays: numIn(b.recentDays, 7, 1, 90), coolAfterDays: numIn(b.coolAfterDays, 21, 1, 365), mentionMin: Math.round(numIn(b.mentionMin, 3, 1, 100)) },
  };
}

// ─── small helpers ───────────────────────────────────────────────────────────

const oneLine = (s: string, max: number) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
function short(ms: number): string {
  const h = ms / HOUR;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}
/** "about 9 hours", "about 3 days": a gap the way someone would say it. */
export function durationWords(ms: number): string {
  const m = Math.max(0, ms) / 60_000;
  const n = (x: number, unit: string) => `about ${x} ${unit}${x === 1 ? "" : "s"}`;
  if (m < 90) return n(Math.max(1, Math.round(m)), "minute");
  const h = m / 60;
  if (h < 36) return n(Math.round(h), "hour");
  return n(Math.round(h / 24), "day");
}
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** Weekday name in the process's local time (the host's day, which is the one the agent lives in). */
export const weekdayOf = (t: number) => WEEKDAYS[new Date(t).getDay()]!;
const list = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const parseArr = (s: string | null | undefined): string[] => { try { const v = JSON.parse(s ?? "[]") as unknown; return Array.isArray(v) ? v.map(String) : []; } catch { return []; } };

interface StateCols { last_turn_at: number | null; away_from: number | null; away_seen_at: number | null; last_sleep_at: number | null; mood_state: string | null }
function stateCols(db: Database.Database): StateCols | undefined {
  return db.prepare("SELECT last_turn_at, away_from, away_seen_at, last_sleep_at, mood_state FROM inner_state WHERE id = 'singleton'").get() as StateCols | undefined;
}
function ready(agentId: string, cfg: Partial<BrainConfig>): Database.Database | null {
  if (!innerLifeEnabled(cfg, agentId)) return null;
  const db = getDb(agentId);
  return innerHasTables(db) ? db : null;
}

// ═══ 1. wants that persist ═══════════════════════════════════════════════════

/** A want the agent wrote (or was handed), as opposed to one generated from a low need. */
const OWN_WANT = "source NOT LIKE 'need:%'";
/** A reminder that was just shown stays the reminder for this long, so two header builds in one turn agree. */
const STICKY_MS = 10 * 60_000;
export const MAX_WANTS_PER_IMPORT = 100;

const wantKey = (s: string) => s.toLowerCase().replace(/['’]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export interface ImportWantsResult { ok: boolean; error?: string; added: Array<{ id: string; what: string }>; skipped: Array<{ what: string; reason: string }> }
/**
 * Add many wants in one call (a wishlist moved into the brain). Each item is a string or a full
 * want. Items that match an open want, or an earlier item in the same list, are skipped: the
 * match ignores case, punctuation and spacing, nothing looser.
 */
export function addWants(agentId: string, cfg: Partial<BrainConfig>, items: Array<string | WantInput>, now = Date.now()): ImportWantsResult {
  const out: ImportWantsResult = { ok: true, added: [], skipped: [] };
  if (!innerLifeEnabled(cfg, agentId)) return { ...out, ok: false, error: INNER_OFF };
  if (!Array.isArray(items) || !items.length) return { ...out, ok: false, error: "items is required: a list of wants (strings, or objects with what / why / cost / need)" };
  const db = getDb(agentId);
  db.transaction(() => {
    innerTickDb(db, cfg, now, agentId);
    const seen = new Set((db.prepare("SELECT what FROM inner_wants WHERE status = 'open'").all() as Array<{ what: string }>).map((r) => wantKey(r.what)));
    for (const [i, it] of items.entries()) {
      const input: WantInput = typeof it === "string" ? { what: it } : { ...(it ?? { what: "" }) };
      const what = oneLine(String(input.what ?? ""), 200);
      if (!what) { out.skipped.push({ what: "", reason: "empty" }); continue; }
      if (i >= MAX_WANTS_PER_IMPORT) { out.skipped.push({ what, reason: `over the ${MAX_WANTS_PER_IMPORT}-item limit for one call` }); continue; }
      const key = wantKey(what);
      if (seen.has(key)) { out.skipped.push({ what, reason: "already an open want" }); continue; }
      if (input.need !== undefined && !(NEEDS as readonly string[]).includes(String(input.need))) { out.skipped.push({ what, reason: `need must be one of ${NEEDS.join(", ")}` }); continue; }
      seen.add(key);
      out.added.push({ id: insertWantDb(db, { ...input, what }, now), what });
    }
  })();
  return out;
}

/** "I am still on this": restart the reminder clock for a want, and optionally rewrite its why. */
export function touchWant(agentId: string, cfg: Partial<BrainConfig>, idOrPrefix: string, input: { why?: string } = {}, now = Date.now()): { ok: boolean; error?: string; want?: string } {
  if (!innerLifeEnabled(cfg, agentId)) return { ok: false, error: INNER_OFF };
  const db = getDb(agentId);
  const p = (idOrPrefix ?? "").trim();
  if (p.length < 6) return { ok: false, error: "want_id (or a 6+ char prefix) is required" };
  const rows = db.prepare("SELECT id, what FROM inner_wants WHERE id LIKE ? AND status = 'open'").all(`${p.replace(/[%_]/g, "")}%`) as Array<{ id: string; what: string }>;
  if (rows.length !== 1) return { ok: false, error: rows.length ? "that prefix matches more than one open want" : `no open want ${p}` };
  const why = input.why ? oneLine(input.why, 200) : null;
  db.prepare("UPDATE inner_wants SET touched_at = ?, surface_count = 0, last_surfaced_at = NULL, why = COALESCE(?, why), updated_at = ? WHERE id = ?").run(now, why, now, rows[0]!.id);
  return { ok: true, want: rows[0]!.what };
}

interface NagRow { id: string; what: string; why: string; cost: string | null; created_at: number; touched_at: number | null; last_surfaced_at: number | null; surface_count: number }
const waitMs = (c: Required<WantResurfaceConfig>, count: number) => Math.min(c.maxDays * DAY, c.firstHours * HOUR * Math.pow(c.factor, Math.max(0, count)));

export interface DueWant { id: string; what: string; why: string; cost: string | null; untouchedMs: number; surfaceCount: number; nextInMs: number; sticky: boolean }
/**
 * The own want that should come back now, if any. A want is due when it has sat untouched (and
 * unreminded) for its current wait: firstHours × factor^reminders, capped at maxDays. The most
 * neglected one wins, and there is at most one reminder per minGapHours across all wants.
 * `excludeId` is the want already on the "top want" line.
 */
export function dueWant(db: Database.Database, c: Required<WantResurfaceConfig>, now: number, excludeId?: string | null): DueWant | null {
  const rows = db.prepare(`SELECT id, what, why, cost, created_at, touched_at, last_surfaced_at, surface_count FROM inner_wants WHERE status = 'open' AND ${OWN_WANT}`).all() as NagRow[];
  const view = (r: NagRow, sticky: boolean): DueWant => ({
    id: r.id, what: r.what, why: r.why, cost: r.cost, untouchedMs: now - (r.touched_at ?? r.created_at), surfaceCount: r.surface_count,
    nextInMs: waitMs(c, sticky ? r.surface_count : r.surface_count + 1), sticky,
  });
  const last = rows.filter((r) => r.last_surfaced_at !== null && r.last_surfaced_at <= now).sort((a, b) => b.last_surfaced_at! - a.last_surfaced_at!)[0];
  if (last && now - last.last_surfaced_at! < STICKY_MS) return last.id === excludeId ? null : view(last, true);
  if (last && now - last.last_surfaced_at! < c.minGapHours * HOUR) return null;
  const due = rows
    .filter((r) => r.id !== excludeId && now - Math.max(r.touched_at ?? r.created_at, r.last_surfaced_at ?? 0) >= waitMs(c, r.surface_count))
    .sort((a, b) => (a.touched_at ?? a.created_at) - (b.touched_at ?? b.created_at));
  return due[0] ? view(due[0], false) : null;
}
function markSurfaced(db: Database.Database, id: string, now: number): void {
  db.prepare("UPDATE inner_wants SET last_surfaced_at = ?, surface_count = surface_count + 1 WHERE id = ?").run(now, id);
}
function wantLine(d: DueWant): string {
  return `[inner] still wanting, untouched ${short(d.untouchedMs)}: ${oneLine(d.what, 90)} (why: ${oneLine(d.why, 70)}${d.cost ? `; cost ${d.cost}` : ""}) · back in ~${short(d.nextInMs)} unless touched · ${d.id.slice(0, 8)}`;
}

// ═══ 2. a felt gap after time away ═══════════════════════════════════════════

/** How long a host has to replace the brain's own note for the same return. (The header shows a fresh note for STICKY_MS.) */
const AWAY_FRESH_MS = 30 * 60_000;
const MAX_MOVED = 5;

interface AwayRow { id: string; node_id: string | null; gap_ms: number; moved_json: string; text: string; source: string; at: number; folded_into: string | null }

/** The stored text of an away note. */
export function awayText(gapMs: number, moved: string[], note?: string): string {
  const head = `Away ${durationWords(gapMs)}.`;
  const body = moved.length ? ` While I was gone: ${moved.join("; ")}.` : "";
  return `${head}${body}${note ? ` ${note.replace(/[.\s]+$/, "")}.` : ""}`;
}

/**
 * What the brain itself knows moved in (from, now]: promises that came due, where the mood
 * went, states that wore off or set in, wants that lapsed, sleep. At most three, most
 * consequential first. Empty when nothing moved.
 */
export function composeAwayItems(db: Database.Database, from: number, now: number): string[] {
  const items: string[] = [];
  try {
    const due = db.prepare("SELECT title FROM commitments WHERE status = 'open' AND due_at > ? AND due_at <= ? ORDER BY due_at").all(from, now) as Array<{ title: string }>;
    if (due.length) items.push(`a promise came due (${oneLine(due[0]!.title, 60)}${due.length > 1 ? `, and ${due.length - 1} more` : ""})`);
  } catch { /* pre-v22 */ }
  const moods = db.prepare("SELECT reason FROM inner_events WHERE kind = 'mood' AND at > ? AND at <= ? ORDER BY at, id").all(from, now) as Array<{ reason: string | null }>;
  if (moods.length) {
    const first = (moods[0]!.reason ?? "").split(" → ")[0]?.trim(), last = (moods[moods.length - 1]!.reason ?? "").split(" → ")[1]?.trim();
    const ri = (l?: string) => (MOOD_RUNGS as readonly string[]).indexOf((l ?? "").toLowerCase());
    if (first && last && ri(first) >= 0 && ri(last) >= 0 && ri(first) !== ri(last)) items.push(`my mood ${ri(last) > ri(first) ? "lifted" : "slid"} from ${first} to ${last}`);
  }
  const setIn = db.prepare("SELECT need FROM inner_moodlets WHERE need IS NOT NULL AND ended_at IS NULL AND created_at > ? AND created_at <= ? ORDER BY intensity DESC").all(from, now) as Array<{ need: string }>;
  if (setIn.length) items.push(`I started feeling ${list(setIn.slice(0, 2).map((r) => NEED_WORDS[r.need as Need] ?? r.need))}`);
  const wore = db.prepare("SELECT label, reason FROM inner_moodlets WHERE need IS NULL AND ended_at > ? AND ended_at <= ? ORDER BY (ended_at - created_at) DESC LIMIT 1").get(from, now) as { label: string; reason: string } | undefined;
  if (wore) { const r = cleanReason(wore.reason); items.push(`${wore.label} wore off${r ? ` (${r})` : ""}`); }
  const lapsed = db.prepare("SELECT what FROM inner_wants WHERE status = 'lapsed' AND resolved_at > ? AND resolved_at <= ? ORDER BY resolved_at DESC").all(from, now) as Array<{ what: string }>;
  if (lapsed.length) items.push(`a want lapsed (${oneLine(lapsed[0]!.what, 50)}${lapsed.length > 1 ? `, and ${lapsed.length - 1} more` : ""})`);
  const slept = (db.prepare("SELECT COUNT(*) AS n FROM inner_events WHERE kind = 'sleep' AND at > ? AND at <= ?").get(from, now) as { n: number }).n;
  if (slept) items.push(slept === 1 ? "I slept once" : `I slept ${slept} times`);
  return items.slice(0, 3);
}

function storeAway(db: Database.Database, agentId: string, c: Required<AwayConfig>, input: { gapMs: number; moved: string[]; note?: string; source: string }, now: number): AwayRow {
  const text = awayText(input.gapMs, input.moved, input.note);
  const label = `Away ${short(input.gapMs)}, back ${isoDay(now)}`;
  // a note for the same return replaces the earlier one (the host's words replace the brain's own guess)
  const prev = db.prepare("SELECT * FROM inner_away_notes WHERE folded_into IS NULL AND source != 'fold' AND at > ? AND at <= ? ORDER BY at DESC LIMIT 1").get(now - AWAY_FRESH_MS, now) as AwayRow | undefined;
  const moved = JSON.stringify(input.moved.length ? input.moved : input.note ? [input.note] : []);
  if (prev) {
    if (prev.node_id) db.prepare("UPDATE nodes SET label = ?, content = ?, embedding = NULL, updated_at = ? WHERE id = ?").run(label, text, Date.now(), prev.node_id);
    db.prepare("UPDATE inner_away_notes SET gap_ms = ?, moved_json = ?, text = ?, source = ?, at = ? WHERE id = ?").run(input.gapMs, moved, text, input.source, now, prev.id);
    return { ...prev, gap_ms: input.gapMs, moved_json: moved, text, source: input.source, at: now };
  }
  const nodeId = writeNode(agentId, "episodic", label, text, { importance: c.importance, source: "inner:away", sourceType: "self_observation", deduplicate: false });
  const row: AwayRow = { id: randomUUID(), node_id: nodeId, gap_ms: input.gapMs, moved_json: moved, text, source: input.source, at: now, folded_into: null };
  db.prepare("INSERT INTO inner_away_notes (id, node_id, gap_ms, moved_json, text, source, at, folded_into) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)").run(row.id, row.node_id, row.gap_ms, row.moved_json, row.text, row.source, row.at);
  logInnerEventDb(db, "away", oneLine(text, 200), null, null, { gapMs: input.gapMs, source: input.source }, now);
  return row;
}

export interface AwayInput {
  /** How long the agent was away, in hours. Omitted: the gap the brain measured between turn headers. */
  hours?: number;
  /** Two or three short things that moved while away, in the host's words. */
  moved?: string[];
  /** A free line instead of (or after) the list. */
  note?: string;
}
export interface AwayResult { ok: boolean; error?: string; stored: boolean; reason?: string; text?: string; nodeId?: string | null; gapMs?: number }
/**
 * Hand in an away note. Stored as a low-importance episodic memory, and only when the gap is at
 * least `away.minHours`. With no `moved` and no `note` the brain composes a minimal one from its
 * own records, and stores nothing when nothing moved.
 */
export function innerAway(agentId: string, cfg: Partial<BrainConfig>, input: AwayInput = {}, now = Date.now()): AwayResult {
  if (!innerLifeEnabled(cfg, agentId)) return { ok: false, stored: false, error: INNER_OFF };
  const c = continuityConfig(cfg).away;
  if (!c) return { ok: false, stored: false, error: "away notes are off (innerLife.away: false)" };
  const db = getDb(agentId);
  if (!innerHasTables(db)) return { ok: false, stored: false, error: "no inner state yet" };
  innerTickDb(db, cfg, now, agentId);
  const st = stateCols(db);
  let gapMs: number;
  if (typeof input.hours === "number" && Number.isFinite(input.hours) && input.hours >= 0) gapMs = input.hours * HOUR;
  else if (st?.away_from && st.away_seen_at && now - st.away_seen_at <= AWAY_FRESH_MS) gapMs = st.away_seen_at - st.away_from;
  else if (st?.last_turn_at) gapMs = now - st.last_turn_at;
  else return { ok: false, stored: false, error: "hours is required (the brain has not measured a gap between turns yet)" };
  if (gapMs < c.minHours * HOUR) return { ok: true, stored: false, gapMs, reason: `away ${short(gapMs)}, under the ${c.minHours}h threshold (innerLife.away.minHours)` };
  let moved = (input.moved ?? []).map((m) => oneLine(String(m), 120).replace(/[.;\s]+$/, "")).filter(Boolean).slice(0, MAX_MOVED);
  const note = input.note ? oneLine(input.note, 300) : undefined;
  let source = "host";
  if (!moved.length && !note) {
    moved = composeAwayItems(db, now - gapMs, now);
    source = "brain";
    if (!moved.length) return { ok: true, stored: false, gapMs, reason: "nothing moved that the brain knows of" };
  }
  const row = storeAway(db, agentId, c, { gapMs, moved, note, source }, now);
  db.prepare("UPDATE inner_state SET away_from = NULL, away_seen_at = NULL WHERE id = 'singleton'").run();
  return { ok: true, stored: true, text: row.text, nodeId: row.node_id, gapMs };
}

/** Per turn: notice a gap since the last turn header, and (with away.auto) write the brain's own note for it. */
function noticeGap(db: Database.Database, agentId: string, c: Required<AwayConfig> | null, now: number): void {
  const st = stateCols(db);
  const last = st?.last_turn_at ?? null;
  if (c && last && now - last >= c.minHours * HOUR) {
    db.prepare("UPDATE inner_state SET away_from = ?, away_seen_at = ? WHERE id = 'singleton'").run(last, now);
    const fresh = db.prepare("SELECT 1 FROM inner_away_notes WHERE source != 'fold' AND at > ? AND at <= ?").get(now - AWAY_FRESH_MS, now);
    if (c.auto && !fresh) {
      const moved = composeAwayItems(db, last, now);
      if (moved.length) storeAway(db, agentId, c, { gapMs: now - last, moved, source: "brain" }, now);
    }
  }
  if (!last || now > last) db.prepare("UPDATE inner_state SET last_turn_at = ? WHERE id = 'singleton'").run(now);
}
function awayLine(db: Database.Database, now: number): string | null {
  const r = db.prepare("SELECT * FROM inner_away_notes WHERE source != 'fold' AND at > ? AND at <= ? ORDER BY at DESC LIMIT 1").get(now - STICKY_MS, now) as AwayRow | undefined;
  if (!r) return null;
  const moved = parseArr(r.moved_json);
  return `[inner] back after ~${short(r.gap_ms)} away${moved.length ? `: ${oneLine(moved.join("; "), 200)}` : ""}`;
}

/** Sleep: every calendar day (UTC) with two or more loose away notes becomes one note. Returns how many notes were folded away. */
export function foldAwayNotes(db: Database.Database, agentId: string, c: Required<AwayConfig>, now: number): number {
  const rows = db.prepare("SELECT * FROM inner_away_notes WHERE folded_into IS NULL AND at <= ? ORDER BY at").all(now) as AwayRow[];
  const byDay = new Map<string, AwayRow[]>();
  for (const r of rows) byDay.set(isoDay(r.at), [...(byDay.get(isoDay(r.at)) ?? []), r]);
  let folded = 0;
  for (const [day, group] of byDay) {
    if (group.length < 2) continue;
    const gap = group.reduce((a, r) => a + r.gap_ms, 0);
    const moved = [...new Set(group.flatMap((r) => parseArr(r.moved_json)))].slice(0, 6);
    // an earlier fold for this day already counts several stretches
    const stretches = group.reduce((a, r) => a + (r.source === "fold" ? Math.max(1, Number(/^Away (\d+) times/.exec(r.text)?.[1] ?? 1)) : 1), 0);
    const text = `Away ${stretches} times on ${day}, ${durationWords(gap)} in all.${moved.length ? ` What moved: ${moved.join("; ")}.` : ""}`;
    const nodeId = writeNode(agentId, "episodic", `Away notes for ${day}`, text, { importance: c.importance, source: "inner:away", sourceType: "self_observation", deduplicate: false });
    const id = randomUUID();
    const at = group[group.length - 1]!.at;
    db.prepare("INSERT INTO inner_away_notes (id, node_id, gap_ms, moved_json, text, source, at, folded_into) VALUES (?, ?, ?, ?, ?, 'fold', ?, NULL)").run(id, nodeId, gap, JSON.stringify(moved), text, at);
    const t = Date.now();
    for (const r of group) {
      db.prepare("UPDATE inner_away_notes SET folded_into = ? WHERE id = ?").run(id, r.id);
      if (r.node_id) db.prepare("UPDATE nodes SET status = 'superseded', status_reason = ?, status_changed_at = ?, valid_until = COALESCE(valid_until, ?), updated_at = ? WHERE id = ? AND status = 'active'")
        .run(`folded into ${nodeId} (the day's away notes)`, t, t, t, r.node_id);
      folded++;
    }
  }
  return folded;
}

// ═══ 3. continuity of mood: recent weather ═══════════════════════════════════

/** How a low need reads in a sentence. */
const NEED_WORDS: Record<Need, string> = { social: "lonely", fun: "bored", inspiration: "short on anything new", rest: "tired", autonomy: "boxed in", competence: "not getting much done", relatedness: "out of touch with people" };
/** How a moodlet reads in a sentence (by moodlet key; unknown keys use their label in lower case). */
const FEELING_WORDS: Record<string, string> = {
  proud: "proud", delighted: "delighted", disappointed: "let down", glad: "glad", upset: "upset", connected: "connected", playful: "playful", inspired: "inspired",
  rested: "rested", selfdirected: "glad to be choosing my own work", frustrated: "frustrated", appreciated: "appreciated", pleased: "pleased", stung: "stung", hurt: "hurt", hurting: "worn down",
};

/** A moodlet reason as it can sit in a sentence, or null when it would not read as one (chat snippets, stock need text). */
function cleanReason(reason: string): string | null {
  let t = String(reason ?? "").replace(/^(better|worse) than expected:\s*/i, "").replace(/\s+/g, " ").trim();
  if (!t || /^["“']/.test(t) || / is low \(needs /.test(t)) return null;
  if ((EVENT_KINDS as readonly string[]).includes(t.toLowerCase())) return null; // an event logged without a reason
  t = t.replace(/[.…!;:,\s]+$/u, "");
  if (t.length > 70) t = `${t.slice(0, 70).replace(/\s+\S*$/, "")}…`;
  return t || null;
}
/** "proud (shipped the walk clip)", "inspired from talking with a friend", "frustrated about the bridge build", "lonely". */
export function feelingPhrase(m: { key: string; label: string; reason: string; need: string | null }): string {
  if (m.need && (NEEDS as readonly string[]).includes(m.need)) return NEED_WORDS[m.need as Need];
  const adj = FEELING_WORDS[m.key] ?? m.label.toLowerCase();
  const r = cleanReason(m.reason);
  if (!r) return adj;
  const first = r.split(" ")[0]!.toLowerCase();
  if (first.length > 4 && first.endsWith("ing")) return `${adj} from ${r}`;
  if (["the", "a", "an", "my", "our", "her", "his", "their", "that", "this", "how", "what"].includes(first)) return `${adj} about ${r}`;
  return `${adj} (${r})`;
}

export interface WeatherMoodlet { key: string; label: string; reason: string; need: string | null; valence: number; created_at: number; ended_at: number | null }
export interface WeatherData {
  from: number; now: number;
  /** Rung index (0 sad .. 4 happy) now. */
  rungNow: number;
  /** Mood-ladder moves in the window, oldest first. */
  moves: Array<{ at: number; from: number; to: number }>;
  moodlets: WeatherMoodlet[];
}
/** A state has to have lasted this long inside the window to be worth a mention. */
const WEATHER_MIN_LIFE_MS = 2 * HOUR;

/**
 * One or two sentences about the window, built only from the data: where the mood ladder went
 * (the shape of the sentence) and the longest-lived states with their own reasons (the content).
 * Null when there is nothing to say: no ladder move and no state that lasted.
 */
export function weatherText(d: WeatherData): string | null {
  const life = (m: WeatherMoodlet) => Math.min(m.ended_at ?? d.now, d.now) - Math.max(m.created_at, d.from);
  const lasting = d.moodlets.filter((m) => life(m) >= WEATHER_MIN_LIFE_MS).sort((a, b) => life(b) - life(a));
  // Longest-lived first, except that one state with a reason of its own leads: the sentence
  // should carry a real reason when there is one, not only "lonely and bored".
  const pick = (sign: 1 | -1, n: number) => {
    const mine = lasting.filter((m) => Math.sign(m.valence) === sign);
    const reasoned = mine.find((m) => !m.need && cleanReason(m.reason) !== null);
    const seen = new Set<string>(), out: string[] = [];
    for (const m of reasoned ? [reasoned, ...mine] : mine) {
      const p = feelingPhrase(m);
      const k = p.split(" ")[0]!;
      if (seen.has(k)) continue;
      seen.add(k); out.push(p);
      if (out.length >= n) break;
    }
    return out;
  };
  if (!d.moves.length && !lasting.length) return null;
  const start = d.moves.length ? d.moves[0]!.from : d.rungNow;
  const rungs = [start, ...d.moves.map((m) => m.to), d.rungNow];
  const min = Math.min(...rungs), max = Math.max(...rungs);
  const span = Math.round((d.now - d.from) / DAY) <= 1 ? "day" : "few days";
  const good2 = pick(1, 2), bad2 = pick(-1, 2);
  const tail = (xs: string[]) => (xs.length ? `: ${list(xs)}` : "");
  if (d.rungNow <= 1) {
    const open = max >= 3 ? `The last ${span} started well and then dipped` : span === "day" ? "It has been a low day" : "It has been a low few days";
    return `${open}${tail(bad2)}.${good2.length ? ` One bright spot: ${good2[0]}.` : ""}`;
  }
  if (min <= 1) {
    const drop = d.moves.find((m) => m.to <= 1 && m.from > 1);
    const open = drop ? `There was a rough patch on ${weekdayOf(drop.at)}` : `The last ${span} started low`;
    return `${open}${tail(bad2)}. It has lifted since${tail(good2.slice(0, 1))}.`;
  }
  if (max >= 3) {
    const open = d.rungNow >= 3 ? `The last ${span} ${span === "day" ? "has" : "have"} been good` : `The last ${span} ${span === "day" ? "was" : "were"} mostly good`;
    return `${open}${tail(good2)}.${bad2.length ? ` One sore spot: ${bad2[0]}.` : ""}`;
  }
  if (!good2.length && !bad2.length) return null; // the ladder twitched inside Okay and nothing lasted
  const open = `The last ${span} ${span === "day" ? "was" : "were"} even`;
  if (good2.length && bad2.length) return `${open}. A lift: ${good2[0]}. A sore spot: ${bad2[0]}.`;
  return good2.length ? `${open}, with a lift: ${list(good2)}.` : `${open}, with a sore spot: ${list(bad2)}.`;
}

/** Read the window's data for weatherText. */
export function weatherData(db: Database.Database, days: number, now: number): WeatherData {
  const from = now - days * DAY;
  const ri = (l: string | null | undefined) => { const i = (MOOD_RUNGS as readonly string[]).indexOf(String(l ?? "").trim().toLowerCase()); return i < 0 ? 2 : i; };
  const moves = (db.prepare("SELECT reason, at FROM inner_events WHERE kind = 'mood' AND at > ? AND at <= ? ORDER BY at, id").all(from, now) as Array<{ reason: string | null; at: number }>)
    .map((r) => { const [a, b] = (r.reason ?? "").split(" → "); return { at: r.at, from: ri(a), to: ri(b) }; });
  const moodlets = db.prepare("SELECT key, label, reason, need, valence, created_at, ended_at FROM inner_moodlets WHERE created_at <= ? AND (ended_at IS NULL OR ended_at > ?)").all(now, from) as WeatherMoodlet[];
  return { from, now, rungNow: ri(stateCols(db)?.mood_state), moves, moodlets };
}

/** Sleep: write the weather for the last few days. Says nothing (and writes nothing) when there is nothing to say. */
export function composeWeather(db: Database.Database, c: Required<WeatherConfig>, now: number): string | null {
  const text = weatherText(weatherData(db, c.days, now));
  if (!text) return null;
  const last = db.prepare("SELECT id, text FROM inner_weather ORDER BY at DESC, id DESC LIMIT 1").get() as { id: number; text: string } | undefined;
  if (last && last.text === text) db.prepare("UPDATE inner_weather SET to_at = ?, at = ? WHERE id = ?").run(now, now, last.id);
  else db.prepare("INSERT INTO inner_weather (text, from_at, to_at, at) VALUES (?, ?, ?, ?)").run(text, now - c.days * DAY, now, now);
  db.prepare("DELETE FROM inner_weather WHERE id NOT IN (SELECT id FROM inner_weather ORDER BY at DESC, id DESC LIMIT ?)").run(c.keep);
  return text;
}
/** Weather older than this is no longer "lately": the header drops it until the next sleep has something to say. */
const WEATHER_FRESH_MS = 48 * HOUR;
export function recentWeather(db: Database.Database, now: number, limit = 1): Array<{ text: string; at: number }> {
  return db.prepare("SELECT text, at FROM inner_weather WHERE at <= ? ORDER BY at DESC, id DESC LIMIT ?").all(now, limit) as Array<{ text: string; at: number }>;
}

// ═══ 4. relationships as threads: bonds ══════════════════════════════════════

export const BOND_DIRECTIONS = ["warming", "steady", "cooling"] as const;
export type BondDirection = (typeof BOND_DIRECTIONS)[number];
/** A week's exchanges have to add up to this to read as warming: two ordinary good ones, or one that mattered. */
export const BOND_WARM_AT = 0.75;
/** One clearly bad exchange in the week reads as cooling. */
export const BOND_COOL_AT = -0.5;
const BOND_DEFAULT_VALENCE = 0.5;
const MAX_BONDS = 50;
const BOND_EVENTS_KEPT = 30;
/** Relatedness: an explicit good exchange feeds 0.15 × valence, at most this much per bond per day. */
const BOND_FEED_PER_VALENCE = 0.15;
const BOND_FEED_DAILY_CAP = 0.3;
/** Relatedness at sleep: each warming bond adds this, up to the cap. */
const BOND_SLEEP_FEED = 0.05;
const BOND_SLEEP_FEED_CAP = 0.15;

interface BondRow { id: string; who: string; who_key: string; line: string | null; created_at: number; updated_at: number; last_event_at: number | null }
interface BondEventRow { id: number; bond_id: string; what: string; valence: number; source: string; at: number }
export interface BondView {
  id: string; who: string; line: string | null; direction: BondDirection;
  /** Why the direction is what it is, in a few words. */
  because: string;
  /** Sum of valence over the recent window. */
  recentNet: number;
  lastAt: number | null;
  /** The last few exchanges that moved it, newest first. */
  exchanges: Array<{ what: string; valence: number; source: string; at: number }>;
}

const bondKey = (who: string) => who.toLowerCase().replace(/\s+/g, " ").trim();
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The name as a whole word, any case ("Ana" does not match "banana"). */
const nameRe = (who: string) => new RegExp(`(?<![\\p{L}\\p{N}])${escRe(who.trim()).replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}])`, "iu");

/**
 * Direction from the exchanges, and nothing else:
 *   warming  the last `recentDays` add up to +0.75 or more
 *   cooling  they add up to -0.5 or less, or there has been no contact for `coolAfterDays`
 *   steady   otherwise
 */
export function bondDirection(events: Array<{ valence: number; at: number }>, createdAt: number, c: Required<BondsConfig>, now: number): { direction: BondDirection; because: string; recentNet: number } {
  const recent = events.filter((e) => e.at > now - c.recentDays * DAY && e.at <= now);
  const net = recent.reduce((a, e) => a + e.valence, 0);
  const lastAt = events.reduce((a, e) => (e.at <= now ? Math.max(a, e.at) : a), createdAt);
  const n = `${recent.length} exchange${recent.length === 1 ? "" : "s"} in ${c.recentDays}d, net ${net >= 0 ? "+" : "−"}${Math.abs(net).toFixed(1)}`;
  if (net >= BOND_WARM_AT) return { direction: "warming", because: n, recentNet: net };
  if (net <= BOND_COOL_AT) return { direction: "cooling", because: n, recentNet: net };
  if (now - lastAt >= c.coolAfterDays * DAY) return { direction: "cooling", because: `quiet for ${short(now - lastAt)}`, recentNet: net };
  return { direction: "steady", because: recent.length ? n : `nothing new in ${c.recentDays}d`, recentNet: net };
}

function bondView(db: Database.Database, b: BondRow, c: Required<BondsConfig>, now: number): BondView {
  const ev = db.prepare("SELECT * FROM inner_bond_events WHERE bond_id = ? AND at <= ? ORDER BY at DESC, id DESC").all(b.id, now) as BondEventRow[];
  const d = bondDirection(ev, b.created_at, c, now);
  return {
    id: b.id, who: b.who, line: b.line, ...d, lastAt: ev[0]?.at ?? null,
    exchanges: ev.filter((e) => e.valence !== 0).slice(0, 3).map((e) => ({ what: e.what, valence: e.valence, source: e.source, at: e.at })),
  };
}
/** All bonds, most recently fed first. */
export function listBonds(agentId: string, cfg: Partial<BrainConfig>, now = Date.now()): BondView[] {
  const db = ready(agentId, cfg);
  const c = continuityConfig(cfg).bonds;
  if (!db || !c) return [];
  return listBondsDb(db, c, now);
}
function listBondsDb(db: Database.Database, c: Required<BondsConfig>, now: number): BondView[] {
  return (db.prepare("SELECT * FROM inner_bonds ORDER BY COALESCE(last_event_at, created_at) DESC").all() as BondRow[]).map((b) => bondView(db, b, c, now));
}

export interface BondInput {
  /** The person. Matching ignores case. */
  who: string;
  /** What happened between you (one line). Omit to only set the description. */
  what?: string;
  /** How it moved things, -1..1. Default +0.5 (an ordinary good exchange). */
  valence?: number;
  /** The running one-line description of the bond, in the agent's words. */
  line?: string;
}
export interface BondResult { ok: boolean; error?: string; bond?: BondView; created?: boolean; fed?: number }
/**
 * Set a bond's description and / or log an exchange that moved it. The first call for a person
 * creates the bond. A good exchange feeds Relatedness a little; a bad one costs a little.
 */
export function bondUpdate(agentId: string, cfg: Partial<BrainConfig>, input: BondInput, now = Date.now()): BondResult {
  if (!innerLifeEnabled(cfg, agentId)) return { ok: false, error: INNER_OFF };
  const c = continuityConfig(cfg).bonds;
  if (!c) return { ok: false, error: "bonds are off (innerLife.bonds: false)" };
  const who = oneLine(input.who ?? "", 60);
  if (who.length < 2) return { ok: false, error: "who is required (the person's name)" };
  const what = input.what ? oneLine(input.what, 160) : "";
  const line = input.line !== undefined ? oneLine(input.line, 200) : undefined;
  if (!what && line === undefined) return { ok: false, error: "give what (something that happened between you) or line (a one-line description of the bond)" };
  const db = getDb(agentId);
  if (!innerHasTables(db)) return { ok: false, error: "no inner state yet" };
  let created = false, fed = 0, id = "";
  const res = db.transaction((): BondResult | null => {
    innerTickDb(db, cfg, now, agentId);
    let b = db.prepare("SELECT * FROM inner_bonds WHERE who_key = ?").get(bondKey(who)) as BondRow | undefined;
    if (!b) {
      if ((db.prepare("SELECT COUNT(*) AS n FROM inner_bonds").get() as { n: number }).n >= MAX_BONDS) return { ok: false, error: `there are already ${MAX_BONDS} bonds; remove one first` };
      b = { id: randomUUID(), who, who_key: bondKey(who), line: null, created_at: now, updated_at: now, last_event_at: null };
      db.prepare("INSERT INTO inner_bonds (id, who, who_key, line, created_at, updated_at, last_event_at) VALUES (?, ?, ?, NULL, ?, ?, NULL)").run(b.id, b.who, b.who_key, now, now);
      created = true;
    }
    id = b.id;
    if (line !== undefined) db.prepare("UPDATE inner_bonds SET line = ?, updated_at = ? WHERE id = ?").run(line || null, now, b.id);
    if (what) {
      const v = clamp(typeof input.valence === "number" && Number.isFinite(input.valence) ? input.valence : BOND_DEFAULT_VALENCE, -1, 1);
      if (v > 0) {
        const today = (db.prepare("SELECT COALESCE(SUM(valence), 0) AS s FROM inner_bond_events WHERE bond_id = ? AND source = 'agent' AND valence > 0 AND at > ? AND at <= ?").get(b.id, now - DAY, now) as { s: number }).s;
        fed = Math.max(0, Math.min(BOND_FEED_PER_VALENCE * v, BOND_FEED_DAILY_CAP - BOND_FEED_PER_VALENCE * today));
      } else if (v < 0) fed = 0.1 * v;
      addBondEvent(db, b.id, what, v, "agent", now);
      if (fed) adjustNeedDb(db, "relatedness", fed, now);
      logInnerEventDb(db, "bond", `${b.who}: ${what}`, Math.abs(v), null, { who: b.who, valence: v, fed: Math.round(fed * 1000) / 1000 }, now);
    }
    return null;
  })();
  if (res) return res;
  const b = db.prepare("SELECT * FROM inner_bonds WHERE id = ?").get(id) as BondRow;
  return { ok: true, bond: bondView(db, b, c, now), created, fed };
}
function addBondEvent(db: Database.Database, bondId: string, what: string, valence: number, source: string, at: number): void {
  db.prepare("INSERT INTO inner_bond_events (bond_id, what, valence, source, at) VALUES (?, ?, ?, ?, ?)").run(bondId, what, valence, source, at);
  db.prepare("UPDATE inner_bonds SET last_event_at = MAX(COALESCE(last_event_at, 0), ?), updated_at = ? WHERE id = ?").run(at, at, bondId);
  db.prepare("DELETE FROM inner_bond_events WHERE bond_id = ? AND id NOT IN (SELECT id FROM inner_bond_events WHERE bond_id = ? ORDER BY at DESC, id DESC LIMIT ?)").run(bondId, bondId, BOND_EVENTS_KEPT);
}
/** Forget a bond and its exchanges. */
export function bondRemove(agentId: string, cfg: Partial<BrainConfig>, who: string): { ok: boolean; error?: string } {
  if (!innerLifeEnabled(cfg, agentId)) return { ok: false, error: INNER_OFF };
  const db = getDb(agentId);
  const b = db.prepare("SELECT id FROM inner_bonds WHERE who_key = ?").get(bondKey(who ?? "")) as { id: string } | undefined;
  if (!b) return { ok: false, error: `no bond with ${oneLine(who ?? "", 60) || "that name"}` };
  db.transaction(() => { db.prepare("DELETE FROM inner_bond_events WHERE bond_id = ?").run(b.id); db.prepare("DELETE FROM inner_bonds WHERE id = ?").run(b.id); })();
  return { ok: true };
}

/**
 * Sleep, conservative: for a known bond with no explicit exchange since the last sleep,
 *   - a memory written in that time that names the person and carries real emotional weight
 *     (|emotional_weight| >= 0.35) counts as one weak exchange (valence ±0.3);
 *   - otherwise `mentionMin` or more turns naming the person count as contact (valence 0): it
 *     keeps the bond from reading as gone quiet, and never warms it.
 * At most one inferred entry per bond per sleep. Then each warming bond feeds Relatedness a little.
 */
export function bondSleep(db: Database.Database, c: Required<BondsConfig>, from: number, now: number): { inferred: number; fed: number } {
  const bonds = db.prepare("SELECT * FROM inner_bonds").all() as BondRow[];
  let inferred = 0;
  for (const b of bonds) {
    if (db.prepare("SELECT 1 FROM inner_bond_events WHERE bond_id = ? AND at > ? AND at <= ?").get(b.id, from, now)) continue;
    const re = nameRe(b.who), like = `%${b.who.replace(/[%_]/g, "")}%`;
    let mem: { label: string; content: string; w: number } | undefined;
    try {
      mem = (db.prepare(`SELECT label, content, emotional_weight AS w FROM nodes WHERE created_at > ? AND created_at <= ? AND status = 'active' AND ABS(emotional_weight) >= 0.35
                          AND COALESCE(source, '') != 'inner:away' AND (label LIKE ? OR content LIKE ?) ORDER BY ABS(emotional_weight) DESC LIMIT 20`).all(from, now, like, like) as Array<{ label: string; content: string; w: number }>)
        .find((n) => re.test(n.label) || re.test(n.content));
    } catch { /* nodes table shape */ }
    if (mem) { addBondEvent(db, b.id, oneLine(mem.label, 160), mem.w > 0 ? 0.3 : -0.3, "sleep:memory", now); inferred++; continue; }
    let turns = 0;
    try {
      turns = (db.prepare("SELECT content FROM episodes WHERE created_at > ? AND created_at <= ? AND role IN ('user','assistant') AND content LIKE ? LIMIT 200").all(from, now, like) as Array<{ content: string }>).filter((e) => re.test(e.content)).length;
    } catch { /* ok */ }
    if (turns >= c.mentionMin) { addBondEvent(db, b.id, `came up in ${turns} turns`, 0, "sleep:mentions", now); inferred++; }
  }
  const warming = bonds.filter((b) => bondView(db, b, c, now).direction === "warming").length;
  const fed = Math.min(BOND_SLEEP_FEED_CAP, warming * BOND_SLEEP_FEED);
  if (fed) adjustNeedDb(db, "relatedness", fed, now);
  return { inferred, fed };
}

function bondLine(v: BondView, now: number): string | null {
  const last = v.exchanges[0];
  if (!v.line && !last) return null;
  return `[inner] bond · ${v.who} (${v.direction})${v.line ? `: ${oneLine(v.line, 110)}` : ""}${last ? ` · last: ${oneLine(last.what, 70)}, ${short(now - last.at)} ago` : ""}`;
}
/** The bond to show for this turn: a person named in the turn text; the most recently fed when several are. */
function bondForTurn(db: Database.Database, c: Required<BondsConfig>, turnText: string, now: number): string | null {
  if (!turnText.trim()) return null;
  for (const v of listBondsDb(db, c, now)) {
    if (!nameRe(v.who).test(turnText)) continue;
    const line = bondLine(v, now);
    if (line) return line;
  }
  return null;
}

// ═══ wiring: per turn, at sleep, status ══════════════════════════════════════

/**
 * Per turn, after the tick: note the turn time (and any gap), then return the extra header
 * lines, at most `headerExtraLines` (default 2). Every line is conditional.
 *   - one timely line: back-from-away, else a bond named in this turn, else an own want that is
 *     due to come back;
 *   - the recent weather, when there is any.
 * With no weather a second timely line may take its place; with room for only one line the
 * timely one wins. A want reminder only counts as shown when it made the cut, so one that was
 * crowded out is still due on the next turn.
 */
export function continuityTurn(agentId: string, cfg: Partial<BrainConfig>, now = Date.now(), opts: { turnText?: string; topWantId?: string | null } = {}): string[] {
  const db = ready(agentId, cfg);
  if (!db || !stateCols(db)) return [];
  const c = continuityConfig(cfg);
  noticeGap(db, agentId, c.away, now);
  if (c.extraLines <= 0) return [];
  const timely: Array<{ text: string; shown?: () => void }> = [];
  const away = c.away ? awayLine(db, now) : null;
  if (away) timely.push({ text: away });
  const bond = c.bonds && opts.turnText ? bondForTurn(db, c.bonds, opts.turnText, now) : null;
  if (bond) timely.push({ text: bond });
  const due = c.wants ? dueWant(db, c.wants, now, opts.topWantId) : null;
  if (due) timely.push({ text: wantLine(due), shown: due.sticky ? undefined : () => markSurfaced(db, due.id, now) });
  const w = c.weather ? recentWeather(db, now)[0] : undefined;
  const weather = w && now - w.at <= WEATHER_FRESH_MS ? `[inner] lately: ${oneLine(w.text, 260)}` : null;
  const take = timely.slice(0, weather && c.extraLines > 1 ? c.extraLines - 1 : c.extraLines);
  for (const t of take) t.shown?.();
  const lines = take.map((t) => t.text);
  if (weather && lines.length < c.extraLines) lines.push(weather);
  return lines;
}

/** Sleep, after the inner-life sleep step: fold the day's away notes, read bonds, write the weather. */
export function continuitySleep(agentId: string, cfg: Partial<BrainConfig>, now = Date.now()): { folded: number; bondsInferred: number; weather: string | null } | null {
  const db = ready(agentId, cfg);
  if (!db) return null;
  const st = stateCols(db);
  if (!st) return null;
  const c = continuityConfig(cfg);
  const from = Math.max(st.last_sleep_at ?? 0, now - 2 * DAY);
  const folded = c.away ? foldAwayNotes(db, agentId, c.away, now) : 0;
  let bondsInferred = 0, weather: string | null = null;
  db.transaction(() => {
    if (c.bonds) bondsInferred = bondSleep(db, c.bonds, from, now).inferred;
    if (c.weather) weather = composeWeather(db, c.weather, now);
    logInnerEventDb(db, "sleep", null, null, null, undefined, now);
    db.prepare("UPDATE inner_state SET last_sleep_at = ? WHERE id = 'singleton'").run(now);
  })();
  return { folded, bondsInferred, weather };
}

export interface ContinuitySnapshot {
  weather: Array<{ text: string; at: number }>;
  bonds: BondView[];
  /** Own wants with their reminder state, most neglected first. */
  ownWants: Array<{ id: string; what: string; why: string; untouchedMs: number; reminders: number; nextReminderInMs: number | null }>;
  awayNotes: Array<{ text: string; at: number; gapMs: number; source: string }>;
}
/** Read-only view for brain_inner status. */
export function continuitySnapshot(agentId: string, cfg: Partial<BrainConfig>, now = Date.now()): ContinuitySnapshot | null {
  const db = ready(agentId, cfg);
  if (!db) return null;
  const c = continuityConfig(cfg);
  const wants = (db.prepare(`SELECT id, what, why, cost, created_at, touched_at, last_surfaced_at, surface_count FROM inner_wants WHERE status = 'open' AND ${OWN_WANT}`).all() as NagRow[])
    .sort((a, b) => (a.touched_at ?? a.created_at) - (b.touched_at ?? b.created_at))
    .map((r) => ({
      id: r.id, what: r.what, why: r.why, untouchedMs: now - (r.touched_at ?? r.created_at), reminders: r.surface_count,
      nextReminderInMs: c.wants ? Math.max(0, Math.max(r.touched_at ?? r.created_at, r.last_surfaced_at ?? 0) + waitMs(c.wants, r.surface_count) - now) : null,
    }));
  return {
    weather: c.weather ? recentWeather(db, now, c.weather.keep) : [],
    bonds: c.bonds ? listBondsDb(db, c.bonds, now) : [],
    ownWants: wants,
    awayNotes: c.away ? (db.prepare("SELECT text, at, gap_ms AS gapMs, source FROM inner_away_notes WHERE folded_into IS NULL AND at <= ? ORDER BY at DESC LIMIT 5").all(now) as ContinuitySnapshot["awayNotes"]) : [],
  };
}
/** Extra sections for the brain_inner status read-out. Empty when there is nothing to show. */
export function formatContinuityStatus(s: ContinuitySnapshot, now = Date.now()): string[] {
  const out: string[] = [];
  if (s.weather.length) { out.push(`Lately (${s.weather.length}, newest first):`); for (const w of s.weather.slice(0, 5)) out.push(`  ${isoDay(w.at)}: ${w.text}`); }
  if (s.bonds.length) {
    out.push(`Bonds (${s.bonds.length}):`);
    for (const b of s.bonds.slice(0, 12)) {
      out.push(`  ${b.who} · ${b.direction} (${b.because})${b.line ? `: ${b.line}` : ""}`);
      for (const e of b.exchanges) out.push(`      ${e.valence >= 0 ? "+" : "−"}${Math.abs(e.valence).toFixed(1)} ${e.what} (${short(now - e.at)} ago${e.source === "agent" ? "" : `, ${e.source}`})`);
    }
  }
  const waiting = s.ownWants.filter((w) => w.nextReminderInMs !== null);
  if (waiting.length) {
    out.push(`Own wants and when they come back (${waiting.length}):`);
    for (const w of waiting.slice(0, 8)) out.push(`  [${w.id.slice(0, 8)}] ${oneLine(w.what, 80)} · untouched ${short(w.untouchedMs)} · ${w.nextReminderInMs === 0 ? "due now" : `back in ~${short(w.nextReminderInMs!)}`}${w.reminders ? ` (${w.reminders} reminder${w.reminders === 1 ? "" : "s"} so far)` : ""}`);
  }
  if (s.awayNotes.length) { out.push(`Away notes (${s.awayNotes.length}):`); for (const a of s.awayNotes.slice(0, 3)) out.push(`  ${isoDay(a.at)}: ${oneLine(a.text, 200)}`); }
  return out;
}
