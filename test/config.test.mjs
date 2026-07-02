// profiles.json validation tests.
// Run: node --test test/config.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { validateProfilesConfig } from "../src/config.mjs";

const HOME = "/home/tester";

test("validates a good config and expands ~ in configDir", () => {
  const cfg = validateProfilesConfig({
    profiles: [
      { name: "personal", configDir: "~/.claude-", port: 32809 },
      { name: "work", configDir: "/abs/.claude-work", port: 32810 },
    ],
  }, { home: HOME });
  assert.equal(cfg.profiles.length, 2);
  assert.equal(cfg.profiles[0].configDir, join(HOME, ".claude-"));
  assert.equal(cfg.profiles[1].configDir, "/abs/.claude-work");
  assert.equal(cfg.profiles[0].host, "127.0.0.1");
});

test("caveman profile field normalizes levels and rejects garbage", () => {
  const cfg = validateProfilesConfig({
    profiles: [
      { name: "a", configDir: "~/.claude-a", port: 32801, caveman: "lite" },
      { name: "b", configDir: "~/.claude-b", port: 32802, caveman: false },
      { name: "c", configDir: "~/.claude-c", port: 32803, caveman: true },
      { name: "d", configDir: "~/.claude-d", port: 32804 },
    ],
  }, { home: HOME });
  assert.deepEqual(cfg.profiles.map((p) => p.caveman), ["lite", "off", "full", null]);
  assert.throws(
    () => validateProfilesConfig({ profiles: [{ name: "x", configDir: "~/.c", port: 32805, caveman: "mega" }] }, { home: HOME }),
    /invalid "caveman"/,
  );
});

test("rejects empty / missing profiles", () => {
  assert.throws(() => validateProfilesConfig({}, { home: HOME }), /non-empty "profiles"/);
  assert.throws(() => validateProfilesConfig({ profiles: [] }, { home: HOME }), /non-empty "profiles"/);
  assert.throws(() => validateProfilesConfig(null, { home: HOME }), /JSON object/);
});

test("rejects duplicate ports", () => {
  assert.throws(
    () => validateProfilesConfig({
      profiles: [
        { name: "a", configDir: "~/.a", port: 32809 },
        { name: "b", configDir: "~/.b", port: 32809 },
      ],
    }, { home: HOME }),
    /duplicate port 32809/
  );
});

test("rejects duplicate names", () => {
  assert.throws(
    () => validateProfilesConfig({
      profiles: [
        { name: "dup", configDir: "~/.a", port: 1 },
        { name: "dup", configDir: "~/.b", port: 2 },
      ],
    }, { home: HOME }),
    /duplicate profile name: dup/
  );
});

test("rejects bad ports and missing fields", () => {
  assert.throws(() => validateProfilesConfig({ profiles: [{ name: "a", configDir: "~/.a", port: 0 }] }, { home: HOME }), /integer "port"/);
  assert.throws(() => validateProfilesConfig({ profiles: [{ name: "a", configDir: "~/.a", port: 70000 }] }, { home: HOME }), /integer "port"/);
  assert.throws(() => validateProfilesConfig({ profiles: [{ name: "a", port: 1 }] }, { home: HOME }), /string "configDir"/);
  assert.throws(() => validateProfilesConfig({ profiles: [{ configDir: "~/.a", port: 1 }] }, { home: HOME }), /string "name"/);
});

test("accepts a custom host", () => {
  const cfg = validateProfilesConfig({ profiles: [{ name: "a", configDir: "~/.a", port: 1, host: "0.0.0.0" }] }, { home: HOME });
  assert.equal(cfg.profiles[0].host, "0.0.0.0");
});
