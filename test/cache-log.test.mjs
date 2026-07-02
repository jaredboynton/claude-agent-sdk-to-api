import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";

import {
  resolveCacheLogPath,
  initCacheLog,
  appendCacheLog,
  flushCacheLogForTest,
  cacheLogEnabled,
  cacheLogPath,
  cacheCreationSplit,
  _resetCacheLogForTest,
} from "../src/cache-log.mjs";

function tmpDir() {
  return fs.mkdtempSync(join(os.tmpdir(), "cache-log-test-"));
}

test("resolveCacheLogPath: disabled forms", () => {
  for (const v of [undefined, null, false, "0", "false"]) {
    assert.equal(resolveCacheLogPath(v, "/tmp/x"), null);
  }
});

test("resolveCacheLogPath: boolean/true forms default under profileDir", () => {
  for (const v of [true, "1", "true"]) {
    assert.equal(resolveCacheLogPath(v, "/tmp/prof"), "/tmp/prof/cache-log.jsonl");
  }
});

test("resolveCacheLogPath: explicit path is honored", () => {
  assert.equal(resolveCacheLogPath("/var/log/x.jsonl", "/tmp/prof"), "/var/log/x.jsonl");
});

test("disabled: append is a no-op and cacheLogEnabled() is false", () => {
  _resetCacheLogForTest();
  assert.equal(initCacheLog(false, "/tmp"), null);
  assert.equal(cacheLogEnabled(), false);
  assert.equal(cacheLogPath(), null);
  appendCacheLog({ a: 1 }); // must not throw
});

test("enabled: appends one JSON line per call, append mode preserves prior", async () => {
  _resetCacheLogForTest();
  const dir = tmpDir();
  const p = initCacheLog(true, dir);
  assert.equal(p, join(dir, "cache-log.jsonl"));
  assert.equal(cacheLogEnabled(), true);

  appendCacheLog({ conv: "a", read: 100, create: 10 });
  appendCacheLog({ conv: "b", read: 200, create: 0 });
  await flushCacheLogForTest();

  const lines = fs.readFileSync(p, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), { conv: "a", read: 100, create: 10 });
  assert.deepEqual(JSON.parse(lines[1]), { conv: "b", read: 200, create: 0 });

  // Re-init same path (simulates restart) and append: prior rows survive.
  _resetCacheLogForTest();
  initCacheLog(true, dir);
  appendCacheLog({ conv: "c" });
  await flushCacheLogForTest();
  const after = fs.readFileSync(p, "utf8").trim().split("\n");
  assert.equal(after.length, 3);
  _resetCacheLogForTest();
});

test("cacheCreationSplit: object form and flat fallback", () => {
  assert.deepEqual(
    cacheCreationSplit({ cache_creation: { ephemeral_5m_input_tokens: 7, ephemeral_1h_input_tokens: 3 } }),
    { create5m: 7, create1h: 3 },
  );
  assert.deepEqual(
    cacheCreationSplit({ cache_creation_input_tokens: 12 }),
    { create5m: 12, create1h: 0 },
  );
  assert.deepEqual(cacheCreationSplit({}), { create5m: 0, create1h: 0 });
  assert.deepEqual(cacheCreationSplit(null), { create5m: 0, create1h: 0 });
});
