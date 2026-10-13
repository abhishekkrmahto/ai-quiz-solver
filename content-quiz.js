
const T_SCROLL = 150;
const T_OPTverify = 250;
const T_NEXTwait = 300;
const T_NEXTverify = 400;
const T_SCAN = 500;
// ==================

const LETTERS = ["A", "B", "C", "D", "E", "F"];
const IS_GPT = location.hostname.includes("chatgpt") || location.hostname.includes("openai");
const IS_TOP = window.top === window;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cycling = false;
let answeredOnce = false;

function sendMsg(payload, timeoutMs = 4000) {
  try {
    return Promise.race([
      chrome.runtime.sendMessage(payload),
      new Promise((res) => setTimeout(() => res(null), timeoutMs)),
    ]).catch(() => null);
  } catch { return Promise.resolve(null); }
}

// ================= MESSAGE HANDLER =================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "SHOW_PANEL") { if (IS_TOP) togglePanel(); sendResponse({ ok: true }); return; }
  if (msg.type === "STATUS") { addLog(msg.text); return; }
  if (msg.type === "PING") { sendResponse({ ok: true }); return; }
  if (msg.type === "VERIFY_FINISH") {
    // Background verify karta hai: dialog sach me band hai?
    const q = getQuestion();
    const cards = getOptionCards();
    sendResponse({ done: !q && cards.length < 2 });
    return;
  }
  if (IS_GPT) return;

  if (msg.type === "GET_QUESTION") { if (!cycling) scanAndSend(); }
  if (msg.type === "CLICK_ANSWER") answerCycle(msg.letter);
  if (msg.type === "RECOVER") { if (!cycling) recover(); }
});

// ================= FLOW =================
async function answerCycle(letter) {
  if (cycling) return;
  cycling = true;
  try {
    if (!getQuestion() && getOptionCards().length < 2) {
      addLog("🎉 Quiz complete!");
      sendMsg({ type: "FINISHED" });
      resetStartBtn();
      return;
    }

    const prevQ = getQuestion();
    const cards = getOptionCards();
    const idx = LETTERS.indexOf(letter);

    if (idx >= 0 && cards[idx]) {
      if (isSelected(cards[idx])) {
        addLog(letter + " already selected ✓");
      } else {
        addLog("Option " + letter + " click...");
        await clickEl(cards[idx]);
        let ok = false;
        for (let i = 0; i < 3; i++) {
          await sleep(T_OPTverify);
          const fresh = getOptionCards();
          if (fresh[idx] && isSelected(fresh[idx])) { ok = true; break; }
        }
        if (!ok) {
          humanClick(cards[idx]);
          await sleep(400);
        }
        addLog("✓ " + letter + " done");
      }
    } else {
      if (!getQuestion()) {
        addLog("🎉 Quiz complete!");
        sendMsg({ type: "FINISHED" });
        resetStartBtn();
        return;
      }
      addLog("⚠ Option " + letter + " nahi mila");
    }

    await clickNext(prevQ);
    await scanAndSend();
  } finally {
    cycling = false;
  }
}

async function clickNext(prevQ) {
  for (let round = 1; round <= 3; round++) {
    let btn = null;
    for (let i = 0; i < 10; i++) {
      const b = findNextBtn();
      if (b && !b.disabled && b.getAttribute("aria-disabled") !== "true") { btn = b; break; }
      await sleep(T_NEXTwait);
    }
    if (!btn) {
      if (!getQuestion()) {
        addLog("🎉 Quiz complete!");
        sendMsg({ type: "FINISHED" });
        resetStartBtn();
        return false;
      }
      addLog("⚠ NEXT nahi mila");
      logBtnDiagnostics();
      return false;
    }

    addLog("NEXT click (" + round + ")...");
    await clickEl(btn);

    for (let j = 0; j < 5; j++) {
      await sleep(T_NEXTverify);
      const nowQ = getQuestion();
      if (!nowQ || nowQ !== prevQ) return true;
    }
    humanClick(btn);
    await sleep(700);
    const nowQ2 = getQuestion();
    if (!nowQ2 || nowQ2 !== prevQ) return true;
  }
  addLog("⚠ NEXT fail — page dekho");
  logBtnDiagnostics();
  return false;
}

