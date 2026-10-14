"use strict";

const LETTERS = ["A", "B", "C", "D", "E", "F"];
const IS_TOP = window.top === window;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function validLetter(letter, optionCount) {
  const value = String(letter || "").toUpperCase();
  const index = LETTERS.indexOf(value);
  return value.length === 1 && index >= 0 && index < optionCount ? value : null;
}

let flowId = 0;
let running = false;
let questions = [];
let automationClick = false;
let currentRunId = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "STATUS") {
    if (IS_TOP) showStatus(message.text);
    return;
  }
  if (message.type === "CANCEL") {
    flowId++;
    running = false;
    questions = [];
    currentRunId = null;
    sendResponse({ ok: true });
    return;
  }
  if (message.type === "APPLY_BATCH") {
    if (running || message.runId !== currentRunId || !questions.length) {
      sendResponse({
        ok: false,
        error: running
          ? "Quiz frame abhi scan/apply kar raha hai."
          : "Quiz scan session expire ho gaya; Start dobara dabayein."
      });
      return;
    }
    const currentFlow = flowId;
    running = true;
    applyKnownAnswers(currentFlow, message.answers, questions.length)
      .then((applied) => {
        sendResponse(applied
          ? { ok: true }
          : { ok: false, error: "Quiz answer apply/submit complete nahi hua." });
      })
      .catch(async (error) => {
        const detail = error instanceof Error ? error.message : String(error);
        await pauseFlow(currentFlow, "Answer apply failed: " + detail);
        sendResponse({ ok: false, error: detail });
      })
      .finally(() => {
        if (flowId === currentFlow) running = false;
      });
    return true;
  }
  if (message.type === "PROBE") {
    if (running || !getQuestion() || getOptionCards().length < 2) return;
    sendResponse({ ok: true });
    currentRunId = message.runId;
    claimAndRun(message.runId);
    return;
  }
});

async function claimAndRun(runId) {
  running = true;
  const currentFlow = ++flowId;
  try {
    const claim = await chrome.runtime.sendMessage({ type: "CLAIM_FRAME", runId });
    if (!claim || !claim.ok) return;
    await runQuiz(currentFlow);
  } catch (error) {
    pauseFlow(currentFlow, "Quiz start nahi hua: " + error.message);
  } finally {
    if (flowId === currentFlow) running = false;
  }
}

async function runQuiz(currentFlow) {
  const badge = parseBadge();
  if (!badge || badge.total < 1 || badge.total > 60) {
    pauseFlow(currentFlow, "Question count detect nahi hua (ya 60 se zyada hai); safe stop.");
    return;
  }

  setStatus("📦 " + badge.total + " questions scan ho rahe hain...");
  const list = await collectAll(currentFlow, badge.total);
  if (isStale(currentFlow)) return;
  if (list.length !== badge.total) {
    pauseFlow(currentFlow, "Sirf " + list.length + "/" + badge.total + " questions scan hue; submit nahi kiya.");
    return;
  }

  questions = list;
  setStatus("📤 Sare " + list.length + " questions ek saath ChatGPT ko bhej raha hun...");
  const result = await chrome.runtime.sendMessage({
    type: "QUESTIONS_READY",
    runId: currentRunId,
    questions: list
  });
  if (!result || !result.ok) {
    pauseFlow(currentFlow, (result && result.error) || "ChatGPT ko questions nahi bhej paya.");
  }
}

async function collectAll(currentFlow, total) {
  const list = [];
  while (list.length < total) {
    if (isStale(currentFlow)) return list;
    const question = await waitForQuestion(currentFlow, 8000);
    if (!question) return list;

    const cards = getOptionCards();
    if (cards.length < 2) return list;
    const options = cards.map((card) => optionText(card));
    if (options.some((option) => !option)) return list;
    list.push({ n: list.length + 1, q: question, options });
    setStatus("📦 Scanned " + list.length + "/" + total);

    const badge = parseBadge();
    if (badge && badge.cur >= badge.total) break;
    if (!badge || badge.total !== total) return list;

    const advanced = await advanceNext(currentFlow, question, badge.cur);
    if (advanced !== true) return list;
  }
  return list;
}

