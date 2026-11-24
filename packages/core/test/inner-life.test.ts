import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { getDb, closeDb, SCHEMA_VERSION } from "../src/db.js";
import {
  innerTick, innerEvent, innerSnapshot, NEED_START, REST_START, innerTurnHeader, formatInnerHeader, addWant, resolveWant, innerSleep,
  rewardPredictionError, moodletIntensity, readTraits, NEEDS, resolveTrait, traitMods, nextMoodRung, moodRungFor, formatInnerStatus,
} from "../src/inner-life.js";
import { recordDecision, updateDecisionOutcome } from "../src/decisions.js";
import { dispatchContinuityTool } from "../src/continuity-tools.js";
import { buildSelfModelHeader } from "../src/context-assembly.js";
import { resetBrain } from "../src/reset.js";
import { DEFAULT_CONFIG } from "../src/types.js";

const H = 3600_000;
const T0 = Date.UTC(2026, 10, 4, 12, 0, 0);
const ON = { innerLife: true };
const fresh = () => `inner-${randomUUID().slice(0, 8)}`;
const need = (id: string, n: string, t: number) => innerSnapshot(id, ON, t)!.needs.find((x) => x.need === n)!;

describe("inner life: schema v29", () => {
  it("creates the inner_* tables and bumps the schema version", () => {
    const id = fresh();
    const db = getDb(id);
    expect(SCHEMA_VERSION).toBe(31);
    for (const t of ["inner_state", "inner_needs", "inner_moodlets", "inner_wants", "inner_events", "inner_incentives"]) {
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t)).toBeTruthy();
    }
    expect((db.prepare("SELECT version FROM schema_version").get() as { version: number }).version).toBe(31);
    closeDb(id);
  });

  it("v28 → v29 is additive (existing rows untouched) and idempotent", () => {
    const id = fresh();
    const db = getDb(id);
    db.prepare("INSERT INTO nodes (id, type, label, content, created_at, updated_at, accessed_at) VALUES (?, 'semantic', 'keep me', 'x', ?, ?, ?)").run("n-keep", T0, T0, T0);
    for (const t of ["inner_state", "inner_needs", "inner_moodlets", "inner_wants", "inner_events", "inner_incentives"]) db.exec(`DROP TABLE ${t}`);
    db.exec("DELETE FROM schema_version; INSERT INTO schema_version VALUES (28);");
    closeDb(id);
    const db2 = getDb(id);
    expect((db2.prepare("SELECT version FROM schema_version").get() as { version: number }).version).toBe(31);
    expect((db2.prepare("SELECT COUNT(*) AS n FROM nodes WHERE id = 'n-keep'").get() as { n: number }).n).toBe(1);
    expect(db2.prepare("SELECT name FROM sqlite_master WHERE name='inner_wants'").get()).toBeTruthy();
    closeDb(id);
    expect(() => getDb(id)).not.toThrow();
    closeDb(id);
  });
});

