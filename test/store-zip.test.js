import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as zip from "@zip.js/zip.js/index-native.js";

test("the extension's native ZIP writer creates a readable archive", async () => {
  const source = await readFile(new URL("../offscreen.js", import.meta.url), "utf8");
  const start = source.indexOf("const CRC_TABLE");
  const end = source.indexOf("async function retry", start);
  const createStoredZip = new Function(`${source.slice(start, end)}; return createStoredZip;`)();
  const archive = await createStoredZip([
    { name: "Model/metadata.txt", file: new File(["title"], "metadata.txt") },
    { name: "Model/part.stl", file: new File(["solid model"], "part.stl") }
  ], () => false);
  const reader = new zip.ZipReader(new zip.BlobReader(archive));
  assert.deepEqual((await reader.getEntries()).map((entry) => entry.filename), ["Model/metadata.txt", "Model/part.stl"]);
  await reader.close();
});
