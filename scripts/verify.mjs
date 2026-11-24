#!/usr/bin/env node
/**
 * Verifies README.md is a sane badge catalog.
 *
 *   node scripts/verify.mjs            # offline structural checks
 *   node scripts/verify.mjs --online   # also fetch every badge URL
 *
 * Exit code 1 on real failures so CI can gate on it. Rate-limit / quota
 * responses (402, 429) and a short allowlist of known-flaky public hosts are
 * reported as warnings instead of failures.
 */
import { readFile } from "node:fs/promises";

const README = new URL("../README.md", import.meta.url);
const ONLINE = process.argv.includes("--online");
const CONCURRENCY = 8;
const TIMEOUT_MS = 20000;

const FLAKY_HOSTS = [
  "github-profile-trophy.vercel.app",
  "github-contributor-stats.vercel.app",
  "metrics.lecoq.io",
];

const raw = await readFile(README, "utf8");

// Snippets show placeholder URLs like <you> — drop fenced blocks and inline
// code so only real, renderable images are checked.
const text = raw
  .replace(/```[\s\S]*?```/g, "")
  .replace(/`[^`\n]*`/g, "");

const urls = [
  ...text.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g),
  ...text.matchAll(/<img[^>]+src="(https?:\/\/[^"]+)"/g),
]
  .map((m) => m[1])
  .filter((u) => !u.includes("<") && !u.includes(">"));

const unique = [...new Set(urls)];
const problems = [];
const warnings = [];

for (const url of unique) {
  if (!url.startsWith("https://")) problems.push(`not https: ${url}`);
  if (url.includes(" ")) problems.push(`unescaped space: ${url}`);
}

if (unique.length < 150) problems.push(`only ${unique.length} badge URLs found (expected >= 150)`);

const rows = raw.split("\n").filter((l) => /^\| (?:⚠️ )?!\[/.test(l)).length;
if (rows < 100) problems.push(`only ${rows} catalog rows found (expected >= 100)`);

console.log(`README.md: ${unique.length} unique badge URLs, ${rows} catalog rows`);

if (ONLINE) {
  const queue = [...unique];
  let broken = 0;

  async function check(url) {
    const host = new URL(url).host;
    const flaky = FLAKY_HOSTS.some((h) => host.endsWith(h));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      let res = await fetch(url, { method: "HEAD", redirect: "follow", signal: ctrl.signal });
      // Several hosts answer HEAD incorrectly (404/405); always confirm with GET.
      if (!res.ok) {
        res = await fetch(url, {
          method: "GET",
          redirect: "follow",
          headers: { "user-agent": "badge-catalog-verifier" },
          signal: ctrl.signal,
        });
      }
      if (!res.ok) {
        if ([402, 429].includes(res.status) || flaky) {
          warnings.push(`HTTP ${res.status} (rate limited): ${url}`);
        } else {
          broken++;
          problems.push(`HTTP ${res.status}: ${url}`);
        }
      }
    } catch (err) {
      // A single TLS hiccup shouldn't fail the run; retry once.
      try {
        const res = await fetch(url, { redirect: "follow", signal: ctrl.signal });
        if (!res.ok) {
          if (flaky) warnings.push(`HTTP ${res.status} (flaky host): ${url}`);
          else {
            broken++;
            problems.push(`HTTP ${res.status}: ${url}`);
          }
        }
      } catch {
        broken++;
        problems.push(`${err.name}: ${url}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async function worker() {
    while (queue.length) await check(queue.shift());
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`Online check: ${unique.length - broken}/${unique.length} reachable`);
  if (warnings.length) {
    console.log(`\n${warnings.length} warning(s):`);
    for (const w of warnings) console.log(`  ~ ${w}`);
  }
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log("OK");
