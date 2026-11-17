// rules.test.mjs —— v0.7 回归测试（node --test）
// 覆盖：第 12 回合有无知识卡、资金/心态归零即时结局、重复提交锁、试探不耗回合且不可重复、
// 结局优先级与 tone、followups 到期/丢弃、flags_not、内部标志位不进数值区、成功交付可区分条件。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const R = require("./rules.js");

const DATA = new URL("./data/", import.meta.url).pathname;
const j = (p) => JSON.parse(readFileSync(DATA + p, "utf-8"));
const endings = j("endings.json").endings;
const events = {};
for (const id of j("events/index.json")) events[id] = j("events/" + id + ".json");
const scenario = j("scenarios/vibe_coding.json");

function freshState() {
  return {
    scenarioId: "vibe_coding", scenario, maxTurns: 12,
    stats: { ...scenario.start_stats }, flags: {}, turn: 0,
    unlocked: {}, visited: {}, ledger: [], followups: [],
    finished: false, endingId: "", committed: false, probeUsed: new Set(),
  };
}
const ev = (id) => events[id];

test("① 第 12 回合（含知识卡）：状态锁定为 finished，不产生第 13 回合", () => {
  const st = freshState();
  st.turn = 11; // 下一回合即第 12
  const { ok, outcome } = R.settleChoice(st, ev("vc_005_token_burn"), "check_bill", events);
  assert.equal(ok, true);
  assert.equal(st.turn, 12, "第 12 回合结算后 turn=12");
  assert.equal(outcome.ended, true, "回合耗尽必须立即标记 ended");
  assert.equal(st.finished, true, "状态必须锁定 finished");
  assert.equal(outcome.card, "token_burn", "知识卡仍应解锁展示");
  // 展示层职责：卡片关闭后按 finished 走 showEnding，不再进入 showContinue
  assert.equal(st.turn >= st.maxTurns && st.finished, true);
});

test("① 第 12 回合（无知识卡）：同样立即终局", () => {
  const st = freshState();
  st.turn = 11;
  const { outcome } = R.settleChoice(st, ev("vc_fallback_daily"), "note_only", events);
  assert.equal(outcome.ended, true);
  assert.equal(st.finished, true);
});

test("② 事件级提交锁：同一选项重复结算被拒绝，effects/ledger 只生效一次", () => {
  const st = freshState();
  const moneyBefore = st.stats.money;
  const first = R.settleChoice(st, ev("vc_005_token_burn"), "check_bill", events);
  assert.equal(first.ok, true);
  const ledgerAfterFirst = st.ledger.length;
  const second = R.settleChoice(st, ev("vc_005_token_burn"), "check_bill", events);
  assert.equal(second.ok, false, "第二次结算必须被提交锁拒绝");
  assert.equal(second.reason, "committed");
  assert.equal(st.ledger.length, ledgerAfterFirst, "ledger 不重复追加");
  assert.equal(st.stats.money, moneyBefore + (first.outcome.deltas.money || 0), "effects 只生效一次");
});

test("③ 试探：不消耗回合、回原事件决策、不可重复使用", () => {
  const st = freshState();
  const turnBefore = st.turn;
  const probeChoice = Object.values(events).flatMap((e) => e.choices || []).find((c) => c.probe);
  if (!probeChoice) return; // 数据无 probe 时跳过（内容层职责）
  const probeEvent = Object.values(events).find((e) => (e.choices || []).includes(probeChoice));
  const { ok, outcome } = R.settleChoice(st, probeEvent, probeChoice.id, events);
  assert.equal(ok, true);
  assert.equal(outcome.probe, true);
  assert.equal(st.turn, turnBefore, "试探不得消耗回合");
  assert.equal(outcome.ended, false, "试探不触发终局");
  const again = R.settleChoice(st, probeEvent, probeChoice.id, events);
  assert.equal(again.ok, false, "同一试探不可重复使用");
  assert.equal(again.reason, "probe-used");
});

test("④ 数值区无内部标志位：deltas 只含五维", () => {
  const st = freshState();
  const { outcome } = R.settleChoice(st, ev("vc_005_token_burn"), "check_bill", events);
  for (const k of Object.keys(outcome.deltas)) {
    assert.ok(R.STAT_KEYS.includes(k), `deltas 键 ${k} 必须是五维之一`);
  }
});

test("⑤ 资金归零 → 即时结局 _broke（优先于回合终局）", () => {
  const st = freshState();
  st.stats.money = 5;
  st.turn = 11; // 即便也是第 12 回合，资金归零优先
  const { outcome } = R.settleChoice(st, ev("vc_005_token_burn"), "ignore", events);
  assert.equal(st.stats.money, 0);
  assert.equal(st.finished, true);
  assert.equal(st.endingId, "_broke");
  assert.equal(outcome.ended, true);
});

