import test from "node:test";
import assert from "node:assert/strict";
import { errorMessage, htmlToText, sanitizePathPart, uniquePath, withExtension } from "../shared.js";

test("sanitizes names that cannot be stored in a ZIP", () => {
  assert.equal(sanitizePathPart(' A/B:C*? '), "A_B_C__");
  assert.equal(sanitizePathPart("..."), "untitled");
});

test("preserves extensions without duplicating them", () => {
  assert.equal(withExtension("model.STL", ".stl"), "model.STL");
  assert.equal(withExtension("model", ".3mf"), "model.3mf");
});

test("avoids collisions without distinguishing case", () => {
  const used = new Set();
  assert.equal(uniquePath("Model.STL", used), "Model.STL");
  assert.equal(uniquePath("model.stl", used), "model (2).stl");
});

test("converts a simple description to readable text", () => {
  assert.equal(htmlToText("<p>Hello<br>world</p><ul><li>one</li></ul>"), "Hello\nworld\n• one");
});

test("formats undefined rejections without throwing another error", () => {
  assert.equal(errorMessage(undefined), "An unexpected error occurred.");
  assert.equal(errorMessage(undefined, "Download failed without details."), "Download failed without details.");
  assert.equal(errorMessage({ message: "Server failed" }), "Server failed");
});
