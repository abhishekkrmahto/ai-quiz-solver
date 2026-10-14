"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildBatchPrompt, parseBatchAnswers } = require("./gpt-protocol.js");

const questions = [
  { n: 1, q: "Which one?", options: ["First", "Second", "Third"] },
  { n: 2, q: "Pick a letter", options: ["Alpha", "Beta"] }
];

test("batch prompt contains all questions and numbered choices in one prompt", () => {
  const prompt = buildBatchPrompt(questions);
  assert.match(prompt, /Question 1: Which one\?/);
  assert.match(prompt, /Question 2: Pick a letter/);
  assert.match(prompt, /C\) Third/);
  assert.match(prompt, /evaluate each option against the exact wording/);
  assert.match(prompt, /independently re-check every selected letter/);
  assert.match(prompt, /valid JSON/);
});

test("parses complete JSON answer batches, including a code fence", () => {
  const answers = parseBatchAnswers(
    '```json\n{"answers":[{"n":1,"a":"C"},{"n":2,"a":"B"}]}\n```',
    questions
  );
  assert.deepEqual(answers, { 1: "C", 2: "B" });
});

test("rejects batches with missing, invalid, or out-of-range answers", () => {
  assert.throws(() =>
    parseBatchAnswers('{"answers":[{"n":1,"a":"A"}]}', questions),
    /Q2/
  );
  assert.throws(() =>
    parseBatchAnswers('{"answers":[{"n":1,"a":"F"},{"n":2,"a":"B"}]}', questions),
    /Q1/
  );
});

test("rejects malformed or non-JSON responses", () => {
  assert.throws(() => parseBatchAnswers("A, B", questions), /JSON object/);
  assert.throws(() => parseBatchAnswers('{"items":[]}', questions), /answers.*array/i);
});
