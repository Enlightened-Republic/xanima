import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { getDb, closeDb, SCHEMA_VERSION } from "../src/db.js";
import { innerTick, innerSnapshot, innerEvent, innerTurnHeader, addWant, resolveWant, innerSleep } from "../src/inner-life.js";
import {
  continuityConfig, addWants, touchWant, dueWant, innerAway, awayText, durationWords, weatherText, weekdayOf, feelingPhrase, composeWeather,
  bondUpdate, bondRemove, listBonds, bondDirection, continuityTurn, continuitySnapshot, type WeatherData, type WeatherMoodlet,
} from "../src/inner-continuity.js";
import { dispatchContinuityTool } from "../src/continuity-tools.js";
import { resetBrain } from "../src/reset.js";

const H = 3600_000, D = 24 * H, MIN = 60_000;
const T0 = Date.UTC(2026, 10, 2, 12, 0, 0); // a Monday, noon UTC
const ON = { innerLife: { traits: [] as string[] } };
const fresh = () => `cont-${randomUUID().slice(0, 8)}`;
const start = (cfg: object = ON, at = T0) => { const id = fresh(); innerTick(id, cfg as never, at); return id; };
const extras = (id: string, at: number, cfg: object = ON, turnText?: string) => innerTurnHeader(id, cfg as never, at, { turnText }).split("\n").slice(1).filter((l) => !/^\[inner\] top (unmet need|want):/.test(l));
const relatedness = (id: string, at: number, cfg: object = ON) => innerSnapshot(id, cfg as never, at)!.needs.find((n) => n.need === "relatedness")!.level;
const TABLES = ["inner_away_notes", "inner_weather", "inner_bonds", "inner_bond_events"];

describe("inner continuity: schema v31", () => {
  it("adds the tables and columns and bumps the schema version", () => {
    const id = fresh();
    const db = getDb(id);
    expect(SCHEMA_VERSION).toBe(31);
    for (const t of TABLES) expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t)).toBeTruthy();
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols("inner_wants")).toEqual(expect.arrayContaining(["touched_at", "last_surfaced_at", "surface_count"]));
    expect(cols("inner_state")).toEqual(expect.arrayContaining(["last_turn_at", "away_from", "away_seen_at", "last_sleep_at"]));
    closeDb(id);
  });

  it("v30 -> v31 is additive (existing rows untouched) and idempotent", () => {
    const id = start();
    addWant(id, ON, { what: "keep this want", why: "it was here before" }, T0);
    const db = getDb(id);
    db.prepare("INSERT INTO nodes (id, type, label, content, created_at, updated_at, accessed_at) VALUES ('n-keep', 'semantic', 'keep me', 'x', ?, ?, ?)").run(T0, T0, T0);
    for (const t of TABLES) db.exec(`DROP TABLE ${t}`);
    db.exec("DELETE FROM schema_version; INSERT INTO schema_version VALUES (30);");
    closeDb(id);
    const db2 = getDb(id);
    expect((db2.prepare("SELECT version FROM schema_version").get() as { version: number }).version).toBe(31);
    expect((db2.prepare("SELECT COUNT(*) AS n FROM nodes WHERE id = 'n-keep'").get() as { n: number }).n).toBe(1);
    expect(db2.prepare("SELECT what, surface_count FROM inner_wants WHERE what = 'keep this want'").get()).toEqual({ what: "keep this want", surface_count: 0 });
    for (const t of TABLES) expect(db2.prepare("SELECT name FROM sqlite_master WHERE name=?").get(t)).toBeTruthy();
    closeDb(id);
    expect(() => getDb(id)).not.toThrow();
    closeDb(id);
  });

  it("brain_reset clears the new tables", () => {
    const id = start();
    bondUpdate(id, ON, { who: "Ines", what: "traded seedlings" }, T0);
    innerAway(id, ON, { hours: 9, moved: ["the well got fixed"] }, T0);
    resetBrain(id);
    const db = getDb(id);
    for (const t of TABLES) expect((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n).toBe(0);
    closeDb(id);
  });

  it("the switches default on inside an enabled layer and can be turned off one by one", () => {
    const c = continuityConfig({ innerLife: true });
    expect(c.extraLines).toBe(2);
    expect(c.wants).toEqual({ firstHours: 24, factor: 2, maxDays: 30, minGapHours: 6 });
    expect(c.away).toEqual({ minHours: 4, auto: true, importance: 0.25 });
    expect(c.weather).toEqual({ days: 3, keep: 7 });
    expect(c.bonds).toEqual({ recentDays: 7, coolAfterDays: 21, mentionMin: 3 });
    const off = continuityConfig({ innerLife: { wantResurface: false, away: false, weather: false, bonds: false, headerExtraLines: 0 } });
    expect(off).toEqual({ extraLines: 0, wants: null, away: null, weather: null, bonds: null });
    expect(continuityConfig({ innerLife: { away: { minHours: 1 } } }).away!.minHours).toBe(1);
  });
});

