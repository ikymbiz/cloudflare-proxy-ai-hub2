# api-backend (api.ddashpot.com)

共通バックエンド Worker。各アプリ (chat.ddashpot.com 等) からの呼び出しを
Clerk で認証し、Service Binding 経由で ai-hub に転送する。

## アーキテクチャ

```
Browser
  └─ chat.ddashpot.com (Cloudflare Pages)
       └─ api.ddashpot.com  ← この Worker (Clerk JWT 検証 + per-user 制限)
            └─ ai-hub Worker  ← Service Binding 経由 (アプリキー認証)
                 └─ AI Gateway → 各プロバイダ
```

ai-hub への接続は **Service Binding** を使う (workers.dev / public URL 非経由)。
`AI_HUB_URL` のような外部 URL は **不要**。

## セットアップ

### 1. 依存インストール

```bash
cd api-backend
npm install
```

### 2. Clerk プロジェクト作成

1. https://dashboard.clerk.com でアカウント作成
2. 新規アプリ作成 (Application name: ddashpot 等)
3. Sign-in methods: 必要なもの (Email + Google 推奨) を有効化
4. API Keys から以下を控える:
   - **Publishable key** (`pk_test_xxx`) → フロント側で使う
   - **Secret key** (`sk_test_xxx`) → この Worker のシークレット
5. **Domains** で開発時は `localhost` を許可、本番は `chat.ddashpot.com` を登録

### 3. wrangler.toml の編集

`[vars]` で以下を本番値に書き換える:

- `AUTHORIZED_PARTIES` … フロントの Origin をカンマ区切りで列挙 (例 `https://chat.ddashpot.com`)
  - **空 / プレースホルダ / localhost を含む状態だと `npm run predeploy` が落ちる**
  - CORS の許可 Origin もこの値ベースで `ALLOWED_ORIGIN_PATTERN` (index.js 内、`*.ddashpot.com` 固定) でハードコード一致する。
    別ドメインを許可したい場合は `index.js` の `ALLOWED_ORIGIN_PATTERN` を編集する。

`[[services]]` バインディング `AI_HUB` は ai-hub Worker の名前と一致させる
(既定では `service = "ai-hub"`)。

### 4. シークレット登録

```bash
npx wrangler secret put CLERK_SECRET_KEY
# Clerk の Secret key (sk_test_xxx) を入力

npx wrangler secret put AI_HUB_KEY
# ai-hub で発行した ahk_xxx を入力
```

### 5. デプロイ

```bash
npm run deploy
# 内部で predeploy → check-config.mjs が走り、
# AUTHORIZED_PARTIES が未設定なら ここで失敗する。
```

### 6. カスタムドメイン設定 (api.ddashpot.com)

1. Cloudflare ダッシュボード → Workers & Pages → api-backend → Settings → Triggers
2. **Custom Domains** → Add Custom Domain → `api.ddashpot.com`
3. DNS レコードは自動で追加される

または `wrangler.toml` の routes を有効化してから再デプロイ。

## 動作確認

### ヘルスチェック

```bash
curl https://api.ddashpot.com/health
# → {"ok": true}
```

### 未認証アクセス

```bash
curl -X POST https://api.ddashpot.com/chat \
  -H "Content-Type: application/json" \
  -d '{"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
# → 401 Unauthorized
```

### 認証付き (Clerk JWT が必要)

ブラウザでログイン後、DevTools の Console で:

```javascript
await Clerk.session.getToken()
// → 長い JWT 文字列
```

これを Bearer で送る:

```bash
curl -X POST https://api.ddashpot.com/chat \
  -H "Authorization: Bearer <Clerk JWT>" \
  -H "Content-Type: application/json" \
  -d '{"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
# → AI 応答
```

## エンドポイント

| Method | Path | 説明 |
|---|---|---|
| GET  | `/health`     | ヘルスチェック (認証不要) |
| POST | `/chat`       | チャット呼び出し (Clerk JWT 必須) |
| POST | `/csp-report` | フロントからの CSP 違反レポート受信 (認証不要) |

将来の拡張時はここに endpoint を追加する (例: `/embeddings`, `/usage` など)。

## 制限

- **Per-user rate**: 10 req/min (DO `USER_RATE_LIMITER` で管理)
- **Per-user monthly tokens**: 100,000 tokens (予約制 — 並行時超過なし)
- **Body size**: 100,000 bytes (バイト単位、日本語等マルチバイト含む)
- **CSP report size**: 32,000 bytes

これらの既定値は `index.js` の上部定数で調整可能。将来は Clerk publicMetadata
や D1 でユーザーごとに上書きできる構造にしてある (`/check` に
`rate_per_minute` / `monthly_token_limit` を渡すと DO 側がそちらを採用)。

## ログ

すべての主要イベントは構造化 JSON として `console.log` / `console.warn` /
`console.error` に出される。Cloudflare の Tail から JSON として集約可能。
`user_id` は SHA-256 の先頭 8 文字に丸めて出力 (PII を残さない)。
