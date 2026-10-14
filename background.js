"use strict";

let activeRun = null;
let gptTabId = null;
let gptTabOwned = false;
const RUN_STORAGE_KEY = "activeQuizRun";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  restoreRun()
    .then(() => handleMessage(message, sender))
    .then((result) => {
      sendResponse(result);
      if (result && result.closeGptTab) {
        setTimeout(() => closeGptTab(), 250);
      }
    })
    .catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      const tabId = (activeRun && activeRun.tabId) || (sender.tab && sender.tab.id);
      sendStatus("Automation error: " + detail, tabId);
      sendResponse({ ok: false, error: detail });
      if (activeRun && sender.tab && sender.tab.id === activeRun.gptTabId) {
        void failRun("ChatGPT response process nahi hua: " + detail);
      }
    });
  return true;
});

async function handleMessage(message, sender) {
  switch (message && message.type) {
    case "BEGIN": {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || tab.id == null) return { ok: false, error: "Quiz tab nahi mila." };
      if (activeRun) return { ok: false, error: "Ek quiz flow pehle se chal raha hai." };

      await closeGptTab();
      const runId = Date.now() + "-" + Math.random().toString(36).slice(2);
      activeRun = {
        runId,
        tabId: tab.id,
        frameId: null,
        state: "scanning",
        questions: [],
        answers: null,
        gptTabId: null
      };
      await persistRun();
      sendStatus("Quiz question wala frame dhoondh raha hun...");
      try {
        await chrome.tabs.sendMessage(tab.id, { type: "PROBE", runId });
      } catch {
        activeRun = null;
        return { ok: false, error: "Extension reload karke quiz page refresh karein." };
      }

      setTimeout(() => {
        if (activeRun && activeRun.runId === runId && activeRun.frameId === null) {
          void failRun("Quiz question/frame nahi mila; quiz dialog open karke phir Start karein.");
        }
      }, 8000);
      return { ok: true };
    }

    case "CLAIM_FRAME":
      if (!activeRun || activeRun.state !== "scanning" ||
          !sender.tab || sender.tab.id !== activeRun.tabId ||
          message.runId !== activeRun.runId) return { ok: false };
      if (activeRun.frameId !== null && activeRun.frameId !== sender.frameId) {
        return { ok: false };
      }
      activeRun.frameId = sender.frameId ?? 0;
      await persistRun();
      sendStatus("Quiz frame mil gaya — sare questions scan ho rahe hain...");
      return { ok: true };

    case "QUESTIONS_READY":
      if (!isActiveQuizFrame(sender) || activeRun.state !== "scanning" ||
          message.runId !== activeRun.runId) {
        return { ok: false, error: "Quiz scan session expire ho gaya; Start dobara dabayein." };
      }
      if (!Array.isArray(message.questions) || !message.questions.length ||
          message.questions.length > 60) {
        return { ok: false, error: "Scan se valid question batch nahi mila." };
      }
      activeRun.questions = message.questions;
      activeRun.state = "asking";
      await persistRun();
      void askChatGPT(activeRun.runId);
      return { ok: true };

    case "BATCH_ANSWERS": {
      if (!activeRun || activeRun.state !== "asking" ||
          !sender.tab || sender.tab.id !== activeRun.gptTabId ||
          message.runId !== activeRun.runId) return { ok: false };
      const checked = validateAnswers(activeRun.questions, message.answers);
      if (!checked.ok) {
        await failRun("ChatGPT ne tamam valid answers nahi diye: " + checked.error);
        return { ok: false, error: checked.error };
      }

      activeRun.answers = checked.answers;
      activeRun.state = "applying";
      await persistRun();
      sendStatus("✅ ChatGPT ke " + Object.keys(checked.answers).length +
        " answers mile; quiz tab par laut raha hun...");
      await chrome.tabs.update(activeRun.tabId, { active: true });
      const applied = await sendToQuiz({
        type: "APPLY_BATCH",
        runId: activeRun.runId,
        answers: checked.answers
      });
      if (!applied || !applied.ok) {
        const error = applied && applied.error
          ? applied.error
          : "Quiz frame ne answers apply command accept nahi kiya.";
        await failRun(error);
        return { ok: false, error };
      }
      return { ok: true, closeGptTab: true };
    }

    case "PAUSED":
      if (isActiveQuizFrame(sender)) {
        sendStatus("⏸ " + String(message.text || "Quiz flow pause hua."));
        activeRun = null;
        await persistRun();
      }
      return { ok: true };

    case "FINISHED":
      if (isActiveQuizFrame(sender)) {
        sendStatus("🎉 Quiz submit/finish complete.");
        activeRun = null;
        await persistRun();
      }
      return { ok: true };

    case "GPT_ERROR":
      if (activeRun && sender.tab && sender.tab.id === activeRun.gptTabId &&
          message.runId === activeRun.runId) {
        await failRun(String(message.error || "ChatGPT se valid answer nahi mila."));
        return { ok: true };
      }
      return { ok: false };

    case "STOP":
      if (activeRun) {
        await sendToQuiz({ type: "CANCEL" });
        activeRun = null;
        await persistRun();
      }
      await closeGptTab();
      sendStatus("Automation stop kar diya.");
      return { ok: true };

    case "STATUS":
      if (activeRun && sender.tab && sender.tab.id === activeRun.gptTabId) {
        sendStatus(String(message.text || ""), activeRun.tabId);
      } else if (sender.tab && (!activeRun || sender.tab.id === activeRun.tabId)) {
        sendStatus(String(message.text || ""), sender.tab.id);
      }
      return { ok: true };

    default:
      return { ok: false, error: "Unknown extension command." };
  }
}