async function advanceNext(currentFlow, previousQuestion, previousNumber) {
  let next = await waitForNext(5);
  if (!next) {
    const firstCard = getOptionCards()[0];
    if (!firstCard) {
      setStatus("➡️ Q" + previousNumber + ": Next button nahi mila aur temporary option bhi detect nahi hua.");
      return false;
    }
    await clickAutomation(firstCard);
    next = await waitForNext(8);
  }
  if (!next) {
    setStatus("➡️ Q" + previousNumber + ": option select kiya, lekin enabled Next/Submit control nahi mila.");
    return false;
  }
  if (isStale(currentFlow)) return false;
  await clickAutomation(next);
  const advanced = await waitForQuestionChange(currentFlow, previousQuestion, previousNumber);
  if (!advanced) {
    setStatus("➡️ Q" + previousNumber + ": Next click ke baad agla question nahi khula.");
  }
  return advanced;
}

async function applyKnownAnswers(currentFlow, answers, total) {
  const quizReady = await waitForReturnedQuiz(currentFlow, 120000);
  if (!quizReady) {
    return pauseFlow(currentFlow, "Quiz fullscreen ready nahi hua; Enter Full Screen manually click karke dobara Start karein.");
  }
  setStatus("⏪ ChatGPT answers mil gaye; quiz ke pehle question par ja raha hun...");
  const first = await goBackToFirst(currentFlow);
  if (!first) {
    return pauseFlow(currentFlow, "Answers mil gaye, lekin quiz ke pehle question par wapas nahi ja saka; submit nahi kiya.");
  }

  for (let index = 0; index < questions.length; index++) {
    if (isStale(currentFlow)) return;
    const question = getQuestion();
    const entry = questions[index];
    if (!question || normalizeText(question) !== normalizeText(entry.q)) {
      return pauseFlow(currentFlow, "Q" + entry.n + " par page match nahi hui; submit nahi kiya.");
    }

    const letter = validLetter(answers[entry.n], entry.options.length);
    if (!letter) {
      return pauseFlow(currentFlow, "Q" + entry.n + " ka answer nahi mila. Is aur baaki questions ko manually check karein; submit nahi kiya.");
    }
    const card = getOptionCards()[LETTERS.indexOf(letter)];
    if (!card) {
      return pauseFlow(currentFlow, "Q" + entry.n + " ka option nahi mila; submit nahi kiya.");
    }
    const cards = getOptionCards();
    const alreadySelected = isSelected(card, cards);
    const beforeClick = selectionFingerprint(card);
    if (!alreadySelected) await clickAutomation(card);
    if (!await waitForSelection(card, cards, beforeClick, 1500)) {
      return pauseFlow(currentFlow, "Q" + entry.n + " ka answer select verify nahi hua; submit nahi kiya.");
    }
    setStatus("✓ Q" + entry.n + "/" + total + " = " + letter);

    const previousNumber = parseBadge()?.cur;
    const next = await waitForNext(8);
    if (!next) {
      return pauseFlow(currentFlow, "Q" + entry.n + " par Next/Submit disabled; manually check karein.");
    }
    await clickAutomation(next);
    if (index < questions.length - 1) {
      const moved = await waitForQuestionChange(currentFlow, entry.q, previousNumber);
      if (!moved) {
        return pauseFlow(currentFlow, "Q" + entry.n + " se aage nahi badha; submit nahi kiya.");
      }
    } else {
      const finished = await waitForFinish(currentFlow, entry.q);
      if (!finished) {
        return pauseFlow(currentFlow, "Submit confirm nahi hua; page manually check karein.");
      }
    }
  }

  await chrome.runtime.sendMessage({ type: "FINISHED" });
  return true;
}

async function waitForReturnedQuiz(currentFlow, maxMs) {
  const end = Date.now() + maxMs;
  let fullscreenStatusShown = false;
  while (Date.now() < end) {
    if (isStale(currentFlow)) return false;
    if (isFullscreenGateVisible()) {
      if (!fullscreenStatusShown) {
        setStatus("🖥️ Quiz fullscreen maang raha hai — Enter Full Screen click karein; main wait kar raha hun...");
        fullscreenStatusShown = true;
      }
      await sleep(500);
      continue;
    }
    if (getQuestion() && getOptionCards().length >= 2) return true;
    await sleep(300);
  }
  return false;
}