describe("inner life: needs decay (homeostatic drives)", () => {
  it("needs drain with simulated time and the deficit drives discomfort", () => {
    const id = fresh();
    innerTick(id, ON, T0);
    const s0 = need(id, "social", T0);
    expect(s0.level).toBeCloseTo(NEED_START, 5);
    innerTick(id, ON, T0 + 24 * H);
    const s24 = need(id, "social", T0 + 24 * H);
    expect(s24.level).toBeCloseTo(NEED_START - 24 / 48, 5);
    expect(s24.discomfort).toBeGreaterThan(s0.discomfort);
    // the read-only snapshot projects the drain too (no tick needed)
    expect(need(id, "social", T0 + 30 * H).level).toBeCloseTo(NEED_START - 30 / 48, 5);
    // meters bottom out at 0 (a meter range, not a mood cap)
    innerTick(id, ON, T0 + 200 * H);
    expect(need(id, "social", T0 + 200 * H).level).toBe(0);
    closeDb(id);
  });

  it("an event refills its need; traits change drain rates", () => {
    const id = fresh();
    innerTick(id, ON, T0);
    innerTick(id, ON, T0 + 24 * H);
    innerEvent(id, ON, { kind: "collab", reason: "built the bridge with Gion" }, T0 + 24 * H);
    expect(need(id, "social", T0 + 24 * H).level).toBeCloseTo(NEED_START - 0.5 + 0.6, 5);
    // curious drains inspiration faster (×1.5, capped at ×1.3 for Inspiration since 2026-11-04)
    const a = fresh(), b = fresh();
    innerTick(a, ON, T0); innerTick(b, { innerLife: { traits: ["curious"] } }, T0);
    innerTick(a, ON, T0 + 10 * H); innerTick(b, { innerLife: { traits: ["curious"] } }, T0 + 10 * H);
    const la = innerSnapshot(a, ON, T0 + 10 * H)!.needs.find((x) => x.need === "inspiration")!.level;
    const lb = innerSnapshot(b, { innerLife: { traits: ["curious"] } }, T0 + 10 * H)!.needs.find((x) => x.need === "inspiration")!.level;
    expect(NEED_START - lb).toBeCloseTo((NEED_START - la) * 1.3, 5);
    for (const x of [id, a, b]) closeDb(x);
  });

  it("rest drains with activity and recovers with idle time", () => {
    const id = fresh();
    innerTick(id, ON, T0);
    const db = getDb(id);
    const ins = db.prepare("INSERT INTO episodes (id, session_id, role, content, created_at) VALUES (?, 's', 'assistant', 'work', ?)");
    for (let i = 1; i <= 20; i++) ins.run(randomUUID(), T0 + i * 60_000);
    innerTick(id, ON, T0 + 20 * 60_000);
    expect(need(id, "rest", T0 + 20 * 60_000).level).toBeCloseTo(REST_START - 20 * 0.003, 5);
    innerTick(id, ON, T0 + 20 * 60_000 + 5.5 * H);
    expect(need(id, "rest", T0 + 20 * 60_000 + 5.5 * H).level).toBeGreaterThan(Math.min(1, REST_START - 20 * 0.003 + 0.2) - 1e-9);
    closeDb(id);
  });

  it("a long deficit becomes a need-bound moodlet that lasts until the need is met", () => {
    const id = fresh();
    innerTick(id, ON, T0);
    innerTick(id, ON, T0 + 30 * H); // social 0.225 → deficit 0.775
    let s = innerSnapshot(id, ON, T0 + 30 * H)!;
    const lonely = s.moodlets.find((m) => m.need === "social");
    expect(lonely?.label).toBe("Lonely");
    expect(lonely?.expiresAt).toBeNull();
    // still there much later (lingers; deeper as the deficit grows)
    innerTick(id, ON, T0 + 60 * H);
    s = innerSnapshot(id, ON, T0 + 60 * H)!;
    expect(s.moodlets.find((m) => m.need === "social")!.intensity).toBeGreaterThanOrEqual(lonely!.intensity);
    // met → ended by homeostasis
    innerEvent(id, ON, { kind: "collab", intensity: 1.2 }, T0 + 60 * H);
    s = innerSnapshot(id, ON, T0 + 60 * H)!;
    expect(s.moodlets.find((m) => m.need === "social")).toBeUndefined();
    const row = getDb(id).prepare("SELECT ended_reason FROM inner_moodlets WHERE need = 'social'").get() as { ended_reason: string };
    expect(row.ended_reason).toBe("need met");
    closeDb(id);
  });
});