describe("inner continuity: wants that persist", () => {
  it("imports a list in one call, skipping what is already open and repeats inside the list", () => {
    const id = start();
    addWant(id, ON, { what: "Learn to bind a chapbook", why: "the winter fair" }, T0);
    const r = addWants(id, ON, [
      "learn to bind a chapbook!",                                       // same as the open one (case / punctuation)
      { what: "Plant the herb box", why: "the sill gets morning sun", cost: "~1h", need: "fun" },
      "Walk the north path",
      "walk the  north path",                                            // repeat inside the list
      "",
      { what: "Bad need", need: "glory" },
    ], T0 + H);
    expect(r.ok).toBe(true);
    expect(r.added.map((a) => a.what)).toEqual(["Plant the herb box", "Walk the north path"]);
    expect(r.skipped.map((s) => s.reason)).toEqual(["already an open want", "already an open want", "empty", expect.stringMatching(/need must be one of/)]);
    const rows = getDb(id).prepare("SELECT what, why, cost, need, source FROM inner_wants WHERE status = 'open' ORDER BY created_at, what").all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(3);
    expect(rows.find((w) => w.what === "Plant the herb box")).toMatchObject({ why: "the sill gets morning sun", cost: "~1h", need: "fun", source: "agent" });
    expect(addWants(id, ON, [], T0).ok).toBe(false);
    closeDb(id);
  });

  it("a want the agent wrote does not lapse at sleep; a want generated from a low need still does", () => {
    const id = start();
    addWant(id, ON, { what: "Paint the gate", why: "it has been bare since spring" }, T0);
    innerTick(id, ON, T0 + 30 * H); // needs fall far enough to generate auto wants
    const db = getDb(id);
    expect((db.prepare("SELECT COUNT(*) AS n FROM inner_wants WHERE status = 'open' AND source LIKE 'need:%'").get() as { n: number }).n).toBeGreaterThan(0);
    innerSleep(id, ON, T0 + 9 * D);
    expect(db.prepare("SELECT status FROM inner_wants WHERE what = 'Paint the gate'").get()).toEqual({ status: "open" });
    expect((db.prepare("SELECT COUNT(*) AS n FROM inner_wants WHERE status = 'lapsed' AND source LIKE 'need:%'").get() as { n: number }).n).toBeGreaterThan(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM inner_wants WHERE status = 'lapsed' AND source NOT LIKE 'need:%'").get() as { n: number }).n).toBe(0);
    closeDb(id);
  });

  it("an untouched own want comes back with its why, then waits twice as long each time", () => {
    const id = start();
    const w = addWant(id, ON, { what: "Paint the gate", why: "it has been bare since spring", cost: "~2h" }, T0).id!;
    const c = continuityConfig(ON).wants!;
    const db = getDb(id);
    expect(dueWant(db, c, T0 + 23 * H)).toBeNull();
    // one day untouched: it is in the header, with the why and the id
    const t1 = T0 + 25 * H;
    const line = extras(id, t1).find((l) => l.startsWith("[inner] still wanting"))!;
    expect(line).toBe(`[inner] still wanting, untouched 25h: Paint the gate (why: it has been bare since spring; cost ~2h) · back in ~2d unless touched · ${w.slice(0, 8)}`);
    expect(db.prepare("SELECT surface_count AS n, last_surfaced_at AS at FROM inner_wants WHERE id = ?").get(w)).toEqual({ n: 1, at: t1 });
    // a second header build in the same turn shows the same line and does not count twice
    expect(extras(id, t1 + 2 * MIN).some((l) => l.startsWith("[inner] still wanting"))).toBe(true);
    expect((db.prepare("SELECT surface_count AS n FROM inner_wants WHERE id = ?").get(w) as { n: number }).n).toBe(1);
    // then it is quiet: not every turn
    expect(extras(id, t1 + H).some((l) => l.startsWith("[inner] still wanting"))).toBe(false);
    expect(dueWant(db, c, t1 + 47 * H)).toBeNull();
    // two days after the first reminder it is back, and the next wait is four days
    const d2 = dueWant(db, c, t1 + 49 * H)!;
    expect(d2).toMatchObject({ id: w, surfaceCount: 1, sticky: false });
    expect(d2.nextInMs).toBe(4 * D);
    closeDb(id);
  });

  it("touch restarts the clock; done ends it; the wait is capped", () => {
    const id = start();
    const w = addWant(id, ON, { what: "Paint the gate", why: "bare since spring" }, T0).id!;
    const c = continuityConfig(ON).wants!;
    const db = getDb(id);
    extras(id, T0 + 25 * H);
    expect(touchWant(id, ON, w.slice(0, 8), { why: "the fair is in three weeks" }, T0 + 30 * H)).toEqual({ ok: true, want: "Paint the gate" });
    expect(db.prepare("SELECT surface_count AS n, why FROM inner_wants WHERE id = ?").get(w)).toEqual({ n: 0, why: "the fair is in three weeks" });
    expect(dueWant(db, c, T0 + 50 * H)).toBeNull();            // 20h after the touch
    expect(dueWant(db, c, T0 + 55 * H)!.why).toBe("the fair is in three weeks"); // 25h after the touch
    expect(touchWant(id, ON, "nope-nope", {}, T0).ok).toBe(false);
    // the wait never grows past maxDays
    db.prepare("UPDATE inner_wants SET surface_count = 12, last_surfaced_at = ? WHERE id = ?").run(T0 + 60 * H, w);
    expect(dueWant(db, c, T0 + 60 * H + 29 * D)).toBeNull();
    expect(dueWant(db, c, T0 + 60 * H + 31 * D)!.id).toBe(w);
    resolveWant(id, ON, w, { status: "done", liking: 0.8 }, T0 + 60 * H + 31 * D);
    expect(dueWant(db, c, T0 + 200 * D)).toBeNull();
    closeDb(id);
  });

  it("one reminder at a time: an imported list is spread out, most neglected first, and the top want is not repeated", () => {
    const id = start();
    const first = addWant(id, ON, { what: "Mend the kite", why: "wind season" }, T0).id!;
    const r = addWants(id, ON, ["Sort the seed tins", "Oil the hinges"], T0 + H);
    const c = continuityConfig(ON).wants!;
    const db = getDb(id);
    const t = T0 + 30 * H;
    expect(dueWant(db, c, t)!.id).toBe(first);                 // oldest untouched first
    expect(dueWant(db, c, t, first)!.id).toBe(r.added[0]!.id); // the top want line already shows `first`
    extras(id, t);
    const shown = (db.prepare("SELECT id FROM inner_wants WHERE surface_count = 1").all() as Array<{ id: string }>).map((x) => x.id);
    expect(shown).toHaveLength(1);
    expect(dueWant(db, c, t + 5 * H)).toBeNull();              // minGapHours: nothing else for six hours
    const next = dueWant(db, c, t + 7 * H)!;
    expect(next.id).not.toBe(shown[0]);
    closeDb(id);
  });

  it("wantResurface: false never reminds", () => {
    const cfg = { innerLife: { traits: [], wantResurface: false } };
    const id = start(cfg);
    addWant(id, cfg as never, { what: "Paint the gate" }, T0);
    expect(extras(id, T0 + 5 * D, cfg).some((l) => l.includes("still wanting"))).toBe(false);
    closeDb(id);
  });
});

describe("inner continuity: a felt gap after time away", () => {
  const notes = (id: string) => getDb(id).prepare("SELECT n.id, n.type, n.label, n.content, n.importance, n.status, n.source, a.source AS by, a.gap_ms, a.folded_into FROM inner_away_notes a JOIN nodes n ON n.id = a.node_id ORDER BY a.at, a.rowid").all() as Array<Record<string, unknown>>;

  it("says a gap the way a person would", () => {
    expect(durationWords(9 * H)).toBe("about 9 hours");
    expect(durationWords(H)).toBe("about 60 minutes");
    expect(durationWords(3 * D)).toBe("about 3 days");
    expect(awayText(9 * H, ["the bakery reopened", "a record was left on the porch"])).toBe("Away about 9 hours. While I was gone: the bakery reopened; a record was left on the porch.");
    expect(awayText(26 * H, [], "The square was quiet.")).toBe("Away about 26 hours. The square was quiet.");
  });

  it("a host note is stored as a low-importance episodic memory, only past the threshold", () => {
    const id = start();
    const under = innerAway(id, ON, { hours: 2, moved: ["nothing much"] }, T0 + H);
    expect(under).toMatchObject({ ok: true, stored: false });
    expect(under.reason).toMatch(/under the 4h threshold/);
    expect(notes(id)).toHaveLength(0);
    const r = innerAway(id, ON, { hours: 9, moved: ["the bakery reopened.", "a record was left on the porch", "it rained all Tuesday"] }, T0 + 2 * H);
    expect(r).toMatchObject({ ok: true, stored: true, text: "Away about 9 hours. While I was gone: the bakery reopened; a record was left on the porch; it rained all Tuesday." });
    const n = notes(id);
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ type: "episodic", label: "Away 9h, back 2026-11-02", content: r.text, importance: 0.25, status: "active", source: "inner:away", by: "host", gap_ms: 9 * H });
    // it rides the header on the turn it lands, and is gone a quarter of an hour later
    expect(extras(id, T0 + 2 * H + MIN)).toContain("[inner] back after ~9h away: the bakery reopened; a record was left on the porch; it rained all Tuesday");
    expect(extras(id, T0 + 2 * H + 15 * MIN).some((l) => l.includes("back after"))).toBe(false);
    // a custom threshold and importance
    const cfg = { innerLife: { traits: [], away: { minHours: 1, importance: 0.1 } } };
    const id2 = start(cfg);
    expect(innerAway(id2, cfg as never, { hours: 2, note: "The square was quiet" }, T0 + H)).toMatchObject({ stored: true, text: "Away about 2 hours. The square was quiet." });
    expect(notes(id2)[0]!.importance).toBe(0.1);
    closeDb(id); closeDb(id2);
  });

  it("with no host, the brain writes its own minimal note from what it knows moved, and nothing when nothing did", () => {
    const id = start();
    innerTurnHeader(id, ON, T0);                              // a turn
    expect(extras(id, T0 + 5 * H).some((l) => l.includes("back after"))).toBe(false); // 5h on a fresh brain: nothing moved
    expect(notes(id)).toHaveLength(0);
    // 20 more hours: needs ran low while away
    const t = T0 + 25 * H;
    const line = extras(id, t).find((l) => l.includes("back after"))!;
    expect(line).toMatch(/^\[inner\] back after ~20h away: (my mood slid from Okay to Low; )?I started feeling (bored|short on anything new)/);
    const n = notes(id);
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ type: "episodic", by: "brain", gap_ms: 20 * H, importance: 0.25 });
    expect(String(n[0]!.content)).toMatch(/^Away about 20 hours\. While I was gone: (my mood slid from Okay to Low; )?I started feeling /);
    // the host's own words, arriving on the same return, replace the brain's guess (same memory, still one note)
    const r = innerAway(id, ON, { moved: ["the bridge lamps were lit"] }, t + MIN);
    expect(r).toMatchObject({ stored: true, gapMs: 20 * H, text: "Away about 20 hours. While I was gone: the bridge lamps were lit." });
    const n2 = notes(id);
    expect(n2).toHaveLength(1);
    expect(n2[0]).toMatchObject({ id: n[0]!.id, by: "host", content: r.text });
    closeDb(id);
  });

  it("the brain's own note names a promise that came due and where the mood went", () => {
    const id = start();
    innerTurnHeader(id, ON, T0);
    const db = getDb(id);
    db.prepare("INSERT INTO nodes (id, type, label, content, created_at, updated_at, accessed_at) VALUES ('c1', 'commitment', 'send the zine draft', 'x', ?, ?, ?)").run(T0, T0, T0);
    const cols = (db.prepare("PRAGMA table_info(commitments)").all() as Array<{ name: string; notnull: number; dflt_value: unknown; pk: number }>);
    const need = cols.filter((c) => c.notnull && c.dflt_value === null && !c.pk).map((c) => c.name);
    const row: Record<string, unknown> = { node_id: "c1", title: "send the zine draft", status: "open", due_at: T0 + 3 * H, created_at: T0, updated_at: T0, to_whom: "user", owner: "self" };
    const use = [...new Set(["node_id", "title", "status", "due_at", ...need])].filter((k) => cols.some((c) => c.name === k));
    db.prepare(`INSERT INTO commitments (${use.join(", ")}) VALUES (${use.map(() => "?").join(", ")})`).run(...use.map((k) => row[k] ?? T0));
    const line = extras(id, T0 + 6 * H).find((l) => l.includes("back after"))!;
    expect(line).toBe("[inner] back after ~6h away: a promise came due (send the zine draft)");
    closeDb(id);
  });

  it("without a measured gap the tool needs hours; away: false refuses", () => {
    const id = start();
    expect(innerAway(id, ON, { moved: ["x"] }, T0 + 9 * H)).toMatchObject({ ok: false, stored: false });
    const cfg = { innerLife: { traits: [], away: false } };
    expect(innerAway(id, cfg as never, { hours: 9, moved: ["x"] }, T0 + 9 * H).error).toMatch(/away notes are off/);
    closeDb(id);
  });

  it("sleep folds a day's away notes into one and keeps the pieces as history", () => {
    const id = start();
    innerAway(id, ON, { hours: 5, moved: ["the bakery reopened"] }, T0 + H);
    innerAway(id, ON, { hours: 4, moved: ["a record was left on the porch"] }, T0 + 3 * H);
    innerAway(id, ON, { hours: 5, moved: ["the bakery reopened", "the well got fixed"] }, T0 + 5 * H);
    innerAway(id, ON, { hours: 8, moved: ["frost on the rail"] }, T0 + D + H); // the next day: stays on its own
    expect(notes(id)).toHaveLength(4);
    innerSleep(id, ON, T0 + D + 2 * H);
    const n = notes(id);
    expect(n.filter((x) => x.status === "superseded" && x.folded_into)).toHaveLength(3);
    const fold = n.find((x) => x.by === "fold")!;
    expect(fold).toMatchObject({ status: "active", type: "episodic", label: "Away notes for 2026-11-02", gap_ms: 14 * H, folded_into: null,
      content: "Away 3 times on 2026-11-02, about 14 hours in all. What moved: the bakery reopened; a record was left on the porch; the well got fixed." });
    expect(n.find((x) => String(x.content).includes("frost on the rail"))).toMatchObject({ status: "active", folded_into: null });
    // a second sleep has nothing left to fold
    innerSleep(id, ON, T0 + D + 3 * H);
    expect(notes(id)).toHaveLength(5);
    closeDb(id);
  });
});