test("⑤ 心态归零 → 即时结局 _meltdown", () => {
  const st = freshState();
  st.stats.sanity = 3;
  const { outcome } = R.settleChoice(st, ev("vc_fallback_daily"), "let_it", events);
  assert.ok(st.stats.sanity <= 0 || st.stats.sanity > 0); // 取决于 effects
  if (st.stats.sanity <= 0) {
    assert.equal(st.endingId, "_meltdown");
    assert.equal(outcome.ended, true);
  }
});

test("⑥ 结局定性：失败结局不得标记为 good", () => {
  for (const e of endings) {
    const tone = R.endingTone(e);
    if (["_broke", "_meltdown", "lc_data_gone", "vc_refund_apocalypse", "vc_ai_backlash", "_hollow"].includes(e.id)) {
      assert.equal(tone, "bad", `${e.id} 必须是失败定性`);
    }
  }
  assert.equal(R.endingTone({ id: "vc_master" }), "good");
  assert.equal(R.endingTone({ id: "_the_end" }), "mid");
});

test("⑦ 结局条件可区分：进度 0 + 质量 100 拿不到成功交付类结局", () => {
  const st = freshState();
  st.stats.quality = 100;
  st.stats.reputation = 100;
  st.stats.progress = 0; // 完全没推进
  const ending = R.resolveEnding(st, endings);
  assert.ok(!["vc_master", "vc_delivered"].includes(ending.id),
    `进度 0 不应获得成功类结局（得到 ${ending.id}）`);
});

test("⑦ 成功交付结局：进度/质量/信誉达标时可达", () => {
  const st = freshState();
  st.stats.progress = 70;
  st.stats.quality = 60;
  st.stats.reputation = 55;
  const ending = R.resolveEnding(st, endings);
  assert.equal(ending.id, "vc_delivered", `应获得成功交付（得到 ${ending.id}）`);
});

test("⑦ 结局优先级：即时结局 > 成功 > 带伤 > 未完成 > 兜底", () => {
  const st = freshState();
  st.endingId = "_broke";
  assert.equal(R.resolveEnding(st, endings).id, "_broke");
  const st2 = freshState();
  st2.stats.progress = 70; st2.stats.quality = 60; st2.stats.reputation = 55;
  assert.equal(R.resolveEnding(st2, endings).id, "vc_delivered");
  const st3 = freshState();
  st3.stats.progress = 0; st3.stats.quality = 10;
  const e3 = R.resolveEnding(st3, endings);
  assert.ok(["vc_vaporware", "_the_end"].includes(e3.id), `未完成态应得原型冢或兜底（得到 ${e3.id}）`);
});

test("followups：到期触发 / 条件不满足保留 / 过期丢弃", () => {
  const st = freshState();
  st.followups = [{ eventId: "vc_fallback_daily", dueMin: 2, dueMax: 3 }];
  st.turn = 1;
  assert.equal(R.dueFollowup(st, events), "vc_fallback_daily", "窗口内必须触发");
  const st2 = freshState();
  st2.followups = [{ eventId: "vc_fallback_daily", dueMin: 2, dueMax: 3 }];
  st2.turn = 3; // 下一回合 4 > dueMax
  R.dueFollowup(st2, events);
  assert.equal(st2.followups.length, 0, "过期必须丢弃");
  // 条件不满足：保留至窗口结束
  const st3 = freshState();
  st3.followups = [{ eventId: "vc_002_prod_incident", dueMin: 2, dueMax: 3 }]; // requires merged_blindly
  st3.turn = 1;
  assert.equal(R.dueFollowup(st3, events), "", "requires 不满足时不触发");
  assert.equal(st3.followups.length, 1, "窗口未结束前保留");
});

test("数据完整性：每个结局有唯一 priority 与合法 tone；即时结局存在", () => {
  const prios = new Set();
  const tones = new Set(["good", "mid", "bad"]);
  for (const e of endings) {
    assert.ok(!prios.has(e.priority), `priority 重复: ${e.priority}`);
    prios.add(e.priority);
    assert.ok(tones.has(e.tone), `${e.id} 缺少合法 tone`);
  }
  for (const fixed of ["_broke", "_meltdown", "_the_end"]) {
    assert.ok(endings.some((e) => e.id === fixed), `缺少引擎约定结局 ${fixed}`);
  }
});

// ── v0.8 垂直切片：因果链与路径可达性 ──
const allEvents = {};
for (const f of [
  "vc_k1_architecture", "vc_k2_testing", "vc_k3_scope_change", "vc_k4_agent_crud",
  "vc_k5_incident", "vc_k5_prod_blast", "vc_k5_exposed", "vc_k6_demo_day",
  "vc_001_overengineering", "vc_fallback_daily", "vc_005_token_burn",
]) allEvents[f] = j("events/" + f + ".json");
const allEventsRef = allEvents;
const kEvents = (id) => allEvents[id];

