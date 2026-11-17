// simulate.mjs —— headless 自动对局（试玩证据生成器）
// 用真实规则引擎 + 真实 data/ 跑完整局，输出逐回合轨迹与结局。
// 策略可指定：random / cautious（优先验证类选项）/ aggressive（优先委托 Agent 类选项）
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const R = require("./rules.js");

const DATA = new URL("./data/", import.meta.url).pathname;
const j = (p) => JSON.parse(readFileSync(DATA + p, "utf-8"));

const scenarioId = process.argv[2] || "vibe_coding";
const policy = process.argv[3] || "random";
const seed = Number(process.argv[4] || 42);
let rngState = seed;
const rng = () => {
  rngState |= 0; rngState = (rngState + 0x6D2B79F5) | 0;
  let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const scenarios = j("scenarios/index.json");
const eventsList = j("events/index.json");
const events = {};
for (const id of eventsList) events[id] = j("events/" + id + ".json");
const cardsList = j("cards/index.json");
const cards = {};
for (const id of cardsList) cards[id] = j("cards/" + id + ".json");
const endings = j("endings.json").endings;
const scenario = j("scenarios/" + scenarioId + ".json");

const st = {
  scenarioId, scenario, maxTurns: scenario.max_turns,
  stats: { ...scenario.start_stats }, flags: {}, turn: 0,
  unlocked: {}, visited: {}, ledger: [], followups: [],
  finished: false, endingId: "", committed: false, probeUsed: new Set(),
};

// 策略：对每个选项打分
function scoreChoice(c) {
  const text = c.text || "";
  if (policy === "cautious") {
    // 谨慎：偏好验证/回滚/立规（关键词），回避委托
    let s = 0;
    if (/验证|查|审|回滚|立|规矩|测试|快照|脱敏|文档|暂缓|冻结|记录/.test(text)) s += 10;
    if (/让它|委托|顺手|自动|直接跑|全部批准/.test(text)) s -= 8;
    if (c.probe) s += 3; // 谨慎玩家也喜欢低成本调查
    return s;
  }
  if (policy === "aggressive") {
    let s = 0;
    if (/让它|委托|顺手|自动|直接|合并|上线|继续|睡|推/.test(text)) s += 10;
    if (/验证|回滚|立|测试|审计|翻/.test(text)) s -= 5;
    return s;
  }
  return rng() * 10; // random
}

const trace = [];
let guard = 0;
while (!st.finished && guard < 60) {
  guard++;
  let forced = R.takePendingGoto();
  if (!forced) forced = R.dueFollowup(st, events);
  const currentEvent = R.pickEvent(st, scenario, events, forced, rng);
  if (!currentEvent) break;
  st.visited[currentEvent.id] = true;
  st.committed = false;
  const entry = { turn: st.turn + 1, event: currentEvent.id, title: currentEvent.title, probe: null, choice: null };
  // 可用试探（谨慎策略会用）
  const probe = (currentEvent.choices || []).find((c) => c.probe && !st.probeUsed.has(currentEvent.id + "/" + c.id) && checkChoice(c));
  function checkChoice(c) { return R.checkRequires(c.requires || {}, st); }
  if (policy === "cautious" && probe && rng() < 0.6) {
    const { ok, outcome } = R.settleChoice(st, currentEvent, probe.id, events);
    if (ok) { entry.probe = probe.text.slice(0, 18); if (outcome.ended) break; }
  }
  const commits = (currentEvent.choices || [])
    .filter((c) => !c.probe && !st.committed && checkChoice(c));
  if (!commits.length) break;
  const scored = commits.map((c) => ({ c, s: scoreChoice(c) + rng() * 2 })).sort((a, b) => b.s - a.s);
  const pick = scored[0].c;
  entry.choice = pick.text.slice(0, 24);
  const { outcome } = R.settleChoice(st, currentEvent, pick.id, events);
  entry.deltas = Object.entries(outcome.deltas || {}).map(([k, v]) => `${k}${v > 0 ? "+" : ""}${v}`).join(",");
  if (outcome.card) entry.card = outcome.card;
  if (outcome.ended) { trace.push(entry); break; }
  trace.push(entry);
}

const ending = R.resolveEnding(st, endings);
const tone = R.endingTone(ending);
const result = {
  scenario: scenarioId, policy, seed,
  turns: st.turn,
  stats: st.stats,
  ending: { id: ending.id, title: ending.title, tone },
  cards_unlocked: Object.keys(st.unlocked),
  flags: Object.keys(st.flags),
  trace,
};
console.log(JSON.stringify(result, null, 1));
writeFileSync(`/tmp/al-sim-${scenarioId}-${policy}.json`, JSON.stringify(result, null, 1));