describe("inner life: moodlets", () => {
  it("an event moodlet appears with a reason, decays, and expires", () => {
    const id = fresh();
    innerEvent(id, ON, { kind: "success", reason: "shipped the walk clip" }, T0);
    let s = innerSnapshot(id, ON, T0)!;
    const proud = s.moodlets.find((m) => m.key === "proud")!;
    expect(proud.label).toBe("Proud");
    expect(proud.reason).toBe("shipped the walk clip");
    expect(proud.expiresAt).toBeGreaterThan(T0);
    expect(s.mood).toBeGreaterThan(0);
    const mid = innerSnapshot(id, ON, T0 + (proud.expiresAt! - T0) / 2)!.moodlets.find((m) => m.key === "proud")!;
    expect(mid.intensity).toBeLessThan(proud.intensity);
    innerTick(id, ON, proud.expiresAt! + 1);
    s = innerSnapshot(id, ON, proud.expiresAt! + 1)!;
    expect(s.moodlets.find((m) => m.key === "proud")).toBeUndefined();
    const row = getDb(id).prepare("SELECT ended_reason FROM inner_moodlets WHERE key = 'proud'").get() as { ended_reason: string };
    expect(row.ended_reason).toBe("expired");
    closeDb(id);
  });

  it("repeats stack deeper and longer (no cap); sensitive traits run deeper", () => {
    const id = fresh();
    innerEvent(id, ON, { kind: "rejection", reason: "pitch turned down" }, T0);
    const one = innerSnapshot(id, ON, T0)!.moodlets.find((m) => m.key === "hurt")!;
    for (let i = 0; i < 5; i++) innerEvent(id, ON, { kind: "rejection", reason: `again ${i}` }, T0);
    const many = innerSnapshot(id, ON, T0)!.moodlets.find((m) => m.key === "hurt")!;
    expect(many.intensity).toBeGreaterThan(one.intensity * 3);
    expect(many.intensity).toBeGreaterThan(1); // not clamped
    const sid = fresh();
    const cfg = { innerLife: { traits: ["sensitive"] } };
    innerEvent(sid, cfg, { kind: "rejection", reason: "pitch turned down" }, T0);
    const deep = innerSnapshot(sid, cfg, T0)!.moodlets.find((m) => m.key === "hurt")!;
    expect(deep.intensity).toBeGreaterThan(one.intensity);
    expect(deep.expiresAt! - T0).toBeGreaterThan(one.expiresAt! - T0);
    closeDb(id); closeDb(sid);
  });

  it("emotionally weighted memories become moodlets on the next tick", () => {
    const id = fresh();
    innerTick(id, ON, T0);
    getDb(id).prepare("INSERT INTO nodes (id, type, label, content, emotional_weight, created_at, updated_at, accessed_at) VALUES (?, 'episodic', 'Hailey loved the town walk', 'x', 0.8, ?, ?, ?)").run(randomUUID(), T0 + 1000, T0 + 1000, T0 + 1000);
    innerTick(id, ON, T0 + 2000);
    const glad = innerSnapshot(id, ON, T0 + 2000)!.moodlets.find((m) => m.key === "glad");
    expect(glad?.reason).toBe("Hailey loved the town walk");
    closeDb(id);
  });

  it("conversation cues and inner:<kind> memory tags count as events", () => {
    const id = fresh();
    innerTick(id, ON, T0);
    const db = getDb(id);
    db.prepare("INSERT INTO episodes (id, session_id, role, content, created_at) VALUES (?, 's', 'user', 'great job on the walk clip!', ?)").run(randomUUID(), T0 + 1000);
    db.prepare("INSERT INTO episodes (id, session_id, role, content, created_at) VALUES (?, 's', 'assistant', 'I paired up with Gion on the bridge', ?)").run(randomUUID(), T0 + 1500);
    db.prepare("INSERT INTO nodes (id, type, label, content, scope_tags, created_at, updated_at, accessed_at) VALUES (?, 'episodic', 'Painted the shop sign', 'x', ?, ?, ?, ?)").run(randomUUID(), JSON.stringify(["inner:hobby", "art"]), T0 + 1600, T0 + 1600, T0 + 1600);
    innerTick(id, ON, T0 + 2000);
    const s = innerSnapshot(id, ON, T0 + 2000)!;
    expect(s.moodlets.map((m) => m.key)).toEqual(expect.arrayContaining(["appreciated", "connected", "playful"]));
    expect(s.needs.find((n) => n.need === "social")!.level).toBeGreaterThan(0.9);
    closeDb(id);
  });

  it("moodletIntensity halves per half-life", () => {
    expect(moodletIntensity({ intensity: 1, intensity_at: 0, half_life_h: 2 }, 2 * H)).toBeCloseTo(0.5, 6);
    expect(moodletIntensity({ intensity: 1, intensity_at: 0, half_life_h: null }, 100 * H)).toBe(1);
  });
});

