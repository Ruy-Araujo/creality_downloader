window.addEventListener("pagehide", () => {
  chrome.runtime.sendMessage({ type: "clear-cache" }).catch(() => {});
}, { once: true });
