import { errorMessage, formatDate, htmlToText, sanitizePathPart, uniquePath, withExtension } from "./shared.js";

// A stored ZIP is generated locally below. This intentionally avoids dynamic
// workers, WebAssembly, and CompressionStream implementation differences in
// Manifest V3 offscreen documents. Model bytes remain unchanged.

let current = null;
const cacheByTab = new Map();
const send = (message) => chrome.runtime.sendMessage(message).catch(() => {});
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "start" && !current) run(message).catch((error) => send({ type: "failed", tabId: message.tabId, message: `Export failed while opening temporary storage: ${errorMessage(error, "Chrome did not provide error details.")}`, cacheAvailable: false }));
  if (message?.type === "cancel" && current?.tabId === message.tabId) current.cancelled = true;
  if (message?.type === "release" && current?.tabId === message.tabId) cleanup(current).finally(() => { current = null; });
  if (message?.type === "release-archive" && current?.tabId === message.tabId) releaseArchive(current);
  if (message?.type === "clear-cache") clearCache(message.tabId);
});

async function run({ tabId, job }) {
  const title = sanitizePathPart(job.model.title);
  const root = await navigator.storage.getDirectory();
  const cache = cacheByTab.get(tabId) || { root, tempNames: [], files: new Map() };
  cacheByTab.set(tabId, cache);
  current = { tabId, job, title, cancelled: false, discarding: false, phase: "running", stage: "preparing the export", root: cache.root, tempNames: cache.tempNames, cache, objectUrl: null };
  const entries = [];
  const failures = [], completed = [], usedPaths = new Set();
  current.entries = entries;
  current.failures = failures;
  current.completed = completed;
  current.usedPaths = usedPaths;
  const total = job.downloads.files.length + job.downloads.threeMf.length + job.model.gallery.length + job.model.descriptionImages.length;
  let currentIndex = 0;
  const progress = (stage, detail) => send({ type: "progress", tabId, stage, detail, current: currentIndex, total: Math.max(total, 1) });
  const addText = async (name, text) => entries.push({ name: `${title}/${name}`, file: new File([text], name, { type: "text/plain;charset=utf-8" }) });
  const addRemote = async (name, url, kind = "file", unavailableReason = "", cacheKey = cacheKeyFor(kind, name, url)) => {
    current.stage = `downloading ${name}`;
    currentIndex += 1; progress("Downloading files…", name);
    if (current.cancelled) throw new Error("Export cancelled.");
    if (!url) { failures.push({ name, reason: unavailableReason || "Creality Cloud did not provide a download URL." }); return null; }
    try {
      const file = await retry(() => fetchToOpfs(url, kind, cacheKey));
      const path = uniquePath(`${title}/${name}`, usedPaths); entries.push({ name: path, file }); completed.push(name); return file;
    } catch (error) { failures.push({ name, reason: errorMessage(error) }); return null; }
  };
  try {
    current.stage = "checking temporary storage";
    progress("Preparing export…", "Checking available storage");
    const estimate = await navigator.storage.estimate();
    const declaredSize = [...job.downloads.files, ...job.downloads.threeMf].reduce((sum, item) => sum + Number(item.size || 0), 0);
    if (estimate.quota && estimate.usage + declaredSize > estimate.quota) throw new Error("There is not enough temporary browser storage for this model.");
    for (const item of job.downloads.files) await addRemote(withExtension(item.name, ""), item.url, "model", item.error, `model:${item.id}`);
    for (const item of job.downloads.threeMf) await addRemote(withExtension(item.name, ".3mf"), item.url, "model", item.error, `3mf:${item.id}`);
    const galleryMap = new Map();
    for (let i = 0; i < job.model.gallery.length; i += 1) {
      const name = i === 0 ? "cover.png" : `img_${i}.png`;
      const image = await addImage(name, job.model.gallery[i], addRemote, "gallery");
      if (image) galleryMap.set(job.model.gallery[i], name);
    }
    const descriptionAssets = new Map();
    let assetIndex = 0;
    for (const url of [...new Set(job.model.descriptionImages)].filter((url) => !galleryMap.has(url))) {
      assetIndex += 1;
      const local = `description_assets/img_${assetIndex}.png`;
      const image = await addImage(local, url, addRemote, "description");
      if (image) descriptionAssets.set(url, local);
    }
    current.stage = "writing metadata";
    const metadata = createMetadata(job, completed);
    await addText("metadata.txt", metadata);
    await addText("description.txt", htmlToText(job.model.descriptionHtml));
    await addText("description.html", offlineHtml(job.model.title, job.model.descriptionHtml, new Map([...galleryMap, ...descriptionAssets])));
    if (current.cancelled) throw new Error("Export cancelled.");
    current.stage = "creating the ZIP archive";
    progress("Creating ZIP…", `${entries.length} items`);
    const archive = await createStoredZip(entries, () => current.cancelled);
    current.stage = "finalizing the ZIP archive";
    current.objectUrl = URL.createObjectURL(archive);
    const summary = failures.length ? `Partial ZIP created: ${completed.length} item(s) downloaded, ${failures.length} missing.` : `Complete ZIP created with ${completed.length} item(s).`;
    current.phase = "waiting-download";
    send({ type: "zip-ready", tabId, url: current.objectUrl, filename: `${title}.zip`, summary, failures });
  } catch (error) {
    const state = current;
    current = null;
    if (errorMessage(error) === "Export cancelled.") {
      await cleanup(state);
      if (!state.discarding) send({ type: "failed", tabId, message: "Export cancelled." });
    } else {
      const fallback = `Export failed while ${state?.stage || "processing the export"}. Chrome did not provide error details.`;
      send({ type: "failed", tabId, message: `${errorMessage(error, fallback)} Previously downloaded files are kept temporarily for retry.`, cacheAvailable: true });
    }
  }
}

