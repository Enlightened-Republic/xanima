import { describe, it, expect } from "vitest";
import { innerTick, innerSnapshot, innerEvent, innerLifeEnabled } from "../src/inner-life.js";

const T0 = Date.UTC(2026, 10, 13, 12, 0, 0);
const cfg = { innerLife: { traits: [] as string[], excludeAgents: ["mila"] } };

describe("innerLife.excludeAgents", () => {
  it("treats a listed agent as off, others as on", () => {
    expect(innerLifeEnabled(cfg, "mila")).toBe(false);
    expect(innerLifeEnabled(cfg, "Mila")).toBe(false);
    expect(innerLifeEnabled(cfg, "wren")).toBe(true);
    expect(innerLifeEnabled(cfg)).toBe(true);
  });
  it("does not tick or snapshot a listed agent, and does not block others", () => {
    expect(innerTick("mila", cfg as never, T0)).toBe(false);
    expect(innerSnapshot("mila", cfg as never, T0)).toBeNull();
    expect(innerEvent("mila", cfg as never, { kind: "success", reason: "should not land" }, T0).ok).toBe(false);
    expect(innerTick("wren", cfg as never, T0)).toBe(true);
    expect(innerSnapshot("wren", cfg as never, T0)).toBeTruthy();
  });
});