describe("inner continuity: recent mood weather", () => {
  const ml = (o: Partial<WeatherMoodlet> & { key: string; from: number; to?: number | null }): WeatherMoodlet =>
    ({ label: o.key[0]!.toUpperCase() + o.key.slice(1), reason: "", need: null, valence: 1, created_at: o.from, ended_at: o.to ?? null, ...o });
  const NOW = T0 + 3 * D;
  const data = (o: Partial<WeatherData>): WeatherData => ({ from: T0, now: NOW, rungNow: 2, moves: [], moodlets: [], ...o });

  it("says nothing when there is nothing to say", () => {
    expect(weatherText(data({}))).toBeNull();
    // a state that came and went inside an hour is not weather
    expect(weatherText(data({ moodlets: [ml({ key: "glad", from: T0 + H, to: T0 + 2 * H - 1 })] }))).toBeNull();
    // the ladder twitching inside Okay with nothing that lasted
    expect(weatherText(data({ moves: [{ at: T0 + H, from: 2, to: 2 }] }))).toBeNull();
  });

  it("builds the sentence from the real reasons", () => {
    expect(feelingPhrase({ key: "proud", label: "Proud", reason: "better than expected: shipped the walk clip", need: null })).toBe("proud (shipped the walk clip)");
    expect(feelingPhrase({ key: "inspired", label: "Inspired", reason: "talking with a friend", need: null })).toBe("inspired from talking with a friend");
    expect(feelingPhrase({ key: "frustrated", label: "Frustrated", reason: "the bridge build failing.", need: null })).toBe("frustrated about the bridge build failing");
    expect(feelingPhrase({ key: "need:social", label: "Lonely", reason: "Social is low (needs a collab)", need: "social" })).toBe("lonely");
    // a quoted chat snippet or a bare event kind is not a reason someone would say
    expect(feelingPhrase({ key: "proud", label: "Proud", reason: '"...the last thing I shipped here was"', need: null })).toBe("proud");
    expect(feelingPhrase({ key: "connected", label: "Connected", reason: "collab", need: null })).toBe("connected");
  });

  it("a good stretch, a rough patch that lifted, a low stretch, an even one", () => {
    const proud = ml({ key: "proud", reason: "shipped the walk clip", from: T0 + 2 * H });
    const inspired = ml({ key: "inspired", reason: "talking with a friend", from: T0 + D, to: T0 + D + 10 * H });
    const frustrated = ml({ key: "frustrated", reason: "the bridge build failing", valence: -1, from: T0 + D, to: T0 + 2 * D });
    const lonely = ml({ key: "need:social", label: "Lonely", reason: "Social is low (needs a collab)", need: "social", valence: -1, from: T0 + D + 2 * H, to: T0 + 2 * D });
    expect(weatherText(data({ rungNow: 3, moves: [{ at: T0 + 3 * H, from: 2, to: 3 }], moodlets: [proud, inspired] })))
      .toBe("The last few days have been good: proud (shipped the walk clip) and inspired from talking with a friend.");
    const dip = T0 + D + H;
    expect(weatherText(data({ rungNow: 2, moves: [{ at: dip, from: 2, to: 1 }, { at: T0 + 2 * D, from: 1, to: 2 }], moodlets: [frustrated, lonely, proud] })))
      .toBe(`There was a rough patch on ${weekdayOf(dip)}: frustrated about the bridge build failing and lonely. It has lifted since: proud (shipped the walk clip).`);
    expect(weatherText(data({ rungNow: 1, moves: [{ at: dip, from: 2, to: 1 }], moodlets: [frustrated, lonely, inspired] })))
      .toBe("It has been a low few days: frustrated about the bridge build failing and lonely. One bright spot: inspired from talking with a friend.");
    expect(weatherText(data({ rungNow: 2, moodlets: [inspired] }))).toBe("The last few days were even, with a lift: inspired from talking with a friend.");
    expect(weatherText(data({ rungNow: 3, moves: [{ at: T0 + 3 * H, from: 2, to: 3 }], moodlets: [proud, frustrated] })))
      .toBe("The last few days have been good: proud (shipped the walk clip). One sore spot: frustrated about the bridge build failing.");
  });

  it("is written at sleep from the brain's own history and shown as one header line", () => {
    const id = start();
    // nothing has happened: sleep writes no weather and the header has no line
    innerSleep(id, ON, T0 + H);
    const db = getDb(id);
    expect((db.prepare("SELECT COUNT(*) AS n FROM inner_weather").get() as { n: number }).n).toBe(0);
    expect(extras(id, T0 + 2 * H).some((l) => l.startsWith("[inner] lately"))).toBe(false);
    // a good day: a real success with a real reason, and time with a friend
    innerEvent(id, ON, { kind: "success", reason: "shipped the walk clip" }, T0 + 3 * H);
    innerEvent(id, ON, { kind: "collab", reason: "pairing on the sleeve design" }, T0 + 4 * H);
    for (const h of [5, 6, 7]) innerTick(id, ON, T0 + h * H);
    innerSleep(id, ON, T0 + 12 * H);
    const w = db.prepare("SELECT text FROM inner_weather ORDER BY id").all() as Array<{ text: string }>;
    expect(w).toHaveLength(1);
    expect(w[0]!.text).toMatch(/^The last few days (have been|were mostly) good: /);
    expect(w[0]!.text).toContain("proud (shipped the walk clip)");
    expect(w[0]!.text).toContain("connected from pairing on the sleeve design");
    expect(extras(id, T0 + 13 * H)).toContain(`[inner] lately: ${w[0]!.text}`);
    // a second sleep with the same thing to say does not pile up
    innerSleep(id, ON, T0 + 14 * H);
    expect((db.prepare("SELECT COUNT(*) AS n FROM inner_weather").get() as { n: number }).n).toBe(1);
    // stale weather leaves the header
    expect(extras(id, T0 + 14 * H + 49 * H).some((l) => l.startsWith("[inner] lately"))).toBe(false);
    closeDb(id);
  });

  it("keeps the last several and weather: false writes none", () => {
    const id = start();
    const db = getDb(id);
    const c = { days: 3, keep: 3 };
    for (let i = 0; i < 6; i++) {
      db.prepare("DELETE FROM inner_moodlets").run();
      db.prepare("INSERT INTO inner_moodlets (id, key, label, reason, valence, intensity, intensity_at, half_life_h, need, source, created_at, expires_at) VALUES (?, 'glad', 'Glad', ?, 1, 0.5, ?, 6, NULL, 'test', ?, NULL)")
        .run(randomUUID(), `the letter number ${i}`, T0 + i * D, T0 + i * D);
      composeWeather(db, c, T0 + i * D + 5 * H);
    }
    const rows = db.prepare("SELECT text FROM inner_weather ORDER BY at").all() as Array<{ text: string }>;
    expect(rows.map((r) => /number (\d)/.exec(r.text)![1])).toEqual(["3", "4", "5"]);
    const cfg = { innerLife: { traits: [], weather: false } };
    const id2 = start(cfg);
    innerEvent(id2, cfg as never, { kind: "success", reason: "shipped the walk clip" }, T0 + 3 * H);
    innerSleep(id2, cfg as never, T0 + 12 * H);
    expect((getDb(id2).prepare("SELECT COUNT(*) AS n FROM inner_weather").get() as { n: number }).n).toBe(0);
    closeDb(id); closeDb(id2);
  });
});

