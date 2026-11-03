const state = document.querySelector("#state");
const detail = document.querySelector("#detail");
const progress = document.querySelector("#progress");
const primary = document.querySelector("#primary");
const cancel = document.querySelector("#cancel");
const hint = document.querySelector("#hint");
const errorLog = document.querySelector("#error-log");
const errorRows = document.querySelector("#error-rows");

async function request(type) { return chrome.runtime.sendMessage({ type }); }
async function refresh(autoStart = false) {
  const response = await request("get-status");
  render(response);
  if (autoStart && response.canExport && response.status?.state === "idle") await start();
}
function render(response) {
  const status = response.status || { state: "idle", stage: "Ready to export", detail: "" };
  state.textContent = status.stage;
  detail.textContent = status.detail || (status.state === "idle" ? "Click below to create a ZIP for the current model." : "");
  renderFailures(status.failures);
  const total = Number(status.total) || 1, current = Number(status.current) || 0;
  progress.max = total; progress.value = status.state === "done" ? total : current;
  const running = ["reading", "running", "cancelling"].includes(status.state);
  cancel.hidden = !running;
  primary.hidden = running;
  if (!response.canExport) { primary.hidden = true; hint.textContent = "Open a Creality Cloud model details page to export it."; }
  else if (status.state === "error") { primary.hidden = false; primary.textContent = "Try again"; hint.textContent = status.cacheAvailable ? "Previously downloaded files will be reused until this page is reloaded." : "The previous export did not finish. Temporary files may be reused."; }
  else if (status.state === "done") { primary.hidden = false; primary.textContent = status.cacheAvailable ? "Retry missing files" : "Export again"; hint.textContent = status.cacheAvailable ? "Previously downloaded files will be reused until this page is reloaded." : "Chrome has finished the previous download."; }
  else { primary.textContent = "Export current model"; hint.textContent = running ? "You can close this popup; the export keeps running." : ""; }
}
function renderFailures(failures) {
  errorRows.replaceChildren();
  const items = Array.isArray(failures) ? failures : [];
  errorLog.hidden = items.length === 0;
  for (const failure of items) {
    const row = document.createElement("tr");
    const file = document.createElement("td"), error = document.createElement("td");
    file.textContent = failure?.name || "Unknown file";
    error.textContent = failure?.reason || "No error details were provided.";
    row.append(file, error); errorRows.append(row);
  }
}
async function start() { primary.disabled = true; await request("start-export"); primary.disabled = false; await refresh(); }
primary.addEventListener("click", start);
cancel.addEventListener("click", async () => { cancel.disabled = true; await request("cancel-export"); await refresh(); });
refresh(true).catch((error) => { state.textContent = "Extension error"; detail.textContent = error?.message || String(error || "An unexpected extension error occurred."); });
setInterval(() => refresh(false).catch(() => {}), 700);
