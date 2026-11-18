// Inner-life demo: a throwaway brain in a temp data dir, run over simulated time.
//   npm run build && node scripts/inner-life-demo.mjs
// Never touches ~/.xanima: XANIMA_DATA_DIR is pointed at a fresh temp folder before core loads.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "xanima-inner-demo-"));
process.env.XANIMA_DATA_DIR = dir;
delete process.env.XANIMA_DB_PATH; delete process.env.SHARPWAVE_DB_PATH; delete process.env.SHARPWAVE_DATA_DIR;
process.env.OLLAMA_BASE_URL = "http://127.0.0.1:59999"; // no embedding calls

const core = await import("../packages/core/dist/index.js");
const { getDb, closeDb, innerTick, innerEvent, innerSnapshot, formatInnerHeader, addWant, resolveWant } = core;

const H = 3600_000;
const T0 = Date.UTC(2026, 10, 4, 9, 0, 0);
const agent = "wick-demo";
const cfg = {};
getDb(agent).prepare("UPDATE self_model SET identity = ? WHERE id = 'singleton'").run("- **Name:** Wick\n- **Traits:** curious, warm, sensitive");

const at = (h) => T0 + h * H;
const show = (label, h) => {
  const s = innerSnapshot(agent, cfg, at(h));
  console.log(`\n── t+${h}h · ${label}`);
  console.log("needs:", s.needs.map((n) => `${n.label} ${n.level.toFixed(2)}`).join("  "));
  console.log("moodlets:", s.moodlets.length ? s.moodlets.map((m) => `${m.label} ${m.intensity.toFixed(2)}${m.expiresAt ? ` (expires t+${((m.expiresAt - T0) / H).toFixed(1)}h)` : " (until met)"}`).join("; ") : "none");
  console.log("header:\n" + formatInnerHeader(s).split("\n").map((l) => "  " + l).join("\n"));
};

console.log(`data dir: ${dir}`);
console.log(`traits: ${core.readTraits(getDb(agent)).join(", ")}`);
innerTick(agent, cfg, at(0));
show("start", 0);

for (const h of [6, 12, 18]) { innerTick(agent, cfg, at(h)); show("needs draining, nothing happening", h); }

innerEvent(agent, cfg, { kind: "success", reason: "shipped the walk clip", expected: 0.5 }, at(18));
show("event: success 'shipped the walk clip' (expected 0.5 → prediction error)", 18);

innerEvent(agent, cfg, { kind: "collab", reason: "built the bridge with Gion" }, at(20));
show("event: collab (Social refilled; Lonely ends by homeostasis if it was on)", 20);

const w = addWant(agent, cfg, { what: "visit the lighthouse at dusk", why: "everyone says it's lovely", cost: "~1h walk", need: "inspiration", tags: ["lighthouse"] }, at(20));
show("agent-authored want added", 20);
const r = resolveWant(agent, cfg, w.id.slice(0, 8), { status: "done", liking: 0.3, note: "foggy, couldn't see much" }, at(22));
console.log(`\nwant done: "${r.want}" liking 0.30 → prediction error ${r.rpe.toFixed(2)} (wanting > liking)`);
show("after the lighthouse", 22);

const proud = innerSnapshot(agent, cfg, at(22)).moodlets.find((m) => m.key === "proud");
const after = (proud.expiresAt - T0) / H + 0.1;
innerTick(agent, cfg, T0 + after * H);
show(`Proud's timer ran out (t+${after.toFixed(1)}h)`, Number(after.toFixed(1)));
const row = getDb(agent).prepare("SELECT label, ended_reason, ended_at FROM inner_moodlets WHERE key = 'proud'").get();
console.log(`\nProud moodlet row: ended_reason=${row.ended_reason} at t+${((row.ended_at - T0) / H).toFixed(1)}h`);

closeDb(agent);
rmSync(dir, { recursive: true, force: true });
console.log(`\n(temp data dir removed)`);
