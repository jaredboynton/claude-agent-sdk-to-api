// HTTP update routes: GET /update status, POST /update manual tick.
// Run: node --test test/server.update.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "../src/server.mjs";
import {
  AutoUpdateOutcome,
  _resetLoopGuardForTests,
  registerManualUpdate,
} from "../src/self-update.mjs";

async function jsonGet(port, path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  assert.equal(res.status, 200);
  return res.json();
}

async function jsonPost(port, path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST" });
  assert.equal(res.status, 200);
  return res.json();
}

test("GET /update and POST /update work with manual registration and polling off", async () => {
  _resetLoopGuardForTests();
  const dir = mkdtempSync(join(tmpdir(), "su-http-"));
  registerManualUpdate({
    pkgName: "@jaredboynton/claude-agent-api",
    ownInstallDir: dir,
    currentVersion: "0.1.45",
    statePath: join(dir, "state.json"),
    fetchImpl: async () => { throw new Error("must not fetch in a dev checkout"); },
  });

  const server = startServer({ port: 0, host: "127.0.0.1", version: "0.1.45" });
  await new Promise((resolve) => {
    if (server.listening) resolve();
    else server.once("listening", resolve);
  });
  const port = server.address().port;
  try {
    const status = await jsonGet(port, "/update");
    assert.equal(status.ok, true);
    assert.equal(status.update.currentVersion, "0.1.45");
    assert.equal(status.update.pollActive, false);
    assert.equal(status.update.manualCheckAvailable, true);

    const triggered = await jsonPost(port, "/update");
    assert.equal(triggered.ok, true);
    assert.equal(triggered.outcome, AutoUpdateOutcome.DevCheckout);
    assert.equal(triggered.update.lastOutcome, "dev_checkout");

    const alias = await jsonPost(port, "/update/check");
    assert.equal(alias.outcome, AutoUpdateOutcome.DevCheckout);
  } finally {
    await new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    _resetLoopGuardForTests();
  }
});