async function scanAndSend(depth = 0) {
  for (let attempt = 0; attempt < 24; attempt++) {
    const q = getQuestion();
    const cards = getOptionCards();
    if (q && cards.length >= 2) {
      answeredOnce = true;
      sendMsg({ type: "QUESTION", question: q, options: cards.map(cleanText) });
      return;
    }
    await sleep(T_SCAN);
  }

  // Scan fail — FINISHED sirf tab jab dialog SACH ME gayab ho
  const q = getQuestion();
  const cards = getOptionCards();
  if (!q && cards.length < 2) {
    if (answeredOnce) {
      sendMsg({ type: "FINISHED" });
      resetStartBtn();
    } else {
      addLog("⚠ Question nahi mila — dialog khula hai?");
    }
    return;
  }

  // Dialog khula hai lekin question detect nahi hua — dobara try (FINISHED NAHI!)
  if (depth < 2) {
    addLog("⚠ Question detect slow — dobara scan...");
    await sleep(1500);
    await scanAndSend(depth + 1);
  } else {
    addLog("⚠ Question detect nahi ho raha — Stop dabao, screenshot bhejo");
  }
}

async function recover() {
  const q = getQuestion();
  const cards = getOptionCards();
  if (!q) {
    if (answeredOnce && cards.length < 2) {
      addLog("🎉 Quiz complete!");
      sendMsg({ type: "FINISHED" });
      resetStartBtn();
    }
    return;
  }
  const selIdx = cards.findIndex(isSelected);
  cycling = true;
  try {
    if (selIdx >= 0) {
      addLog("Recover: " + LETTERS[selIdx] + " selected — NEXT");
      await clickNext(q);
      await scanAndSend();
    } else {
      addLog("Recover: Q dobara bheja");
      sendMsg({ type: "QUESTION", question: q, options: cards.map(cleanText) });
    }
  } finally { cycling = false; }
}

// ================= CLICKING =================

function isVisible(el) {
  const r = el.getBoundingClientRect();
  return r.width > 5 && r.height > 5;
}

function absRect(el) {
  try {
    let x = 0, y = 0, win = window, cur = el;
    while (true) {
      const r = cur.getBoundingClientRect();
      if (r.width < 3 || r.height < 3) return null;
      x += r.left + r.width / 2;
      y += r.top + r.height / 2;
      if (win === window.top) break;
      cur = win.frameElement;
      if (!cur) return null;
      win = win.parent;
    }
    return { x: Math.round(x), y: Math.round(y) };
  } catch { return null; }
}

async function clickEl(el) {
  try { el.scrollIntoView({ block: "center" }); } catch {}
  await sleep(T_SCROLL);
  const pos = absRect(el);
  if (pos) {
    const res = await sendMsg({ type: "REAL_CLICK", x: pos.x, y: pos.y }, 4000);
    if (res && res.ok) return true;
    if (res && res.error) addLog("⚠ Real click: " + res.error);
  }
  humanClick(el);
  return false;
}

function humanClick(el) {
  const r = el.getBoundingClientRect();
  const opts = {
    bubbles: true, cancelable: true, view: window,
    clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
  };
  el.dispatchEvent(new PointerEvent("pointerdown", opts));
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  el.dispatchEvent(new PointerEvent("pointerup", opts));
  el.dispatchEvent(new MouseEvent("mouseup", opts));
  el.dispatchEvent(new MouseEvent("click", opts));
}

function isSelected(btn) {
  try {
    const bg = getComputedStyle(btn).backgroundColor;
    const m = bg.match(/\d+/g);
    if (!m) return false;
    const sum = m.slice(0, 3).reduce((a, c) => a + Number(c), 0);
    return sum < 350;
  } catch { return false; }
}

// ================= DETECTION (FIXED) =================

function getScope() {
  return (
    document.querySelector('[role="dialog"]') ||
    document.querySelector('[data-slot="dialog-content"]') ||
    document.querySelector('[class*="modal" i]') ||
    document.querySelector('[class*="dialog" i]') ||
    document
  );
}

function cleanText(el) {
  return el.innerText.trim().replace(/^[A-F]\s*\n?/, "").trim();
}

