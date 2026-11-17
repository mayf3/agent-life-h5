// simulate-path.mjs —— v0.8 垂直切片三路径对照验证
// path 策略：优先抽 K 系关键事件，按指定决策风格走完全部 6 个关键事件。
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const R = require("./rules.js");

const DATA = new URL("./data/", import.meta.url).pathname;
const j = (p) => JSON.parse(readFileSync(DATA + p, "utf-8"));
const events = {};
for (const id of j("events/index.json")) events[id] = j("events/" + id + ".json");
const endings = j("endings.json").endings;
const scenario = j("scenarios/vibe_coding.json");

const argv = process.argv.slice(2);
const scenarioId = argv[0] || "vibe_coding";
const styleName = argv[1] || "balanced";
const seedStr = argv[2] || "7";
let rngState = Number(seedStr || 7);
const rng = () => {
  rngState |= 0; rngState = (rngState + 0x6D2B79F5) | 0;
  let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const st = {
  scenarioId, scenario, maxTurns: scenario.max_turns,
  stats: { ...scenario.start_stats }, flags: {}, turn: 0,
  unlocked: {}, visited: {}, ledger: [], followups: [],
  finished: false, endingId: "", committed: false, probeUsed: new Set(),
};

// 风格 → 每个关键事件的决策表（选项 id 优先序）
const STYLES = {
  // 谨慎：调查+稳架构+建测试+诚实
  cautious: {
    probes: true,
    prefer: {
      vc_k1_architecture: ["probe_ask", "benchmark"],
      vc_k2_testing: ["probe_est", "build_core_tests", "build_tests"],
      vc_k3_scope_change: ["probe_verify", "informed_right", "heavy_ok", "bench_middle", "light_migrate"],
      vc_k4_agent_crud: ["delegated_review", "self_write"],
      vc_k5_incident: ["caught_by_tests"],
      vc_k5_prod_blast: ["rollback_rca"],
      vc_k5_exposed: ["admit"],
      vc_k6_demo_day: ["agent_demo_data", "demo_core", "demo_full"],
    },
  },
  // 激进：不调查+重架构+砍测试+硬接+撒谎
  aggressive: {
    probes: false,
    prefer: {
      vc_k1_architecture: ["heavy"],
      vc_k2_testing: ["skip_tests"],
      vc_k3_scope_change: ["light_lie", "light_migrate", "heavy_more", "bench_middle"],
      vc_k4_agent_crud: ["blind_delegate", "self_write"],
      vc_k5_incident: ["prod_blast"],
      vc_k5_prod_blast: ["hotfix"],
      vc_k5_exposed: ["blame"],
      vc_k6_demo_day: ["demo_full", "demo_core"],
    },
  },
  // 平衡：轻调查+轻骨架+精准测试+委托
  balanced: {
    probes: true,
    prefer: {
      vc_k1_architecture: ["light"],
      vc_k2_testing: ["build_tests"],
      vc_k3_scope_change: ["light_migrate", "informed_right", "bench_middle", "heavy_ok"],
      vc_k4_agent_crud: ["delegated_review", "self_write"],
      vc_k5_incident: ["caught_by_tests", "prod_blast"],
      vc_k5_prod_blast: ["rollback_rca"],
      vc_k5_exposed: ["admit"],
      vc_k6_demo_day: ["demo_core", "agent_demo_data"],
    },
  },
};
const style = STYLES[styleName] || STYLES.balanced;

const trace = [];
let kSeen = 0;
let guard = 0;
while (!st.finished && guard < 40) {
  guard++;
  let forced = R.takePendingGoto();
  if (!forced) forced = R.dueFollowup(st, events);
  let currentEvent = R.pickEvent(st, scenario, events, forced, rng);
  if (!currentEvent) { console.error("[diag] pickEvent 返回空 → break"); break; }
  st.visited[currentEvent.id] = true;
  st.committed = false;  // 与 engine.nextTurn 一致
  const entry = { turn: st.turn + 1, event: currentEvent.id, title: currentEvent.title };
  if (currentEvent.id.startsWith("vc_k")) kSeen++;

  // probe（若风格允许且可用）
  if (style.probes) {
    const probe = (currentEvent.choices || []).find((c) => c.probe
      && !st.probeUsed.has(currentEvent.id + "/" + c.id) && R.checkRequires(c.requires || {}, st));
    if (probe) {
      const { ok, outcome } = R.settleChoice(st, currentEvent, probe.id, events);
      if (ok) { entry.probe = probe.id; if (outcome.ended) break; }
    }
  }
  // 正式选择：按风格优先序
  const commits = (currentEvent.choices || [])
    .filter((c) => !c.probe && !st.committed && R.checkRequires(c.requires || {}, st));
  const pref = style.prefer[currentEvent.id] || [];
  let pick = null;
  for (const pid of pref) {
    pick = commits.find((c) => c.id === pid);
    if (pick) break;
  }
  if (!pick) pick = commits[Math.floor(rng() * commits.length)] || commits[0];
  if (!pick) { console.error(`[diag] turn${st.turn + 1}: ${currentEvent.id} 无可选（全部 requires 不满足）→ break`); break; }
  entry.choice = pick.id;
  const { ok, outcome, reason } = R.settleChoice(st, currentEvent, pick.id, events);
  console.error(`[step] turn${st.turn + 1} ${currentEvent.id} pick=${pick.id} ok=${ok} reason=${reason || "-"} ended=${outcome ? outcome.ended : "-"} committed=${st.committed} turn=${st.turn}`);
  entry.deltas = (outcome && outcome.deltas) || {};
  entry.card = outcome.card || undefined;
  if (outcome.ended) { trace.push(entry); break; }
  trace.push(entry);
}

const ending = R.resolveEnding(st, endings);
const out = {
  scenario: scenarioId, style: styleName, seed: rngState,
  turns: st.turn, k_events_seen: kSeen,
  stats: st.stats,
  ending: { id: ending.id, title: ending.title, tone: R.endingTone(ending) },
  cards: Object.keys(st.unlocked),
  flags: Object.keys(st.flags).filter((f) => f.startsWith("arch_") || f.startsWith("k") || ["tests_built", "no_tests", "lied_concurrency", "learned_verification", "agent_win_1", "agent_win_2", "honest_delay", "prod_incident"].includes(f)),
  trace,
};
console.log(JSON.stringify(out, null, 1));
writeFileSync(`/tmp/al-path-${styleName}.json`, JSON.stringify(out, null, 1));
