// ============================================================
// background.js — BATCH mode: Collect -> 1 GPT call -> Apply
// ============================================================

let quizTabId = null;
let gptTabId = null;
let qCount = 0;
let watchdog = null;
let wdKind = "quiz";
let pendingQ = null;
let lastQ = null;
let lastLetter = null;
let sameQCount = 0;
let recoverUsed = 0;
let lastStart = 0;
let lastBatch = null;
const MAX_Q = 100;
const GPT_URL = "https://chatgpt.com/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

chrome.action.onClicked.addListener(async (tab) => {
  try { await chrome.tabs.sendMessage(tab.id, { type: "SHOW_PANEL" }); } catch {}
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-panel") return;
  const tab = await getActiveTab();
  if (!tab) return;
  try { await chrome.tabs.sendMessage(tab.id, { type: "SHOW_PANEL" }); } catch {}
});

chrome.debugger.onDetach.addListener((source) => {
  if (quizTabId && source.tabId === quizTabId) {
    status("⚠ Debugger detach — Start dobara dabao");
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "KEEPALIVE":
          break;

        case "STATUS":
          sendToTab(quizTabId, { type: "STATUS", text: msg.text });
          break;

        case "START": {
          const sid = sender.tab ? sender.tab.id : null;
          if (sid != null && sid === quizTabId && Date.now() - lastStart < 10000) {
            status("Start dobara dabaya — already chal raha hai ✓");
            break;
          }
          lastStart = Date.now();

          quizTabId = sid != null ? sid : (await getActiveTab()).id;
          qCount = 0; pendingQ = null; lastQ = null; lastLetter = null;
          sameQCount = 0; recoverUsed = 0; lastBatch = null;
          try { chrome.action.setBadgeText({ text: "" }); } catch {}

          status("📦 Batch mode — pehle sare questions collect honge");

          const [, att] = await Promise.all([ensureGptTab(), ensureDbg(quizTabId)]);
          if (!att) {
            status("⚠ Debugger FAIL — F12 band karo, page refresh, phir Start");
            return;
          }
          status("🔐 Debugger ready — clicks REAL");

          status("⏳ 2s wait...");
          await sleep(2000);

          status("Shuru! 🚀");
          armWatchdog(120, "Collection slow — page dekho", "none");
          sendToTab(quizTabId, { type: "START_FLOW" });
          break;
        }

        // ===== SINGLE MODE (fallback jab badge na mile) =====
        case "QUESTION": {
          clearWatchdog();
          if (msg.question === lastQ && lastLetter) {
            sameQCount++;
            if (sameQCount <= 4) {
              status("Same Q — dobara try (" + sameQCount + "/4)");
              await sendToTab(quizTabId, { type: "CLICK_ANSWER", letter: lastLetter });
              armWatchdog(15, "Click/Next baar baar fail", "quiz");
            } else {
              status("⚠ Same Q baar baar — page dekho");
            }
            break;
          }
          sameQCount = 0;
          recoverUsed = 0;
          qCount++;
          if (qCount > MAX_Q) return;
          pendingQ = msg.question;
          status("Q" + qCount + " -> ChatGPT");
          gptTabId = await ensureGptTab();
          const ok = gptTabId != null && (await sendToTabRetry(gptTabId, {
            type: "ANSWER_THIS",
            question: msg.question,
            options: msg.options,
          }, 6, 800));
          if (ok) {
            armWatchdog(30, "ChatGPT slow", "quiz");
          } else {
            status("⚠ ChatGPT tab dead — 3s me retry...");
            gptTabId = null;
            await sleep(3000);
            sendToTab(quizTabId, { type: "GET_QUESTION" });
          }
          break;
        }

        case "ANSWER": {
          clearWatchdog();
          lastQ = pendingQ;
          lastLetter = msg.letter;
          status("Answer: " + msg.letter);
          await sendToTab(quizTabId, { type: "CLICK_ANSWER", letter: msg.letter });
          armWatchdog(15, "Click/Next fail", "quiz");
          break;
        }

        // ===== BATCH MODE =====
        case "ALL_QUESTIONS": {
          clearWatchdog();
          lastBatch = msg.questions || [];
          const mcq = lastBatch.filter((q) => q.type === "mcq").length;
          status("📦 " + lastBatch.length + " questions mile (" + mcq + " MCQ, baaki NULL)");
          status("🧠 GPT ko EK saath bheja...");
          gptTabId = await ensureGptTab();
          const okB = gptTabId != null && (await sendToTabRetry(gptTabId, {
            type: "ANSWER_ALL",
            questions: lastBatch,
          }, 6, 800));
          if (okB) {
            armWatchdog(90, "GPT batch slow", "gpt");
          } else {
            status("⚠ GPT tab dead — 3s me retry...");
            gptTabId = null;
            await sleep(3000);
            sendToTab(quizTabId, { type: "START_FLOW" });
          }
          break;
        }

        case "ANSWERS": {
          clearWatchdog();
          recoverUsed = 0;
          const n = Object.keys(msg.answers || {}).length;
          status("🎯 " + n + " answers aa gaye — tick + submit shuru");
          sendToTab(quizTabId, { type: "APPLY_ANSWERS", answers: msg.answers || {} });
          armWatchdog(90, "Apply slow", "quiz");
          break;
        }

        case "FINISHED": {
          clearWatchdog();
          let v = null;
          try {
            v = await Promise.race([
              chrome.tabs.sendMessage(quizTabId, { type: "VERIFY_FINISH" }).catch(() => null),
              new Promise((res) => setTimeout(() => res(null), 3000)),
            ]);
          } catch {}
          if (v && v.done === false) {
            status("⚠ False finish pakda! Continue...");
            await sleep(1000);
            armWatchdog(30, "Question nahi mila", "quiz");
            sendToTab(quizTabId, { type: "GET_QUESTION" });
            break;
          }
          status("🎉 Quiz finished!");
          try { chrome.action.setBadgeText({ text: "DONE" }); } catch {}
          break;
        }

        case "REAL_CLICK": {
          const tid = sender.tab ? sender.tab.id : quizTabId;
          const res = await realClick(tid, msg.x, msg.y);
          try { sendResponse(res); } catch {}
          break;
        }
      }
    } catch (e) {
      console.warn("[Auto] bg error:", e);
    }
  })();
  return true;
});

