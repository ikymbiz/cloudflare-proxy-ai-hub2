# 検証手順 (V.1 〜 V.6)

Phase 1/2/3 修正後の動作確認。
本番環境 (`api.ddashpot.com` / `chat.ddashpot.com` / Service Binding) を前提に書く。
ローカル `wrangler dev` でも該当箇所は確認可能。

事前準備:

```bash
# Clerk JWT (有効) を取得
# ブラウザで chat.ddashpot.com にログイン後、DevTools Console で:
#   await Clerk.session.getToken()
TOKEN="eyJhbGciOi..."           # 有効な Clerk JWT
TOKEN_EXP="eyJhbGciOi..."       # 期限切れの Clerk JWT (検証用に取っておく)
TOKEN_BADAZP="eyJhbGciOi..."    # 別 origin で発行された Clerk JWT
API=https://api.ddashpot.com
ORIGIN=https://chat.ddashpot.com
```

---

## V.1 正常系エンドツーエンド

ブラウザで `https://chat.ddashpot.com` を開き、ログイン → メッセージ送信。

期待:
- [ ] レスポンスが **文字単位で流れる** (ストリーミング動作)
- [ ] Response Headers に
      `Content-Security-Policy: ... 'nonce-XXX' 'strict-dynamic' ...` がある
- [ ] Response Headers に
      `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload` がある
- [ ] `_middleware.js` で nonce が毎回変わる (リロードして確認)
- [ ] `Network` タブで `api.ddashpot.com/chat` が `Content-Type: text/event-stream`

CLI 確認 (ストリーミング):

```bash
curl -N -X POST "$API/chat" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Origin: $ORIGIN" \
  -H "Content-Type: application/json" \
  -d '{"model":"openai/gpt-4o-mini","stream":true,"messages":[{"role":"user","content":"hi"}]}'
# → data: {...}\n\n が複数回、最後に data: [DONE]
```

CLI 確認 (非ストリーミング):

```bash
curl -i -X POST "$API/chat" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Origin: $ORIGIN" \
  -H "Content-Type: application/json" \
  -d '{"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
# → 200 OK, JSON body
```

---

## V.2 401 系 (トークン関連)

### V.2.a Authorization ヘッダなし

```bash
curl -i -X POST "$API/chat" \
  -H "Origin: $ORIGIN" \
  -H "Content-Type: application/json" \
  -d '{"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
# → 401 Unauthorized
```

### V.2.b 期限切れトークン

```bash
curl -i -X POST "$API/chat" \
  -H "Authorization: Bearer $TOKEN_EXP" \
  -H "Origin: $ORIGIN" \
  -H "Content-Type: application/json" \
  -d '{"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
# → 401 Unauthorized
# ログ: { "event": "clerk_verify_failed", ... }
```

### V.2.c azp 不一致 (他オリジンの Clerk JWT)

```bash
curl -i -X POST "$API/chat" \
  -H "Authorization: Bearer $TOKEN_BADAZP" \
  -H "Origin: $ORIGIN" \
  -H "Content-Type: application/json" \
  -d '{"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
# → 401 Unauthorized
# ログ: { "event": "clerk_verify_failed", "msg": "...azp..." }
```

### V.2.d AUTHORIZED_PARTIES 未設定でデプロイ → 失敗

```bash
cd api-backend
# wrangler.toml を一時編集して AUTHORIZED_PARTIES を空にする
npm run deploy
# → scripts/check-config.mjs が exit 1 で予防的に失敗
# Error: AUTHORIZED_PARTIES is empty or contains placeholder/localhost.
```

ランタイムでも保険として 500:

```bash
# 強引にデプロイした場合、最初の /chat で
curl -i -X POST "$API/chat" -H "Authorization: Bearer $TOKEN" ...
# → 500, ログ: { "event": "config_missing_authorized_parties_runtime" }
```

---

## V.3 403 系

### V.3.a 許可外モデル

```bash
curl -i -X POST "$API/chat" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Origin: $ORIGIN" \
  -H "Content-Type: application/json" \
  -d '{"model":"openai/gpt-5","messages":[{"role":"user","content":"hi"}]}'
# → 403 Forbidden (ai-hub の allowed_models で弾く)
# ログ: { "event": "model_not_allowed", "model": "openai/gpt-5" }
```

### V.3.b 不正 Origin

```bash
curl -i -X POST "$API/chat" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Origin: https://evil.example.com" \
  -H "Content-Type: application/json" \
  -d '{"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
# → 403 Forbidden (CORS / Origin allowlist)
```

### V.3.c Origin ヘッダなし

```bash
curl -i -X POST "$API/chat" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
# → 403 Forbidden (/chat は Origin 必須)
```

`/health` (GET) のみ Origin なしでも 200:

```bash
curl -i "$API/health"
# → 200 OK
```

---

## V.4 413 系 (ボディサイズ)

### V.4.a ASCII で 100KB 超

```bash
# 130KB の ASCII を送る
python3 -c 'print("a"*130000)' > /tmp/big.txt
curl -i -X POST "$API/chat" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Origin: $ORIGIN" \
  -H "Content-Type: application/json" \
  --data-binary @<(jq -nR --rawfile s /tmp/big.txt \
    '{model:"openai/gpt-4o-mini",messages:[{role:"user",content:$s}]}')
# → 413 Payload Too Large
```

### V.4.b 日本語 (UTF-8 マルチバイト) で 100KB 超