function isFullscreenGateVisible() {
  const text = (document.body && document.body.innerText || "").toLowerCase();
  return text.includes("full screen required") ||
    text.includes("enter full screen");
}

async function goBackToFirst(currentFlow) {
  const first = normalizeText(questions[0] && questions[0].q);
  const maxSteps = Math.min(60, Math.max(1, questions.length + 2));
  for (let i = 0; i < maxSteps; i++) {
    if (isStale(currentFlow)) return false;
    const question = await waitForQuestion(currentFlow, 2500);
    const badge = parseBadge();
    if (question && normalizeText(question) === first &&
        (!badge || badge.cur === 1)) return true;
    if (!question || (badge && badge.cur <= 1)) return false;
    const back = findPreviousButton();
    if (!back) {
      setStatus("⏪ Q" + (badge ? badge.cur : "?") +
        " se Q1 par lautne ke liye Previous button nahi mila.");
      return false;
    }
    const previousNumber = badge && badge.cur;
    await clickAutomation(back);
    if (!await waitForPreviousQuestion(currentFlow, question, previousNumber)) {
      setStatus("⏪ Previous click ke baad quiz question nahi badla.");
      return false;
    }
  }
  return false;
}

async function waitForPreviousQuestion(currentFlow, previousQuestion, previousNumber) {
  const previous = normalizeText(previousQuestion);
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    if (isStale(currentFlow)) return false;
    const question = getQuestion();
    const badge = parseBadge();
    if (question && (
      normalizeText(question) !== previous ||
      (previousNumber && badge && badge.cur < previousNumber)
    )) return true;
    await sleep(200);
  }
  return false;
}

async function waitForQuestion(currentFlow, maxMs) {
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    if (isStale(currentFlow)) return null;
    const question = getQuestion();
    if (question) return question;
    await sleep(200);
  }
  return null;
}

async function waitForQuestionChange(currentFlow, previousQuestion, previousNumber) {
  const previous = normalizeText(previousQuestion);
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    if (isStale(currentFlow)) return false;
    const question = getQuestion();
    if (!question) {
      await sleep(200);
      continue;
    }
    const badge = parseBadge();
    if (normalizeText(question) !== previous ||
        (previousNumber && badge && badge.cur > previousNumber)) return true;
    await sleep(200);
  }
  return false;
}

async function waitForFinish(currentFlow, previousQuestion) {
  const end = Date.now() + 8000;
  let emptySince = null;
  while (Date.now() < end) {
    if (isStale(currentFlow)) return false;
    const question = getQuestion();
    if (!question) {
      if (emptySince === null) emptySince = Date.now();
      if (Date.now() - emptySince >= 1200) return true;
    } else {
      emptySince = null;
    }
    await sleep(250);
  }
  return false;
}

async function waitForNext(polls) {
  for (let i = 0; i < polls; i++) {
    const button = findNextButton();
    if (button && !button.disabled && button.getAttribute("aria-disabled") !== "true") {
      return button;
    }
    await sleep(250);
  }
  return null;
}

async function waitForSelection(card, cards, beforeClick, maxMs) {
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    if (isSelected(card, cards) || selectionFingerprint(card) !== beforeClick) return true;
    await sleep(150);
  }
  return false;
}

async function clickAutomation(element) {
  automationClick = true;
  try {
    element.scrollIntoView({ block: "center", inline: "nearest" });
    element.click();
  } finally {
    setTimeout(() => { automationClick = false; }, 0);
  }
  await sleep(200);
}

function pauseFlow(currentFlow, text) {
  if (isStale(currentFlow)) return Promise.resolve(false);
  return chrome.runtime.sendMessage({ type: "PAUSED", text })
    .then(() => false);
}

function isStale(currentFlow) {
  return currentFlow !== flowId;
}

function parseBadge() {
  const scope = getScope();
  if (!scope) return null;
  const text = (scope.innerText || "") + " " + (document.body.innerText || "").slice(0, 3000);
  const match = text.match(/QUESTION\s+(\d+)\s+OF\s+(\d+)/i);
  return match ? { cur: Number(match[1]), total: Number(match[2]) } : null;
}

