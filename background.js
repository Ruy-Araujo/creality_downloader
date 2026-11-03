import { errorMessage } from "./shared.js";

const activeJobs = new Map();
const statusByTab = new Map();

setActionIcon();
chrome.runtime.onStartup.addListener(() => setActionIcon());
chrome.runtime.onInstalled.addListener(() => setActionIcon());

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "get-status") { getActiveStatus().then(sendResponse); return true; }
  if (message?.type === "start-export") { startExportForActiveTab().then(sendResponse); return true; }
  if (message?.type === "cancel-export") { cancelExportForActiveTab().then(sendResponse); return true; }
  if (message?.type === "clear-cache" && sender.tab?.id) { clearTabCache(sender.tab.id); return; }
  if (message?.type === "progress" && message.tabId) updateStatus(message.tabId, { state: "running", stage: message.stage, detail: message.detail, current: message.current, total: message.total });
  if (message?.type === "failed" && message.tabId) {
    activeJobs.delete(message.tabId);
    updateStatus(message.tabId, { state: "error", stage: "Export failed", detail: message.message, current: 0, total: 0, cacheAvailable: Boolean(message.cacheAvailable) });
  }
  if (message?.type === "zip-ready") finishDownload(message);
});

async function startExportForActiveTab() {
  const tab = await getActiveTab();
  if (!isModelPage(tab)) return { ok: false, state: "unsupported", message: "Open a Creality Cloud model details page first." };
  if (activeJobs.has(tab.id)) return { ok: true, status: await statusForTab(tab.id) };
  try {
    updateStatus(tab.id, { state: "reading", stage: "Reading model information…", detail: "", current: 0, total: 1, failures: [] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["page-collector.js"], world: "MAIN" });
    const [{ result: job }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: () => window.__crealityCloudExportCollect?.() });
    if (!job?.ok) throw new Error(job?.error || "The model information could not be read.");
    activeJobs.set(tab.id, { tabId: tab.id, title: job.model.title, cancelled: false });
    await ensureOffscreen();
    await sendToOffscreen({ type: "start", tabId: tab.id, job });
    return { ok: true, status: await statusForTab(tab.id) };
  } catch (error) {
    activeJobs.delete(tab.id);
    updateStatus(tab.id, { state: "error", stage: "Export failed", detail: errorMessage(error), current: 0, total: 0 });
    return { ok: false, status: await statusForTab(tab.id) };
  }
}

async function cancelExportForActiveTab() {
  const tab = await getActiveTab();
  if (!activeJobs.has(tab.id)) return { ok: false, status: await statusForTab(tab.id) };
  await sendToOffscreen({ type: "cancel", tabId: tab.id });
  updateStatus(tab.id, { state: "cancelling", stage: "Cancelling export…", detail: "", current: 0, total: 0 });
  return { ok: true, status: await statusForTab(tab.id) };
}

async function getActiveStatus() {
  const tab = await getActiveTab();
  return { ok: true, canExport: isModelPage(tab), status: await statusForTab(tab.id) };
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error("No active tab was found.");
  return tab;
}

function isModelPage(tab) { return /^https:\/\/www\.crealitycloud\.com\/(?:[a-z-]+\/)?model-detail\//.test(tab?.url || ""); }

async function statusForTab(tabId) {
  if (statusByTab.has(tabId)) return statusByTab.get(tabId);
  const stored = await chrome.storage.session.get(`status-${tabId}`);
  return stored[`status-${tabId}`] || { state: "idle", stage: "Ready to export", detail: "", current: 0, total: 0 };
}

function updateStatus(tabId, patch) {
  const oldStatus = statusByTab.get(tabId) || { state: "idle", stage: "Ready to export", detail: "", current: 0, total: 0 };
  const status = { ...oldStatus, ...patch, updatedAt: Date.now() };
  statusByTab.set(tabId, status);
  chrome.storage.session.set({ [`status-${tabId}`]: status }).catch(() => {});
  setActionIcon(tabId, progressPercent(status), status.state);
}

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (!contexts.length) await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["BLOBS"], justification: "Download files, convert images, and create a ZIP archive." });
}

async function sendToOffscreen(message) {
  let lastError;
  for (let i = 0; i < 10; i += 1) {
    try { await chrome.runtime.sendMessage(message); return; } catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 150)); }
  }
  throw new Error(errorMessage(lastError, "The export worker did not accept the request."));
}

