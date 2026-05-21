# ddashpot AI Platform

複数の AI 連携アプリで共通利用するための基盤一式。

## 構成

```
┌───────────────────────────────────────────────────────────────────┐
│                                                                   │
│   [Browser]                                                       │
│      │ Clerk ログイン → JWT 取得                                  │
│      │                                                            │
│      ▼                                                            │
│   chat.ddashpot.com  (Cloudflare Pages: HTML/CSS/JS)              │
│      ├─ functions/_middleware.js: CSP nonce 注入                  │
│      ├─ _headers: HSTS preload / Reporting-Endpoints              │
│   appN.ddashpot.com  ← 今後増える個別アプリ                       │
│      │                                                            │
│      │ Authorization: Bearer <Clerk JWT> (SSE 可)                 │
│      ▼                                                            │
│   api.ddashpot.com  (Cloudflare Worker: api-backend)              │
│      - Clerk JWT 検証 (azp / AUTHORIZED_PARTIES)                  │
│      - per-user rate / monthly (Durable Object)                   │
│      - CSP report receiver (/csp-report)                          │
│      - SSE 中継 + usage 抽出                                      │
│      │                                                            │
│      │ Service Binding (env.AI_HUB.fetch)                         │
│      │ Authorization: Bearer ahk_xxx (内部用アプリキー)           │
│      ▼                                                            │
│   ai-hub  (Cloudflare Worker, workers_dev = false)                │
│      - アプリキー検証 (KV にハッシュ保存)                         │
│      - allowed_models / rate / monthly (Durable Object 予約制)    │
│      - SSE 中継 + usage 抽出                                      │
│      │                                                            │
│      │ cf-aig-authorization: Bearer <Gateway Token>               │
│      ▼                                                            │
│   gateway.ai.cloudflare.com  (Cloudflare AI Gateway)              │
│      - BYOK でプロバイダーキーを差し込み                          │
│      │                                                            │
│      ▼                                                            │
│   OpenAI / Anthropic / Google / xAI ...                           │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

## ディレクトリ構成

```
ddashpot-ai/
├── README.md                ← このファイル
├── SECURITY-CHANGES.md      ← 旧版からの変更履歴
├── VERIFICATION.md          ← V.1〜V.6 の検証手順
├── ai-hub/                  ← 内部用 AI プロキシ Worker
│   ├── index.js
│   ├── rate-limiter.js      ← Durable Object (rate / monthly 予約制)
│   ├── wrangler.toml        ← workers_dev = false
│   ├── package.json
│   └── README.md
├── api-backend/             ← 共通バックエンド Worker (api.ddashpot.com)
│   ├── index.js
│   ├── user-rate-limiter.js ← per-user の Durable Object
│   ├── wrangler.toml
│   ├── package.json
│   ├── scripts/
│   │   └── check-config.mjs ← predeploy で AUTHORIZED_PARTIES 検査
│   └── README.md
├── frontend-lib/            ← 共通フロントライブラリ
│   └── ai-client.js         ← chat() / chatRaw() / chatStream()
└── chat-app/                ← テスト用シングルチャットアプリ
    ├── index.html           ← Clerk SDK 固定バージョン + SRI
    ├── style.css
    ├── app.js               ← ストリーミング対応
    ├── ai-client.js         ← frontend-lib からコピー
    ├── _headers             ← Pages のセキュリティヘッダ
    ├── functions/
    │   └── _middleware.js   ← CSP nonce 注入 (HTML レスポンス)
    └── README.md
```

## セキュリティ責務の分離

| 層 | 認証 | 何を守るか |
|---|---|---|
| chat-app (フロント) | なし | 公開 OK |
| api-backend | Clerk JWT | エンドユーザー単位 |
| ai-hub | アプリキー (Bearer) | アプリ単位、コスト制御 |
| AI Gateway | Gateway Token | プロバイダー API キーの BYOK 保護 |

**重要**: 各層のキー/トークンは絶対に下層に降ろさない。

- Clerk Secret Key → api-backend にしか置かない
- ai-hub アプリキー (`ahk_xxx`) → api-backend にしか置かない
- Gateway Token → ai-hub にしか置かない
- プロバイダー API キー → AI Gateway の BYOK にしか置かない

## セットアップ全体の流れ

旧 ai-hub Worker は**先に停止**してから始めること
(`ALLOWED_ORIGIN` を空に変更してデプロイ、または Worker を削除)。

### ステップ1: 新 AI Gateway 作成

旧 Account ID / Gateway ID (`8bf23c7b...` / `ai-shuttle-api`) は公開済みのため、新規作成を強く推奨。

1. Cloudflare → AI → AI Gateway → 新規作成
2. **Authenticated Gateway** を ON
3. **Provider Keys** に各社の API キーを登録 (BYOK)
4. Gateway Token を発行 (Run 権限)

### ステップ2: ai-hub デプロイ

詳細は `ai-hub/README.md`。

```bash
cd ai-hub
npm install
npx wrangler kv namespace create "KEYS_KV"
# wrangler.toml に KV id と新 Gateway URL を反映
npx wrangler secret put CF_AIG_TOKEN
npx wrangler deploy
```

### ステップ3: アプリキー発行

```bash
echo "ahk_$(openssl rand -hex 24)"
# 出力された ahk_xxx を keydata.json と共に KV へ登録 (詳細は ai-hub/README.md)
```

### ステップ4: Clerk プロジェクト作成

1. https://dashboard.clerk.com で新規アプリ
2. Sign-in methods 設定 (Email + Google 推奨)
3. Publishable Key と Secret Key を控える

### ステップ5: api-backend デプロイ

```bash
cd api-backend
npm install
# wrangler.toml の AUTHORIZED_PARTIES を本番ドメインに書き換え (必須)
# [[services]] AI_HUB が ai-hub Worker 名 と一致しているか確認
npx wrangler secret put CLERK_SECRET_KEY
npx wrangler secret put AI_HUB_KEY
npm run deploy
# ↑ npm run deploy は predeploy で AUTHORIZED_PARTIES を検査するので、
#   未設定/プレースホルダのままだと exit 1 で止まる
# Cloudflare Pages or Workers 管理画面で api.ddashpot.com をカスタムドメインに設定
```

### ステップ6: chat-app デプロイ

```bash
# chat-app/index.html を編集:
#   - Clerk Publishable Key を実値に
#   - Clerk Frontend API URL を実値に
#   - @clerk/clerk-js@5.50.0 のバージョンは固定のまま
#   - integrity の sha384-... を実際に計算して差し替え
#     (curl -sL "<URL>" | openssl dgst -sha384 -binary | openssl base64 -A)
git add . && git commit -m "Initial" && git push
# Cloudflare Pages で GitHub 連携 → build output dir = chat-app
# Custom Domain で chat.ddashpot.com を設定
# functions/_middleware.js は Pages が自動的に Function として読み込む
```

### ステップ7: 動作確認

| 確認項目 | 期待 |
|---|---|
| `chat.ddashpot.com` を開く | ログイン画面表示 |
| Clerk でログイン | チャット UI 表示 |
| メッセージ送信 | AI が **文字単位で流れて** 返答 |
| `curl api.ddashpot.com/chat` (認証なし) | 401 |
| `curl ai-hub.workers.dev/` | 404 (workers_dev=false で塞いだ) |

詳細な検証手順 (V.1〜V.6 の各観点) は `VERIFICATION.md` を参照。

## 開発用ローカル起動

各 Worker ディレクトリで:

```bash
npx wrangler dev    # http://localhost:8787 で起動
```

chat-app:

```bash
cd chat-app
python3 -m http.server 8000
# → http://localhost:8000
```

ローカル時は `chat-app/app.js` の `API_BASE` を一時的に `http://localhost:8787` に変更。
Clerk Dashboard で `http://localhost:8000` を Allowed origins に追加しておく。