function getScope() {
  const dialog = document.querySelector(
    '[role="dialog"], [data-slot="dialog-content"], [class*="modal" i], [class*="dialog" i]'
  );
  if (dialog && isVisible(dialog)) return dialog;
  if (findOptionCards(document).length >= 2 || !IS_TOP) return document;
  return null;
}

function getQuestion() {
  const scope = getScope();
  if (!scope) return null;
  const nodes = [...scope.querySelectorAll("p,div,span,h1,h2,h3,h4")]
    .filter((element) => {
      if (element.children.length || !isVisible(element) ||
          element.closest("button, [role='button'], #lqh-root")) return false;
      const text = element.innerText.trim();
      return text.length >= 15 && text.length <= 600 &&
        !/^question\s+\d+\s+of\s+\d+$/i.test(text);
    });
  nodes.sort((a, b) => {
    const aText = a.innerText.trim(), bText = b.innerText.trim();
    const aScore = (/[?:]/.test(aText) ? 10000 : 0) + aText.length;
    const bScore = (/[?:]/.test(bText) ? 10000 : 0) + bText.length;
    return bScore - aScore;
  });
  return nodes[0] ? nodes[0].innerText.trim() : null;
}

function getOptionCards() {
  const scope = getScope();
  return scope ? findOptionCards(scope) : [];
}

function findOptionCards(root) {
  const result = [];
  const candidates = root.querySelectorAll("button, [role='radio'], [role='button'], label");
  for (const element of candidates) {
    if (!isVisible(element) || element.closest("#lqh-root")) continue;
    const text = (element.innerText || element.textContent || "").trim();
    const badge = element.querySelector("span")?.innerText.trim();
    const match = (badge && /^([A-F])$/.exec(badge)) ||
      /^\(?([A-F])(?:\s*[.):\-]\s*|\s+)\S/.exec(text);
    if (!match) continue;
    const letter = match[1];
    const card = element.matches("label") ? element :
      (element.closest("[role='radio']") || element.closest("button") || element);
    if (!result.some((item) => item.element === card)) result.push({ letter, element: card });
  }
  result.sort((a, b) => LETTERS.indexOf(a.letter) - LETTERS.indexOf(b.letter));
  return result.map((item) => item.element);
}

function optionText(card) {
  const text = (card.innerText || card.textContent || "").trim();
  return text.replace(/^\s*\(?[A-F][\s.):\-]+/, "").replace(/\s+/g, " ").trim();
}

function findNextButton() {
  const labeled = findButton(/next|submit|finish|check answers/i);
  if (labeled) return labeled;

  const scope = getScope() || document;
  const scopeRect = scope === document
    ? { left: 0, bottom: window.innerHeight, width: window.innerWidth }
    : scope.getBoundingClientRect();
  const options = getOptionCards();
  const footerButtons = [...scope.querySelectorAll(
    "button, [role='button'], input[type='button'], input[type='submit']"
  )].filter((button) => {
    if (button.closest("#lqh-root") || !isVisible(button)) return false;
    if (options.some((card) => card === button || card.contains(button) || button.contains(card))) {
      return false;
    }
    const label = buttonLabel(button);
    if (/cancel|back|previous|close/i.test(label)) return false;
    const rect = button.getBoundingClientRect();
    return rect.bottom >= scopeRect.bottom - 115 &&
      rect.left >= scopeRect.left + scopeRect.width * 0.55;
  });
  footerButtons.sort((a, b) =>
    b.getBoundingClientRect().right - a.getBoundingClientRect().right
  );
  return footerButtons[0] || null;
}

function findButton(pattern) {
  const scope = getScope() || document;
  return [...scope.querySelectorAll("button, [role='button']")]
    .find((button) => !button.closest("#lqh-root") && isVisible(button) &&
      pattern.test(buttonLabel(button))) || null;
}