async function addImage(name, url, addRemote, category) {
  const rawName = `.__cc_image_${crypto.randomUUID()}`;
  const raw = await addRemote(rawName, url, "image", "", cacheKeyFor("image", rawName, url));
  if (!raw) {
    const failure = current.failures.findLast((item) => item.name === rawName);
    if (failure) failure.name = name;
    return null;
  }
  try {
    const png = await imageToPng(raw);
    const path = uniquePath(`${current.title}/${name}`, current.usedPaths);
    // Replace raw temporary entry with the converted entry; raw remains only in OPFS and is cleaned later.
    const index = currentEntriesIndex(raw);
    if (index >= 0) current.entries.splice(index, 1);
    current.entries.push({ name: path, file: png });
    const completedIndex = current.completed.lastIndexOf(rawName);
    if (completedIndex >= 0) current.completed.splice(completedIndex, 1, name);
    return png;
  } catch (error) {
    const completedIndex = current.completed.lastIndexOf(rawName);
    if (completedIndex >= 0) current.completed.splice(completedIndex, 1);
    current.failures.push({ name, reason: `Could not convert to PNG: ${errorMessage(error)}` });
    return null;
  }
}

// addImage needs access to the per-run collection while retaining a compact download helper.
function currentEntriesIndex(file) { return current.entries?.findIndex((entry) => entry.file === file) ?? -1; }

async function fetchToOpfs(url, kind, cacheKey) {
  const cachedName = current.cache.files.get(cacheKey);
  if (cachedName) {
    try { return await (await current.root.getFileHandle(cachedName)).getFile(); }
    catch { current.cache.files.delete(cacheKey); }
  }
  const response = await fetch(url, { credentials: "omit", redirect: "follow" });
  if (!response.ok) throw new Error(`Server responded with ${response.status}.`);
  const contentType = response.headers.get("content-type") || "";
  if (kind === "model" && /text\/html|application\/json/i.test(contentType)) throw new Error("The server returned an error page instead of a file.");
  if (!response.body) throw new Error("The response has no content.");
  const name = `cc-export-${crypto.randomUUID()}`;
  current.tempNames.push(name);
  const handle = await current.root.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await response.body.pipeTo(writable);
  current.cache.files.set(cacheKey, name);
  return handle.getFile();
}

