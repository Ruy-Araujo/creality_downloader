import test from "node:test";
import assert from "node:assert/strict";
import * as zip from "@zip.js/zip.js/index-native.js";

test("creates a ZIP from a File like the offscreen document", async () => {
  zip.configure({ useWebWorkers: false, useCompressionStream: true, maxWorkers: 1 });
  const input = new File(["content"], "model.stl", { type: "application/octet-stream" });
  const writer = new zip.ZipWriter(new zip.BlobWriter("application/zip"), { zip64: true });
  await writer.add("Model/model.stl", new zip.BlobReader(input), { bufferedWrite: false, level: 6, useWebWorkers: false, useCompressionStream: true });
  const archive = await writer.close();
  assert.ok(archive.size > 100);
  const reader = new zip.ZipReader(new zip.BlobReader(archive));
  assert.deepEqual((await reader.getEntries()).map((entry) => entry.filename), ["Model/model.stl"]);
  await reader.close();
});