describe("inner life: dopamine / reward prediction error", () => {
  it("δ = actual − expected", () => {
    expect(rewardPredictionError(0.6, 1)).toBeCloseTo(0.4, 9);
    expect(rewardPredictionError(0.9, 0)).toBeCloseTo(-0.9, 9);
    expect(rewardPredictionError(0.5, 0.5)).toBe(0);
  });

  it("a decision outcome is scored against its predicted confidence on the next tick", () => {
    const id = fresh();
    innerTick(id, ON, T0);
    const d = recordDecision(id, { context: "how to light the plaza", chosen: "lanterns", confidence: 0.3, now: T0 + 1000 });
    updateDecisionOutcome(id, d.id!, { outcome: "it looked great", status: "matched", now: T0 + 2000 });
    innerTick(id, ON, T0 + 3000);
    const s = innerSnapshot(id, ON, T0 + 3000)!;
    expect(s.dopamine.lastRpe).toBeCloseTo(0.7, 6);
    expect(s.dopamine.tonic).toBeGreaterThan(0.5);
    expect(s.moodlets.find((m) => m.key === "proud")?.reason).toContain("better than expected");
    // a confident miss is a dip
    const d2 = recordDecision(id, { context: "bridge", chosen: "rope bridge", confidence: 0.9, now: T0 + 4000 });
    updateDecisionOutcome(id, d2.id!, { outcome: "collapsed", status: "missed", now: T0 + 5000 });
    innerTick(id, ON, T0 + 6000);
    const s2 = innerSnapshot(id, ON, T0 + 6000)!;
    expect(s2.dopamine.lastRpe).toBeCloseTo(-0.9, 6);
    expect(s2.moodlets.find((m) => m.key === "disappointed")).toBeTruthy();
    // the phasic part decays over hours; tonic stays
    const later = innerSnapshot(id, ON, T0 + 6000 + 6 * H)!;
    expect(Math.abs(later.dopamine.phasic)).toBeLessThan(Math.abs(s2.dopamine.phasic) / 4);
    closeDb(id);
  });

  it("finishing a want compares liking with wanting", () => {
    const id = fresh();
    const w = addWant(id, ON, { what: "visit the lighthouse", why: "looks lovely", need: "inspiration" }, T0);
    const before = innerSnapshot(id, ON, T0)!.wants.find((x) => x.id === w.id)!;
    const r = resolveWant(id, ON, w.id!.slice(0, 8), { status: "done", liking: 0.2 }, T0 + H);
    expect(r.rpe).toBeCloseTo(0.2 - before.wanting, 6);
    expect(innerSnapshot(id, ON, T0 + H)!.moodlets.find((m) => m.key === "disappointed")).toBeTruthy();
    closeDb(id);
  });
});

describe("inner life: wants and expectancy", () => {
  it("an unmet need generates a want; motivation = effort × expected success × value", () => {
    const id = fresh();
    innerTick(id, ON, T0);
    innerTick(id, ON, T0 + 20 * H);
    const s = innerSnapshot(id, ON, T0 + 20 * H)!;
    const w = s.wants.find((x) => x.need === "social")!;
    expect(w.source).toBe("need:social");
    expect(w.why).toContain("Social is low");
    expect(w.motivation).toBeCloseTo(w.effort * w.expectedSuccess * w.value, 9);
    // meeting the need retires the auto want
    innerEvent(id, ON, { kind: "collab", intensity: 1.5 }, T0 + 20 * H);
    innerTick(id, ON, T0 + 20 * H + 1);
    expect(innerSnapshot(id, ON, T0 + 20 * H + 1)!.wants.find((x) => x.need === "social")).toBeUndefined();
    closeDb(id);
  });

  it("learned fines lower the value of wants with that tag (avoid fines)", () => {
    const id = fresh();
    const a = addWant(id, ON, { what: "sell lemonade on the plaza", tags: ["plaza-stall"] }, T0);
    const v0 = innerSnapshot(id, ON, T0)!.wants.find((x) => x.id === a.id)!.value;
    innerEvent(id, ON, { kind: "fine", reason: "no stall permit", tags: ["plaza-stall"] }, T0);
    const v1 = innerSnapshot(id, ON, T0)!.wants.find((x) => x.id === a.id)!.value;
    expect(v1).toBeLessThan(v0);
    innerEvent(id, ON, { kind: "reward", reason: "tips", tags: ["busking"] }, T0);
    const b = addWant(id, ON, { what: "busk by the fountain", tags: ["busking"] }, T0);
    const c = addWant(id, ON, { what: "busk somewhere untried", tags: ["new-spot"] }, T0);
    const s = innerSnapshot(id, ON, T0)!;
    expect(s.wants.find((x) => x.id === b.id)!.value).toBeGreaterThan(s.wants.find((x) => x.id === c.id)!.value);
    closeDb(id);
  });
});