function cacheKeyFor(kind, name, url) {
  if (kind === "image") {
    try { const parsed = new URL(url); return `image:${parsed.origin}${parsed.pathname}`; }
    catch { return `image:${url}`; }
  }
  return `${kind}:${name.toLocaleLowerCase()}`;
}

async function imageToPng(file) {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    return new File([await canvas.convertToBlob({ type: "image/png" })], "image.png", { type: "image/png" });
  } finally { bitmap.close(); }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

async function createStoredZip(entries, isCancelled) {
  const encoder = new TextEncoder();
  const parts = [], directory = [];
  let offset = 0;
  for (const entry of entries) {
    if (isCancelled()) throw new Error("Export cancelled.");
    const name = encoder.encode(entry.name);
    const size = entry.file.size;
    if (size > 0xffffffff || offset > 0xffffffff) throw new Error("This export is too large for the browser ZIP writer.");
    const crc = await crc32(entry.file, isCancelled);
    const { time, date } = dosDateTime(entry.file.lastModified || Date.now());
    const local = zipLocalHeader(name, crc, size, time, date);
    parts.push(local, entry.file);
    directory.push(zipDirectoryHeader(name, crc, size, time, date, offset));
    offset += local.byteLength + size;
  }
  const directorySize = directory.reduce((sum, item) => sum + item.byteLength, 0);
  if (offset + directorySize > 0xffffffff || entries.length > 0xffff) throw new Error("This export is too large for the browser ZIP writer.");
  parts.push(...directory, zipEndOfDirectory(entries.length, directorySize, offset));
  return new Blob(parts, { type: "application/zip" });
}

async function crc32(file, isCancelled) {
  let value = 0xffffffff;
  const reader = file.stream().getReader();
  try {
    while (true) {
      if (isCancelled()) throw new Error("Export cancelled.");
      const { done, value: chunk } = await reader.read();
      if (done) break;
      for (let index = 0; index < chunk.length; index += 1) value = (value >>> 8) ^ CRC_TABLE[(value ^ chunk[index]) & 0xff];
    }
    return (value ^ 0xffffffff) >>> 0;
  } finally { reader.releaseLock(); }
}

function dosDateTime(timestamp) {
  const date = new Date(timestamp);
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  return { time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2), date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate() };
}

function zipLocalHeader(name, crc, size, time, date) {
  const buffer = new ArrayBuffer(30 + name.length), view = new DataView(buffer);
  view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(6, 0x0800, true); view.setUint16(8, 0, true);
  view.setUint16(10, time, true); view.setUint16(12, date, true); view.setUint32(14, crc, true); view.setUint32(18, size, true); view.setUint32(22, size, true); view.setUint16(26, name.length, true); view.setUint16(28, 0, true);
  new Uint8Array(buffer, 30).set(name); return new Uint8Array(buffer);
}

function zipDirectoryHeader(name, crc, size, time, date, offset) {
  const buffer = new ArrayBuffer(46 + name.length), view = new DataView(buffer);
  view.setUint32(0, 0x02014b50, true); view.setUint16(4, 20, true); view.setUint16(6, 20, true); view.setUint16(8, 0x0800, true); view.setUint16(10, 0, true);
  view.setUint16(12, time, true); view.setUint16(14, date, true); view.setUint32(16, crc, true); view.setUint32(20, size, true); view.setUint32(24, size, true); view.setUint16(28, name.length, true); view.setUint16(30, 0, true); view.setUint16(32, 0, true); view.setUint16(34, 0, true); view.setUint16(36, 0, true); view.setUint32(38, 0, true); view.setUint32(42, offset, true);
  new Uint8Array(buffer, 46).set(name); return new Uint8Array(buffer);
}

