#!/usr/bin/env node
/**
 * predeploy 設定チェック (Phase 1.2)
 *
 * production 用 [vars] に AUTHORIZED_PARTIES が空のまま wrangler deploy すると、
 * azp 検証が黙ってスキップされる。これを防ぐため、デプロイ前に必ず弾く。
 *
 * 動作:
 *   - wrangler.toml の [vars] AUTHORIZED_PARTIES を読み、空 / プレースホルダなら exit 1
 *   - wrangler dev / wrangler dev --env dev は影響を受けない (npm scripts: dev)
 */
import { readFileSync } from "node:fs";

const tomlPath = new URL("../wrangler.toml", import.meta.url);
const content = readFileSync(tomlPath, "utf-8");

// 簡易 TOML 走査 ([vars] 直下の AUTHORIZED_PARTIES のみ。[env.dev.vars] は対象外)
const lines = content.split("\n");
let currentSection = null;
let prodAuthorizedParties = null;

for (const raw of lines) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  const secMatch = line.match(/^\[([^\]]+)\]$/);
  if (secMatch) {
    currentSection = secMatch[1];
    continue;
  }
  if (currentSection === "vars") {
    const m = line.match(/^AUTHORIZED_PARTIES\s*=\s*"([^"]*)"\s*$/);
    if (m) prodAuthorizedParties = m[1];
  }
}

const PLACEHOLDERS = [
  "",
  "REPLACE_ME",
  "REPLACE_WITH_PRODUCTION_ORIGIN",
  "https://example.com",
];

if (prodAuthorizedParties === null) {
  console.error("[predeploy] FATAL: AUTHORIZED_PARTIES is missing in [vars] section of wrangler.toml");
  console.error("[predeploy] Add a line like: AUTHORIZED_PARTIES = \"https://chat.ddashpot.com\"");
  process.exit(1);
}

const trimmed = prodAuthorizedParties.trim();
if (PLACEHOLDERS.includes(trimmed)) {
  console.error(`[predeploy] FATAL: AUTHORIZED_PARTIES is empty or placeholder ("${trimmed}").`);
  console.error("[predeploy] Set the production frontend origin(s) before deploying.");
  process.exit(1);
}

// http://localhost を本番用 vars に置いていないかも軽くチェック
const items = trimmed.split(",").map((s) => s.trim()).filter(Boolean);
const localhostInProd = items.some((s) => /^http:\/\/(localhost|127\.0\.0\.1)/i.test(s));
if (localhostInProd) {
  console.error(`[predeploy] FATAL: localhost origin found in production AUTHORIZED_PARTIES: ${trimmed}`);
  console.error("[predeploy] Keep localhost only in [env.dev.vars].");
  process.exit(1);
}

console.log(`[predeploy] AUTHORIZED_PARTIES OK: ${trimmed}`);
