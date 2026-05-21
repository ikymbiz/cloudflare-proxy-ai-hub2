#!/usr/bin/env node
/**
 * check-html.mjs
 *
 * chat-app/index.html に REPLACE_WITH_* プレースホルダが残ったまま
 * 本番デプロイされるのを防ぐ.
 *
 * 検出対象:
 *   - data-clerk-publishable-key="REPLACE_WITH_YOUR_CLERK_PUBLISHABLE_KEY"
 *   - integrity="sha384-REPLACE_WITH_SRI_HASH"
 *   - src="https://REPLACE_WITH_YOUR_CLERK_FRONTEND_API.clerk.accounts.dev/..."
 *
 * Cloudflare Pages の Build command (= `npm run build`) で
 *   sync-frontend-lib.mjs --check  →  check-html.mjs
 * の順で走る. どちらかが落ちれば本番に出ない.
 *
 * ローカル開発時に置換せず動かしたい場合は --skip 引数で抑制できる
 * (Pages build には渡さないので本番では効かない).
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

if (process.argv.includes("--skip")) {
  console.log("[check-html] --skip specified, skipping placeholder check");
  process.exit(0);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = resolve(HERE, "..", "index.html");

if (!existsSync(HTML_PATH)) {
  console.error(`[check-html] FATAL: index.html not found at ${HTML_PATH}`);
  process.exit(2);
}

const html = readFileSync(HTML_PATH, "utf-8");

// 検出パターン
const placeholderPatterns = [
  {
    pattern: /REPLACE_WITH_YOUR_CLERK_PUBLISHABLE_KEY/,
    name: "Clerk publishable key",
    hint: "Replace with your pk_live_xxx from Clerk Dashboard → API Keys.",
  },
  {
    pattern: /sha384-REPLACE_WITH_SRI_HASH/,
    name: "Clerk SDK SRI hash",
    hint: "Compute with: curl -sL <src URL> | openssl dgst -sha384 -binary | openssl base64 -A",
  },
  {
    pattern: /REPLACE_WITH_YOUR_CLERK_FRONTEND_API/,
    name: "Clerk Frontend API host",
    hint: "Replace with your Clerk Frontend API host (e.g. clerk.ddashpot.com or your-instance.clerk.accounts.dev).",
  },
];

const found = [];
for (const { pattern, name, hint } of placeholderPatterns) {
  if (pattern.test(html)) {
    found.push({ name, hint });
  }
}

if (found.length > 0) {
  console.error(`[check-html] FATAL: ${found.length} unreplaced placeholder(s) in index.html:`);
  for (const f of found) {
    console.error(`  - ${f.name}`);
    console.error(`    ${f.hint}`);
  }
  console.error("[check-html] Replace these before deploying to production.");
  console.error("[check-html] (Pass --skip for local-only builds without Clerk.)");
  process.exit(1);
}

// `@latest` の利用も禁止 (SRI の意味が無くなるため)
if (/@clerk\/clerk-js@latest/.test(html)) {
  console.error("[check-html] FATAL: @clerk/clerk-js@latest is forbidden.");
  console.error("[check-html] Pin a specific version (e.g. @5.50.0) and update the SRI hash.");
  process.exit(1);
}

console.log("[check-html] OK: no unreplaced placeholders in index.html");
