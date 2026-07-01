// preflightProfileDir tests (pure fs: no SDK, no network).
// Run: node --test test/profile-preflight.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, statSync, lstatSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { preflightProfileDir } from "../src/auth.mjs";

// Symlink-farm profile: every entry in <profile> points into <backing>.
function makeFarm() {
  const root = mkdtempSync(join(tmpdir(), "caa-preflight-"));
  const profile = join(root, "profile");
  const backing = join(root, "backing");
  mkdirSync(profile, { recursive: true });
  mkdirSync(backing, { recursive: true });
  return { root, profile, backing };
}

test("dangling required symlink is repaired by recreating the target", () => {
  const { profile, backing } = makeFarm();
  mkdirSync(join(backing, "session-env"));
  symlinkSync(join(backing, "session-env"), join(profile, "session-env"));
  rmSync(join(backing, "session-env"), { recursive: true });

  const r = preflightProfileDir(profile, { repair: true, requiredDirs: ["session-env"] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.repaired.map((x) => x.entry), ["session-env"]);
  assert.ok(statSync(join(profile, "session-env")).isDirectory(), "path resolves through the symlink again");
  assert.ok(lstatSync(join(profile, "session-env")).isSymbolicLink(), "the symlink itself was preserved");
  assert.ok(statSync(join(backing, "session-env")).isDirectory(), "target was recreated");
});

test("missing required entry is created as a plain directory", () => {
  const { profile } = makeFarm();
  const r = preflightProfileDir(profile, { repair: true, requiredDirs: ["session-env", "debug"] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.repaired.map((x) => x.entry).sort(), ["debug", "session-env"]);
  assert.ok(statSync(join(profile, "session-env")).isDirectory());
});

test("repair: false reports without mutating", () => {
  const { profile, backing } = makeFarm();
  mkdirSync(join(backing, "session-env"));
  symlinkSync(join(backing, "session-env"), join(profile, "session-env"));
  rmSync(join(backing, "session-env"), { recursive: true });

  const r = preflightProfileDir(profile, { repair: false, requiredDirs: ["session-env", "debug"] });
  assert.equal(r.ok, false);
  assert.equal(r.repaired.length, 0);
  assert.equal(r.errors.length, 2, "dangling + missing both reported");
  assert.equal(existsSync(join(backing, "session-env")), false, "nothing created");
  assert.equal(existsSync(join(profile, "debug")), false, "nothing created");
});

test("file squatting on a required name is an error and left untouched", () => {
  const { profile } = makeFarm();
  writeFileSync(join(profile, "session-env"), "not a dir");
  const r = preflightProfileDir(profile, { repair: true, requiredDirs: ["session-env"] });
  assert.equal(r.ok, false);
  assert.match(r.errors[0].reason, /not a directory/);
  assert.ok(statSync(join(profile, "session-env")).isFile(), "file untouched");
});

test("non-required dangling symlink is a warning, not repaired", () => {
  const { profile, backing } = makeFarm();
  symlinkSync(join(backing, "CLAUDE.md"), join(profile, "CLAUDE.md"));
  const r = preflightProfileDir(profile, { repair: true, requiredDirs: ["session-env"] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings.map((w) => w.entry), ["CLAUDE.md"]);
  assert.equal(existsSync(join(backing, "CLAUDE.md")), false, "target not created");
});

test("profile dir itself missing is created", () => {
  const { root } = makeFarm();
  const profile = join(root, "nonexistent-profile");
  const r = preflightProfileDir(profile, { repair: true, requiredDirs: ["session-env"] });
  assert.equal(r.ok, true);
  assert.ok(statSync(join(profile, "session-env")).isDirectory());
});

test("profile dir itself a dangling symlink gets its target recreated", () => {
  const { root, backing } = makeFarm();
  const profile = join(root, "linked-profile");
  symlinkSync(join(backing, "real-profile"), profile);
  const r = preflightProfileDir(profile, { repair: true, requiredDirs: ["session-env"] });
  assert.equal(r.ok, true);
  assert.ok(statSync(join(profile, "session-env")).isDirectory());
  assert.ok(statSync(join(backing, "real-profile")).isDirectory());
});

test("healthy plain dir is a no-op", () => {
  const { profile } = makeFarm();
  mkdirSync(join(profile, "session-env"));
  mkdirSync(join(profile, "debug"));
  const r = preflightProfileDir(profile, { repair: true, requiredDirs: ["session-env", "debug"] });
  assert.equal(r.ok, true);
  assert.equal(r.repaired.length, 0);
  assert.equal(r.warnings.length, 0);
});

test("relative symlink target resolves against the profile dir", () => {
  const { profile } = makeFarm();
  mkdirSync(join(profile, "store"));
  symlinkSync(join("store", "session-env"), join(profile, "session-env"));
  const r = preflightProfileDir(profile, { repair: true, requiredDirs: ["session-env"] });
  assert.equal(r.ok, true);
  assert.ok(statSync(join(profile, "store", "session-env")).isDirectory(), "relative target created under profile");
  assert.ok(statSync(join(profile, "session-env")).isDirectory());
});
