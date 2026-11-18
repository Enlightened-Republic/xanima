import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { getDb } from "../src/db.js";
import { innerTick, innerSnapshot } from "../src/inner-life.js";

const H = 3600_000;
const T0 = Date.UTC(2026, 10, 5, 12, 0, 0);
const cfg = { innerLife: { traits: [] as string[] } };
const lvl = (id: string, n: string, t: number) => innerSnapshot(id, cfg as never, t)!.needs.find((x) => x.need === n)!.level;
function drained(content: string, role = "assistant") {
  const id = `mr-${randomUUID().slice(0, 8)}`;
  innerTick(id, cfg as never, T0);
  const t1 = T0 + 24 * H;
  innerTick(id, cfg as never, t1);
  getDb(id).prepare("INSERT INTO episodes (id, session_id, role, content, created_at) VALUES (?, 's', ?, ?, ?)").run(randomUUID(), role, content, t1 + 60_000);
  const t2 = t1 + 120_000;
  const before = { fun: lvl(id, "fun", t1), social: lvl(id, "social", t1), autonomy: lvl(id, "autonomy", t1) };
  innerTick(id, cfg as never, t2);
  return { fun: lvl(id, "fun", t2) - before.fun, social: lvl(id, "social", t2) - before.social, autonomy: lvl(id, "autonomy", t2) - before.autonomy };
}

describe("mayor's rules 2026-11-05", () => {
  it("a creative session counts toward Fun and Social", () => {
    const d = drained("We brainstormed the train station and dreamed up a night market together.");
    expect(d.fun).toBeGreaterThan(0.1);
    expect(d.social).toBeGreaterThan(0.1);
  });
  it("running with her idea (own spin) counts toward Autonomy", () => {
    const d = drained("I ran with your idea and added a clock tower you didn't ask for.");
    expect(d.autonomy).toBeGreaterThan(0.05);
  });
  it("routine work moves none of Fun, Social, Autonomy", () => {
    const d = drained("Fixed the failing test and updated the config.");
    expect(d.fun).toBeLessThan(0.01);
    expect(d.social).toBeLessThan(0.01);
    expect(d.autonomy).toBeLessThan(0.01);
  });
});
