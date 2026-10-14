"use strict";

const status = document.getElementById("status");

function message(payload) {
  return chrome.runtime.sendMessage(payload);
}

document.getElementById("start").addEventListener("click", async () => {
  status.textContent = "Starting…";
  try {
    const result = await message({ type: "BEGIN" });
    status.textContent = result.ok ? "Quiz scan started." : result.error;
  } catch (error) {
    status.textContent = "Start failed: " + error.message;
  }
});

document.getElementById("stop").addEventListener("click", async () => {
  try {
    await message({ type: "STOP" });
    status.textContent = "Stopped.";
  } catch (error) {
    status.textContent = "Stop failed: " + error.message;
  }
});
