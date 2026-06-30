// Native-first auth resolution tests (pure: no SDK, no network).
// Run: node --test test/auth.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expandHome, resolveProfileDir, resolveAuthPlan, applyAuth, readProfileAccount } from "../src/auth.mjs";

const HOME = "/home/tester";

test("expandHome expands leading ~", () => {
  assert.equal(expandHome("~/.claude-work", HOME), join(HOME, ".claude-work"));
  assert.equal(expandHome("~", HOME), HOME);
  assert.equal(expandHome("/abs/path", HOME), "/abs/path");
  assert.equal(expandHome("relative", HOME), "relative");
});

test("resolveProfileDir precedence: --profile > CLAUDE_CONFIG_DIR > default", () => {
  assert.equal(resolveProfileDir({ profile: "~/.claude-x", env: {}, home: HOME }), join(HOME, ".claude-x"));
  assert.equal(resolveProfileDir({ env: { CLAUDE_CONFIG_DIR: "~/.claude-env" }, home: HOME }), join(HOME, ".claude-env"));
  assert.equal(resolveProfileDir({ env: {}, home: HOME }), join(HOME, ".claude"));
});

test("native mode is the default and strips any inherited token", () => {
  const plan = resolveAuthPlan({ profile: "~/.claude-", env: {}, home: HOME });
  assert.equal(plan.mode, "native");
  assert.equal(plan.tokenSource, null);
  assert.equal(plan.set.CLAUDE_CONFIG_DIR, join(HOME, ".claude-"));
  assert.ok(plan.unset.includes("CLAUDE_CODE_OAUTH_TOKEN"), "native unsets inherited token");
  assert.ok(plan.unset.includes("ANTHROPIC_API_KEY"));
  assert.ok(plan.unset.includes("CLAUDE_CODE_USE_BEDROCK"));
});

test("explicit CLAUDE_CODE_OAUTH_TOKEN env switches to token mode", () => {
  const plan = resolveAuthPlan({ profile: "~/.claude-", env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-test" }, home: HOME });
  assert.equal(plan.mode, "token");
  assert.equal(plan.tokenSource, "env");
  assert.equal(plan.set.CLAUDE_CODE_OAUTH_TOKEN, "sk-test");
});

test("--token-file wins over env and is read from disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "caa-auth-"));
  const tf = join(dir, "token");
  writeFileSync(tf, "  file-token  \n");
  const plan = resolveAuthPlan({ profile: "~/.claude-", tokenFile: tf, env: { CLAUDE_CODE_OAUTH_TOKEN: "env-token" }, home: HOME });
  assert.equal(plan.mode, "token");
  assert.equal(plan.tokenSource, "file");
  assert.equal(plan.set.CLAUDE_CODE_OAUTH_TOKEN, "file-token");
});

test("applyAuth mutates the target env (sets config dir, clears shadowers)", () => {
  const env = { ANTHROPIC_API_KEY: "leak", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_OAUTH_TOKEN: "stale" };
  const plan = resolveAuthPlan({ profile: "~/.claude-", env: {}, home: HOME });
  applyAuth(plan, env);
  assert.equal(env.CLAUDE_CONFIG_DIR, join(HOME, ".claude-"));
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

test("readProfileAccount reads oauthAccount metadata when present", () => {
  const dir = mkdtempSync(join(tmpdir(), "caa-prof-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "a@b.com", organizationName: "Org" } }));
  assert.deepEqual(readProfileAccount(dir), { email: "a@b.com", org: "Org" });
});

test("readProfileAccount returns null when not logged in / missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "caa-prof-"));
  assert.equal(readProfileAccount(dir), null);
  writeFileSync(join(dir, ".claude.json"), JSON.stringify({}));
  assert.equal(readProfileAccount(dir), null);
});
