#!/usr/bin/env node
/**
 * sync-frontend-lib.mjs
 *
 * frontend-lib/ai-client.js を chat-app/ai-client.js に同期する.
 *
 * 使い方:
 *   node scripts/sync-frontend-lib.mjs           # 上書きコピー
 *   node scripts/sync-frontend-lib.mjs --check   # 差分があれば exit 1
 *
 * Cloudflare Pages の Build command に
 *   `node scripts/sync-frontend-lib.mjs --check`
 * を入れておくと、`frontend-lib` 側だけ更新して `chat-app` 側のコピーを
 * 忘れた状態で本番に出ることを防げる.
 *
 * 真実の源 (Source of truth) は frontend-lib/ai-client.js とする.
 * chat-app/ai-client.js は静的サイトとしてバンドルせず参照したいだけの
 * コピーであり、直接編集しないこと.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(HERE, "..", "..", "frontend-lib", "ai-client.js");
const DEST = resolve(HERE, "..", "ai-client.js");

const checkOnly = process.argv.includes("--check");

if (!existsSync(SOURCE)) {
  console.error(`[sync-frontend-lib] source not found: ${SOURCE}`);
  process.exit(2);
}

const src = readFileSync(SOURCE);
const srcHash = createHash("sha256").update(src).digest("hex").slice(0, 16);

if (!existsSync(DEST)) {
  if (checkOnly) {
    console.error(`[sync-frontend-lib] dest missing: ${DEST}`);
    process.exit(1);
  }
  writeFileSync(DEST, src);
  console.log(`[sync-frontend-lib] created ${DEST} (sha256:${srcHash})`);
  process.exit(0);
}

const dst = readFileSync(DEST);
const dstHash = createHash("sha256").update(dst).digest("hex").slice(0, 16);

if (srcHash === dstHash) {
  console.log(`[sync-frontend-lib] in sync (sha256:${srcHash})`);
  process.exit(0);
}

if (checkOnly) {
  console.error(`[sync-frontend-lib] OUT OF SYNC`);
  console.error(`  source: ${SOURCE} (sha256:${srcHash})`);
  console.error(`  dest:   ${DEST} (sha256:${dstHash})`);
  console.error(`  run: node scripts/sync-frontend-lib.mjs`);
  process.exit(1);
}

writeFileSync(DEST, src);
console.log(`[sync-frontend-lib] updated ${DEST} (sha256:${srcHash})`);