function getQuestion() {
  const scope = getScope();
  // 1) Strict: ? ya : wala text
  let q = findQuestionIn(scope, true);
  if (!q && scope !== document) q = findQuestionIn(document, true);
  // 2) Fallback: koi bhi lamba text (options exclude hain)
  if (!q) q = findQuestionIn(scope, false);
  if (!q && scope !== document) q = findQuestionIn(document, false);
  return q;
}

function findQuestionIn(root, needPunct) {
  const nodes = [...root.querySelectorAll("p,div,span,h1,h2,h3,h4")].filter((el) => {
    if (el.children.length !== 0) return false;
    if (!isVisible(el)) return false;
    if (el.closest("button")) return false;    // option text exclude
    if (el.closest("#qa-root")) return false;  // apna panel exclude
    const t = el.innerText.trim();
    if (t.length < 25 || t.length > 400) return false;
    if (needPunct && !/[?:]/.test(t)) return false;
    return true;
  });
  if (!nodes.length) return null;
  nodes.sort((a, b) => b.innerText.length - a.innerText.length);
  return nodes[0].innerText.trim();
}

function getOptionCards() {
  const scope = getScope();
  let cards = findCardsIn(scope);
  if (cards.length < 2 && scope !== document) cards = findCardsIn(document);
  return cards;
}

function findCardsIn(root) {
  const btns = [...root.querySelectorAll("button")].filter((b) => {
    const badge = b.querySelector("span");
    return badge && /^[A-F]$/.test(badge.innerText.trim()) && isVisible(b);
  });
  if (btns.length >= 2) {
    return btns.sort(
      (a, b) =>
        LETTERS.indexOf(a.querySelector("span").innerText.trim()) -
        LETTERS.indexOf(b.querySelector("span").innerText.trim())
    );
  }
  const cards = [];
  for (const L of ["A", "B", "C", "D"]) {
    const badge = [...root.querySelectorAll("span,div")].find(
      (el) => el.children.length === 0 && el.innerText.trim() === L && isVisible(el)
    );
    if (!badge) break;
    const card =
      badge.closest("button") ||
      badge.closest('[role="button"]') ||
      badge.parentElement;
    if (card && !cards.includes(card)) cards.push(card);
  }
  return cards;
}

function findNextBtn() {
  const scope = getScope();
  const all = [...scope.querySelectorAll("button"), ...document.querySelectorAll("button")];
  const seen = new Set();
  const btns = all.filter((b) => {
    if (seen.has(b)) return false;
    seen.add(b);
    return /next|submit|finish/i.test(b.innerText.trim()) && isVisible(b);
  });
  if (!btns.length) return null;
  const enabled = btns.find((b) => !b.disabled && b.getAttribute("aria-disabled") !== "true");
  return enabled || btns[0];
}

function logBtnDiagnostics() {
  const btns = [...document.querySelectorAll("button")].filter(isVisible).slice(0, 12);
  const info = btns.map((b) => {
    const t = (b.innerText || "").trim().slice(0, 12) || "(empty)";
    return t + (b.disabled ? "[disabled]" : "");
  });
  addLog("Buttons: " + (info.join(" | ") || "koi nahi"));
}

// ================= UI: BUBBLE + PANEL =================
let panelOpen = false;

function bubbleAllowed() {
  try { return localStorage.getItem("qa_bubble") === "1"; } catch { return false; }
}

function resetStartBtn() {
  const b = document.querySelector("#qa-start");
  if (b) {
    b.disabled = false;
    b.style.background = "#2563eb";
    b.style.cursor = "pointer";
    b.textContent = "▶ Start";
  }
}

function ensureRoot() {
  let root = document.getElementById("qa-root");
  if (root && root.isConnected) return root;
  root = document.createElement("div");
  root.id = "qa-root";
  (document.fullscreenElement || document.body).appendChild(root);
  return root;
}

function ensureBubble(root) {
  if (root.querySelector("#qa-bubble")) return;
  const b = document.createElement("div");
  b.id = "qa-bubble";
  b.textContent = "🤖";
  b.style.cssText =
    "position:fixed;bottom:20px;right:20px;z-index:2147483647;width:46px;height:46px;" +
    "background:#1e293b;border-radius:50%;display:flex;align-items:center;justify-content:center;" +
    "font-size:22px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.45);user-select:none";
  b.title = "Quiz Auto — panel kholo";
  b.addEventListener("click", togglePanel);
  root.appendChild(b);
}