async function askChatGPT(runId) {
  try {
    const tab = await chrome.tabs.create({ url: "https://chatgpt.com/", active: true });
    if (!activeRun || activeRun.runId !== runId) {
      if (tab.id != null) await chrome.tabs.remove(tab.id);
      return;
    }
    gptTabId = tab.id;
    gptTabOwned = true;
    activeRun.gptTabId = tab.id;
    await persistRun();
    sendStatus("💬 ChatGPT khula — ek batch mein " + activeRun.questions.length + " questions bhej raha hun...");

    const pageReady = await waitForChatGptPage(tab.id, 120, 500);
    if (!pageReady) {
      await failRun("ChatGPT page load nahi hui. Login/network check karke dobara Start karein.");
      return;
    }
    const sent = await sendMessageWithRetry(tab.id, {
      type: "ANSWER_BATCH",
      runId,
      questions: activeRun.questions
    }, 40, 500);
    if (!sent) {
      await failRun("ChatGPT page ready nahi hui. Login/page load check karke dobara Start karein.");
      return;
    }
    sendStatus("🧠 ChatGPT request start hui; prompt aur send confirmation ka wait...");
    setTimeout(() => {
      if (activeRun && activeRun.runId === runId && activeRun.state === "asking") {
        void failRun("ChatGPT se response ka wait timeout hua; tab mein response check karein.");
      }
    }, 300000);
  } catch (error) {
    await failRun("ChatGPT tab open nahi hua: " + error.message);
  }
}

async function waitForChatGptPage(tabId, attempts, delay) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (!activeRun || activeRun.gptTabId !== tabId) return false;
    try {
      const tab = await chrome.tabs.get(tabId);
      const url = new URL(tab.url);
      if (tab.status === "complete" &&
          (url.hostname === "chatgpt.com" || url.hostname === "chat.openai.com")) {
        return true;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  return false;
}

function validateAnswers(questions, rawAnswers) {
  if (!rawAnswers || typeof rawAnswers !== "object") {
    return { ok: false, error: "JSON answer object missing." };
  }
  const answers = {};
  for (const question of questions) {
    const letter = String(rawAnswers[question.n] || "").toUpperCase();
    const index = letter.charCodeAt(0) - 65;
    if (letter.length !== 1 || index < 0 || index >= question.options.length) {
      return { ok: false, error: "Q" + question.n + " ka answer missing/invalid." };
    }
    answers[question.n] = letter;
  }
  return { ok: true, answers };
}

async function sendToQuiz(message) {
  if (!activeRun || activeRun.frameId === null) return null;
  try {
    return await chrome.tabs.sendMessage(activeRun.tabId, message, {
      frameId: activeRun.frameId
    });
  } catch {
    return null;
  }
}

async function sendMessageWithRetry(tabId, message, retries, delay) {
  for (let attempt = 0; attempt < retries; attempt++) {
    if (!activeRun || activeRun.gptTabId !== tabId) return false;
    try {
      const response = await chrome.tabs.sendMessage(tabId, message);
      if (response && response.ok) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  return false;
}

async function failRun(text) {
  sendStatus("⏸ " + text);
  if (activeRun) await sendToQuiz({ type: "CANCEL" });
  activeRun = null;
  await persistRun();
}

async function restoreRun() {
  if (activeRun) return;
  const stored = await chrome.storage.session.get(RUN_STORAGE_KEY);
  activeRun = stored[RUN_STORAGE_KEY] || null;
  if (activeRun && activeRun.gptTabId != null) {
    gptTabId = activeRun.gptTabId;
    gptTabOwned = true;
  }
}

async function persistRun() {
  if (activeRun) {
    await chrome.storage.session.set({ [RUN_STORAGE_KEY]: activeRun });
  } else {
    await chrome.storage.session.remove(RUN_STORAGE_KEY);
  }
}

async function closeGptTab() {
  const tabId = gptTabId;
  const owned = gptTabOwned;
  gptTabId = null;
  gptTabOwned = false;
  if (!owned || tabId == null) return;
  try { await chrome.tabs.remove(tabId); } catch {}
}

function isActiveQuizFrame(sender) {
  return Boolean(
    activeRun && sender.tab && sender.tab.id === activeRun.tabId &&
    activeRun.frameId === (sender.frameId ?? 0)
  );
}

function sendStatus(text, tabId = activeRun && activeRun.tabId) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, { type: "STATUS", text }).catch(() => {});
}