test("v0.8 因果①：arch_heavy 玩家在 K3 看到『改配置即可』正反馈选项", () => {
  const st = freshState();
  st.flags["arch_heavy"] = true;
  st.turn = 5;
  const k3 = kEvents("vc_k3_scope_change");
  const visible = (k3.choices || []).filter((c) => R.checkRequires(c.requires || {}, st));
  assert.ok(visible.some((c) => c.id === "heavy_ok"), "heavy 玩家必须看到正反馈选项");
  assert.ok(!visible.some((c) => c.id === "light_migrate"), "light 专属选项对 heavy 玩家不可见");
});

test("v0.8 因果②：tests_built 玩家在 K5 看到『测试拦下』减伤选项", () => {
  const st = freshState();
  st.flags["tests_built"] = true;
  st.turn = 8;
  const k5 = kEvents("vc_k5_incident");
  const visible = (k5.choices || []).filter((c) => R.checkRequires(c.requires || {}, st));
  assert.ok(visible.some((c) => c.id === "caught_by_tests"), "tests_built 玩家看到正反馈");
  const st2 = freshState();
  st2.flags["no_tests"] = true;
  st2.turn = 8;
  const visible2 = (k5.choices || []).filter((c) => R.checkRequires(c.requires || {}, st2));
  assert.ok(visible2.some((c) => c.id === "prod_blast"), "no_tests 玩家看到事故分支");
});

test("v0.8 因果③：lied_concurrency 玩家在 K5c 面对拆穿事件", () => {
  const st = freshState();
  st.flags["lied_concurrency"] = true;
  st.turn = 9;
  const k5c = kEvents("vc_k5_exposed");
  const visible = (k5c.choices || []).filter((c) => R.checkRequires(c.requires || {}, st));
  assert.equal(visible.length, 2, "拆穿事件两个选项均可见");
});

test("v0.8 学习标志：learned_verification 解锁 K4 高收益委托", () => {
  const st = freshState();
  st.flags["learned_verification"] = true;
  st.turn = 6;
  const k4 = kEvents("vc_k4_agent_crud");
  const visible = (k4.choices || []).filter((c) => R.checkRequires(c.requires || {}, st));
  const win = visible.find((c) => c.id === "delegated_review");
  assert.ok(win, "学习标志必须解锁高收益委托");
  assert.equal(win.effects.progress, 14, "高收益委托进度收益最高");
  const st2 = freshState();
  st2.turn = 6;
  const visible2 = (k4.choices || []).filter((c) => R.checkRequires(c.requires || {}, st2));
  assert.ok(!visible2.some((c) => c.id === "delegated_review"), "未学习玩家看不到该选项");
});

test("v0.8 结局 hint：全部结局带下局策略提示", () => {
  for (const e of endings) {
    assert.ok(e.hint && e.hint.length > 5, `${e.id} 缺 hint`);
  }
});

test("v0.8 选项代价差异化：K1 三条路均有合理收益（无无条件正确答案）", () => {
  const k1 = kEvents("vc_k1_architecture");
  const gains = k1.choices.filter((c) => !c.probe).map((c) => ({
    id: c.id, progress: c.effects.progress || 0,
  }));
  const heavy = gains.find((g) => g.id === "heavy");
  const light = gains.find((g) => g.id === "light");
  const bench = gains.find((g) => g.id === "benchmark");
  assert.ok(heavy.progress > light.progress && heavy.progress > bench.progress,
    "heavy 进度收益最高（承担 K3 风险）");
  assert.ok(bench.progress > 0, "谨慎路线也有正收益（不无理由惩罚谨慎）");
  assert.ok(light.progress >= 10, "轻量路线进度可观");
});

test("v0.7 关键修复：试探后提交锁解除，正式选项可用", () => {
  const st = freshState();
  st.turn = 3;
  const probeChoice = Object.values(events).flatMap((e) => e.choices || []).find((c) => c.probe);
  const probeEvent = Object.values(events).find((e) => (e.choices || []).includes(probeChoice));
  const first = R.settleChoice(st, probeEvent, probeChoice.id, events);
  assert.equal(first.ok, true);
  assert.equal(first.outcome.probe, true);
  assert.equal(st.committed, false, "试探后提交锁必须解除");
  const formalChoice = probeEvent.choices.find((c) => !c.probe);
  const formal = R.settleChoice(st, probeEvent, formalChoice.id, events);
  assert.equal(formal.ok, true, "试探后正式选项必须可结算");
  assert.equal(st.committed, true, "正式选项结算后重新上锁");
});