describe("inner continuity: bonds", () => {
  const c = continuityConfig(ON).bonds!;

  it("direction comes from the exchanges and nothing else", () => {
    const ev = (...xs: Array<[number, number]>) => xs.map(([valence, daysAgo]) => ({ valence, at: T0 - daysAgo * D }));
    expect(bondDirection(ev([0.5, 1]), T0 - 30 * D, c, T0)).toMatchObject({ direction: "steady", because: "1 exchange in 7d, net +0.5" });
    expect(bondDirection(ev([0.5, 1], [0.5, 3]), T0 - 30 * D, c, T0)).toMatchObject({ direction: "warming", because: "2 exchanges in 7d, net +1.0" });
    expect(bondDirection(ev([0.8, 2]), T0 - 30 * D, c, T0).direction).toBe("warming");          // one that mattered
    expect(bondDirection(ev([0.5, 1], [0.5, 9]), T0 - 30 * D, c, T0).direction).toBe("steady");  // last week's does not count
    expect(bondDirection(ev([-0.6, 1]), T0 - 30 * D, c, T0)).toMatchObject({ direction: "cooling", because: "1 exchange in 7d, net −0.6" });
    expect(bondDirection(ev([0.5, 1], [0.5, 2], [-0.8, 3]), T0 - 30 * D, c, T0).direction).toBe("steady"); // good and bad cancel
    expect(bondDirection(ev([0.9, 22]), T0 - 30 * D, c, T0)).toMatchObject({ direction: "cooling", because: "quiet for 22d" });
    expect(bondDirection(ev([0.9, 22], [0, 2]), T0 - 30 * D, c, T0).direction).toBe("steady");   // contact without warmth keeps it from going quiet
    expect(bondDirection([], T0 - 2 * D, c, T0)).toMatchObject({ direction: "steady", because: "nothing new in 7d" });
  });

  it("an explicit exchange creates the bond, keeps the line, and feeds Relatedness a little", () => {
    const id = start();
    const before = relatedness(id, T0);
    const r1 = bondUpdate(id, ON, { who: "Ines", what: "traded records and an honest note about the B side", line: "we keep trading records and honest notes" }, T0);
    expect(r1).toMatchObject({ ok: true, created: true });
    expect(r1.fed).toBeCloseTo(0.075, 5);
    expect(r1.bond).toMatchObject({ who: "Ines", line: "we keep trading records and honest notes", direction: "steady" });
    expect(relatedness(id, T0)).toBeCloseTo(before + 0.075, 5);
    const r2 = bondUpdate(id, ON, { who: "ines", what: "she left a record on the porch", valence: 0.7 }, T0 + D);
    expect(r2).toMatchObject({ ok: true, created: false });
    expect(r2.bond).toMatchObject({ direction: "warming", because: "2 exchanges in 7d, net +1.2", line: "we keep trading records and honest notes" });
    expect(r2.bond!.exchanges.map((e) => e.what)).toEqual(["she left a record on the porch", "traded records and an honest note about the B side"]);
    expect(listBonds(id, ON, T0 + D)).toHaveLength(1);
    // a day of many good exchanges cannot fill the need on its own
    let fed = 0;
    for (let i = 0; i < 6; i++) fed += bondUpdate(id, ON, { who: "Ines", what: `another good hour ${i}`, valence: 1 }, T0 + 3 * D + i * MIN).fed!;
    expect(fed).toBeCloseTo(0.3, 5);
    // a bad exchange costs a little and can cool it
    const id2 = start();
    const r3 = bondUpdate(id2, ON, { who: "Tavi", what: "argued about the fence line", valence: -0.7 }, T0);
    expect(r3.fed).toBeCloseTo(-0.07, 5);
    expect(r3.bond!.direction).toBe("cooling");
    expect(bondUpdate(id2, ON, { who: "Tavi" }, T0).ok).toBe(false);
    expect(bondUpdate(id2, ON, { who: "", what: "x" }, T0).ok).toBe(false);
    expect(bondRemove(id2, ON, "tavi").ok).toBe(true);
    expect(listBonds(id2, ON, T0)).toHaveLength(0);
    closeDb(id); closeDb(id2);
  });

  it("shows one short line when the person is named in the turn, and only then", () => {
    const id = start();
    bondUpdate(id, ON, { who: "Ana", what: "fixed the gate latch together", line: "easy to work beside" }, T0);
    bondUpdate(id, ON, { who: "Ana", what: "she brought soup when the roof leaked", valence: 0.8 }, T0 + D);
    const t = T0 + 3 * D;
    expect(extras(id, t, ON, "has Ana been by the workshop today?")).toContain("[inner] bond · Ana (warming): easy to work beside · last: she brought soup when the roof leaked, 2d ago");
    expect(extras(id, t + MIN, ON, "we are out of bananas").some((l) => l.includes("bond ·"))).toBe(false);
    expect(extras(id, t + 2 * MIN, ON, "what is for lunch?").some((l) => l.includes("bond ·"))).toBe(false);
    expect(extras(id, t + 3 * MIN, ON).some((l) => l.includes("bond ·"))).toBe(false);
    closeDb(id);
  });

  it("sleep reads bonds conservatively: a weighted memory is a weak exchange, mentions are only contact, explicit wins", () => {
    const id = start();
    const db = getDb(id);
    for (const who of ["Ines", "Tavi", "Odile", "Bram"]) bondUpdate(id, ON, { who, line: `${who} and I` }, T0);
    innerSleep(id, ON, T0 + H);
    const t = T0 + 10 * H;
    const node = (label: string, w: number) => db.prepare("INSERT INTO nodes (id, type, label, content, emotional_weight, created_at, updated_at, accessed_at) VALUES (?, 'episodic', ?, 'x', ?, ?, ?, ?)").run(randomUUID(), label, w, t, t, t);
    const say = (content: string, n: number) => { for (let i = 0; i < n; i++) db.prepare("INSERT INTO episodes (id, session_id, role, content, created_at) VALUES (?, 's', 'user', ?, ?)").run(randomUUID(), `${content} (${i})`, t + i * 1000); };
    node("Ines stayed late to help me finish the sleeve", 0.6);   // names her, carries weight
    node("Tavi has a new bicycle", 0.1);                           // names him, no weight: not an exchange
    say("did Tavi come by", 2);                                    // two mentions: under mentionMin
    say("Odile says the kiln is ready", 3);                        // three mentions: contact
    say("Bram and I talked", 5);
    bondUpdate(id, ON, { who: "Bram", what: "walked the north path together" }, T0 + 11 * H); // explicit since the last sleep
    innerSleep(id, ON, T0 + 20 * H);
    const ev = (who: string) => db.prepare("SELECT e.what, e.valence, e.source FROM inner_bond_events e JOIN inner_bonds b ON b.id = e.bond_id WHERE b.who = ? ORDER BY e.id").all(who);
    expect(ev("Ines")).toEqual([{ what: "Ines stayed late to help me finish the sleeve", valence: 0.3, source: "sleep:memory" }]);
    expect(ev("Tavi")).toEqual([]);
    expect(ev("Odile")).toEqual([{ what: "came up in 3 turns", valence: 0, source: "sleep:mentions" }]);
    expect(ev("Bram")).toEqual([{ what: "walked the north path together", valence: 0.5, source: "agent" }]);
    // inference alone does not make a bond warm
    const bonds = listBonds(id, ON, T0 + 20 * H);
    expect(bonds.find((b) => b.who === "Ines")!.direction).toBe("steady");
    expect(bonds.find((b) => b.who === "Odile")).toMatchObject({ direction: "steady", exchanges: [] });
    // the same sleep does not read the same window twice
    innerSleep(id, ON, T0 + 21 * H);
    expect(ev("Ines")).toHaveLength(1);
    closeDb(id);
  });

  it("a warming bond feeds Relatedness at sleep; bonds: false is off", () => {
    const id = start(), id2 = start();
    for (const x of [id, id2]) innerTick(x, ON, T0 + 40 * H);
    bondUpdate(id, ON, { who: "Ines", what: "a long good talk", valence: 0.9 }, T0 + 40 * H);
    bondUpdate(id2, ON, { who: "Ines", what: "a short hello", valence: 0.2 }, T0 + 40 * H);
    const a = relatedness(id, T0 + 40 * H), b = relatedness(id2, T0 + 40 * H);
    innerSleep(id, ON, T0 + 40 * H + MIN); innerSleep(id2, ON, T0 + 40 * H + MIN);
    const drain = MIN / H / 72;
    expect(relatedness(id, T0 + 40 * H + MIN)).toBeCloseTo(a - drain + 0.05, 4);  // warming: fed
    expect(relatedness(id2, T0 + 40 * H + MIN)).toBeCloseTo(b - drain, 4);        // steady: not fed
    const cfg = { innerLife: { traits: [], bonds: false } };
    expect(bondUpdate(id, cfg as never, { who: "Ines", what: "x" }, T0).error).toMatch(/bonds are off/);
    expect(listBonds(id, cfg as never, T0 + 41 * H)).toEqual([]);
    expect(extras(id, T0 + 41 * H, cfg, "Ines?").some((l) => l.includes("bond ·"))).toBe(false);
    closeDb(id); closeDb(id2);
  });
});

