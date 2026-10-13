// ============================================================
// content-gpt.js — SINGLE + BATCH (ek call me sare answers JSON)
// ============================================================

const LETTERS = ["A", "B", "C", "D", "E", "F"];
const T_POLL = 400;
const T_COMPOSER = 300;
const NEW_CHAT_AFTER = 25;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sendBG(payload) {
  try { chrome.runtime.sendMessage(payload).catch(() => {}); } catch {}
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "ANSWER_THIS") {
    sendResponse({ ok: true });
    answerFlow(msg.question, msg.options || []);
  }
  if (msg.type === "ANSWER_ALL") {
    sendResponse({ ok: true });
    answerAllFlow(msg.questions || []);
  }
});

// ---------- TEXT CLEANING ----------
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

// ---------- BATCH PROMPT ----------
function buildBatchPrompt(mcqs) {
  const parts = mcqs.map((q) => {
    const opts = (q.options || []).slice(0, 6)
      .map((o, i) => LETTERS[i] + ") " + cleanOption(o))
      .join("\n");
    return q.n + ") " + cleanLine(q.q) + "\n" + opts;
  });
  return (
    "You are answering a multiple-choice quiz. " +
    "Reply with ONLY a JSON object — no markdown, no code fences, no explanation — exactly like:\n" +
    '{"answers":[{"n":1,"a":"B"},{"n":2,"a":"C"}]}\n' +
    '"a" = correct option letter for question "n". Best guess if unsure.\n\n' +
    "Questions:\n\n" + parts.join("\n\n")
  );
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

// ---------- PARSING ----------
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

function parseAnswers(text) {
  if (!text) return null;
  const t = String(text).replace(/```json/gi, "").replace(/```/g, "").trim();
  const out = {};
  const m = t.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const obj = JSON.parse(m[0]);
      if (Array.isArray(obj.answers)) {
        for (const it of obj.answers) {
          const n = parseInt(it && (it.n ?? it.number ?? it.q), 10);
          const a = String((it && (it.a ?? it.ans ?? it.answer)) || "").toUpperCase();
          const L = (a.match(/\b([A-F])\b/) || [])[1];
          if (n >= 1 && L) out[n] = L;
        }
        if (Object.keys(out).length) return out;
      }
      for (const k of Object.keys(obj || {})) {
        const n = parseInt(k, 10);
        const L = (String(obj[k]).toUpperCase().match(/\b([A-F])\b/) || [])[1];
        if (n >= 1 && L) out[n] = L;
      }
      if (Object.keys(out).length) return out;
    } catch {}
  }
  // Fallback: "1. B" / "1: B" / "1) B" lines
  const re = /(\d+)\s*[:.\)\-]\s*\(?([A-F])\)?\b/g;
  let mm;
  while ((mm = re.exec(t))) {
    const n = parseInt(mm[1], 10);
    if (n >= 1 && !out[n]) out[n] = mm[2];
  }
  return Object.keys(out).length ? out : null;
}

// ---------- CHATGPT AUTOMATION ----------
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
  for (let i = 0; i < 150; i++) {
    await sleep(T_POLL);
    const stop = document.querySelector(
      '[data-testid="stop-button"], button[aria-label*="Stop" i]'
    );
    if (stop) continue;
    const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
    if (msgs.length > prevCount) {
      const txt = (msgs[msgs.length - 1].innerText || "").trim();
      if (txt) {
        await sleep(300);
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

// ---------- FLOWS ----------
let busy = false;

// BATCH: sare questions -> 1 call -> JSON answers
async function answerAllFlow(questions) {
  if (busy) return;
  busy = true;
  try {
    const mcqs = questions.filter((q) => q.type === "mcq" && (q.options || []).length >= 2);
    if (!mcqs.length) {
      sendBG({ type: "ANSWERS", answers: {} });
      return;
    }
    await maybeNewChat();

    for (let attempt = 1; attempt <= 2; attempt++) {
      sendBG({ type: "STATUS", text: "🧠 " + mcqs.length + " questions EK saath GPT ko..." + (attempt > 1 ? " (retry)" : "") });
      const composer = await waitForComposer();
      if (!composer) {
        sendBG({ type: "STATUS", text: "⚠ ChatGPT composer nahi mila — login check karo" });
        return;
      }
      const prevCount = document.querySelectorAll('[data-message-author-role="assistant"]').length;

      let prompt = buildBatchPrompt(mcqs);
      if (attempt > 1) {
        prompt += "\n\nREMINDER: Reply with ONLY the JSON object. No markdown, no explanation.";
      }

      await typeInto(composer, prompt);
      if (!clickSend()) {
        composer.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true,
        }));
      }

      const reply = await waitReply(prevCount);
      if (!reply) { sendBG({ type: "STATUS", text: "⚠ Reply nahi aya" }); continue; }

      const answers = parseAnswers(reply);
      if (answers && Object.keys(answers).length) {
        sendBG({ type: "STATUS", text: "🎯 " + Object.keys(answers).length + " answers parse ho gaye" });
        sendBG({ type: "ANSWERS", answers });
        return;
      }
      sendBG({ type: "STATUS", text: 'JSON clear nahi: "' + reply.slice(0, 50) + '"' });
    }
    sendBG({ type: "STATUS", text: "⚠ Batch parse fail — retry hoga" });
  } finally {
    busy = false;
  }
}

// SINGLE (fallback mode)
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
      sendBG({ type: "STATUS", text: "ChatGPT soch raha hai" + (attempt > 1 ? " (retry)" : "...") });
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
      if (!reply) { sendBG({ type: "STATUS", text: "⚠ Reply nahi aya" }); continue; }
      const letter = extractLetter(reply, options.length);
      if (letter) { sendBG({ type: "ANSWER", letter }); return; }
      sendBG({ type: "STATUS", text: 'Clear nahi: "' + reply.slice(0, 35) + '"' });
    }
    sendBG({ type: "STATUS", text: "⚠ Answer nahi mila — retry hoga" });
  } finally {
    busy = false;
  }
}