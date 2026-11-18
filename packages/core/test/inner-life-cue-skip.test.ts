import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { getDb } from "../src/db.js";
import { innerTick, innerEvent, innerSnapshot } from "../src/inner-life.js";

const H = 3600_000;
const T0 = Date.UTC(2026, 10, 12, 12, 0, 0);
const CHAT = "Done. All five adjustments are live. The last thing I shipped here was the SOLD tally.";

function sayThenTick(cfg: object) {
  const id = `cs-${randomUUID().slice(0, 8)}`;
  innerTick(id, cfg as never, T0);
  const t1 = T0 + 2 * H;
  innerTick(id, cfg as never, t1);
  getDb(id).prepare("INSERT INTO episodes (id, session_id, role, content, created_at) VALUES (?, 's', 'assistant', ?, ?)").run(randomUUID(), CHAT, t1 + 60_000);
  const t2 = t1 + 120_000;
  innerTick(id, cfg as never, t2);
  return { id, t2, proud: innerSnapshot(id, cfg as never, t2)!.moodlets.find((m) => m.key === "proud") };
}
const episodeEvents = (id: string, kind: string) =>
  (getDb(id).prepare("SELECT detail_json AS d FROM inner_events WHERE kind = ?").all(kind) as Array<{ d: string | null }>)
    .filter((r) => /"origin":"episode"/.test(r.d ?? "")).length;

describe("innerLife.episodeCueSkip", () => {
  it("by default, saying 'shipped' in chat fires a success cue (Proud)", () => {
    const { id, proud } = sayThenTick({ innerLife: { traits: [] } });
    expect(proud).toBeDefined();
    expect(episodeEvents(id, "success")).toBe(1);
  });
  it("with episodeCueSkip: ['success'], the same chat fires nothing", () => {
    const { id, proud } = sayThenTick({ innerLife: { traits: [], episodeCueSkip: ["success"] } });
    expect(proud).toBeUndefined();
    expect(episodeEvents(id, "success")).toBe(0);
  });
  it("a real brain_inner success event still lands with the skip on", () => {
    const cfg = { innerLife: { traits: [] as string[], episodeCueSkip: ["success"] } };
    const { id, t2 } = sayThenTick(cfg);
    innerEvent(id, cfg as never, { kind: "success", reason: "shipped: SOLD tally shingle" }, t2 + 60_000);
    const proud = innerSnapshot(id, cfg as never, t2 + 60_000)!.moodlets.find((m) => m.key === "proud");
    expect(proud).toBeDefined();
    expect(proud!.reason).toBe("shipped: SOLD tally shingle");
  });
  it("other cues (praise from the owner) are untouched by a success-only skip", () => {
    const cfg = { innerLife: { traits: [] as string[], episodeCueSkip: ["success"] } };
    const { id, t2 } = sayThenTick(cfg);
    getDb(id).prepare("INSERT INTO episodes (id, session_id, role, content, created_at) VALUES (?, 's', 'user', ?, ?)").run(randomUUID(), "nice work on the tally", t2 + 30_000);
    innerTick(id, cfg as never, t2 + 60_000);
    expect(episodeEvents(id, "praise")).toBe(1);
    expect(episodeEvents(id, "success")).toBe(0);
  });
});
