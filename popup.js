document.getElementById("start").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.tabs.sendMessage(tab.id, { type: "PING" }, (r) => {
    if (chrome.runtime.lastError || !r) {
      alert("Ye page pe kaam nahi karega — quiz wale tab pe jaake try karo.");
    } else {
      chrome.runtime.sendMessage({ type: "START" });
      window.close();
    }
  });
});