#!/usr/bin/env node
/**
 * Verifies README.md is a sane badge catalog.
 *
 *   node scripts/verify.mjs            # offline structural checks
 *   node scripts/verify.mjs --online   # also HEAD/GET every badge URL
 *
 * Exit code 1 on failure so CI can gate on it.
 */
import { readFile } from "node:fs/promises";

const README = new URL("../README.md", import.meta.url);
const ONLINE = process.argv.includes("--online");
const CONCURRENCY = 10;
const TIMEOUT_MS = 20000;

const text = await readFile(README, "utf8");

// Every image URL: markdown ![alt](url) plus <img src="url">
const urls = [
  ...text.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g),
  ...text.matchAll(/<img[^>]+src="(https?:\/\/[^"]+)"/g),
].map((m) => m[1]);

const unique = [...new Set(urls)];
const problems = [];

for (const url of unique) {
  if (!url.startsWith("https://")) problems.push(`not https: ${url}`);
  if (url.includes(" ")) problems.push(`unescaped space: ${url}`);
}

// The catalog should keep growing, not shrink silently.
if (unique.length < 150) problems.push(`only ${unique.length} badge URLs found (expected >= 150)`);

const rows = text.split("\n").filter((l) => l.startsWith("| ![")).length;
if (rows < 100) problems.push(`only ${rows} catalog rows found (expected >= 100)`);

console.log(`README.md: ${unique.length} unique badge URLs, ${rows} catalog rows`);

if (ONLINE) {
  let broken = 0;
  const queue = [...unique];

  async function check(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      let res = await fetch(url, { method: "HEAD", redirect: "follow", signal: ctrl.signal });
      // Some hosts reject HEAD; retry with GET.
      if (res.status === 405 || res.status === 403 || res.status === 501) {
        res = await fetch(url, {
          method: "GET",
          redirect: "follow",
          headers: { "user-agent": "badge-catalog-verifier" },
          signal: ctrl.signal,
        });
      }
      if (!res.ok) {
        broken++;
        problems.push(`HTTP ${res.status}: ${url}`);
      }
    } catch (err) {
      broken++;
      problems.push(`${err.name}: ${url}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async function worker() {
    while (queue.length) await check(queue.shift());
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`Online check: ${unique.length - broken}/${unique.length} reachable`);
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log("OK");