## 新しいアプリを追加するとき

1. `chat-app` をコピーして `appN-app` ディレクトリ作成
2. `index.html`, `app.js` を用途に合わせて変更
3. `ai-client.js` は同じものをコピー (or シンボリックリンク)
4. Cloudflare Pages で新規プロジェクト作成
5. Custom Domain で `appN.ddashpot.com` を設定
6. **api-backend や ai-hub の変更は不要** ← これが基盤化の利点

## ユーザー単位の制限値 (プラン別)

`api-backend` の per-user レート / 月次トークン上限は、Clerk JWT の
`public_metadata` から動的に取り出す (なければデフォルト)。

### Clerk JWT Template の設定

Clerk Dashboard → JWT Templates → "Default" (または api-backend で使うテンプレート) に
以下のクレームを追加:

```json
{
  "public_metadata": "{{user.public_metadata}}"
}
```

### ユーザーの public_metadata 設定例

```json
{
  "ai_limits": {
    "rate_per_minute": 30,
    "monthly_token_limit": 1000000
  }
}
```

| プラン | rate_per_minute | monthly_token_limit |
|---|---:|---:|
| Free (未設定) | 10 | 100,000 |
| Pro | 30 | 1,000,000 |
| Team | 60 | 5,000,000 |

api-backend 側には `HARD_MAX_USER_RATE_PER_MINUTE` / `HARD_MAX_USER_MONTHLY_TOKEN_LIMIT`
の天井 (600 req/min, 1億 tokens/month) があるため、`public_metadata` で値が
吹き飛ばされても上限を超えない。



## 今後の拡張ポイント

- **D1 でユーザー別利用量管理**: api-backend に D1 を追加し、現在 DO 内でしか
  見えない使用量履歴を BigQuery/D1 に流して可視化
- **プラン/課金**: 上記「ユーザー単位の制限値」は Clerk public_metadata 経由で
  すでに動的化済み。Stripe Webhook を api-backend に追加して、サブスク状態の
  変化で Clerk metadata を更新すれば、`UserRateLimiter` の判定値が次の
  リクエストから即反映される
- **HSTS preload list 登録**: `https://hstspreload.org/` で `ddashpot.com`
  を申請 (preload ディレクティブ自体は宣言済み)
- **CSP style-src の `'unsafe-inline'` 排除**: Clerk SDK の nonce 対応待ち、
  または Clerk `appearance` API で全 style を自前 CSS に寄せる
- **会話履歴**: 個別アプリの責務 (D1 を直接使う or api-backend に履歴 API を追加)

## トラブルシューティング

| 症状 | 原因 |
|---|---|
| `401 Invalid token` (api-backend) | Clerk JWT 失効 / Secret Key 不一致 / Clerk アプリ間違い |
| `401 Unauthorized` (ai-hub) | AI_HUB_KEY 未設定 or 値違い / KV に該当 apikey 未登録 |
| `403 Forbidden origin` | Origin が `*.ddashpot.com` パターンに合わない |
| `403 Model not allowed` | KV の `allowed_models` に指定モデルがない |
| `429 Rate limit / Monthly limit` | KV の `rate_per_minute` / `monthly_token_limit` 到達 |
| `502 Upstream error` | ai-hub から AI Gateway への通信失敗 / Gateway Token 不正 |
| Clerk SDK が読み込まれない | `index.html` の Frontend API URL が間違っている |
| CORS エラー | `api-backend/index.js` の `ALLOWED_ORIGIN_PATTERN` を確認 |

## ライセンス

(必要に応じて記入)
