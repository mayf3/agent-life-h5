// engine.js v0.7 —— 呈现层 + 流程编排。规则语义全部在 rules.js（Node 可测）。
// v0.7 修复：①回合耗尽与知识卡解耦（不再出现第 13 回合）②事件级提交锁（重复回车只结算一次）
// ③试探=耗资源换信息后回到原事件（不结束、不免费重复）④内部标志位不再漏进玩家数值区
// ⑤已收录知识卡只做轻提示 ⑥结局定性先行（失败/平凡/成功），小D不再在崩溃结局庆祝
// ⑦结局条件可区分（成功交付/带伤上线/未完成/延期各有门槛，见 data/endings.json）
"use strict";

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MOOD_FACES = { normal: "🙂", happy: "😄", smug: "😏", worry: "😟", panic: "😱", cheer: "🥳" };
const MOOD_RING = {
  normal: "rgba(37,99,235,.25)", happy: "rgba(16,185,129,.25)", smug: "rgba(139,92,246,.28)",
  worry: "rgba(239,68,68,.25)", panic: "rgba(239,68,68,.35)", cheer: "rgba(16,185,129,.30)",
};
const WHO_BADGE = {
  user: { face: "🧑‍💻", cls: "user", tag: "YOU · 你的指令" },
  agent: { face: "🤖", cls: "agent", tag: "AGENT · 自动执行" },
  system: { face: "📣", cls: "system", tag: "SYSTEM · 旁白" },
};

let DB = null;
let state = null;
let currentEvent = null;
let probeUsed = new Set();
let skipType = false;
let lastStats = null;
let rngState = 0;

