/** The settings used to be two booleans that interacted; they are now one
 *  three-way choice. Anyone upgrading has the old shape on disk, and getting
 *  this wrong silently resets how their PDFs open. */
import test from "node:test";
import assert from "node:assert/strict";
import { migrateSettings, DEFAULT_SETTINGS } from "../.testbuild/settings.mjs";

test("a fresh install opens only PDFs that are already marked up", () => {
  assert.equal(migrateSettings(null).openMode, "marked");
  assert.equal(migrateSettings({}).openMode, "marked");
  assert.equal(DEFAULT_SETTINGS.openMode, "marked");
});

test("the old take-over toggle becomes 'every PDF'", () => {
  assert.equal(migrateSettings({ reopenMarkedUp: true, takeOverAllPdfs: true }).openMode, "always");
  // takeOver won even when reopen was off, so it still has to.
  assert.equal(migrateSettings({ reopenMarkedUp: false, takeOverAllPdfs: true }).openMode, "always");
});

test("the old pair both off becomes 'never'", () => {
  assert.equal(migrateSettings({ reopenMarkedUp: false, takeOverAllPdfs: false }).openMode, "never");
});

test("the old defaults come through unchanged", () => {
  assert.equal(migrateSettings({ reopenMarkedUp: true, takeOverAllPdfs: false }).openMode, "marked");
});

test("a saved new-style choice is never overridden by the old keys", () => {
  const saved = { openMode: "never", reopenMarkedUp: true, takeOverAllPdfs: true };
  assert.equal(migrateSettings(saved).openMode, "never", "what he chose last wins");
});

test("migration only ever returns a known mode", () => {
  for (const raw of [null, undefined, {}, { openMode: "always" }, { takeOverAllPdfs: true }]) {
    assert.ok(["never", "marked", "always"].includes(migrateSettings(raw).openMode));
  }
});