function zipEndOfDirectory(count, directorySize, directoryOffset) {
  const buffer = new ArrayBuffer(22), view = new DataView(buffer);
  view.setUint32(0, 0x06054b50, true); view.setUint16(4, 0, true); view.setUint16(6, 0, true); view.setUint16(8, count, true); view.setUint16(10, count, true); view.setUint32(12, directorySize, true); view.setUint32(16, directoryOffset, true); view.setUint16(20, 0, true); return new Uint8Array(buffer);
}

async function retry(action) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return await action(); } catch (error) { lastError = error; if (attempt < 2) await new Promise((r) => setTimeout(r, 500 * (attempt + 1))); }
  }
  throw new Error(errorMessage(lastError, "The download failed without an error detail from Chrome."));
}

function createMetadata(job, files) {
  const m = job.model;
  const line = (key, value) => `${key}: ${value ?? "Not provided"}`;
  return [line("Title", m.title), line("Source URL", m.sourceUrl), line("Model ID", m.id), line("Author", m.author?.nickName), line("Author ID", m.author?.userId), line("License", m.license), line("Categories", m.categories.map((item) => item.name).join(", ") || "Not provided"), line("Tags", m.tags.map((item) => item.name).join(", ") || "Not provided"), line("Created", formatDate(m.stats?.createdAt)), line("Updated", formatDate(m.stats?.updatedAt)), line("Downloads", m.stats?.downloads), line("Likes", m.stats?.likes), line("Collections", m.stats?.collections), line("Comments", m.stats?.comments), "", "Author 3MF profiles:", ...(job.downloads.profileDetails.length ? job.downloads.profileDetails.map((item) => `- ${item.name} | Printer: ${item.printer || "Not provided"} | ${item.settings || ""}`) : ["- None available"]), "", "Included files:", ...(files.length ? files.map((file) => `- ${file}`) : ["- None"]), "", line("Exported", new Date().toISOString()), ""].join("\n");
}

function offlineHtml(title, source, imagePaths) {
  const doc = new DOMParser().parseFromString(source || "", "text/html");
  doc.querySelectorAll("script,style,iframe,form,object,embed,link,meta").forEach((node) => node.remove());
  doc.querySelectorAll("*").forEach((node) => {
    [...node.attributes].forEach((attribute) => {
      const name = attribute.name.toLowerCase(), value = attribute.value.trim();
      if (name.startsWith("on") || name === "style" || (name === "href" && !/^https?:/i.test(value)) || (name === "src" && node.tagName !== "IMG")) node.removeAttribute(attribute.name);
    });
  });
  doc.querySelectorAll("img").forEach((img) => { const sourceUrl = img.getAttribute("data-src") || img.getAttribute("src") || ""; const local = imagePaths.get(sourceUrl); if (local) img.setAttribute("src", local); else img.replaceWith(doc.createTextNode(img.alt ? `[Image unavailable: ${img.alt}]` : "[Image unavailable]")); img.removeAttribute("data-src"); });
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:900px;margin:32px auto;padding:0 20px;color:#1b1b1b}img{max-width:100%;height:auto}a{color:#0757b8}</style><body><h1>${escapeHtml(title)}</h1>${doc.body.innerHTML}</body></html>`;
}
function escapeHtml(text) { return String(text || "").replace(/[&<>"']/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[char])); }

async function cleanup(state) {
  if (!state) return;
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  await Promise.all(state.tempNames.map((name) => state.root.removeEntry(name).catch(() => {})));
  cacheByTab.delete(state.tabId);
}

function releaseArchive(state) {
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  if (current === state) current = null;
}

async function clearCache(tabId) {
  if (current?.tabId === tabId) {
    if (current.phase === "waiting-download") {
      const state = current;
      current = null;
      await cleanup(state);
      return;
    }
    current.discarding = true;
    current.cancelled = true;
    return;
  }
  const cache = cacheByTab.get(tabId);
  if (!cache) return;
  await Promise.all(cache.tempNames.map((name) => cache.root.removeEntry(name).catch(() => {})));
  cacheByTab.delete(tabId);
}
