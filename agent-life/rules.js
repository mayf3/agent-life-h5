// rules.js —— 《Agent 人生》H5 规则层（spec：docs/engine-spec.md v1.2 子集）
// 纯逻辑、零 DOM 依赖：浏览器（engine.js 引入）与 Node 测试（rules.test.mjs）共用同一实现。
// 语义权威是 docs/engine-spec.md；本文件与 Godot 版 scripts/engine/*.gd 保持一致。
"use strict";

const clamp = (v) => Math.max(0, Math.min(100, v));

const STAT_NAMES = { money: "资金", progress: "进度", quality: "质量", sanity: "心态", reputation: "信誉" };
const STAT_KEYS = Object.keys(STAT_NAMES);

/** requires 语义（spec v1.2）：turn 闭区间（1 基）、stats 闭区间、flags_all/any/not。 */
function checkRequires(req, st) {
  req = req || {};
  const t = st.turn + 1;
  if (req.turn_min !== undefined && t < req.turn_min) return false;
  if (req.turn_max !== undefined && t > req.turn_max) return false;
  for (const [k, v] of Object.entries(req.stats_min || {})) if ((st.stats[k] || 0) < v) return false;
  for (const [k, v] of Object.entries(req.stats_max || {})) if ((st.stats[k] || 0) > v) return false;
  for (const f of req.flags_all || []) if (!st.flags[f]) return false;
  for (const f of req.flags_not || []) if (st.flags[f]) return false;
  if (req.flags_any && req.flags_any.length) {
    if (!req.flags_any.some((f) => st.flags[f])) return false;
  }
  return true;
}

/** weight：正整数或 {base, modifiers:[{if, mul}]}（mul 按声明顺序连乘，四舍五入 ≥1）。 */
function effectiveWeight(ev, st) {
  const w = ev.weight;
  if (typeof w === "number") return Math.max(1, Math.round(w));
  let eff = w.base || 1;
  for (const m of w.modifiers || []) if (checkRequires(m.if, st)) eff *= m.mul;
  return Math.max(1, Math.round(eff));
}

/** 事件抽取：forced（goto/followup 链）> 池过滤加权 > fallback。 */
function pickEvent(st, scenario, events, forcedId, rand) {
  const rnd = rand || Math.random;
  if (forcedId) {
    const ev = events[forcedId];
    return ev && checkRequires(ev.requires, st) ? ev : null;
  }
  const cands = (scenario.event_pool || [])
    .map((id) => events[id])
    .filter((ev) => ev && (ev.repeatable || !st.visited[ev.id]) && checkRequires(ev.requires, st));
  if (!cands.length) {
    const fb = events[scenario.fallback_event];
    return fb && (fb.repeatable || !st.visited[fb.id]) ? fb : null;
  }
  const total = cands.reduce((s, e) => s + effectiveWeight(e, st), 0);
  let roll = Math.floor(rnd() * total) + 1;
  for (const ev of cands) {
    roll -= effectiveWeight(ev, st);
    if (roll <= 0) return ev;
  }
  return cands[cands.length - 1];
}

/** 延迟回响：到期窗口覆盖下一回合且 requires 满足者触发；过期丢弃。返回事件 id。 */
function dueFollowup(st, events) {
  const nextT = st.turn + 1;
  const kept = [];
  let picked = "";
  for (const f of st.followups) {
    if (f.dueMax < nextT) continue;
    const ev = events[f.eventId];
    if (!picked && f.dueMin <= nextT && ev && checkRequires(ev.requires, st)) { picked = f.eventId; continue; }
    kept.push(f);
  }
  st.followups = kept;
  return picked;
}

/** effects：数值截断 0..100 + 旗标增删。 */
function applyEffects(effects, st) {
  effects = effects || {};
  for (const k of STAT_KEYS) if (effects[k] !== undefined) st.stats[k] = clamp(st.stats[k] + effects[k]);
  for (const f of effects.flags_set || []) st.flags[f] = true;
  for (const f of effects.flags_clear || []) delete st.flags[f];
}

/** 即时结局：资金/心态归零。 */
function immediateEndId(st) {
  if ((st.stats.money || 0) <= 0) return "_broke";
  if ((st.stats.sanity || 0) <= 0) return "_meltdown";
  return "";
}

