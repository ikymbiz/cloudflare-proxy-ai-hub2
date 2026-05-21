# ai-hub

内部用 AI プロキシ Worker。**外部から直接叩かせない**前提で運用する。
共通バックエンド (`api.ddashpot.com`) のみがアプリキーを持ってアクセスする。

## セットアップ

### 1. 依存インストール

```bash
cd ai-hub
npm install
```

### 2. KV namespace 作成

```bash
npx wrangler kv namespace create "KEYS_KV"
```

出力された `id` を `wrangler.toml` の `REPLACE_WITH_YOUR_KV_ID` に貼り付ける。

### 3. AI Gateway 設定

新しい AI Gateway を作成 (旧 Gateway の Account ID/Gateway ID は公開済みのため):

1. Cloudflare ダッシュボード → AI → AI Gateway → 新規作成
2. **Authenticated Gateway** を ON
3. **Provider Keys** に各プロバイダーの API キーを登録 (BYOK)
4. Gateway トークンを発行 (Run 権限)
5. `wrangler.toml` の `AI_GATEWAY_URL` を新 Gateway の URL に書き換える

### 4. シークレット登録

```bash
npx wrangler secret put CF_AIG_TOKEN
# プロンプトで Gateway トークンを入力
```

### 5. デプロイ

```bash
npx wrangler deploy
```

`wrangler.toml` で `workers_dev = false` を設定済みのため、
**この Worker には外部公開 URL は生えない** (`*.workers.dev` も無効)。
api-backend からは **Service Binding** 経由でのみ呼ばれる。
api-backend 側 `wrangler.toml` の `[[services]]` の `service` 名を
ここのワーカー名 (既定 `ai-hub`) と一致させる。

### 6. アプリキー発行

**重要**: 新版ではアプリキーを KV に**平文で保存しない**。
SHA-256 ハッシュをキーにして登録する (KV ダンプ漏洩時の被害を抑えるため)。

```bash
# キー生成
KEY="ahk_$(openssl rand -hex 24)"
echo "$KEY"
# 例: ahk_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4

# ハッシュ計算 (KV 登録に使う)
KEY_HASH=$(printf '%s' "$KEY" | openssl dgst -sha256 -hex | awk '{print $2}')
echo "$KEY_HASH"
```

`keydata.json` を作成:

```json
{
  "app_name": "common-backend",
  "allowed_models": [
    "openai/gpt-4o-mini",
    "anthropic/claude-3-5-haiku-latest",
    "google-ai-studio/gemini-2.5-flash"
  ],
  "max_tokens_cap": 2000,
  "rate_per_minute": 30,
  "monthly_token_limit": 1000000,
  "enabled": true
}
```

KV にハッシュをキーに登録:

```bash
npx wrangler kv key put --binding=KEYS_KV "apikey:$KEY_HASH" --path=keydata.json
```

平文の `$KEY` (ahk_xxx) は api-backend の `AI_HUB_KEY` シークレットにのみ保存:

```bash
cd ../api-backend
echo "$KEY" | npx wrangler secret put AI_HUB_KEY
```

その後 `$KEY` の値はどこにも残さない (再生成すれば良い)。

### 既存キーの移行 (旧版からアップグレードする場合)

旧版で `apikey:ahk_xxx` の形で平文登録していた場合:

```bash
# 1. 旧キーのデータを取得
npx wrangler kv key get --binding=KEYS_KV "apikey:ahk_OLD..." > keydata.json
# 2. ハッシュ計算
NEW_KEY="apikey:$(printf 'ahk_OLD...' | openssl dgst -sha256 -hex | awk '{print $2}')"
# 3. ハッシュ化キーに再登録
npx wrangler kv key put --binding=KEYS_KV "$NEW_KEY" --path=keydata.json
# 4. 旧キーを削除
npx wrangler kv key delete --binding=KEYS_KV "apikey:ahk_OLD..."
```

## 動作確認

`workers_dev = false` のため、`*.workers.dev` で直接叩く確認は **できない**
(してはいけない。仮に到達した場合はこの設定が効いていない)。
api-backend 経由でテストするか、ローカルで `wrangler dev` してから叩く:

```bash
# wrangler dev で起動した場合 (Service Binding は使えないので直接叩く)
LOCAL=http://localhost:8787

# 1. アプリキー無し → 401
curl -X POST "$LOCAL/" \
  -H "Content-Type: application/json" \
  -d '{"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'

# 2. 正しいキー → AI 応答
curl -X POST "$LOCAL/" \
  -H "Authorization: Bearer ahk_a1b2c3..." \
  -H "Content-Type: application/json" \
  -d '{"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'

# 3. 許可外モデル → 403
curl -X POST "$LOCAL/" \
  -H "Authorization: Bearer ahk_a1b2c3..." \
  -H "Content-Type: application/json" \
  -d '{"model":"openai/gpt-5","messages":[{"role":"user","content":"hi"}]}'

# 4. workers.dev 直叩き不到達確認 (本番デプロイ後)
curl -i "https://ai-hub.YOUR_SUBDOMAIN.workers.dev/"
# → 404 / Not Found (Cloudflare の管理ページに飛ぶ)
```

## 利用量確認

利用量は Durable Object のストレージに記録されている (KV ではない)。
DO のストレージはダッシュボードの "Storage & Databases" で確認するか、
管理用エンドポイントを将来追加する。

## キー無効化

ハッシュ化キーで `enabled: false` の JSON を上書き:

```bash
KEY_HASH=$(printf 'ahk_xxx' | openssl dgst -sha256 -hex | awk '{print $2}')
npx wrangler kv key put --binding=KEYS_KV "apikey:$KEY_HASH" --path=keydata-disabled.json
```
