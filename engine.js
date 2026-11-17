// H5 精简引擎 v3——语义对齐 docs/engine-spec.md v1.2 子集，呈现层带打字机/逐条出现/头像/编号选项。
// 内容与 Godot 版共用 data/*.json。
"use strict";

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v) => Math.max(0, Math.min(100, v));

const STAT_NAMES = { money: "资金", progress: "进度", quality: "质量", sanity: "心态", reputation: "信誉" };
const MOOD_FACES = { normal: "🙂", happy: "😄", smug: "😏", worry: "😟", panic: "😱", cheer: "🥳" };
const WHO_BADGE = { user: { face: "🧑‍💻", cls: "user" }, agent: { face: "🤖", cls: "agent" }, system: { face: "📣", cls: "system" } };

let DB = null;
let state = null;
let currentEvent = null;
let pendingGoto = "";
let probeUsed = new Set();
let skipType = false; // 点击聊天区跳过打字/逐条动画
let lastStats = null;
let rngState = 0;

// 跨局收集持久化（localStorage）——H5 版的 user://collection.json 等价物
const COLL_KEY = "agent-life-cards";
function collLoad() {
  try { return JSON.parse(localStorage.getItem(COLL_KEY) || "{}"); } catch { return {}; }
}
function collSave(obj) {
  try { localStorage.setItem(COLL_KEY, JSON.stringify(obj)); } catch { /* 隐私模式等场景忽略 */ }
}
function collUnlock(cardId) {
  const c = collLoad();
  if (!c[cardId]) { c[cardId] = true; collSave(c); }
}
function collUnlockMany(ids) {
  const c = collLoad();
  let changed = false;
  for (const id of ids) if (!c[id]) { c[id] = true; changed = true; }
  if (changed) collSave(c);
}