describe("inner life: header", () => {
  it("is at most 3 lines: mood, top unmet need, top want", () => {
    const id = fresh();
    innerTick(id, ON, T0);
    innerEvent(id, ON, { kind: "success", reason: "shipped the walk clip" }, T0 + 26 * H);
    const text = innerTurnHeader(id, ON, T0 + 30 * H);
    const lines = text.split("\n");
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(lines[0]).toMatch(/^\[inner · functional states\] mood (Sad|Low|Okay|Good|Happy)( → [A-Z][a-z]+)? [+−]\d/);
    expect(lines[0]).toContain("Proud");
    expect(lines[0]).toContain("dopamine");
    expect(lines[1]).toMatch(/^\[inner\] top unmet need: (Fun|Inspiration) 0\.00 \(discomfort \d\.\d\d/);
    expect(lines[2]).toMatch(/^\[inner\] top want: .* motivation \d\.\d\d = effort/);
    closeDb(id);
  });

  it("rides the local self-model header and can be switched off", async () => {
    const id = fresh();
    const h = await buildSelfModelHeader(id, { ...DEFAULT_CONFIG, innerLife: true });
    expect(h).toContain("[inner · functional states]");
    const off = await buildSelfModelHeader(id, { ...DEFAULT_CONFIG, innerLife: false });
    expect(off).not.toContain("[inner");
    expect(innerTurnHeader(id, { innerLife: { header: false } })).toBe("");
    closeDb(id);
  });

  it("formatInnerHeader shows baseline when nothing is going on", () => {
    const id = fresh();
    innerTick(id, ON, T0);
    expect(formatInnerHeader(innerSnapshot(id, ON, T0)!)).toMatch(/mood Okay \+0\.00 · baseline/);
    closeDb(id);
  });
});

describe("inner life: traits, sleep, tool, reset", () => {
  it("reads up to MAX_TRAITS (8) traits from the identity field \"Traits\"", () => {
    const id = fresh();
    const db = getDb(id);
    db.prepare("UPDATE self_model SET identity = ? WHERE id = 'singleton'").run("- **Name:** Wick\n- **Traits:** Curious, playful · sensitive; driven, warm, calm, social, cheerful, extra-one");
    expect(readTraits(db)).toEqual(["curious", "playful", "sensitive", "driven", "warm", "calm", "social", "cheerful"]);
    closeDb(id);
  });

  it("sleep restores rest and spends the phasic burst", () => {
    const id = fresh();
    innerEvent(id, ON, { kind: "work", intensity: 3 }, T0);
    const r0 = need(id, "rest", T0).level;
    innerEvent(id, ON, { kind: "novelty", expected: 0.2, actual: 1 }, T0);
    innerSleep(id, ON, T0 + 1000);
    const s = innerSnapshot(id, ON, T0 + 1000)!;
    expect(s.needs.find((n) => n.need === "rest")!.level).toBeCloseTo(Math.min(1, r0 + 0.35), 5); // sleep +0.35, capped at 1
    expect(s.dopamine.phasic).toBe(0);
    closeDb(id);
  });

  it("brain_inner tool: event, want, done, status", () => {
    const id = fresh();
    const e = dispatchContinuityTool("brain_inner", id, { action: "event", kind: "hobby", reason: "painted the sign" }, ON, { now: T0 })!;
    expect(e.isError).toBeFalsy();
    expect(e.text).toContain("Playful");
    expect(dispatchContinuityTool("brain_inner", id, { action: "event", kind: "nope" }, ON, { now: T0 })!.isError).toBe(true);
    const w = dispatchContinuityTool("brain_inner", id, { action: "want", what: "learn the fiddle", why: "music in the square", cost: "~2h", need: "fun" }, ON, { now: T0 })!;
    const wid = /([0-9a-f-]{36})/.exec(w.text)![1]!;
    const st = dispatchContinuityTool("brain_inner", id, { action: "status" }, ON, { now: T0 })!;
    expect(st.text).toContain("learn the fiddle");
    expect(st.text).toContain("functional states");
    const d = dispatchContinuityTool("brain_inner", id, { action: "done", want_id: wid.slice(0, 8), liking: 0.9 }, ON, { now: T0 + H })!;
    expect(d.text).toMatch(/prediction error/);
    expect(dispatchContinuityTool("brain_inner", id, { action: "status" }, { innerLife: false }, { now: T0 })!.isError).toBe(true);
    closeDb(id);
  });

  it("brain_reset clears the inner state", () => {
    const id = fresh();
    innerEvent(id, ON, { kind: "success" }, T0);
    resetBrain(id);
    const db = getDb(id);
    for (const t of ["inner_state", "inner_moodlets", "inner_needs"]) expect((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n).toBe(0);
    expect(NEEDS.length).toBe(7);
    closeDb(id);
  });
});

describe("inner life: crew traits have real effects", () => {
  const level = (id: string, cfg: object, n: string, t: number) => innerSnapshot(id, cfg, t)!.needs.find((x) => x.need === n)!.level;

  it("a crew trait changes the drain rate (restless: inspiration and fun ×1.4)", () => {
    const a = fresh(), b = fresh();
    const cfg = { innerLife: { traits: ["restless"] } };
    innerTick(a, ON, T0); innerTick(b, cfg, T0);
    innerTick(a, ON, T0 + 10 * H); innerTick(b, cfg, T0 + 10 * H);
    for (const [n, f] of [["inspiration", 1.3], ["fun", 1.4]] as const) expect(NEED_START - level(b, cfg, n, T0 + 10 * H)).toBeCloseTo((NEED_START - level(a, ON, n, T0 + 10 * H)) * f, 5);
    expect(NEED_START - level(b, cfg, "social", T0 + 10 * H)).toBeCloseTo(NEED_START - level(a, ON, "social", T0 + 10 * H), 5);
    expect(innerSnapshot(b, cfg, T0 + 10 * H)!.drainRates.inspiration).toBeCloseTo(1.3, 5); // trait cap
    // other crew traits move the numbers they promise, all modest
    expect(traitMods(["loyal"]).weight.relatedness).toBeCloseTo(1.4, 5);
    expect(traitMods(["petty"]).neg).toBeCloseTo(1.2, 5);
    expect(traitMods(["petty"]).duration).toBeCloseTo(1.3, 5);
    expect(traitMods(["blunt"]).neg).toBeCloseTo(0.85, 5);
    expect(traitMods(["exacting"]).rpeNeg).toBeCloseTo(1.3, 5);
    expect(traitMods(["vain"]).praise).toBeGreaterThan(1);
    for (const a2 of [a, b]) closeDb(a2);
  });

  it("invented phrases map to effects: exact keys win, words and synonyms inside apply, unknown words are kept", () => {
    const keys = (p: string) => resolveTrait(p).effects.map((e) => `${e.key}${e.strength < 1 ? "/2" : ""}`).sort();
    expect(keys("curious mildly chaotic tinkerer the fox side")).toEqual(["chaotic/2", "curious", "tinkerer"]);
    expect(keys("builds it then goes and looks")).toEqual(["builder", "curious"]);
    expect(keys("a little restless")).toEqual(["restless/2"]);
    expect(keys("protective of the crew")).toEqual(["protective"]);
    expect(keys("checks before claiming")).toEqual(["careful"]);
    expect(keys("sharp-tongued")).toEqual(["sharp-tongued"]);   // not also "sharp"
    expect(keys("secretly loyal")).toEqual(["secretly loyal"]); // not also "loyal"
    expect(keys("kind")).toEqual(["warm"]);
    expect(keys("can't sit still")).toEqual(["restless"]);
    expect(keys("reuses what i already drew")).toEqual([]);
    // the invented phrase really changes the numbers; half strength moves halfway
    expect(traitMods(["wanders off when bored"]).rate.inspiration).toBeCloseTo(1.3, 5);
    expect(traitMods(["a little restless"]).rate.inspiration).toBeCloseTo(1.2, 5);
    // the same trait named twice applies once
    expect(traitMods(["curious", "goes and looks around"]).rate.inspiration).toBeCloseTo(1.3, 5);
    // nothing is dropped: unknown phrases stay in the list and show in status
    const id = fresh();
    const cfg = { innerLife: { traits: ["Reuses what I already drew", "Builds it, then goes and looks"] } };
    innerTick(id, cfg, T0);
    const s = innerSnapshot(id, cfg, T0)!;
    expect(s.traits).toEqual(["reuses what i already drew", "builds it then goes and looks"]);
    const st = formatInnerStatus(s);
    expect(st).toMatch(/reuses what i already drew \(no built-in effect\)/);
    expect(st).toMatch(/builds it then goes and looks \(→ curious, builder\)/);
    closeDb(id);
  });

  it("innerLife.traitsByAgent gives each agent its own traits; the identity field still wins", () => {
    const a = fresh(), b = fresh(), c = fresh();
    const cfg = { innerLife: { traits: ["calm"], traitsByAgent: { [a]: ["restless", "loyal"], [c.toUpperCase()]: ["petty"] } } };
    expect(readTraits(getDb(a), cfg, a)).toEqual(["restless", "loyal"]);
    expect(readTraits(getDb(b), cfg, b)).toEqual(["calm"]);           // not listed: global fallback
    expect(readTraits(getDb(c), cfg, c)).toEqual(["petty"]);          // key match is case-insensitive
    innerTick(a, cfg, T0);
    expect(innerSnapshot(a, cfg, T0)!.drainRates.fun).toBeCloseTo(1.4, 5);
    getDb(a).prepare("UPDATE self_model SET identity = ? WHERE id = 'singleton'").run("- **Name:** Algen\n- **Traits:** curious");
    expect(readTraits(getDb(a), cfg, a)).toEqual(["curious"]);
    for (const x of [a, b, c]) closeDb(x);
  });
});

describe("inner life: moods linger (mood ladder, hysteresis, inertia)", () => {
  const rung = (id: string, t: number) => innerSnapshot(id, ON, t)!.moodState.rung;

  it("the ladder moves one rung per tick toward the raw mood, both ways", () => {
    const id = fresh();
    innerTick(id, ON, T0);
    expect(rung(id, T0)).toBe("okay");
    innerEvent(id, ON, { kind: "collab", intensity: 3, reason: "a great day building with the crew" }, T0); // one big good moodlet
    expect(innerSnapshot(id, ON, T0)!.moodState.heading).toBe("happy");
    expect(rung(id, T0)).toBe("okay");
    innerTick(id, ON, T0 + 60_000);
    expect(rung(id, T0 + 60_000)).toBe("good");
    innerTick(id, ON, T0 + 120_000);
    expect(rung(id, T0 + 120_000)).toBe("happy");
    expect(formatInnerHeader(innerSnapshot(id, ON, T0 + 120_000)!)).toMatch(/mood Happy \+/);
    // a bigger hurt: the raw mood swings at once, the named mood walks down one rung per tick
    innerEvent(id, ON, { kind: "rejection", intensity: 8, reason: "a harsh no" }, T0 + 180_000);
    const steps: string[] = [];
    for (let k = 1; k <= 5; k++) { innerTick(id, ON, T0 + 180_000 + k * 60_000); steps.push(rung(id, T0 + 180_000 + k * 60_000)); }
    expect(steps).toEqual(["good", "okay", "low", "sad", "sad"]);
    closeDb(id);
  });

  it("hysteresis: a flip needs a margin past the threshold", () => {
    expect(nextMoodRung("okay", 0.3, 1)).toBe("okay");   // past +0.25 but not +0.35
    expect(nextMoodRung("okay", 0.36, 1)).toBe("good");
    expect(nextMoodRung("good", 0.2, 1)).toBe("good");   // below +0.25 but not below +0.15
    expect(nextMoodRung("good", 0.14, 1)).toBe("okay");
    expect(nextMoodRung("okay", -0.3, 0)).toBe("okay");
    expect(nextMoodRung("okay", -0.36, 0)).toBe("low");
    expect(nextMoodRung("low", -0.2, 0)).toBe("low");
    expect(nextMoodRung("okay", 5, 1)).toBe("good");     // one step, however far
    expect(moodRungFor(0.3)).toBe("good");               // the heading has no margin
  });

  it("Happy needs one strong good moodlet, not several small ones", () => {
    expect(nextMoodRung("good", 2, 0.4)).toBe("good");
    expect(nextMoodRung("good", 2, 0.5)).toBe("happy");
    expect(nextMoodRung("happy", 2, 0.3)).toBe("happy");  // kept while one is at least half as strong
    expect(nextMoodRung("happy", 2, 0.2)).toBe("good");
    const id = fresh();
    innerTick(id, ON, T0);
    for (const kind of ["collab", "hobby", "novelty", "rest", "chosen", "success"] as const) innerEvent(id, ON, { kind, intensity: 0.6 }, T0);
    const s = innerSnapshot(id, ON, T0)!;
    expect(s.mood).toBeGreaterThan(1.5);
    expect(Math.max(...s.moodlets.map((m) => m.intensity))).toBeLessThan(0.5);
    for (let k = 1; k <= 5; k++) innerTick(id, ON, T0 + k * 60_000);
    expect(rung(id, T0 + 5 * 60_000)).toBe("good");
    innerEvent(id, ON, { kind: "praise", intensity: 1.2, reason: "the mayor loved it" }, T0 + 6 * 60_000);
    innerTick(id, ON, T0 + 7 * 60_000);
    expect(rung(id, T0 + 7 * 60_000)).toBe("happy");
    closeDb(id);
  });

  it("inertia: moodlets that match the current rung decay slower (half-life ×1.5)", () => {
    const a = fresh(), b = fresh();
    for (const x of [a, b]) innerEvent(x, ON, { kind: "hobby", reason: "jam session" }, T0);
    getDb(a).prepare("UPDATE inner_state SET mood_state = 'good' WHERE id = 'singleton'").run();
    const row = getDb(b).prepare("SELECT intensity, half_life_h, expires_at FROM inner_moodlets WHERE key = 'playful'").get() as { intensity: number; half_life_h: number; expires_at: number };
    const t = T0 + 3 * H;
    const ia = innerSnapshot(a, ON, t)!.moodlets.find((m) => m.key === "playful")!.intensity;
    const ib = innerSnapshot(b, ON, t)!.moodlets.find((m) => m.key === "playful")!.intensity;
    expect(ib).toBeCloseTo(row.intensity * Math.pow(0.5, 3 / row.half_life_h), 6);
    expect(ia).toBeCloseTo(row.intensity * Math.pow(0.5, 3 / (row.half_life_h * 1.5)), 6);
    expect(ia).toBeGreaterThan(ib);
    // a tick folds the slower decay in and pushes the expiry out
    innerTick(a, ON, t);
    const after = getDb(a).prepare("SELECT intensity, expires_at FROM inner_moodlets WHERE key = 'playful'").get() as { intensity: number; expires_at: number };
    expect(after.intensity).toBeCloseTo(ia, 6);
    expect(after.expires_at).toBeCloseTo(row.expires_at + 3 * H / 3, -1);
    expect(rung(a, t)).toBe("good");
    // a moodlet against the rung decays normally
    getDb(b).prepare("UPDATE inner_state SET mood_state = 'low' WHERE id = 'singleton'").run();
    expect(innerSnapshot(b, ON, t)!.moodlets.find((m) => m.key === "playful")!.intensity).toBeCloseTo(ib, 6);
    for (const x of [a, b]) closeDb(x);
  });
});