function findPreviousButton() {
  const scope = getScope() || document;
  const candidates = [...scope.querySelectorAll(
    "button, [role='button'], input[type='button'], input[type='submit']"
  )].filter((button) =>
    !button.closest("#lqh-root") && isVisible(button) &&
    !button.disabled && button.getAttribute("aria-disabled") !== "true" &&
    !isOptionControl(button)
  );
  const labeled = candidates.find((button) =>
    /back|previous|prev(?:ious)?(?:\s|$)|question before|chevron-left|arrow-left|navigate-back/i
      .test(buttonLabel(button))
  ) || null;
  if (labeled) return labeled;

  const next = findNextButton();
  if (!next) return null;
  for (let parent = next.parentElement, depth = 0;
       parent && parent !== scope && depth < 5;
       parent = parent.parentElement, depth++) {
    const siblings = candidates.filter((button) => parent.contains(button));
    const nextIndex = siblings.indexOf(next);
    if (nextIndex < 1) continue;
    for (let index = nextIndex - 1; index >= 0; index--) {
      const candidate = siblings[index];
      const hasNavigationHint = candidate.matches(
        "input[type='button'], input[type='submit']"
      ) || candidate.querySelector("svg, [data-icon], [class*='icon' i]") ||
        candidate.hasAttribute("aria-label") || candidate.hasAttribute("title") ||
        candidate.hasAttribute("data-testid") || candidate.hasAttribute("data-cy");
      if (hasNavigationHint &&
          candidate.getBoundingClientRect().left < next.getBoundingClientRect().left) {
        return candidate;
      }
    }
  }
  return null;
}

function isOptionControl(element) {
  return getOptionCards().some((card) =>
    card === element || card.contains(element) || element.contains(card)
  );
}

function buttonLabel(button) {
  return [
    button.innerText,
    button.textContent,
    button.getAttribute("aria-label"),
    button.getAttribute("title"),
    button.getAttribute("data-testid"),
    button.getAttribute("data-cy")
  ].filter(Boolean).join(" ").trim();
}

function isSelected(element, siblingCards) {
  const candidates = [element, ...element.querySelectorAll(
    "[aria-checked], [aria-pressed], [aria-selected], [data-state], input[type='radio'], input[type='checkbox']"
  )];
  for (const candidate of candidates) {
    const aria = candidate.getAttribute("aria-checked") ??
      candidate.getAttribute("aria-pressed") ??
      candidate.getAttribute("aria-selected");
    if (aria !== null) return aria === "true";
    if (candidate.matches("input[type='radio'], input[type='checkbox']")) return candidate.checked;
    const state = candidate.getAttribute("data-state");
    if (state === "checked" || state === "on") return true;
    if (state === "unchecked" || state === "off") return false;
  }
  if (/\b(selected|checked|active)\b/i.test(String(element.className))) return true;
  const cards = siblingCards || getOptionCards();
  if (cards.length < 2) return false;
  const signature = selectionFingerprint(element);
  const signatures = cards.map(selectionFingerprint);
  return signatures.filter((item) => item === signature).length === 1 &&
    new Set(signatures).size > 1;
}

function selectionFingerprint(element) {
  const style = getComputedStyle(element);
  return [
    element.className,
    element.getAttribute("aria-checked"),
    element.getAttribute("aria-pressed"),
    element.getAttribute("aria-selected"),
    element.getAttribute("data-state"),
    style.backgroundColor,
    style.borderColor,
    style.boxShadow,
    style.color
  ].join("|");
}

function isVisible(element) {
  const rect = element.getBoundingClientRect();
  return rect.width > 5 && rect.height > 5 &&
    getComputedStyle(element).visibility !== "hidden";
}

function setStatus(text) {
  chrome.runtime.sendMessage({ type: "STATUS", text }).catch(() => {});
}

function showStatus(text) {
  const root = ensurePanel();
  const line = document.createElement("div");
  line.textContent = "• " + text;
  line.style.cssText = "margin-top:4px;overflow-wrap:anywhere";
  root.querySelector("#lqh-log").appendChild(line);
  while (root.querySelector("#lqh-log").children.length > 8) {
    root.querySelector("#lqh-log").firstElementChild.remove();
  }
}

function ensurePanel() {
  let root = document.getElementById("lqh-root");
  if (root) return root;
  root = document.createElement("div");
  root.id = "lqh-root";
  root.style.cssText = "all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647";
  root.innerHTML = '<div style="width:260px;padding:10px;background:#172033;color:#fff;border-radius:9px;font:12px system-ui,sans-serif;box-shadow:0 3px 16px #0006"><b>Local Quiz Helper</b><div id="lqh-log" style="max-height:130px;overflow:auto;margin-top:5px"></div></div>';
  (document.fullscreenElement || document.body).appendChild(root);
  return root;
}
