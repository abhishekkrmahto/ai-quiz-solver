

const LETTERS = ["A", "B", "C", "D", "E", "F"];
const T_POLL = 400;       // reply poll
const T_COMPOSER = 300;   // composer poll
const NEW_CHAT_AFTER = 25;// itne replies baad fresh chat
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sendBG(payload) {
  try { chrome.runtime.sendMessage(payload).catch(() => {}); } catch {}
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "ANSWER_THIS") {
    sendResponse({ ok: true });
    answerFlow(msg.question, msg.options || []);
  }
});

// ---------- 1) TEXT CLEANING ----------
function cleanLine(t) {
  return String(t || "")
    .replace(/QUESTION\s+\d+\s+OF\s+\d+/gi, " ")
    .replace(/Concept\s+Check/gi, " ")
    .replace(/[*_`#>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanOption(t) {
  return cleanLine(t)
    .replace(/^\(([A-F])\)\s*/, "")
    .replace(/^([A-F])[\.\):]\s*/, "")
    .replace(/^([A-F])\s*[-–]\s+/, "")
    .trim();
}

function buildPrompt(question, options) {
  const q = cleanLine(question);
  const opts = options
    .slice(0, 6)
    .map((o, i) => LETTERS[i] + ") " + cleanOption(o))
    .join("\n");
  return (
    "You are answering a multiple-choice quiz question. " +
    "Reply with ONLY the letter of the correct option (example: B). " +
    "No explanation, no extra words, no punctuation — just ONE letter. " +
    "If unsure, reply with your best guess letter.\n\n" +
    "Question: " + q + "\n\nOptions:\n" + opts
  );
}

// ---------- 2) SMART PARSING ----------
function extractLetter(text, numOpts) {
  if (!text) return null;
  const t = String(text).replace(/\*\*/g, "").trim();
  const max = Math.max(2, Math.min(numOpts || 6, 6));
  const ok = (L) => LETTERS.indexOf(L) < max;

  let m = t.match(/(?:correct\s+)?answer\s*(?:is|:|=)?\s*\(?\s*([A-F])\b/i);
  if (m && ok(m[1].toUpperCase())) return m[1].toUpperCase();

  m = t.match(/^\s*\(?\s*([A-F])\s*\)?\s*(?:[\.\):,]|$)/);
  if (m && ok(m[1].toUpperCase())) return m[1].toUpperCase();

  m = t.match(/\b([A-F])\b/);
  if (m && ok(m[1].toUpperCase())) return m[1].toUpperCase();

  return null;
}

// ---------- 3) CHATGPT AUTOMATION ----------
async function waitForComposer(maxTries = 12) {
  for (let i = 0; i < maxTries; i++) {
    const c = document.querySelector(
      "#prompt-textarea, div.ProseMirror[contenteditable='true']"
    );
    if (c) return c;
    await sleep(T_COMPOSER);
  }
  return null;
}

async function typeInto(el, text) {
  el.focus();
  await sleep(100);
  if (el.tagName === "TEXTAREA") {
    el.value = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    document.execCommand("selectAll", false, null);
    document.execCommand("insertText", false, text);
  }
  await sleep(150);
}

function clickSend() {
  const btn =
    document.querySelector('[data-testid="send-button"]') ||
    document.querySelector('button[aria-label*="Send" i]');
  if (btn && !btn.disabled) { btn.click(); return true; }
  return false;
}

async function waitReply(prevCount) {
  for (let i = 0; i < 150; i++) { // max ~60s
    await sleep(T_POLL);
    const stop = document.querySelector(
      '[data-testid="stop-button"], button[aria-label*="Stop" i]'
    );
    if (stop) continue;
    const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
    if (msgs.length > prevCount) {
      const txt = (msgs[msgs.length - 1].innerText || "").trim();
      if (txt) {
        await sleep(300); // stability
        const msgs2 = document.querySelectorAll('[data-message-author-role="assistant"]');
        if (msgs2.length === msgs.length &&
            (msgs2[msgs2.length - 1].innerText || "").trim() === txt) {
          return txt;
        }
      }
    }
  }
  return null;
}

async function maybeNewChat() {
  try {
    const msgs = document.querySelectorAll('[data-message-author-role="assistant"]').length;
    if (msgs < NEW_CHAT_AFTER) return;
    const btn =
      document.querySelector('button[aria-label="New chat"]') ||
      document.querySelector('a[aria-label="New chat"]') ||
      document.querySelector('a[href="/"]');
    if (btn) { btn.click(); await sleep(2000); }
  } catch {}
}

// ---------- 4) FLOW ----------
let busy = false;

async function answerFlow(question, options) {
  if (busy) return;
  busy = true;
  try {
    await maybeNewChat();

    let composer = await waitForComposer();
    if (!composer) {
      sendBG({ type: "STATUS", text: "⚠ ChatGPT composer nahi mila — login check karo" });
      return;
    }

    for (let attempt = 1; attempt <= 2; attempt++) {
      sendBG({ type: "STATUS", text: "ChatGPT soch raha hai" + (attempt > 1 ? " (retry)" : "..." ) });
      const prevCount = document.querySelectorAll('[data-message-author-role="assistant"]').length;

      let prompt = buildPrompt(question, options);
      if (attempt > 1) {
        prompt += "\n\nREMINDER: Reply with ONLY one letter (A, B, C, D or E). Nothing else.";
      }

      composer = await waitForComposer();
      if (!composer) break;
      await typeInto(composer, prompt);

      if (!clickSend()) {
        composer.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true,
        }));
      }

      const reply = await waitReply(prevCount);
      if (!reply) {
        sendBG({ type: "STATUS", text: "⚠ Reply nahi aya" });
        continue;
      }

      const letter = extractLetter(reply, options.length);
      if (letter) {
        sendBG({ type: "ANSWER", letter });
        return;
      }
      sendBG({ type: "STATUS", text: 'Clear nahi: "' + reply.slice(0, 35) + '"' });
    }

    sendBG({ type: "STATUS", text: "⚠ Answer nahi mila — retry hoga" });
  } finally {
    busy = false;
  }
}