function ensurePanel(root) {
  if (root.querySelector("#qa-panel")) return;
  const panel = document.createElement("div");
  panel.id = "qa-panel";
  panel.innerHTML = `
    <div style="position:fixed;top:15px;right:15px;z-index:2147483647;font-family:sans-serif;
                width:240px;background:#1e293b;color:#fff;border-radius:10px;padding:12px;
                box-shadow:0 4px 20px rgba(0,0,0,.4)">
      <div style="font-weight:bold;font-size:13px;margin-bottom:8px">🤖 Quiz Auto</div>
      <button id="qa-start" style="all:unset;width:100%;box-sizing:border-box;background:#2563eb;color:#fff;
              text-align:center;padding:8px;border-radius:6px;font-size:13px;cursor:pointer">▶ Start</button>
      <button id="qa-test" style="all:unset;width:100%;box-sizing:border-box;background:#0f766e;color:#fff;
              text-align:center;padding:8px;border-radius:6px;font-size:13px;cursor:pointer;margin-top:6px">🧪 Click Test</button>
      <button id="qa-stop" style="all:unset;width:100%;box-sizing:border-box;background:#7f1d1d;color:#fff;
              text-align:center;padding:8px;border-radius:6px;font-size:13px;cursor:pointer;margin-top:6px">■ Stop (reload page)</button>
      <div id="qa-log" style="margin-top:8px;font-size:11px;color:#94a3b8;max-height:130px;overflow-y:auto"></div>
    </div>`;
  root.appendChild(panel);

  const startBtn = panel.querySelector("#qa-start");
  startBtn.onclick = () => {
    if (startBtn.disabled) return;
    startBtn.disabled = true;
    startBtn.style.background = "#475569";
    startBtn.style.cursor = "not-allowed";
    startBtn.textContent = "⏳ Running...";
    addLog("Start hua...");
    chrome.runtime.sendMessage({ type: "START" }).catch(() => {});
  };
  panel.querySelector("#qa-test").onclick = async () => {
    addLog("🧪 Click test: Option A...");
    const cards = getOptionCards();
    if (!cards.length) { addLog("⚠ Koi option nahi mila"); return; }
    await clickEl(cards[0]);
    await sleep(600);
    addLog(isSelected(cards[0]) || isSelected(getOptionCards()[0])
      ? "✅ A select ho gaya!" : "⚠ A select nahi hua");
  };
  panel.querySelector("#qa-stop").onclick = () => location.reload();
}

function togglePanel() {
  if (!IS_TOP) return;
  panelOpen = !panelOpen;
  try { localStorage.setItem("qa_bubble", "1"); } catch {}
  ensureUI();
}

function ensureUI() {
  if (IS_GPT || !IS_TOP) return;
  if (!panelOpen && !bubbleAllowed()) return;
  const root = ensureRoot();
  ensureBubble(root);
  if (panelOpen) ensurePanel(root);
  else root.querySelector("#qa-panel")?.remove();
}

function addLog(text) {
  const log = document.querySelector("#qa-log");
  if (!log) return;
  const line = document.createElement("div");
  line.textContent = "• " + text;
  line.style.marginBottom = "2px";
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

// ================= FULLSCREEN FIX =================
function keepInFullscreen() {
  const fs = document.fullscreenElement;
  const root = document.getElementById("qa-root");
  if (fs && root && !fs.contains(root)) fs.appendChild(root);
}

document.addEventListener("fullscreenchange", keepInFullscreen);
setInterval(() => { ensureUI(); keepInFullscreen(); }, 2000);

setInterval(() => {
  try { chrome.runtime.sendMessage({ type: "KEEPALIVE" }).catch(() => {}); } catch {}
}, 15000);

if (!IS_GPT && IS_TOP) {
  const boot = () => { ensureUI(); keepInFullscreen(); };
  if (document.readyState === "complete") setTimeout(boot, 800);
  else window.addEventListener("load", () => setTimeout(boot, 800));
}