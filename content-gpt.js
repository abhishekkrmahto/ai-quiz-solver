"use strict";

(function installChatGptContent(root) {
if (root.__quizBatchChatGptContentInstalled) return;
root.__quizBatchChatGptContentInstalled = true;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const POLL_MS = 400;
let answering = false;
let activeRunId = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "ANSWER_BATCH") return;
  if (answering) {
    sendResponse({ ok: false, error: "ChatGPT request already running." });
    return;
  }
  if (!Array.isArray(message.questions) || !message.questions.length) {
    sendResponse({ ok: false, error: "Question batch empty." });
    return;
  }

  answering = true;
  activeRunId = message.runId;
  sendResponse({ ok: true });
  answerBatch(message.runId, message.questions)
    .catch(async (error) => {
      await sendStatus("ChatGPT error: " + error.message);
      await chrome.runtime.sendMessage({
        type: "GPT_ERROR",
        runId: message.runId,
        error: error.message
      }).catch(() => {});
    })
    .finally(() => {
      answering = false;
      activeRunId = null;
    });
});

async function answerBatch(runId, questions) {
  await startFreshChat();
  const prompt = GptProtocol.buildBatchPrompt(questions);
  let reply = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    await sendStatus("🧠 ChatGPT ko sare " + questions.length + " questions ek saath bhej raha hun" +
      (attempt > 1 ? " (JSON retry)" : "..."));
    const composer = await waitForComposer(60);
    if (!composer) throw new Error("Composer nahi mila; ChatGPT login/page check karein.");
    const attemptPrompt = attempt === 1 ? prompt :
      prompt + "\n\nReminder: return complete valid JSON only.";
    const previousReplies = new Set(readAssistantReplies());
    await typeInto(composer, attemptPrompt);
    await sendStatus("✍️ Question batch composer mein likha; verify kar raha hun...");
    if (!composerContains(composer, attemptPrompt)) {
      throw new Error("ChatGPT composer mein prompt enter nahi hua; text manually check karein.");
    }
    await sendStatus("⏳ ChatGPT Send button ready hone ka wait...");
    const submitted = await submitPrompt(composer, 20);
    if (!submitted) {
      throw new Error("Prompt composer mein hai, lekin Send button/form submit nahi hua.");
    }
    await sendStatus("📤 Send click kiya; ChatGPT ke valid answer ka wait...");
    reply = await waitForReply(previousReplies, 240, questions);
    if (!reply) continue;
    await sendStatus("💬 ChatGPT ka jawab mil gaya; JSON validate karke quiz ko bhej raha hun...");

    let answers;
    try {
      answers = GptProtocol.parseBatchAnswers(reply, questions);
    } catch (error) {
      if (attempt === 2) throw error;
      await sendStatus("⚠ Answer JSON incomplete/invalid; ek baar poora batch retry...");
      continue;
    }
    await sendStatus("✅ ChatGPT se " + Object.keys(answers).length +
      "/" + questions.length + " valid answers mile; quiz apply ho raha hai...");
    const result = await chrome.runtime.sendMessage({
      type: "BATCH_ANSWERS",
      runId,
      answers
    });
    if (!result || !result.ok) {
      throw new Error((result && result.error) || "Quiz ne answer batch accept nahi kiya.");
    }
    return;
  }
  throw new Error("ChatGPT reply timeout hua; login/network check karke dobara Start karein.");
}

async function startFreshChat() {
  const newChat = document.querySelector(
    'button[aria-label="New chat"], a[aria-label="New chat"], a[href="/"]'
  );
  if (assistantMessages().length && newChat) {
    newChat.click();
    await sleep(1200);
  }
}

async function waitForComposer(polls) {
  for (let index = 0; index < polls; index++) {
    const composer = [...document.querySelectorAll(
      "#prompt-textarea, [data-testid='prompt-textarea'], textarea[placeholder], [contenteditable='true']"
    )].find((element) =>
      isVisible(element) &&
      element.getAttribute("aria-disabled") !== "true" &&
      !element.disabled &&
      !element.closest("#search, [role='search']")
    );
    if (composer) return composer;
    await sleep(POLL_MS);
  }
  return null;
}