```bash
# 40,000 文字 = UTF-8 で約 120KB
python3 -c 'print("あ"*40000)' > /tmp/big_ja.txt
curl -i -X POST "$API/chat" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Origin: $ORIGIN" \
  -H "Content-Type: application/json" \
  --data-binary @<(jq -nR --rawfile s /tmp/big_ja.txt \
    '{model:"openai/gpt-4o-mini",messages:[{role:"user",content:$s}]}')
# → 413 Payload Too Large  (旧版はここを通していた)
```

### V.4.c Content-Length ヘッダ偽装

```bash
# Content-Length を意図的に小さく見せかける
# (HTTP 仕様上、curl だと curl 側が再計算してしまうので、
#  nc / openssl s_client で直接送るか、wrk スクリプト等を使う)
# 期待: byteLength で再判定するので 413
```

### V.4.d 1 メッセージに 32KB 超を集中投入 (Phase 2.2 追加判定)

```bash
# 全体は 80KB だが 1 個の content が 50KB
python3 -c 'print("a"*50000)' > /tmp/onemsg.txt
curl -i -X POST "$API/chat" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Origin: $ORIGIN" \
  -H "Content-Type: application/json" \
  --data-binary @<(jq -nR --rawfile s /tmp/onemsg.txt \
    '{model:"openai/gpt-4o-mini",messages:[{role:"user",content:$s}]}')
# → 413 Payload Too Large
# ログ: { "event": "message_content_too_large", ... }
```

---

## V.5 429 系

### V.5.a per-user rate (10 req/min)

```bash
for i in $(seq 1 12); do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST "$API/chat" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Origin: $ORIGIN" \
    -H "Content-Type: application/json" \
    -d '{"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
done
# → 200 が 10 個、その後 429 が出始める
# ログ: { "event": "user_limit_exceeded", "reason": "rate_limit", "user_hash": "abcd1234" }
```

### V.5.b ai-hub のアプリキー rate (30 req/min)

api-backend を経由しない直接の検証は不要 (Service Binding 越し)。

### V.5.c monthly token 上限 (per-user)

`api-backend/index.js` の `DEFAULT_USER_MONTHLY_TOKEN_LIMIT` を一時的に
1,000 に下げて検証するのが現実的:

```bash
# 数回叩いて累計が 1,000 を超えると 429
# ログ: { "event": "user_limit_exceeded", "reason": "monthly_limit" }
```

### V.5.d monthly token 上限 (アプリキー)

ai-hub の `monthly_token_limit` を `keydata.json` で 1,000 に下げて確認。

### V.5.e 並行リクエストでの超過なし (Phase 3.2)

```bash
# max_tokens=2000 を 5 並列、monthly_limit=5000 で試す
for i in $(seq 1 5); do
  (curl -s -X POST "$API/chat" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Origin: $ORIGIN" \
    -H "Content-Type: application/json" \
    -d '{"model":"openai/gpt-4o-mini","max_tokens":2000,"messages":[{"role":"user","content":"hi"}]}'
  ) &
done
wait
# → 並行でも合計予約 (5 * 2000 = 10000) > limit (5000) を超過した時点で 429。
#    旧版は実消費が後追いだったので 5 全部通って 10000 ぶん使ってしまった。
```

### V.5.f upstream 失敗時のスロット返却 (Phase 2.4)

意図的に AI Gateway を 502 にできない場合は、ai-hub の `AI_GATEWAY_URL` を
存在しないドメインに一時差し替えて検証。
- 1 リクエスト送ると 502 が返る
- すぐに次のリクエストを送ると **429 にならず通る** (slot が refund 済み)
- ログ: `{ "event": "user_refund_ok", "reason": "ai_hub_5xx" }` (api-backend) /
  `{ "event": "refund_ok", "reason": "upstream_5xx" }` (ai-hub)

---

## V.6 workers.dev 直叩き不到達確認

```bash
curl -i "https://ai-hub.YOUR_SUBDOMAIN.workers.dev/"
# → 404 / 521 / Cloudflare の "Not Found" ページ
# (workers_dev = false により Worker は route されない)
```

```bash
# 仮に従来 URL を覚えていて叩いてみても無効
curl -i -X POST "https://ai-hub.YOUR_SUBDOMAIN.workers.dev/" \
  -H "Authorization: Bearer ahk_..." \
  -H "Content-Type: application/json" \
  -d '{"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
# → 404 (アプリキーが正しくても到達しない)
```

api-backend 経由は問題なく動く:

```bash
curl -X POST "$API/chat" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Origin: $ORIGIN" \
  -H "Content-Type: application/json" \
  -d '{"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
# → 200 OK
```

---

## CSP report 受信確認 (P1.7)

CSP 違反を意図的に起こす:

```html
<!-- chat-app/index.html に一時的に追加 -->
<script>console.log("inline test")</script>
```

リロード → コンソール CSP エラー → `api.ddashpot.com/csp-report` に POST が飛ぶ。
api-backend のログに `{ "event": "csp_violation", "blocked_uri": "...", "violated_directive": "..." }` が
出ることを確認。

---

## ログ確認 (P2.3 構造化ログ)

```bash
npx wrangler tail api-backend --format=json | jq .
npx wrangler tail ai-hub --format=json | jq .
```

JSON 1 行で出ているか、`user_hash` が 8 文字の hex に丸まっているか (sha256Short の先頭 4 byte → 8 hex) 確認。