// ============ CHATGPT TAB ============
async function ensureGptTab() {
  if (gptTabId != null) {
    try { await chrome.tabs.get(gptTabId); return gptTabId; }
    catch { gptTabId = null; }
  }
  const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
  if (tabs.length) { gptTabId = tabs[0].id; return gptTabId; }
  status("ChatGPT tab khol raha hun...");
  const t = await chrome.tabs.create({ url: GPT_URL, active: false });
  gptTabId = t.id;
  await sleep(3500);
  return gptTabId;
}

// ============ DEBUGGER ============
async function ensureDbg(tabId) {
  try {
    await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: "1" });
    return true;
  } catch {
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
      return true;
    } catch (e2) {
      if (/already attached/i.test(String((e2 && e2.message) || e2))) return true;
      return false;
    }
  }
}

async function dbgSend(tabId, method, params) {
  try {
    return await chrome.debugger.sendCommand({ tabId }, method, params);
  } catch (e) {
    const m = String((e && e.message) || e);
    if (/not attached/i.test(m)) {
      const ok = await ensureDbg(tabId);
      if (!ok) throw e;
      return await chrome.debugger.sendCommand({ tabId }, method, params);
    }
    throw e;
  }
}

async function realClick(tabId, x, y) {
  if (!(await ensureDbg(tabId))) {
    return { ok: false, error: "debugger fail — F12 band karo" };
  }
  try {
    const base = { x, y, button: "left", clickCount: 1, pointerType: "mouse" };
    await dbgSend(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", ...base });
    await sleep(30);
    await dbgSend(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ...base });
    await sleep(30);
    await dbgSend(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: "click fail: " + String((e && e.message) || e) };
  }
}

// ============ WATCHDOG ============
function armWatchdog(sec, text, kind = "quiz") {
  clearWatchdog();
  wdKind = kind;
  watchdog = setTimeout(() => {
    if (recoverUsed < 2 && kind !== "none") {
      recoverUsed++;
      if (wdKind === "gpt" && lastBatch) {
        status("GPT slow — batch dobara bheja (" + recoverUsed + "/2)...");
        (async () => {
          gptTabId = await ensureGptTab();
          await sendToTabRetry(gptTabId, { type: "ANSWER_ALL", questions: lastBatch }, 6, 800);
        })();
        armWatchdog(sec, text, "gpt");
      } else {
        status("Atak gaya — recover " + recoverUsed + "/2...");
        sendToTab(quizTabId, { type: "RECOVER" });
        armWatchdog(sec, text, "quiz");
      }
    } else {
      status("⚠ " + text);
    }
  }, sec * 1000);
}
function clearWatchdog() {
  if (watchdog) { clearTimeout(watchdog); watchdog = null; }
}

// ============ HELPERS ============
function status(text) { sendToTab(quizTabId, { type: "STATUS", text }); }
function sendToTab(tabId, payload) {
  if (tabId == null) return Promise.resolve(false);
  return chrome.tabs.sendMessage(tabId, payload).then(() => true).catch(() => false);
}
async function sendToTabRetry(tabId, payload, tries = 6, delay = 800) {
  for (let i = 0; i < tries; i++) {
    if (await sendToTab(tabId, payload)) return true;
    await sleep(delay);
  }
  return false;
}
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}