async function typeInto(element, text) {
  element.focus();
  await sleep(100);
  if (element instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    ).set;
    setter.call(element, text);
    element.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: text
    }));
  } else {
    const selection = document.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
    const inserted = document.execCommand("insertText", false, text);
    if (!inserted || !composerContains(element, text)) {
      element.replaceChildren(document.createTextNode(text));
    }
    element.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: text
    }));
  }
  await sleep(150);
  if (!composerContains(element, text)) {
    throw new Error("ChatGPT composer ne prompt enter nahi kiya; input manually check karein.");
  }
}

function composerContains(element, text) {
  const value = element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
    ? element.value
    : element.innerText || element.textContent || "";
  return value.trim() === text.trim();
}

async function submitPrompt(composer, polls) {
  for (let index = 0; index < polls; index++) {
    const form = composer.closest("form");
    const candidates = document.querySelectorAll(
      'button[data-testid*="send" i], button[aria-label*="send" i], button[title*="send" i], button[type="submit"], input[type="submit"]'
    );
    const button = [...candidates].find((element) =>
      isVisible(element) &&
      !element.disabled &&
      element.getAttribute("aria-disabled") !== "true" &&
      (!form || form.contains(element) ||
        element.matches('[data-testid*="send" i], [aria-label*="send" i], [title*="send" i]'))
    );
    if (button) {
      button.click();
      return true;
    }
    if (form && index === Math.min(9, polls - 1)) {
      form.requestSubmit();
      return true;
    }
    await sleep(POLL_MS);
  }
  return false;
}

function assistantMessages() {
  return [...document.querySelectorAll('[data-message-author-role="assistant"]')];
}

async function waitForReply(previousReplies, polls, questions) {
  let lastText = "";
  let stablePolls = 0;
  for (let index = 0; index < polls; index++) {
    await sleep(POLL_MS);
    const replies = readAssistantReplies().filter((text) => !previousReplies.has(text));
    for (const current of replies.reverse()) {
      try {
        GptProtocol.parseBatchAnswers(current, questions);
        return current;
      } catch {}
      if (current === lastText) {
        stablePolls++;
        if (!isGenerating() && stablePolls >= 3) return current;
      } else {
        lastText = current;
        stablePolls = 0;
      }
    }
    if (isGenerating()) stablePolls = 0;
  }
  return null;
}

function readAssistantReplies() {
  const marked = [...document.querySelectorAll(
    '[data-message-author-role="assistant"], [data-testid*="assistant-message" i]'
  )];
  const fallback = [...document.querySelectorAll(
    "main p, main pre, main code, main [class*='markdown' i], main [data-testid^='conversation-turn-']"
  )].filter((element) => {
    if (element.closest(
      '[data-message-author-role="user"], #prompt-textarea, [contenteditable="true"]'
    )) return false;
    const text = (element.innerText || element.textContent || "").trim();
    return text.length > 10 && text.length <= 12000 &&
      /["']answers["']\s*:|\{\s*["']answers["']/i.test(text) &&
      !/Answer every multiple-choice question below/i.test(text);
  });
  const seen = new Set();
  return [...marked, ...fallback]
    .filter(isVisible)
    .map((element) => (element.innerText || element.textContent || "").trim())
    .filter((text) => {
      if (!text || seen.has(text)) return false;
      seen.add(text);
      return true;
    });
}

function isGenerating() {
  return [...document.querySelectorAll(
    '[data-testid="stop-button"], button[aria-label*="Stop generating" i]'
  )].some((button) => {
    const style = getComputedStyle(button);
    const rect = button.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 &&
      style.visibility !== "hidden" && style.display !== "none";
  });
}

function isVisible(element) {
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 &&
    style.visibility !== "hidden" && style.display !== "none";
}

function sendStatus(text) {
  return chrome.runtime.sendMessage({ type: "STATUS", text }).catch(() => null);
}
})(globalThis);
