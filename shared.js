export function sanitizePathPart(value, fallback = "untitled") {
  const text = String(value ?? "").normalize("NFKC").trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/[. ]+$/g, "");
  return (text || fallback).slice(0, 180);
}

export function withExtension(name, extension) {
  const safeName = sanitizePathPart(name);
  const ext = String(extension || "").trim();
  if (!ext) return safeName;
  return safeName.toLowerCase().endsWith(ext.toLowerCase()) ? safeName : `${safeName}${ext.startsWith(".") ? ext : `.${ext}`}`;
}

export function uniquePath(path, used) {
  const normalized = path.replace(/\\/g, "/");
  const key = normalized.toLocaleLowerCase();
  if (!used.has(key)) { used.add(key); return normalized; }
  const dot = normalized.lastIndexOf(".");
  const base = dot > normalized.lastIndexOf("/") ? normalized.slice(0, dot) : normalized;
  const ext = dot > normalized.lastIndexOf("/") ? normalized.slice(dot) : "";
  let i = 2;
  while (used.has(`${base} (${i})${ext}`.toLocaleLowerCase())) i += 1;
  const result = `${base} (${i})${ext}`;
  used.add(result.toLocaleLowerCase());
  return result;
}

export function htmlToText(html) {
  const source = String(html || "")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|li|h[1-6]|tr)\s*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ");
  return source.replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/\n{3,}/g, "\n\n").trim();
}

export function formatDate(value) {
  if (!value) return "Not provided";
  const date = new Date(Number(value) < 100000000000 ? Number(value) * 1000 : value);
  return Number.isNaN(date.valueOf()) ? String(value) : date.toISOString();
}

export function errorMessage(error, fallback = "An unexpected error occurred.") {
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error.message === "string" && error.message.trim()) return error.message;
  if (error && typeof error.toString === "function") {
    const text = error.toString();
    if (text && text !== "[object Object]") return text;
  }
  if (error && typeof error === "object") {
    const details = ["name", "type", "code", "reason", "statusText"]
      .map((key) => error[key])
      .filter((value) => typeof value === "string" && value.trim())
      .join(": ");
    if (details) return details;
  }
  return fallback;
}
