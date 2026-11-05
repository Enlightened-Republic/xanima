import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { getDb } from "../src/db.js";
import { innerTick, innerEvent, innerSnapshot, resolveTrait, traitMods, isOwnerEpisode } from "../src/inner-life.js";

const H = 3600_000;
const T0 = Date.UTC(2026, 10, 4, 12, 0, 0);
const fresh = () => `insp-${randomUUID().slice(0, 8)}`;
const lvl = (id: string, cfg: object, n: string, t: number) => innerSnapshot(id, cfg as never, t)!.needs.find((x) => x.need === n)!.level;
const cfgWith = (traits: string[], extra: object = {}) => ({ innerLife: { traits, ...extra } });
function ep(id: string, role: string, at: number, meta: object | null = null, session = "s1") {
  getDb(id).prepare("INSERT INTO episodes (id, session_id, role, content, created_at, meta) VALUES (?, ?, ?, ?, ?, ?)")
    .run(randomUUID(), session, role, "hey, how is the town?", at, meta ? JSON.stringify(meta) : null);
}

describe("inner life: Inspiration fix (owner chat, trait feeds, drain cap)", () => {
  it("an owner-flagged user episode raises Inspiration; a non-owner one does not", () => {
    const a = fresh(), b = fresh(); const cfg = cfgWith([]);
    const t1 = T0 + 12 * H, t2 = t1 + 2 * 60_000; // drain first so nothing clamps at 1
    for (const id of [a, b]) { innerTick(id, cfg, T0); innerTick(id, cfg, t1); }
    ep(a, "user", t1 + 60_000, { owner: true });
    ep(b, "user", t1 + 60_000, { sender: "stranger" });
    innerTick(a, cfg, t2); innerTick(b, cfg, t2);
    expect(lvl(a, cfg, "inspiration", t2) - lvl(b, cfg, "inspiration", t2)).toBeCloseTo(0.25, 2);
    expect(lvl(a, cfg, "relatedness", t2)).toBeGreaterThan(lvl(b, cfg, "relatedness", t2));
  });

  it("owner bonus is capped at about +0.5 per rolling hour", () => {
    const id = fresh(); const cfg = cfgWith([]);
    innerTick(id, cfg, T0);
    // owner chat every 2 minutes for an hour, ticking each turn
    for (let m = 1; m <= 30; m++) { ep(id, "user", T0 + m * 120_000, { owner: true }); innerTick(id, cfg, T0 + m * 120_000 + 1000); }
    const n = (getDb(id).prepare("SELECT COUNT(*) AS n FROM inner_events WHERE kind='owner_chat'").get() as { n: number }).n;
    expect(n).toBe(2);
  });

  it("falls back to ownerAllowFrom and ownerSessionIds; meta.owner=false wins", () => {
    const cfg = cfgWith([], { ownerAllowFrom: [12345], ownerSessionIds: ["tg-hailey"] });
    expect(isOwnerEpisode({ session_id: "x", meta: JSON.stringify({ sender: "12345" }) }, cfg as never)).toBe(true);
    expect(isOwnerEpisode({ session_id: "tg-hailey", meta: null }, cfg as never)).toBe(true);
    expect(isOwnerEpisode({ session_id: "tg-hailey", meta: JSON.stringify({ owner: false }) }, cfg as never)).toBe(false);
    expect(isOwnerEpisode({ session_id: "x", meta: JSON.stringify({ sender: "999" }) }, cfg as never)).toBe(false);
  });

  it("a builder gains Inspiration from a success; the same event without the trait does not", () => {
    const a = fresh(), b = fresh(); const ca = cfgWith(["builder"]), cb = cfgWith([]);
    innerTick(a, ca, T0); innerTick(b, cb, T0);
    const a0 = lvl(a, ca, "inspiration", T0), b0 = lvl(b, cb, "inspiration", T0);
    innerEvent(a, ca, { kind: "success" }, T0); innerEvent(b, cb, { kind: "success" }, T0);
    expect(lvl(a, ca, "inspiration", T0) - a0).toBeCloseTo(0.15, 2); // 0.2, clamped at 1 from 0.85
    expect(lvl(b, cb, "inspiration", T0) - b0).toBeCloseTo(0, 5);
  });

  it("soft trait applies at half strength; invented phrases map to builder", () => {
    expect(resolveTrait("likes to build").effects).toEqual([{ key: "builder", strength: 1 }]);
    expect(resolveTrait("a builder").effects[0]!.key).toBe("builder");
    expect(resolveTrait("a little builder").effects).toEqual([{ key: "builder", strength: 0.5 }]);
    expect(traitMods(["a little builder"]).feeds.success!.inspiration).toBeCloseTo(0.1, 5);
  });

  it("trait-driven Inspiration drain is capped at 1.3 (curious + restless used to be 1.8)", () => {
    expect(traitMods(["curious", "a little restless"]).rate.inspiration).toBeCloseTo(1.3, 5);
    expect(traitMods(["curious", "restless"], { innerLife: { needRates: { inspiration: 2 } } } as never).rate.inspiration).toBeCloseTo(2.6, 5);
  });

  it("mismatch drains are small, negative and clamped at 0", () => {
    const m = traitMods(["introverted", "curious"]);
    expect(m.feeds.collab!.rest).toBeCloseTo(-0.05, 5);
    expect(m.feeds.assigned!.inspiration).toBeCloseTo(-0.03, 5);
    const id = fresh(); const cfg = cfgWith(["curious"]);
    innerTick(id, cfg, T0);
    for (let i = 0; i < 100; i++) innerEvent(id, cfg, { kind: "assigned" }, T0);
    expect(lvl(id, cfg, "inspiration", T0)).toBeGreaterThanOrEqual(0);
  });

  it("build cues count as success (placed in game3d / ALL PASS)", () => {
    const id = fresh(); const cfg = cfgWith(["builder"]);
    innerTick(id, cfg, T0);
    getDb(id).prepare("INSERT INTO episodes (id, session_id, role, content, created_at) VALUES (?, 's', 'assistant', 'skate park placed in game3d, smoke ALL PASS', ?)").run(randomUUID(), T0 + 60_000);
    innerTick(id, cfg, T0 + 120_000);
    const ev = getDb(id).prepare("SELECT kind FROM inner_events WHERE kind='success'").all();
    expect(ev.length).toBe(1);
  });
});
