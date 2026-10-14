"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function createBackground(storedSession = {}) {
  let messageListener;
  let nextTabId = 90;
  const sentMessages = [];
  const chrome = {
    runtime: {
      onMessage: {
        addListener(listener) { messageListener = listener; }
      }
    },
    storage: {
      session: {
        async get(key) { return { [key]: storedSession[key] }; },
        async set(value) { Object.assign(storedSession, value); },
        async remove(key) { delete storedSession[key]; }
      }
    },
    tabs: {
      async query() { return [{ id: 42 }]; },
      async create(options) {
        sentMessages.push({ type: "createTab", options });
        return { id: nextTabId++ };
      },
      async update(tabId, options) {
        sentMessages.push({ type: "updateTab", tabId, options });
      },
      async get(tabId) {
        return { id: tabId, status: "complete", url: "https://chatgpt.com/" };
      },
      async remove(tabId) {
        sentMessages.push({ type: "removeTab", tabId });
      },
      sendMessage(tabId, message, options) {
        sentMessages.push({ tabId, message, options });
        return Promise.resolve({ ok: true });
      }
    },
  };
  const context = {
    chrome,
    Math,
    Date,
    String,
    Number,
    Object,
    Array,
    Boolean,
    Promise,
    Error,
    URL,
    setTimeout(callback, delay) {
      if (delay === 500) queueMicrotask(callback);
      return 1;
    }
  };
  vm.runInNewContext(fs.readFileSync("background.js", "utf8"), context);

  function send(message, sender = {}) {
    return new Promise((resolve) => {
      const keepChannelOpen = messageListener(message, sender, resolve);
      if (keepChannelOpen !== true) resolve(undefined);
    });
  }
  return { send, sentMessages, storedSession };
}

async function beginScanning(worker) {
  const started = await worker.send({ type: "BEGIN" });
  assert.equal(started.ok, true);
  const probe = worker.sentMessages.find((item) => item.message.type === "PROBE");
  assert.ok(probe);
  const runId = probe.message.runId;
  const quizFrame = { tab: { id: 42 }, frameId: 3 };
  const claim = await worker.send({ type: "CLAIM_FRAME", runId }, quizFrame);
  assert.equal(claim.ok, true);
  const questions = [
    { n: 1, q: "Which number is even?", options: ["One", "Two", "Three"] },
    { n: 2, q: "Which one is a color?", options: ["Blue", "Table"] }
  ];
  const ready = await worker.send({ type: "QUESTIONS_READY", runId, questions }, quizFrame);
  assert.equal(ready.ok, true);
  return { runId, quizFrame, questions };
}

test("complete batch reaches GPT and validated answers route to the claimed quiz frame", async () => {
  const worker = createBackground();
  const { runId, quizFrame, questions } = await beginScanning(worker);
  await new Promise((resolve) => setImmediate(resolve));
  const gptBatch = worker.sentMessages.find((item) =>
    item.message && item.message.type === "ANSWER_BATCH"
  );
  assert.ok(gptBatch);
  assert.equal(gptBatch.message.questions.length, questions.length);
  const chatGptTab = worker.sentMessages.find((item) => item.type === "createTab");
  assert.equal(chatGptTab.options.active, true);
  assert.equal(
    worker.sentMessages.some((item) => item.type === "executeScript"),
    false
  );
  assert.equal(worker.storedSession.activeQuizRun.state, "asking");
  assert.equal(worker.storedSession.activeQuizRun.gptTabId, 90);

  const restartedWorker = createBackground(worker.storedSession);
  const accepted = await restartedWorker.send({
    type: "BATCH_ANSWERS",
    runId,
    answers: { 1: "B", 2: "A" }
  }, { tab: { id: 90 }, frameId: 0 });
  assert.equal(accepted.ok, true);
  const activatedQuiz = restartedWorker.sentMessages.find((item) =>
    item.type === "updateTab"
  );
  assert.equal(activatedQuiz.tabId, quizFrame.tab.id);
  assert.equal(activatedQuiz.options.active, true);
  const apply = restartedWorker.sentMessages.find((item) =>
    item.message && item.message.type === "APPLY_BATCH"
  );
  assert.ok(apply);
  assert.equal(apply.tabId, quizFrame.tab.id);
  assert.equal(apply.options.frameId, quizFrame.frameId);
  assert.deepEqual(JSON.parse(JSON.stringify(apply.message.answers)), { 1: "B", 2: "A" });
});

test("incomplete GPT batch is rejected without applying any answer", async () => {
  const worker = createBackground();
  const { runId } = await beginScanning(worker);
  await new Promise((resolve) => setImmediate(resolve));

  const rejected = await worker.send({
    type: "BATCH_ANSWERS",
    runId,
    answers: { 1: "B" }
  }, { tab: { id: 90 }, frameId: 0 });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.closeGptTab, undefined);
  assert.equal(
    worker.sentMessages.some((item) => item.type === "removeTab"),
    false
  );
  assert.equal(
    worker.sentMessages.some((item) =>
      item.message && item.message.type === "APPLY_BATCH"
    ),
    false
  );
});
