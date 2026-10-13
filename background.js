

const START_WAIT = 2000;    // Start ke baad page settle wait
const GPT_TAB_BOOT = 3500;  // naya ChatGPT tab khulne ka wait
const WD_FIRST = 20;        // pehla question na mile to (sec)
const WD_CLICK = 15;        // click/next watchdog (sec)
const WD_GPT = 30;          // ChatGPT slow watchdog (sec)

let quizTabId = null;
let gptTabId = null;
let qCount = 0;
let watchdog = null;
let pendingQ = null;
let lastQ = null;
let lastLetter = null;
let sameQCount = 0;
let recoverUsed = 0;
let lastStart = 0;
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

        // ChatGPT tab ke messages panel me relay
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
          sameQCount = 0; recoverUsed = 0;
          try { chrome.action.setBadgeText({ text: "" }); } catch {}

          status("💬 ChatGPT-only mode — fata-fat");

          // PARALLEL: ChatGPT tab + debugger ek saath ready
          const [, att] = await Promise.all([ensureGptTab(), ensureDbg(quizTabId)]);
          if (!att) {
            status("⚠ Debugger FAIL — F12 band karo, page refresh, phir Start");
            return;
          }
          status("🔐 Debugger ready — clicks REAL");

          status("⏳ " + (START_WAIT / 1000) + "s wait...");
          await sleep(START_WAIT);

          status("Shuru! 🚀");
          armWatchdog(WD_FIRST, "Question nahi mila — quiz dialog khula hai?");
          sendToTab(quizTabId, { type: "GET_QUESTION" });
          break;
        }

        case "QUESTION": {
          clearWatchdog();

          if (msg.question === lastQ && lastLetter) {
            sameQCount++;
            if (sameQCount <= 4) {
              status("Same Q — dobara try (" + sameQCount + "/4)");
              await sendToTab(quizTabId, { type: "CLICK_ANSWER", letter: lastLetter });
              armWatchdog(WD_CLICK, "Click/Next baar baar fail");
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
            armWatchdog(WD_GPT, "ChatGPT slow — recover...");
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
          armWatchdog(WD_CLICK, "Click/Next fail");
          break;
        }

        case "FINISHED": {
          clearWatchdog();
          // VERIFY: dialog sach me band hai? (false-finish se bachao)
          let v = null;
          try {
            v = await Promise.race([
              chrome.tabs.sendMessage(quizTabId, { type: "VERIFY_FINISH" }).catch(() => null),
              new Promise((res) => setTimeout(() => res(null), 3000)),
            ]);
          } catch {}
          if (v && v.done === false) {
            status("⚠ False finish pakda! Quiz abhi chal raha hai — continue...");
            await sleep(1000);
            armWatchdog(WD_FIRST, "Question nahi mila");
            sendToTab(quizTabId, { type: "GET_QUESTION" });
            break;
          }
          status("🎉 Quiz finished! Total: " + qCount);
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
  await sleep(GPT_TAB_BOOT);
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
function armWatchdog(sec, text) {
  clearWatchdog();
  watchdog = setTimeout(() => {
    if (recoverUsed < 2) {
      recoverUsed++;
      status("Atak gaya — recover " + recoverUsed + "/2...");
      sendToTab(quizTabId, { type: "RECOVER" });
      armWatchdog(sec, text);
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