function rng() {
  rngState |= 0; rngState = (rngState + 0x6D2B79F5) | 0;
  let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

async function loadDB() {
  const j = async (p) => (await fetch(p)).json();
  const dir = async (base) => {
    const list = await j(`data/${base}/index.json`);
    const out = {};
    for (const f of list) {
      const obj = await j(`data/${base}/${f}.json`);
      out[obj.id] = obj;
    }
    return out;
  };
  const [scenarios, events, cards, endings, mascot] = await Promise.all([
    dir("scenarios"), dir("events"), dir("cards"),
    j("data/endings.json"), j("data/mascot.json"),
  ]);
  return { scenarios, events, cards, endings: endings.endings, mascot };
}

function checkRequires(req, st) {
  req = req || {};
  const t = st.turn + 1;
  if (req.turn_min !== undefined && t < req.turn_min) return false;
  if (req.turn_max !== undefined && t > req.turn_max) return false;
  for (const [k, v] of Object.entries(req.stats_min || {})) if (st.stats[k] < v) return false;
  for (const [k, v] of Object.entries(req.stats_max || {})) if (st.stats[k] > v) return false;
  for (const f of req.flags_all || []) if (!st.flags[f]) return false;
  for (const f of req.flags_not || []) if (st.flags[f]) return false;
  if (req.flags_any && req.flags_any.length) {
    if (!req.flags_any.some((f) => st.flags[f])) return false;
  }
  return true;
}

function effectiveWeight(ev, st) {
  const w = ev.weight;
  if (typeof w === "number") return Math.max(1, Math.round(w));
  let eff = w.base || 1;
  for (const m of w.modifiers || []) if (checkRequires(m.if, st)) eff *= m.mul;
  return Math.max(1, Math.round(eff));
}

function pickEvent(st, scenario, forcedId) {
  if (forcedId) {
    const ev = DB.events[forcedId];
    return ev && checkRequires(ev.requires, st) ? ev : null;
  }
  const cands = scenario.event_pool
    .map((id) => DB.events[id])
    .filter((ev) => ev && (ev.repeatable || !st.visited[ev.id]) && checkRequires(ev.requires, st));
  if (!cands.length) {
    const fb = DB.events[scenario.fallback_event];
    return fb && (fb.repeatable || !st.visited[fb.id]) ? fb : null;
  }
  const total = cands.reduce((s, e) => s + effectiveWeight(e, st), 0);
  let roll = Math.floor(rng() * total) + 1;
  for (const ev of cands) {
    roll -= effectiveWeight(ev, st);
    if (roll <= 0) return ev;
  }
  return cands[cands.length - 1];
}

function dueFollowup(st) {
  const nextT = st.turn + 1;
  const kept = [];
  let picked = "";
  for (const f of st.followups) {
    if (f.dueMax < nextT) continue;
    const ev = DB.events[f.eventId];
    if (!picked && f.dueMin <= nextT && ev && checkRequires(ev.requires, st)) { picked = f.eventId; continue; }
    kept.push(f);
  }
  st.followups = kept;
  return picked;
}

function applyEffects(effects, st) {
  effects = effects || {};
  for (const k of Object.keys(STAT_NAMES)) if (effects[k] !== undefined) st.stats[k] = clamp(st.stats[k] + effects[k]);
  for (const f of effects.flags_set || []) st.flags[f] = true;
  for (const f of effects.flags_clear || []) delete st.flags[f];
}

function resolveEnding(st) {
  if (st.endingId) {
    const fixed = DB.endings.find((e) => e.id === st.endingId);
    if (fixed) return fixed;
  }
  const sorted = [...DB.endings].sort((a, b) => (b.priority || 0) - (a.priority || 0));
  for (const e of sorted) {
    if (e.scenario !== "any" && e.scenario !== st.scenarioId) continue;
    if (checkRequires(e.requires, st)) return e;
  }
  return DB.endings.find((e) => e.id === "_the_end");
}

// ---- 呈现 ----

function scrollBottom() {
  window.scrollTo({ top: document.body.scrollHeight, behavior: skipType ? "auto" : "smooth" });
}

function buildMsg(who, text) {
  const meta = WHO_BADGE[who] || WHO_BADGE.system;
  const row = el("div", "msg " + meta.cls);
  row.append(el("div", "badge " + meta.cls, meta.face));
  const bubble = el("div", "bubble");
  const span = el("span", "msg-text");
  const cursor = el("span", "cursor", "▌");
  bubble.append(span, cursor);
  row.append(bubble);
  $("#chat").append(row);
  return { row, span, cursor, text };
}

async function typeText(node, text) {
  for (let i = 0; i < text.length; i++) {
    if (skipType) { node.textContent = text; break; }
    node.textContent += text[i];
    if (i % 2 === 0) await sleep(20);
    scrollBottom();
  }
}

// 逐条出现：每条消息淡入 + 打字机；skipType 时瞬时全出
async function playMessages(msgs) {
  const chat = $("#chat");
  for (let i = 0; i < msgs.length; i++) {
    const { who, text } = msgs[i];
    if (skipType) {
      chat.append(buildMsgStatic(who, text));
      continue;
    }
    const node = buildMsg(who, text);
    chat.append(node.row);
    scrollBottom();
    await sleep(240);
    await typeText(node.span, text);
    node.cursor.remove();
    await sleep(160);
  }
  scrollBottom();
}

function buildMsgStatic(who, text) {
  const meta = WHO_BADGE[who] || WHO_BADGE.system;
  const row = el("div", "msg " + meta.cls);
  row.append(el("div", "badge " + meta.cls, meta.face));
  row.append(el("div", "bubble", text));
  return row;
}

function renderTop(st, changed) {
  const cur = st.finished ? st.maxTurns : st.turn + 1;
  $("#turn").textContent = `第 ${cur}/${st.maxTurns} 回合`;
  const bar = $("#stats");
  bar.innerHTML = "";
  for (const k of Object.keys(STAT_NAMES)) {
    const v = st.stats[k];
    const pill = el("div", "pill" + (v < 30 ? " bad" : v >= 60 ? " good" : "") + (changed && changed.has(k) ? " flash" : ""));
    pill.append(`${STAT_NAMES[k]} `);
    pill.append(el("b", "", String(v)));
    bar.append(pill);
  }
}

function renderEvent() {
  const st = state;
  skipType = false;
  $("#chat").innerHTML = "";
  const ev = currentEvent;
  const head = el("div", "title-row");
  head.append(el("span", "bar"));
  head.append(el("h1", "", `${ev.icon || ""} ${ev.title || ""}`));
  $("#chat").append(head);
  const msgs = [];
  if (st.turn === 0 && st.scenario.intro) msgs.push({ who: "system", text: st.scenario.intro });
  for (const m of ev.chat || []) msgs.push({ who: m.who, text: m.text });
  playMessages(msgs).then(() => {
    if (!state || state !== st) return;
    renderChoices();
    renderTop(st);
  });
}

function renderChoices() {
  const st = state;
  const box = $("#choices");
  box.innerHTML = "";
  let n = 0;
  for (const c of currentEvent.choices || []) {
    const isProbe = !!c.probe;
    if (isProbe && probeUsed.has(currentEvent.id + "/" + c.id)) continue;
    if (!checkRequires(c.requires, st)) continue;
    n += 1;
    const btn = el("button", "choice" + (isProbe ? " probe" : ""));
    btn.append(el("span", "bar"));
    const num = el("span", "num", String(n));
    btn.append(num);
    if (isProbe) btn.append(el("span", "tagchip", "试探"));
    btn.append(el("span", "ctext", c.text));
    btn.onclick = () => onChoice(c.id);
    box.append(btn);
  }
}

function showDeltas(deltas) {
  const parts = [];
  for (const [k, v] of Object.entries(deltas || {})) {
    if (!v) continue;
    parts.push(`<span class="${v > 0 ? "up" : "down"}">${STAT_NAMES[k]} ${v > 0 ? "+" : ""}${v}</span>`);
  }
  if (parts.length) $("#chat").append(el("div", "deltas", "◆ " + parts.join(" ｜ ")));
}

function mascotReact(slot) {
  const pool = DB.mascot.slots[slot] || [];
  if (!pool.length) return;
  const e = pool[Math.floor(rng() * pool.length)];
  $("#m-line").textContent = e.text;
  const face = $("#m-face");
  face.textContent = MOOD_FACES[e.mood] || "🙂";
  face.classList.remove("pop");
  void face.offsetWidth;
  face.classList.add("pop");
  setTimeout(() => face.classList.remove("pop"), 300);
}
function mascotReactStats(st) {
  let danger = 0, worst = 100, allGood = true;
  for (const k of Object.keys(STAT_NAMES)) {
    const v = st.stats[k];
    worst = Math.min(worst, v);
    if (v < 30) danger++;
    if (v < 60) allGood = false;
  }
  if (worst <= 15 || danger >= 2) mascotReact("crisis");
  else if (danger === 1) mascotReact("danger");
  else if (allGood) mascotReact("good");
}

function onChoice(choiceId) {
  skipType = true; // 选择后结果即时显示（动画已在消息阶段给足节奏）
  const st = state;
  const choice = (currentEvent.choices || []).find((c) => c.id === choiceId);
  if (!choice) return;
  applyEffects(choice.effects, st);
  if (choice.card) { st.unlocked[choice.card] = true; collUnlock(choice.card); }
  const t0 = st.turn + 1;
  st.ledger.push({ turn: t0, title: currentEvent.title, choice: choice.text });
  for (const f of choice.followups || []) {
    st.followups.push({
      eventId: f.event, dueMin: t0 + f.after_turns[0], dueMax: t0 + Math.max(f.after_turns[1], f.after_turns[0]),
    });
  }
  pendingGoto = choice.goto || "";
  const changed = new Set(Object.keys(choice.effects || {}).filter((k) => STAT_NAMES[k]));
  const res = choice.result;
  if (res) addMsg(res.who, res.text);
  showDeltas(choice.effects);
  renderTop(st, changed);
  mascotReactStats(st);
  const broke = st.stats.money <= 0, meltdown = st.stats.sanity <= 0;
  st.turn += 1;
  if (broke || meltdown) {
    st.finished = true;
    st.endingId = broke ? "_broke" : "_meltdown";
    setTimeout(showEnding, 500);
    return;
  }
  if (choice.card) showCard(choice.card);
  else if (st.turn >= st.maxTurns) { st.finished = true; setTimeout(showEnding, 500); }
  else showContinue();
}

function addMsg(who, text) {
  $("#chat").append(buildMsgStatic(who, text));
  scrollBottom();
}

function showContinue() {
  const box = $("#choices");
  box.innerHTML = "";
  const btn = el("button", "continue-btn", "继续 →");
  btn.onclick = nextTurn;
  box.append(btn);
}

function nextTurn() {
  const st = state;
  skipType = false;
  let forced = pendingGoto;
  pendingGoto = "";
  if (!forced) forced = dueFollowup(st);
  currentEvent = pickEvent(st, st.scenario, forced);
  if (!currentEvent) { st.finished = true; showEnding(); return; }
  st.visited[currentEvent.id] = true;
  probeUsed.clear();
  renderEvent();
}

function showCard(cardId) {
  const card = DB.cards[cardId];
  const ov = el("div", "overlay");
  const p = el("div", "panel");
  p.append(el("div", "tag", "坑点卡"));
  p.append(el("h2", "", `${card.icon || ""} ${card.name}（威胁等级：${card.severity}）`));
  p.append(el("p", "", "是什么：" + card.essence));
  p.append(el("p", "", "为什么会发生：" + card.why));
  p.append(el("p", "", "怎么防：" + card.defenses.map((d) => "· " + d).join("<br>")));
  const row = el("div", "btn-row");
  const btn = el("button", "primary", "收下，继续 →");
  btn.onclick = () => { ov.remove(); state.finished ? showEnding() : showContinue(); };
  row.append(btn);
  p.append(row);
  ov.append(p);
  document.body.append(ov);
}

function showEnding() {
  const st = state;
  skipType = true;
  mascotReact(st.endingId === "_the_end" || st.endingId === "" ? "ending_mid" : "ending_good");
  const ending = resolveEnding(st);
  const ov = el("div", "overlay");
  const p = el("div", "panel");
  p.append(el("div", "tag", "ENDING // 结局归档"));
  p.append(el("h2", "", ending.title || ""));
  p.append(el("p", "", ending.desc || ""));
  const stats = el("div", "stats");
  const cell = (l, v) => { const d = el("div"); d.append(el("i", "", l)); d.append(el("b", "", String(v))); return d; };
  stats.append(cell("回合", st.turn));
  for (const k of Object.keys(STAT_NAMES)) stats.append(cell(STAT_NAMES[k], st.stats[k]));
  p.append(stats);
  const coll = collLoad();
  const totalUnlocked = Object.keys(DB.cards).filter((cid) => st.unlocked[cid] || coll[cid]).length;
  p.append(el("p", "", `坑点图鉴 ${totalUnlocked}/${Object.keys(DB.cards).length}（跨局累计）`));
  const ledger = el("div", "ledger");
  const ledgerText = st.ledger.slice(-5).map((e) => `第${e.turn}回合｜${e.title} → ${e.choice}`).join("<br>");
  if (ledgerText) ledger.innerHTML = "本局关键抉择：<br>" + ledgerText;
  p.append(ledger);
  const row = el("div", "btn-row");
  const again = el("button", "primary", "再来一局");
  again.onclick = () => location.reload();
  const menu = el("button", "plain", "退出");
  menu.onclick = () => { ov.remove(); showMenu(); };
  row.append(again, menu);
  p.append(row);
  ov.append(p);
  document.body.append(ov);
}

function showMenu() {
  const app = $("#app");
  app.innerHTML = "";
  $("#mascot").classList.add("hidden");
  const menu = el("div", "menu");
  for (const d of ["💻", "🤖", "💸", "⚠️", "🧠"]) {
    const deco = el("div", "deco", d);
    menu.append(deco);
  }
  const title = el("h1", "", `<span class="en">Agent</span> <span class="cn">人生</span>`);
  const subtitle = el("div", "subtitle", "AI Agent 被坑体验模拟器");
  menu.append(title, subtitle, el("div", "divider"));
  const box = el("div", "choices");
  for (const sid of Object.keys(DB.scenarios)) {
    const sc = DB.scenarios[sid];
    const btn = el("button", "choice", "开始：" + sc.title);
    btn.onclick = () => startRun(sid);
    box.append(btn);
  }
  const gallery = el("button", "choice subtle", "坑点图鉴 · 事故档案");
  gallery.onclick = () => {
    const ov = el("div", "overlay");
    const p = el("div", "panel");
    p.append(el("div", "tag", "COLLECTION // 收集"));
    p.append(el("h2", "", "坑点图鉴 · 事故档案"));
    let unlocked = 0;
    const coll = collLoad();
    for (const cid of Object.keys(DB.cards)) {
      const card = DB.cards[cid];
      const has = (state && state.unlocked[cid]) || coll[cid];
      if (has) unlocked++;
      const d = el("p", "", has
        ? `<b>${card.icon || ""} ${card.name}</b>（${card.severity}）：${card.essence}`
        : "？？？ —— 在实战中踩到这个坑后解锁");
      d.style.borderBottom = "1px solid var(--divider)";
      d.style.padding = "8px 0";
      p.append(d);
    }
    p.append(el("p", "", `已解锁 ${unlocked}/${Object.keys(DB.cards).length}`));
    const row = el("div", "btn-row");
    const close = el("button", "plain", "关闭");
    close.onclick = () => ov.remove();
    row.append(close);
    p.append(row);
    ov.append(p);
    document.body.append(ov);
  };
  box.append(gallery);
  const quit = el("button", "quit", "退出");
  quit.onclick = () => { document.body.innerHTML = "<div class='loading'>游戏已退出。刷新页面重新开始。</div>"; };
  menu.append(box, quit);
  const version = el("div", "version", "v0.6-prototype · H5");
  app.append(menu, version);
}

function startRun(scenarioId) {
  const sc = DB.scenarios[scenarioId];
  rngState = Math.floor(Math.random() * 2 ** 31);
  state = {
    scenarioId, scenario: sc, maxTurns: sc.max_turns,
    stats: { ...sc.start_stats }, flags: {}, turn: 0,
    unlocked: {}, visited: {}, ledger: [], followups: [], finished: false, endingId: "",
  };
  lastStats = { ...state.stats };
  skipType = false;
  $("#mascot").classList.remove("hidden");
  mascotReact("intro");
  currentEvent = pickEvent(state, sc, "");
  state.visited[currentEvent.id] = true;
  $("#app").innerHTML = `
    <div class="topbar">
      <span class="scenario">${sc.title}</span><span class="turn" id="turn"></span>
      <span class="spacer"></span><div id="stats" style="display:flex;gap:8px;flex-wrap:wrap"></div>
    </div>
    <div class="chat" id="chat"></div>
    <div class="choices" id="choices"></div>`;
  // 点击聊天区任意处 = 跳过当前打字/逐条动画（只挂聊天区，避免按钮冒泡误触发）
  $("#chat").addEventListener("click", () => { skipType = true; });
  renderEvent();
}

(async function main() {
  try {
    DB = await loadDB();
    showMenu();
  } catch (err) {
    $("#app").innerHTML = `<div class="loading">内容加载失败：${err}<br>请用 <code>python3 tools/serve_h5.py</code> 启动本地服务后访问。</div>`;
  }
})();