/** 终局判定（v0.7）：即时结局 > priority 降序 × 场景匹配 × requires；兜底 _the_end。 */
function resolveEnding(st, endings) {
  if (st.endingId) {
    const fixed = endings.find((e) => e.id === st.endingId);
    if (fixed) return fixed;
  }
  const sorted = [...endings].sort((a, b) => (b.priority || 0) - (a.priority || 0));
  for (const e of sorted) {
    if (e.scenario !== "any" && e.scenario !== st.scenarioId) continue;
    if (checkRequires(e.requires, st)) return e;
  }
  return endings.find((e) => e.id === "_the_end");
}

/** 结局定性（v0.7）：失败 / 平凡 / 成功——驱动看板娘表情与台词，禁止失败时庆祝。 */
const ENDING_TONES = {
  _broke: "bad", _meltdown: "bad",
  lc_data_gone: "bad", vc_refund_apocalypse: "bad", vc_ai_backlash: "bad", _hollow: "bad",
  vc_master: "good", vc_delivered: "good", lc_legend: "good", lc_the_rewriter: "good",
  vc_shipped_mess: "mid", vc_vaporware: "mid", lc_treading_water: "mid", _the_end: "mid",
};
function endingTone(ending) {
  return ENDING_TONES[ending.id] || "mid";
}

/** 结算一个选择（v0.7 核心闭环，含提交锁与试探语义）。
 * 返回 {ok, outcome}；ok=false 表示被锁拒绝或选项非法，状态零变更。 */
function settleChoice(st, currentEvent, choiceId, events, opts) {
  const opts_ = opts || {};
  if (st.committed) return { ok: false, reason: "committed" };
  const choice = (currentEvent.choices || []).find((c) => c.id === choiceId);
  if (!choice) return { ok: false, reason: "invalid" };
  const probeKey = currentEvent.id + "/" + choiceId;
  if (choice.probe && st.probeUsed.has(probeKey)) return { ok: false, reason: "probe-used" };

  st.committed = true;
  applyEffects(choice.effects, st);
  if (choice.card) st.unlocked[choice.card] = true;
  const t0 = st.turn + 1;
  st.ledger.push({ turn: t0, title: currentEvent.title, choice: choice.text, probe: !!choice.probe });
  for (const f of choice.followups || []) {
    st.followups.push({
      eventId: f.event,
      dueMin: t0 + f.after_turns[0],
      dueMax: t0 + Math.max(f.after_turns[1], f.after_turns[0]),
    });
  }
  pendingGotoGlobal = choice.goto || "";

  const outcome = {
    probe: !!choice.probe,
    result: choice.result || null,
    card: choice.card || "",
    deltas: {},
    ended: false,
  };
  for (const k of STAT_KEYS) if (choice.effects && choice.effects[k] !== undefined) outcome.deltas[k] = choice.effects[k];

  if (choice.probe) {
    // 试探（P11）：耗资源换信息，不消耗回合、不触发终局；本事件内不可重复。
    // v0.7 关键修复：probe 不留提交锁——否则同事件的正式选项会被锁死（玩家实测“试探后直接结束事件”的根因）。
    st.probeUsed.add(probeKey);
    st.committed = false;
    const imm = immediateEndId(st);
    if (imm) { st.finished = true; st.endingId = imm; outcome.ended = true; }
    return { ok: true, outcome };
  }

  st.turn += 1;
  const imm = immediateEndId(st);
  if (imm) {
    st.finished = true;
    st.endingId = imm;
    outcome.ended = true;
    return { ok: true, outcome };
  }
  if (st.turn >= st.maxTurns) {
    // v0.7 修复：回合耗尽即终局（与知识卡展示解耦——卡片仍会展示，但状态已锁定）
    st.finished = true;
    outcome.ended = true;
  }
  return { ok: true, outcome };
}

let pendingGotoGlobal = "";
function takePendingGoto() { const g = pendingGotoGlobal; pendingGotoGlobal = ""; return g; }

// UMD：浏览器挂全局，Node 走 module.exports
const Rules = {
  clamp, STAT_NAMES, STAT_KEYS,
  checkRequires, effectiveWeight, pickEvent, dueFollowup, applyEffects,
  immediateEndId, resolveEnding, endingTone, ENDING_TONES,
  settleChoice, takePendingGoto,
};
if (typeof module !== "undefined" && module.exports) module.exports = Rules;
if (typeof window !== "undefined") window.Rules = Rules;