const rng = () => {
  rngState |= 0; rngState = (rngState + 0x6D2B79F5) | 0;
  let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// ---- 收集持久化（localStorage）----
const COLL_KEY = "agent-life-cards";
function collLoad() {
  try { return JSON.parse(localStorage.getItem(COLL_KEY) || "{}"); } catch { return {}; }
}
function collSave(obj) { try { localStorage.setItem(COLL_KEY, JSON.stringify(obj)); } catch { /* 忽略 */ } }
function collUnlock(cardId) {
  const c = collLoad();
  if (!c[cardId]) { c[cardId] = true; collSave(c); }
}

const BASE = location.pathname.replace(/\/[^/]*$/, "/");
async function loadDB() {
  const j = async (p) => (await fetch(BASE + p)).json();
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

// ---- 呈现 ----
function scrollBottom() {
  window.scrollTo({ top: document.body.scrollHeight, behavior: skipType ? "auto" : "smooth" });
}

function buildMsg(who, text) {
  text = text == null ? '' : String(text);
  const meta = WHO_BADGE[who] || WHO_BADGE.system;
  const row = el("div", "msg " + meta.cls);
  row.append(el("div", "badge " + meta.cls, meta.face));
  const bubble = el("div", "bubble");
  bubble.append(el("div", "who-tag", meta.tag));
  const span = el("span", "msg-text");
  const cursor = el("span", "cursor", "▌");
  bubble.append(span, cursor);
  row.append(bubble);
  $("#chat").append(row);
  return { span, cursor };
}

async function typeText(span, text, cursor) {
  for (let i = 0; i < text.length; i++) {
    if (skipType) { span.textContent = text; break; }
    span.textContent += text[i];
    scrollBottom();
    await sleep(6);
  }
  cursor.remove();
  scrollBottom();
}

function sanitizeChat() {
  $("#chat").querySelectorAll("div").forEach((d) => {
    if (!d.classList.length && d.textContent.trim() === "undefined") d.remove();
  });
}

async function playMessages(msgs) {
  const chat = $("#chat");
  for (const { who, text } of msgs) {
    if (skipType) { chat.append(buildMsgStatic(who, text)); continue; }
    const node = buildMsg(who, text);
    chat.append(node.row);
    sanitizeChat();
    scrollBottom();
    await sleep(220);
    await typeText(node.span, text, node.cursor);
    await sleep(150);
  }
  scrollBottom();
  sanitizeChat();
}

function buildMsgStatic(who, text) {
  text = text == null ? '' : String(text);
  const meta = WHO_BADGE[who] || WHO_BADGE.system;
  const row = el("div", "msg " + meta.cls);
  row.append(el("div", "badge " + meta.cls, meta.face));
  const bubble = el("div", "bubble");
  bubble.append(el("div", "who-tag", meta.tag));
  bubble.append(el("span", "", text));
  row.append(bubble);
  return row;
}

function renderTop(st, changed, prev) {
  const cur = st.finished ? st.maxTurns : st.turn + 1;
  $("#turn").textContent = `第 ${cur}/${st.maxTurns} 回合`;
  const bar = $("#stats");
  bar.innerHTML = "";
  for (const k of Rules.STAT_KEYS) {
    const v = st.stats[k];
    const pill = el("div", "pill" + (v < 30 ? " bad" : v >= 60 ? " good" : "")
      + (changed && changed.has(k) ? " flash" : "")
      + (changed && changed.has(k) && prev && v < prev[k] ? " shake" : ""));
    pill.dataset.key = k;
    const fill = el("span", "fill");
    fill.style.width = v + "%";
    pill.append(fill);
    pill.append(el("span", "pname", Rules.STAT_NAMES[k]));
    pill.append(el("b", "", String(v)));
    pill.append(el("span", "predot"));
    bar.append(pill);
  }
}

function renderChoices() {
  const st = state;
  const box = $("#choices");
  box.innerHTML = "";
  let n = 0;
  for (const c of currentEvent.choices || []) {
    const isProbe = !!c.probe;
    if (isProbe && probeUsed.has(currentEvent.id + "/" + c.id)) continue;
    if (!Rules.checkRequires(c.requires, st)) continue;
    n += 1;
    const btn = el("button", "choice" + (isProbe ? " probe" : ""));
    btn.append(el("span", "bar"));
    btn.append(el("span", "num", String(n)));
    if (isProbe) btn.append(el("span", "tagchip", "试探"));
    btn.append(el("span", "ctext", c.text));
    const affected = Object.keys(c.effects || {}).filter((k) => Rules.STAT_NAMES[k]);
    btn.addEventListener("mouseenter", () => {
      document.querySelectorAll("#stats .pill").forEach((p) => {
        p.classList.toggle("pred", affected.includes(p.dataset.key));
      });
    });
    btn.addEventListener("mouseleave", () => {
      document.querySelectorAll("#stats .pill").forEach((p) => p.classList.remove("pred"));
    });
    btn.onclick = () => onChoice(c.id, btn);
    box.append(btn);
  }
}

function showDeltas(deltas) {
  const parts = [];
  for (const k of Rules.STAT_KEYS) {
    const v = deltas ? deltas[k] : undefined;
    if (!v) continue;
    parts.push(`<span class="${v > 0 ? "up" : "down"}">${Rules.STAT_NAMES[k]} ${v > 0 ? "+" : ""}${v}</span>`);
  }
  if (parts.length) $("#chat").append(el("div", "deltas", "◆ " + parts.join(" ｜ ")));
}

async function typeMascot(text, face, mood) {
  const line = $("#m-line");
  const faceEl = $("#m-face");
  line.textContent = "";
  faceEl.textContent = face;
  faceEl.classList.remove("jelly");
  void faceEl.offsetWidth;
  faceEl.classList.add("jelly");
  $("#mascot").style.setProperty("--ring", MOOD_RING[mood] || MOOD_RING.normal);
  for (let i = 0; i < text.length; i++) {
    if (text.slice(i, i + 2) === "——") {
      line.textContent += "——";
      if (!skipType) await sleep(400);
      i += 1;
      continue;
    }
    line.textContent += text[i];
    if (!skipType) await sleep(30);
  }
  setTimeout(() => faceEl.classList.remove("jelly"), 460);
}
function mascotReact(slot) {
  const pool = DB.mascot.slots[slot] || [];
  if (!pool.length) return;
  const e = pool[Math.floor(rng() * pool.length)];
  typeMascot(e.text, MOOD_FACES[e.mood] || "🙂", e.mood);
}
function mascotReactStats(st) {
  let danger = 0, worst = 100, allGood = true;
  for (const k of Rules.STAT_KEYS) {
    const v = st.stats[k];
    worst = Math.min(worst, v);
    if (v < 30) danger++;
    if (v < 60) allGood = false;
  }
  if (worst <= 15 || danger >= 2) mascotReact("crisis");
  else if (danger === 1) mascotReact("danger");
  else if (allGood) mascotReact("good");
}

function onChoice(choiceId, btnEl) {
  const st = state;
  // 提交锁在 rules.settleChoice 内：重复点击/回车只结算一次
  const { ok, outcome } = Rules.settleChoice(st, currentEvent, choiceId, DB.events);
  if (!ok) return;
  skipType = true;
  document.querySelectorAll("#choices .choice").forEach((b) => {
    if (b !== btnEl) b.classList.add("fade-out");
    else b.classList.add("chosen");
  });
  if (outcome.card) collUnlock(outcome.card);
  if (outcome.result) {
    $("#chat").append(buildMsgStatic(outcome.result.who, outcome.result.text));
  }
  showDeltas(outcome.deltas);
  sanitizeChat();
  sanitizeChat();
  renderTop(st, new Set(Object.keys(outcome.deltas)), lastStats);
  lastStats = { ...st.stats };
  scrollBottom();
  const ended = outcome.ended;
  const cardId = outcome.card;
  if (outcome.probe) {
    // 试探：回到当前事件继续正式决策（不消耗回合）
    mascotReactStats(st);
    setTimeout(renderChoices, 450);
    return;
  }
  if (ended) updateAlarm(st);
  mascotReactStats(st);
  setTimeout(() => {
    if (cardId) showCard(cardId);
    else if (st.finished) showEnding();
    else showContinue();
  }, 550);
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
  let forced = Rules.takePendingGoto();
  if (!forced) forced = Rules.dueFollowup(st, DB.events);
  currentEvent = Rules.pickEvent(st, st.scenario, DB.events, forced, rng);
  if (!currentEvent) { st.finished = true; showEnding(); return; }
  st.visited[currentEvent.id] = true;
  probeUsed = new Set();
  st.committed = false; // 新事件解锁提交
  renderEvent();
}

function showCard(cardId) {
  const card = DB.cards[cardId];
  const already = collLoad()[cardId];
  const finish = () => { state.finished ? showEnding() : showContinue(); };
  // v0.7：已收录只做轻提示，不再弹大卡、不多出一次“继续”
  if (already) {
    const toast = el("div", "toast", `${card.icon || ""} 《${card.name}》已在图鉴中`);
    document.body.append(toast);
    setTimeout(() => toast.remove(), 1400);
    setTimeout(finish, 400);
    return;
  }
  const ov = el("div", "overlay");
  const p = el("div", "panel card-panel");
  p.append(el("div", "warnbar"));
  p.append(el("div", "tag", "坑点卡 · 新收录"));
  p.append(el("h2", "", `${card.icon || ""} ${card.name}（威胁等级：${card.severity}）`));
  p.append(el("p", "", "是什么：" + card.essence));
  p.append(el("p", "", "为什么会发生：" + card.why));
  const defenseBox = el("div", "defense-box");
  defenseBox.append(el("div", "defense-title", "怎么防"));
  for (const d of card.defenses || []) defenseBox.append(el("div", "defense-item", "· " + d));
  p.append(defenseBox);
  const row = el("div", "btn-row");
  const btn = el("button", "primary", "收下，继续 →");
  btn.onclick = () => { ov.remove(); finish(); };
  row.append(btn);
  p.append(row);
  ov.append(p);
  document.body.append(ov);
}

function showEnding() {
  const st = state;
  skipType = true;
  updateAlarm(st);
  // v0.7：先确定最终结局与定性，再驱动小D——失败结局绝不庆祝
  const ending = Rules.resolveEnding(st, DB.endings);
  const tone = Rules.endingTone(ending);
  mascotReact(tone === "good" ? "ending_good" : tone === "bad" ? "ending_bad" : "ending_mid");
  const ov = el("div", "overlay");
  const p = el("div", "panel");
  p.append(el("div", "tag", "ENDING // 结局归档 · " + (tone === "good" ? "成功" : tone === "bad" ? "失败" : "平凡")));
  p.append(el("h2", "", ending.title || ""));
  p.append(el("p", "", ending.desc || ""));
  const stats = el("div", "stats");
  const cell = (l, v) => { const d = el("div"); d.append(el("i", "", l)); d.append(el("b", "", String(v))); return d; };
  stats.append(cell("回合", st.turn));
  for (const k of Rules.STAT_KEYS) stats.append(cell(Rules.STAT_NAMES[k], st.stats[k]));
  p.append(stats);
  const coll = collLoad();
  const totalUnlocked = Object.keys(DB.cards).filter((cid) => st.unlocked[cid] || coll[cid]).length;
  p.append(el("p", "", `坑点图鉴 ${totalUnlocked}/${Object.keys(DB.cards).length}（跨局累计）`));
  // v0.8：结局页从「最后五次选择」改为「关键决定 + 代价 + 下局策略」
  const keyDecisions = st.ledger.filter((e) => !e.probe && (e.turn <= 3 || e.choice.length > 10));
  const decisions = el("div", "ledger");
  const decText = keyDecisions.slice(-4).map((e) =>
    `第${e.turn}回合｜${e.title}：<b>${e.choice}</b>`).join("<br>");
  if (decText) decisions.innerHTML = "导致该结局的关键决定：<br>" + decText;
  p.append(decisions);
  if (ending.hint) {
    const hint = el("div", "hint-box");
    hint.innerHTML = "💡 下局可尝试：" + ending.hint;
    p.append(hint);
  }
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

function updateAlarm(st) {
  const alarm = $("#alarm");
  if (!alarm) return;
  const danger = Rules.STAT_KEYS.some((k) => st.stats[k] < 25 && k !== "progress");
  alarm.classList.toggle("on", danger && !st.finished);
}

function showMenu() {
  const app = $("#app");
  app.innerHTML = "";
  $("#mascot").classList.add("hidden");
  const menu = el("div", "menu");
  const DECO = [
    { e: "💻", x: "12%", y: "12%", s: 46, far: false }, { e: "🤖", x: "72%", y: "16%", s: 38, far: true },
    { e: "💸", x: "16%", y: "68%", s: 42, far: true }, { e: "⚠️", x: "78%", y: "58%", s: 44, far: false },
    { e: "🧠", x: "30%", y: "82%", s: 40, far: true }, { e: "🐛", x: "64%", y: "78%", s: 36, far: false },
    { e: "📉", x: "8%", y: "44%", s: 34, far: true }, { e: "☕", x: "86%", y: "30%", s: 38, far: false },
  ];
  for (const d of DECO) {
    const deco = el("div", "deco", d.e);
    deco.style.left = d.x; deco.style.top = d.y; deco.style.fontSize = d.s + "px";
    if (d.far) deco.classList.add("far");
    menu.append(deco);
  }
  const title = el("h1", "", `<span class="en">Agent</span> <span class="cn">人生</span>`);
  const subtitle = el("div", "subtitle", "// AI Agent 被坑体验模拟器 //");
  menu.append(title, subtitle, el("div", "divider"));
  const box = el("div", "choices");
  for (const [icon, sid, label] of [
    ["🏚️", "legacy_code", "开始：接手祖传代码"],
    ["🚀", "vibe_coding", "开始：Vibe Coding 创业记"],
  ]) {
    const btn = el("button", "choice primary-choice");
    btn.append(el("span", "menu-badge", icon));
    btn.append(el("span", "", label));
    btn.onclick = () => startRun(sid);
    box.append(btn);
  }
  const gallery = el("button", "choice subtle", "📇 坑点图鉴 · 事故档案");
  gallery.onclick = () => {
    const ov = el("div", "overlay");
    const p = el("div", "panel");
    p.append(el("div", "tag", "COLLECTION // 收集"));
    p.append(el("h2", "", "坑点图鉴 · 事故档案"));
    const coll = collLoad();
    let unlocked = 0;
    for (const cid of Object.keys(DB.cards)) {
      const card = DB.cards[cid];
      const has = coll[cid];
      if (has) unlocked++;
      const d = el("p", "", has
        ? `<b>${card.icon || ""} ${card.name}</b>（${card.severity}）：${card.essence}`
        : `<span class="mystery">？？？ —— 在实战中踩到这个坑后解锁</span>`);
      d.style.borderBottom = "1px solid var(--divider)";
      d.style.padding = "8px 0";
      p.append(d);
    }
    p.append(el("p", "", `跨局累计解锁 ${unlocked}/${Object.keys(DB.cards).length}`));
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
  menu.append(el("div", "version", "v0.7-prototype · H5"));
  app.append(menu);
}

function enableParallax() {
  document.addEventListener("mousemove", (e) => {
    const cx = e.clientX - innerWidth / 2, cy = e.clientY - innerHeight / 2;
    document.querySelectorAll(".menu .deco").forEach((d) => {
      const depth = d.classList.contains("far") ? 8 : 20;
      d.style.marginLeft = (-cx / depth) + "px";
      d.style.marginTop = (-cy / depth) + "px";
    });
  });
}

function startRun(scenarioId) {
  const sc = DB.scenarios[scenarioId];
  rngState = Math.floor(Math.random() * 2 ** 31);
  state = {
    scenarioId, scenario: sc, maxTurns: sc.max_turns,
    stats: { ...sc.start_stats }, flags: {}, turn: 0,
    unlocked: {}, visited: {}, ledger: [], followups: [],
    finished: false, endingId: "",
    committed: false, probeUsed: new Set(),
  };
  lastStats = { ...state.stats };
  skipType = false;
  $("#mascot").classList.remove("hidden");
  mascotReact("intro");
  currentEvent = Rules.pickEvent(state, sc, DB.events, "", rng);
  state.visited[currentEvent.id] = true;
  $("#app").innerHTML = `
    <div class="topbar">
      <span class="scenario">${sc.title}</span><span class="turn" id="turn"></span>
      <span class="spacer"></span><div id="stats" style="display:flex;gap:8px;flex-wrap:wrap"></div>
    </div>
    <div class="chat" id="chat"></div>
    <div class="choices" id="choices"></div>`;
  $("#chat").addEventListener("click", () => { skipType = true; });  // 点击=跳过本事件剩余对白（下事件自动恢复逐字）
  renderEvent();
}

// 键盘 1/2/3 直选（回车重复触发由 rules.settleChoice 的提交锁兜底）
document.addEventListener("keydown", (e) => {
  if (!state || !currentEvent || state.committed) return;
  const idx = ["1", "2", "3", "4"].indexOf(e.key);
  if (idx >= 0) {
    const btns = document.querySelectorAll("#choices .choice");
    if (btns[idx]) btns[idx].click();
  }
});

function renderEvent() {
  const st = state;
  skipType = false;
  $("#chat").innerHTML = "";
  $("#choices").innerHTML = "";
  const ev = currentEvent;
  const head = el("div", "title-row");
  head.append(el("span", "bar"));
  head.append(el("h1", "", `${ev.icon || ""} ${ev.title || ""}`));
  $("#chat").append(head);
  const msgs = [];
  if (st.turn === 0 && st.scenario.intro) msgs.push({ who: "system", text: st.scenario.intro });
  for (const m of ev.chat || []) msgs.push({ who: m.who, text: m.text });
  playMessages(msgs).then(() => {
    renderTop(st);
    renderChoices();
  });
}

(async function main() {
  try {
    DB = await loadDB();
    enableParallax();
    showMenu();
  } catch (err) {
    $("#app").innerHTML = `<div class="loading">内容加载失败：${err}<br>请用 <code>python3 tools/serve_h5.py</code> 启动本地服务后访问。</div>`;
  }
})();