async function finishDownload({ tabId, url, filename, summary, failures = [] }) {
  try {
    const downloadId = await chrome.downloads.download({ url, filename, conflictAction: "uniquify", saveAs: false });
    const job = activeJobs.get(tabId); if (job) job.downloadId = downloadId;
    await chrome.storage.session.set({ [`download-${downloadId}`]: { tabId, retainCache: failures.length > 0 } });
    updateStatus(tabId, { state: "done", stage: "Download started", detail: formatCompletionDetail(summary, failures), current: 1, total: 1, failures });
  } catch (error) {
    activeJobs.delete(tabId);
    updateStatus(tabId, { state: "error", stage: "Download failed", detail: `The ZIP was created but Chrome could not download it: ${errorMessage(error)}`, current: 0, total: 0 });
  }
}

function formatCompletionDetail(summary, failures) {
  if (!failures.length) return summary;
  const items = failures.map((failure) => `${failure.name}: ${failure.reason}`).join("\n");
  return `${summary}\n\nFiles with errors:\n${items}`;
}

chrome.downloads.onChanged.addListener(async (delta) => {
  if (!delta.state?.current || !["complete", "interrupted"].includes(delta.state.current)) return;
  const persisted = await chrome.storage.session.get(`download-${delta.id}`);
  const persistedJob = persisted[`download-${delta.id}`];
  let tabId = persistedJob?.tabId;
  for (const [candidateId, job] of activeJobs) if (job.downloadId === delta.id) { activeJobs.delete(candidateId); tabId ||= candidateId; }
  if (persistedJob) await chrome.storage.session.remove(`download-${delta.id}`);
  if (tabId) {
    const retainCache = delta.state.current === "interrupted" || persistedJob?.retainCache;
    chrome.runtime.sendMessage({ type: retainCache ? "release-archive" : "release", tabId }).catch(() => {});
    const previous = await statusForTab(tabId);
    updateStatus(tabId, delta.state.current === "complete"
      ? { state: "done", stage: "Download complete", detail: previous.detail || "The ZIP was saved by Chrome.", current: 1, total: 1, cacheAvailable: Boolean(retainCache) }
      : { state: "error", stage: "Download interrupted", detail: "Chrome interrupted the ZIP download. Previously downloaded files are kept temporarily for retry.", current: 0, total: 0, cacheAvailable: true });
  }
});

async function clearTabCache(tabId) {
  activeJobs.delete(tabId);
  statusByTab.delete(tabId);
  await chrome.storage.session.remove(`status-${tabId}`);
  chrome.runtime.sendMessage({ type: "clear-cache", tabId }).catch(() => {});
  setActionIcon(tabId);
}

function progressPercent(status) {
  if (status.state === "done") return 1;
  if (!status.total) return status.state === "running" || status.state === "reading" ? 0.08 : 0;
  return Math.max(0, Math.min(1, status.current / status.total));
}

function setActionIcon(tabId, progress = 0, state = "idle") {
  const sizes = [16, 32, 48];
  const imageData = Object.fromEntries(sizes.map((size) => [size, drawIcon(size, progress, state)]));
  chrome.action.setIcon(tabId ? { tabId, imageData } : { imageData }).catch(() => {});
  const target = tabId ? { tabId } : {};
  chrome.action.setBadgeBackgroundColor({ ...target, color: "#d93025" }).catch(() => {});
  chrome.action.setBadgeText({ ...target, text: state === "error" ? "!" : "" }).catch(() => {});
}

function drawIcon(size, progress, state) {
  const canvas = new OffscreenCanvas(size, size);
  const context = canvas.getContext("2d");
  const color = state === "error" ? "#d93025" : state === "done" ? "#188038" : "#276ef1";
  context.fillStyle = "#182033"; context.beginPath(); context.roundRect(0, 0, size, size, Math.max(3, size / 5)); context.fill();
  context.fillStyle = "#ffffff"; context.fillRect(size * .44, size * .22, size * .12, size * .34); context.beginPath(); context.moveTo(size * .28, size * .5); context.lineTo(size * .72, size * .5); context.lineTo(size * .5, size * .73); context.closePath(); context.fill();
  context.fillStyle = "#4f5b72"; context.fillRect(0, size * .82, size, size * .18);
  context.fillStyle = color; context.fillRect(0, size * .82, size * progress, size * .18);
  if (state === "error") {
    const radius = Math.max(3, size * .24), x = size - radius, y = radius;
    context.fillStyle = "#d93025"; context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2); context.fill();
    context.fillStyle = "#ffffff"; context.font = `bold ${Math.max(7, size * .42)}px sans-serif`; context.textAlign = "center"; context.textBaseline = "middle"; context.fillText("!", x, y + size * .02);
  }
  return context.getImageData(0, 0, size, size);
}