describe("inner continuity: header budget, off switches, tool", () => {
  /** A brain where all four lines have something to say at `t`. */
  function busy(cfg: object) {
    const id = start(cfg);
    addWant(id, cfg as never, { what: "Paint the gate", why: "bare since spring" }, T0);
    bondUpdate(id, cfg as never, { who: "Ines", what: "traded records", line: "records and honest notes" }, T0);
    innerEvent(id, cfg as never, { kind: "success", reason: "shipped the walk clip" }, T0 + H);
    innerTurnHeader(id, cfg as never, T0 + 2 * H);
    innerSleep(id, cfg as never, T0 + 20 * H);
    const t = T0 + 30 * H;
    innerAway(id, cfg as never, { hours: 28, moved: ["the bakery reopened"] }, t);
    return { id, t };
  }

  it("adds at most two lines: one timely line (away, else a named bond, else a due want) and the weather; a reminder that was cut is not counted", () => {
    const { id, t } = busy(ON);
    const pickExtras = (at: number, turnText?: string) => innerTurnHeader(id, ON, at, { turnText }).split("\n").filter((l) => /^\[inner\] (back after|bond ·|still wanting|lately:)/.test(l));
    const kinds = (ls: string[]) => ls.map((l) => /^\[inner\] (\S+)/.exec(l)![1]);
    const db = getDb(id);
    const reminders = () => (db.prepare("SELECT surface_count AS n FROM inner_wants WHERE what = 'Paint the gate'").get() as { n: number }).n;
    // the return turn: the away line and the weather; the bond and the want wait
    const all = innerTurnHeader(id, ON, t + MIN, { turnText: "is Ines around?" }).split("\n");
    expect(all.length).toBeLessThanOrEqual(5);
    expect(all[0]).toMatch(/^\[inner · functional states\] mood /);
    const first = pickExtras(t + MIN, "is Ines around?");
    expect(first).toHaveLength(2);
    expect(first[0]).toBe("[inner] back after ~28h away: the bakery reopened");
    expect(first[1]).toMatch(/^\[inner\] lately: /);
    expect(reminders()).toBe(0);
    // a little later the person named this turn gets the timely line
    const second = pickExtras(t + 15 * MIN, "is Ines around?");
    expect(kinds(second)).toEqual(["bond", "lately:"]);
    expect(second[0]).toBe("[inner] bond · Ines (steady): records and honest notes · last: traded records, 30h ago");
    expect(reminders()).toBe(0);
    // nobody named: the want that has been waiting comes back, and now it counts
    expect(kinds(pickExtras(t + H))).toEqual(["still", "lately:"]);
    expect(reminders()).toBe(1);
    // with no weather to show, two timely lines fit
    db.prepare("DELETE FROM inner_weather").run();
    db.prepare("UPDATE inner_wants SET surface_count = 0, last_surfaced_at = NULL").run();
    expect(kinds(pickExtras(t + 2 * H, "is Ines around?"))).toEqual(["bond", "still"]);
    closeDb(id);
  });

  it("headerExtraLines: 0 hides all of them and still keeps time; 1 keeps only the first", () => {
    const zero = { innerLife: { traits: [], headerExtraLines: 0 } };
    const a = busy(zero);
    expect(innerTurnHeader(a.id, zero as never, a.t + MIN, { turnText: "is Ines around?" }).split("\n").length).toBeLessThanOrEqual(3);
    expect((getDb(a.id).prepare("SELECT last_turn_at AS t FROM inner_state").get() as { t: number }).t).toBe(a.t + MIN);
    const one = { innerLife: { traits: [], headerExtraLines: 1 } };
    const b = busy(one);
    const ex = innerTurnHeader(b.id, one as never, b.t + MIN, { turnText: "is Ines around?" }).split("\n").filter((l) => /^\[inner\] (back after|bond ·|still wanting|lately:)/.test(l));
    expect(ex).toHaveLength(1);
    expect(ex[0]).toMatch(/back after/);
    closeDb(a.id); closeDb(b.id);
  });

  it("everything is a no-op when the layer is off or the agent is excluded", () => {
    for (const [cfg, id] of [[{}, fresh()], [{ innerLife: false }, fresh()], [{ innerLife: { excludeAgents: ["guest"] } }, "guest"]] as Array<[object, string]>) {
      const c = cfg as never;
      expect(addWants(id, c, ["x"], T0)).toMatchObject({ ok: false, added: [] });
      expect(touchWant(id, c, "abcdef12", {}, T0).ok).toBe(false);
      expect(innerAway(id, c, { hours: 9, moved: ["x"] }, T0)).toMatchObject({ ok: false, stored: false });
      expect(bondUpdate(id, c, { who: "Ines", what: "x" }, T0).ok).toBe(false);
      expect(bondRemove(id, c, "Ines").ok).toBe(false);
      expect(listBonds(id, c, T0)).toEqual([]);
      expect(continuityTurn(id, c, T0, { turnText: "Ines" })).toEqual([]);
      expect(continuitySnapshot(id, c, T0)).toBeNull();
      expect(innerSleep(id, c, T0)).toBe(false);
      expect(innerTurnHeader(id, c, T0, { turnText: "Ines" })).toBe("");
      const db = getDb(id);
      for (const t of [...TABLES, "inner_state", "inner_wants"]) expect((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n).toBe(0);
      expect((db.prepare("SELECT COUNT(*) AS n FROM nodes").get() as { n: number }).n).toBe(0);
      closeDb(id);
    }
  });

  it("brain_inner: wants, touch, away, bond and the status read-out", () => {
    const id = start();
    const call = (args: Record<string, unknown>, at = T0) => dispatchContinuityTool("brain_inner", id, args, ON as never, { now: at })!;
    const w = call({ action: "wants", items: ["Paint the gate", { what: "Plant the herb box", why: "morning sun on the sill", cost_hours: 1 }, "paint the gate"] });
    expect(w.isError).toBeFalsy();
    expect(w.text).toMatch(/^Added 2 wants, skipped 1\./);
    expect(w.text).toContain("- paint the gate: already an open want");
    const wid = /\[([0-9a-f]{8})\] Paint the gate/.exec(w.text)![1]!;
    expect(call({ action: "touch", want_id: wid, why: "the fair is coming" }, T0 + H).text).toBe("Still on it: Paint the gate. Its reminder clock starts over.");
    expect(call({ action: "touch", want_id: "zzzzzzzz" }).isError).toBe(true);
    expect(call({ action: "away", hours: 1, moved: ["x"] }).text).toMatch(/^No away note: away 1h, under the 4h threshold/);
    expect(call({ action: "away", hours: 9, moved: ["the bakery reopened"] }, T0 + 2 * H).text).toBe("Away note kept: Away about 9 hours. While I was gone: the bakery reopened.");
    const b = call({ action: "bond", who: "Ines", what: "traded records", valence: 0.8, line: "records and honest notes" }, T0 + 2 * H);
    expect(b.text).toBe("New bond · Ines: warming (1 exchange in 7d, net +0.8). records and honest notes Relatedness +0.12.");
    expect(call({ action: "bond", who: "Ines" }).isError).toBe(true);
    const st = call({ action: "status" }, T0 + 3 * H).text;
    expect(st).toContain("Bonds (1):");
    expect(st).toContain("Ines · warming (1 exchange in 7d, net +0.8): records and honest notes");
    expect(st).toContain("+0.8 traded records (1h ago)");
    expect(st).toMatch(/Own wants and when they come back \(2\):/);
    expect(st).toMatch(/\] Paint the gate · untouched 2h · back in ~22h/);
    expect(st).toContain("Away notes (1):");
    expect(st.trim().endsWith("not a claim of human-identical feeling.")).toBe(true);
    const j = JSON.parse(call({ action: "status", format: "json" }, T0 + 3 * H).text) as { continuity: { bonds: Array<{ who: string; direction: string }>; ownWants: unknown[]; awayNotes: unknown[]; weather: unknown[] } };
    expect(j.continuity.bonds).toMatchObject([{ who: "Ines", direction: "warming" }]);
    expect(j.continuity.ownWants).toHaveLength(2);
    expect(j.continuity.awayNotes).toHaveLength(1);
    expect(call({ action: "bond", who: "Ines", remove: true }).text).toBe("Bond with Ines forgotten.");
    expect(call({ action: "nonsense" }).text).toMatch(/action must be status, event, want, wants, done, drop, touch, away or bond/);
    closeDb(id);
  });
});
