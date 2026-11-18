import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { closeDb } from "../src/db.js";
import { innerConfig, innerLifeEnabled, innerTick, innerSnapshot, innerEvent, addWant, innerSleep, innerTurnHeader } from "../src/inner-life.js";
import { dispatchContinuityTool } from "../src/continuity-tools.js";
import { buildSelfModelHeader } from "../src/context-assembly.js";
import { DEFAULT_CONFIG } from "../src/types.js";

const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);
const fresh = () => `inner-off-${randomUUID().slice(0, 8)}`;

describe("innerLife is off unless asked for", () => {
  it("no key, undefined, null and false are off", () => {
    expect(innerLifeEnabled(undefined)).toBe(false);
    expect(innerLifeEnabled({})).toBe(false);
    expect(innerLifeEnabled(DEFAULT_CONFIG)).toBe(false);
    expect(innerLifeEnabled({ innerLife: false })).toBe(false);
    expect(innerLifeEnabled({ innerLife: null } as never)).toBe(false);
    expect(innerLifeEnabled({ innerLife: { enabled: false, traits: ["curious"] } })).toBe(false);
  });

  it("true is on, and so is an object without an `enabled` key", () => {
    expect(innerLifeEnabled({ innerLife: true })).toBe(true);
    expect(innerLifeEnabled({ innerLife: {} })).toBe(true);
    expect(innerLifeEnabled({ innerLife: { traitsByAgent: { main: ["curious"] } } })).toBe(true);
    expect(innerLifeEnabled({ innerLife: { enabled: true } })).toBe(true);
    // the other switches keep their own defaults once the layer is on
    expect(innerConfig({ innerLife: true })).toMatchObject({ enabled: true, header: true, autoWants: true });
  });

  it("an unconfigured brain does nothing: no tick, no header, no state rows, and the tool refuses", async () => {
    const id = fresh();
    expect(innerTick(id, {}, T0)).toBe(false);
    expect(innerSnapshot(id, {}, T0)).toBeNull();
    expect(innerTurnHeader(id, {}, T0)).toBe("");
    expect(innerSleep(id, {}, T0)).toBe(false);
    expect(innerEvent(id, {}, { kind: "success", reason: "should not land" }, T0).ok).toBe(false);
    const w = addWant(id, {}, { what: "should not land" }, T0);
    expect(w.ok).toBe(false);
    expect(w.error).toMatch(/innerLife: true/);
    const r = dispatchContinuityTool("brain_inner", id, { action: "status" }, {}, { now: T0 })!;
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/innerLife: true/);
    expect(await buildSelfModelHeader(id, DEFAULT_CONFIG)).not.toContain("[inner");
    // turning it on later starts from a fresh state
    expect(innerTick(id, { innerLife: true }, T0)).toBe(true);
    expect(innerSnapshot(id, { innerLife: true }, T0)).toBeTruthy();
    closeDb(id);
  });
});
