# セキュリティ修正サマリ

旧版コードに対する変更点をまとめる。重大なものから順に記載。

## 🔴 重大な修正

### 1. レート制限・月次利用量を Durable Object でアトミック化
- **対象**: `ai-hub/index.js`, `ai-hub/rate-limiter.js` (新規), `ai-hub/wrangler.toml`
- **問題**: 旧版は KV を `read → check → ctx.waitUntil(put)` で更新しており、
  並行リクエストで race condition が発生。月次トークン上限・分単位レート制限の
  いずれも実質ザル状態だった。
- **修正**: `RateLimiter` という Durable Object を新設し、`blockConcurrencyWhile`
  で排他制御。1 アプリキー(のハッシュ) = 1 DO インスタンス。
- **デプロイ時の注意**: 初回 `wrangler deploy` 時に migration `v1` が走り、
  新しい DO クラスが作られる。

### 2. ai-hub への中継を Service Binding 経由に変更
- **対象**: `api-backend/index.js`, `api-backend/wrangler.toml`
- **問題**: 旧版は `env.AI_HUB_URL` (workers.dev の公開 URL) に対して fetch していた。
  URL とアプリキーが漏れたら世界中から殴れる。
- **修正**: `env.AI_HUB` を Service Binding として定義し、Cloudflare 内部経路で呼び出す。
  これにより ai-hub 側は `workers_dev = false` まで設定可能 (運用方針次第)。

### 3. Origin ヘッダを認証エンドポイントで必須化
- **対象**: `api-backend/index.js`
- **問題**: 旧版は `Origin` ヘッダが無いリクエストを素通しさせていた。
  「Clerk JWT で弾かれる」とコメントしていたが、JWT を持つユーザーは
  任意のクライアントから API を直接叩けるため CSRF 防御として不完全だった。
- **修正**: `/chat` などの認証エンドポイントでは Origin ヘッダ必須。
  `/health` (GET) のみ Origin 無しでも通す。

### 4. Clerk verifyToken に authorizedParties を指定
- **対象**: `api-backend/index.js`, `api-backend/wrangler.toml`
- **問題**: 旧版は secretKey だけで検証していたため、azp クレームの照合が無く、
  別 origin で発行された JWT も通過し得た。
- **修正**: `AUTHORIZED_PARTIES` 環境変数 (カンマ区切り) を verifyToken に渡す。
  本番は `https://chat.ddashpot.com` のみ、開発は localhost を追加。

### 5. リクエストボディをホワイトリスト方式で再構築
- **対象**: `ai-hub/index.js`
- **問題**: 旧版は `model` と `messages` の存在しか見ず、`tools` / `response_format`
  / `stream` / `logit_bias` / `user` / `metadata` 等を素通しでプロバイダーに転送。
- **修正**: `ALLOWED_TOP_LEVEL_KEYS` で許可キーだけ通す。messages 配列は
  各要素の role / content の型もチェック。配列長は最大 100。

## 🟡 中程度の修正

### 6. エラー詳細をクライアントに返さない
- **対象**: `api-backend/index.js`, `ai-hub/index.js`
- **問題**: 旧版は `detail: String(e.message)` を 401 レスポンスに含めていた。
- **修正**: 内部詳細は `console.warn/error` でログのみに残し、
  クライアントには汎用メッセージを返す。トップレベルの try/catch も追加。

### 7. ローカル開発 origin を環境分岐
- **対象**: `api-backend/index.js`, `api-backend/wrangler.toml`
- **問題**: 旧版は `localhost:8000` 等を本番にも許可していた。
- **修正**: `ENVIRONMENT === "development"` のときだけ localhost origin を許可。
  本番デプロイには影響を出さない。

### 8. レスポンスサイズに上限を設定
- **対象**: `ai-hub/index.js`
- **問題**: 旧版はリクエスト側のみ 100KB 制限で、プロバイダーからのレスポンス
  サイズは無制限だった。
- **修正**: `MAX_RESPONSE_SIZE = 1MB` を超えたら 502。

### 9. max_tokens の値域を厳格化
- **対象**: `ai-hub/index.js`
- **問題**: 旧版は `> cap` だけ見ていたので、負値や 0 がそのまま通過していた。
- **修正**: `Number.isInteger(x) && x > 0 && x <= cap` を満たさない場合は cap に置換。

### 10. KV 上のアプリキーをハッシュ化
- **対象**: `ai-hub/index.js` (および `ai-hub/README.md` での運用変更)
- **問題**: 旧版は `apikey:ahk_xxx` の形で平文保存。KV ダンプ漏洩時にそのまま使える。
- **修正**: SHA-256 でハッシュ化したキーを KV キーに使う (`apikey:<hex>`)。
  ahk_xxx 自体は発行直後に控え、KV には登録しない (詳細はai-hub/README.md 参照)。
- **移行**: 既存キーは `wrangler kv key get` で取り出し → ハッシュ計算 → 再登録。

### 11. Cache-Control: private, no-store をレスポンスに付与
- **対象**: 全レスポンス
- **理由**: AI 応答が経路上のキャッシュに乗らないように。

### 12. chat-app に CSP / セキュリティヘッダを追加
- **対象**: `chat-app/_headers` (新規)
- **内容**: CSP、X-Content-Type-Options、X-Frame-Options、Referrer-Policy、
  Permissions-Policy、HSTS。XSS が起きたときの被害を抑える。
- **注意**: Clerk SDK の都合で script-src に `unsafe-inline` を含めている。
  Clerk のドキュメントに従って nonce ベースに移行すれば更に堅くできる。

## デプロイ手順 (新規/差分)

1. ai-hub:
   ```bash
   cd ai-hub
   npm install
   # KV namespace の id が未設定なら作成
   npx wrangler kv namespace create "KEYS_KV"   # 既存なら不要
   # 既存アプリキーをハッシュ化キーに再登録 (移行)
   #   旧: apikey:ahk_xxx → 新: apikey:<sha256(ahk_xxx)>
   npx wrangler secret put CF_AIG_TOKEN
   npx wrangler deploy   # ← DO の migration v1 が走る
   ```

2. api-backend:
   ```bash
   cd api-backend
   npm install
   # AUTHORIZED_PARTIES を wrangler.toml で確認 (本番ドメイン)
   npx wrangler secret put CLERK_SECRET_KEY
   npx wrangler secret put AI_HUB_KEY
   npx wrangler deploy   # ← Service Binding が ai-hub に向く
   ```

3. chat-app:
   ```bash
   # _headers が build output に含まれることを確認 (Pages が自動配信)
   # Cloudflare Pages の DevTools で Response Headers に CSP が出ているか確認
   ```

## 🟢 軽微な修正

### 13. レスポンス Content-Type を正規化
- **対象**: `ai-hub/index.js`, `api-backend/index.js`
- **内容**: プロバイダーからのレスポンスに `Cache-Control: private, no-store` を
  必ず付ける。`Set-Cookie` 等の不要ヘッダは落とす (ホワイトリスト方式)。

---

# 追加修正 (今回の Phase 1/2/3)

旧版 → 今回の差分。チェックリストに従って網羅的に対応。

## Phase 1 — クイックウィン

### P1.1 ai-hub の workers.dev 直叩きを塞ぐ 🔴
- **対象**: `ai-hub/wrangler.toml`
- **修正**: `workers_dev = false` を追加。これで `*.workers.dev` ホストが
  生えなくなり、AI_HUB_KEY が漏れても外部 fetch 経路は閉鎖される。
- **アクセス経路**: api-backend からの Service Binding のみ。
- **検証**: V.6 で curl が 404 になることを確認。

### P1.2 AUTHORIZED_PARTIES 未設定をデプロイ失敗にする 🔴
- **対象**: `api-backend/scripts/check-config.mjs` (新規),
  `api-backend/package.json`, `api-backend/index.js`
- **修正**:
  - npm の `predeploy` フックで `check-config.mjs` を走らせる。
    `wrangler.toml` をパースし、`AUTHORIZED_PARTIES` が空 /
    プレースホルダ / `localhost` を含む場合 (= 開発値のまま) は exit 1。
  - ランタイム側でも `parseAuthorizedParties()` が空配列を返した場合は
    本番環境では **起動時の最初の `/chat` で 500** を返すよう変更。
    黙って azp を素通しさせない。

### P1.3 Clerk SDK のバージョン固定 + SRI 追加 🔴
- **対象**: `chat-app/index.html`, `chat-app/README.md`
- **修正**:
  - `@clerk/clerk-js@latest` を `@clerk/clerk-js@5.50.0` に固定 (例)。
  - `integrity="sha384-..."` を追加。プレースホルダ `REPLACE_WITH_SRI_HASH`。
  - README にハッシュ計算手順 (`curl -sL ... | openssl dgst -sha384 -binary | openssl base64 -A`)
    を記載。バージョン更新時は再計算する旨も明記。

### P1.4 ボディサイズをバイト単位で判定 🔴
- **対象**: `ai-hub/index.js`, `api-backend/index.js`
- **問題**: 旧版は `text().length` で判定していた。日本語 1 文字が UTF-8 で
  3 バイトなので、文字長 100KB 制限を実バイトで 300KB まで通せた。
- **修正**: `request.arrayBuffer()` を取得し `.byteLength` で判定。
  以降は `TextDecoder` で文字列化して JSON.parse。
  Content-Length ヘッダだけに頼らない (偽装可能)。

### P1.5 api-backend/README.md の AI_HUB_URL 記述削除 🟢
- **対象**: `api-backend/README.md`, `ai-hub/README.md`
- **修正**: 「`AI_HUB_URL` を ai-hub Worker の URL に書き換え」の手順を削除し、
  Service Binding ベースの記述に置換。ai-hub README からも
  「workers.dev URL を api-backend の AI_HUB_URL に設定する」の記載を削除。

### P1.6 HSTS に preload 追加 🟢
- **対象**: `chat-app/_headers`, `chat-app/functions/_middleware.js`
- **修正**: `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`。
  Pages Function 側でも同じ値をセット。`hstspreload.org` への登録を
  運用手順に追加 (任意)。

### P1.7 CSP に report-to / report-uri 追加 🟢
- **対象**: `chat-app/_headers`, `chat-app/functions/_middleware.js`,
  `api-backend/index.js`
- **修正**:
  - フロント側: `report-uri https://api.ddashpot.com/csp-report`、
    `report-to csp-endpoint`、 `Report-To` および `Reporting-Endpoints`
    ヘッダで csp-endpoint を `https://api.ddashpot.com/csp-report` に向ける。
  - バックエンド側: `POST /csp-report` を新設。Reporting API (Level 3) の
    配列形式と Level 2 (`{"csp-report": ...}`) の両方を受け付け、
    `console.warn` に構造化 JSON で出力。サイズ上限 32KB。

## Phase 2 — 中規模修正

### P2.1 api-backend に per-user レート制限 DO を追加 🟡
- **対象**: `api-backend/user-rate-limiter.js` (新規),
  `api-backend/index.js`, `api-backend/wrangler.toml`
- **修正**: `UserRateLimiter` という Durable Object を追加。
  Clerk userId (sub) ごとに 1 インスタンス。
  既定で **10 req/min / 100,000 tokens/month**。
  ai-hub 側のアプリキー全体クォータを 1 ユーザーが食い潰すのを防ぐ。
  rate / monthly が **api-backend で先に判定** されるので、ai-hub に
  到達する前に 429 を返す。
- **将来拡張**: Clerk publicMetadata や D1 で per-user 上書きを入れたい場合は
  `/check` 呼び出し時に `rate_per_minute` / `monthly_token_limit` を渡せば
  DO 側がそちらを採用する設計にしてある。

### P2.2 message.content の長さ上限追加 🟡
- **対象**: `ai-hub/index.js`
- **修正**: `MAX_MESSAGE_CONTENT_SIZE = 32_000` バイト。
  各 `messages[i].content` をバイト単位 (`TextEncoder().encode().length`)
  で判定。文字列でも配列 (vision) でも同様にチェック。
  全体ボディの 100KB 枠を 1 メッセージに全部突っ込む攻撃を遮断。

### P2.3 構造化ログ導入 🟡
- **対象**: `ai-hub/index.js`, `api-backend/index.js`
- **修正**: `logEvent(level, event, fields)` 関数を両 Worker に導入。
  全主要イベント (`clerk_verify_failed`, `user_limit_exceeded`,
  `upstream_5xx`, `csp_violation`, `model_not_allowed`, `message_content_too_large`,
  `user_refund_ok`, `refund_ok` 等) を JSON 1 行で出力。
  PII 保護のため `user_id` は **SHA-256 の先頭 8 文字** に丸める
  (`sha256Short`)。Cloudflare Logpush でそのまま BigQuery 等に流せる。

### P2.4 アップストリーム失敗時のレートスロット返却 🟡
- **対象**: `ai-hub/index.js`, `ai-hub/rate-limiter.js`,
  `api-backend/index.js`, `api-backend/user-rate-limiter.js`
- **問題**: AI Gateway 502 などでも rate slot と予約 token 枠が消費され、
  ユーザーが正常に応答を受け取れていないのに 429 が出やすくなる。
- **修正**:
  - DO に `POST /refund` エンドポイントを追加。`{minute_slot, reserved_tokens}`
    を受けて該当スロットの count を 1 戻し、`usage.reserved` から
    予約 token を引く。
  - ai-hub / api-backend どちらも、upstream の 5xx および fetch 例外を
    捕捉した瞬間に `/refund` を呼ぶ。例外時の二重消費を防ぐため、
    `add-usage` が成功したら refund は呼ばない (フラグ管理)。

### P2.5 img-src を絞る 🟡
- **対象**: `chat-app/_headers`, `chat-app/functions/_middleware.js`
- **修正**: `img-src 'self' data: https:` → `img-src 'self' data:
  https://*.clerk.accounts.dev https://*.clerk.com https://img.clerk.com`。
  任意 https origin の埋め込みを禁止。

## Phase 3 — 設計変更

### P3.1 CSP `unsafe-inline` 解消 (Clerk nonce 移行) 🔴
- **対象**: `chat-app/functions/_middleware.js` (新規)
- **修正**: Cloudflare Pages Function を新設し、
  - per-request に 16 byte → base64 の nonce を生成
  - `HTMLRewriter` で全 `<script>` タグに `nonce="X"` を注入
  - レスポンスの CSP ヘッダを動的に組み立て、
    `script-src 'self' 'nonce-X' 'strict-dynamic' https://*.clerk.accounts.dev https://*.clerk.com`
    に置換 (`'unsafe-inline'` 排除)。
  これにより XSS による任意 script 実行が CSP で遮断される。
- **残る暫定**: `style-src` には依然 `'unsafe-inline'` を残す。Clerk SDK が
  動的にインラインスタイルを差し込むため。Clerk 側が nonce 対応するか、
  Clerk の `appearance` API で全 style を自前 CSS に寄せれば外せる。
- **非 HTML レスポンス**: `_headers` の CSP (フォールバック) が効く。

### P3.2 月次トークン上限を予約制に変更 🟡
- **対象**: `ai-hub/rate-limiter.js`, `ai-hub/index.js`,
  `api-backend/user-rate-limiter.js`, `api-backend/index.js`
- **問題**: 旧版は実消費トークンを `add-usage` 時にのみ加算していた。
  同時刻に `rate × max_tokens` 個の枠が並行で走り得て、月次上限を
  最大 `rate × max_tokens` ぶん超過する。
- **修正**: DO の `/check` に `reserve_tokens` パラメータを追加。
  - `check`: `usage.tokens + usage.reserved + reserve_tokens > monthly_limit`
    なら `monthly_exceeded`。そうでなければ `usage.reserved += reserve_tokens`
    を加算して許可。
  - `add-usage`: `usage.reserved -= reserved_tokens` のあと
    `usage.tokens += actual_total_tokens`。
  - `refund`: `usage.reserved -= reserved_tokens` のみ。
- `reserve_tokens` には `max_tokens` の値を渡す。`max_tokens` が指定されない
  場合はキャップ値 (`max_tokens_cap`) を予約する保守的動作。

### P3.3 ストリーミング対応 🟢
- **対象**: `ai-hub/index.js`, `api-backend/index.js`,
  `frontend-lib/ai-client.js`, `chat-app/ai-client.js`, `chat-app/app.js`
- **修正**:
  - ai-hub / api-backend ともに `TransformStream` で SSE をパススルー。
    最終チャンクの `data: {...}` から `usage.total_tokens` を抽出し、
    `flush()` 内で `/add-usage` を非同期呼び出し。
    累計バイト数も監視し、`MAX_RESPONSE_SIZE` を超えたらストリームを中断。
  - ストリーム時は `stream_options.include_usage = true` を **サーバー側で強制**。
    クライアントが渡してこなくても usage が必ず最終 chunk に乗る。
  - api-backend はリクエストを ArrayBuffer のまま (Content-Length 明示)
    ai-hub に転送。これで ai-hub 側のバイト判定が壊れない。
  - ai-client.js に `async *chatStream()` を追加。SSE をパースして
    OpenAI 互換の delta オブジェクトを yield する非同期ジェネレータ。
  - chat-app の `app.js` は `for await` で chunk を受け、
    `choices[0].delta.content` を逐次連結して `updateMessage()`。

---

## 残課題 (今回後)

- **HSTS preload list 登録**: `_headers` で `preload` ディレクティブを宣言したので、
  運用者は `https://hstspreload.org/` で `ddashpot.com` を申請する必要がある。
- **CSP style-src `'unsafe-inline'`**: Clerk 側の nonce 対応待ち、または
  Clerk `appearance` API で全 style を自前 CSS に寄せる方針。
- **per-user 上限の動的化**: 現在は環境変数の固定値。Clerk publicMetadata
  または D1 で `userId → {rate, monthly}` を引けるようにすると柔軟。
- **DO ストレージの monthly key の TTL**: 現状は月キー (`2026-05` 等) に
  自然分散させているだけ。古い月のレコードを掃除する cron Worker があると良い。
- **AI Gateway 側のキャッシュ統制**: AI Gateway の cache 機能を有効化する場合、
  どの request 属性で cache key を作るかをアプリ要件と合わせて検討する。

---

# 監査後修正 (Phase 1/2/3 適用後の追加 patch)

## 🔴 P2.4 補正: api-backend 5xx 時の二重簿記バグ修正

- **対象**: `api-backend/index.js`
- **問題**: `aiRes.status >= 500` で `refundUser()` を発火させたあと、
  早期 return せずに後続の `streamRelay`(flush で add-usage 呼び出し) または
  非ストリーミング経路(add-usage 直接呼び出し)が走っていた。
  これにより同一 DO 内の `usage.reserved` から `userReserved` ぶんが
  2 回引かれ、同一ユーザーの並行リクエストの予約分が消失する。
  `Math.max(0, ...)` で負値は防げているが、並行リクエストの予約は失われる。
- **修正**: `aiRes.status >= 500` 分岐で refund + ボディ転送をその場で完結させ、
  以降の add-usage を呼ばずに即 return する。ai-hub は 5xx 時に必ず
  `application/json` でエラーボディを返すので、ストリーム経路に流す必要も無い。
- **波及**: ai-hub 側 (`gwRes.status >= 500`) は元から早期 return しており、
  この問題は存在しなかった。修正は api-backend 側のみ。

## 🟢 ドキュメント整合性修正

- `api-backend/README.md`: 存在しない `ALLOWED_ORIGINS` 設定変数の記述を削除。
  CORS は `ALLOWED_ORIGIN_PATTERN` (`index.js` 内ハードコード正規表現) で照合する旨を明記。
- `VERIFICATION.md`: ログ event 名を実コードと一致させる
  (`auth_failed` → `clerk_verify_failed`, `rate_limited` → `user_limit_exceeded`,
  `monthly_exceeded` → `user_limit_exceeded` (reason=monthly_limit),
  `message_too_large` → `message_content_too_large`,
  `refund_issued` → `user_refund_ok` / `refund_ok`,
  `config_error` → `config_missing_authorized_parties_runtime`).
  `user_id` → `user_hash` (フィールド名も実装に合わせる).

## 🟡 追加修正 (今回)

### per-user 制限値を Clerk JWT public_metadata から動的化
- **対象**: `api-backend/index.js`
- **問題**: per-user の `rate_per_minute = 10` / `monthly_token_limit = 100_000` が
  ハードコードされており、全ユーザー一律の制限になっていた。
  プラン別の制限を入れるには毎回コード変更とデプロイが必要。
- **修正**: `resolveUserLimits(payload)` を追加し、Clerk JWT の `public_metadata.ai_limits`
  から `rate_per_minute` / `monthly_token_limit` を読む。未設定なら `DEFAULT_USER_*` を使う。
  `HARD_MAX_USER_*` で天井を設けてあるため、metadata を経由して任意の大きな値を
  渡されても上限を超えない。
- **運用**:
  - Clerk Dashboard → JWT Templates に `"public_metadata": "{{user.public_metadata}}"` を追加.
  - 各ユーザーの `public_metadata.ai_limits` を更新するだけで次のリクエストから反映.
  - Stripe Webhook → Clerk metadata 更新、の流れでプラン課金と接続できる.

### ストリーミングリクエストへの 4xx を JSON で返す
- **対象**: `api-backend/index.js`
- **問題**: `stream:true` で来たリクエストに対し、ai-hub が 4xx (401/403/429 等) を
  返した場合でも `streamRelay()` 経由でレスポンスを返していた。
  ai-hub の 4xx ボディは `application/json` なので、SSE 解析 TransformStream に
  流す意味が無いだけでなく、レスポンスの Content-Type が ai-hub の値 (`application/json`)
  のまま返るため、クライアント (`AIClient.chatStream`) は SSE として解析できず、
  ユーザーには「壊れた SSE」として届いていた。
- **修正**: `if (isStream && aiRes.body && aiRes.ok)` に条件追加し、`aiRes.ok === false`
  なら非ストリーム経路 (= JSON pass-through) を通す。これで:
  - クライアントは `res.ok=false` を見て `res.json()` でエラー詳細を取れる
  - per-user の予約トークンは tokens=0 の add-usage で正しく解放される (二重簿記回避)

## 🟢 メンテナンス改善

### chat-app の ai-client.js を frontend-lib と同期するスクリプト
- **対象**: `chat-app/scripts/sync-frontend-lib.mjs` (新規), `chat-app/package.json` (新規),
  `chat-app/README.md`
- **問題**: `chat-app/ai-client.js` と `frontend-lib/ai-client.js` は同じ内容を
  手動コピーで運用しており、片方だけ更新するリスクがあった。
- **修正**: `sync-frontend-lib.mjs` を追加。`--check` で差分があれば exit 1。
  Cloudflare Pages の Build command に `npm run build` (= `npm run check`) を
  入れておけば、同期忘れの状態でのデプロイをビルド時に止められる。

---

# 監査後追加修正 (v2 patch — 整合性 / defense-in-depth / DX 改善)

## 🔴 v2.1 ai-hub の 4xx 応答もストリーム経路に流していたのを修正

- **対象**: `ai-hub/index.js`
- **問題**: api-backend 側 (前回の P3.3 対称修正) では `aiRes.ok` チェックで
  4xx を streamRelay から弾いていたが、ai-hub 側は `if (isStream && gwRes.body)`
  だけで `gwRes.ok` を見ておらず、AI Gateway の 4xx (429 等) を
  `streamResponse()` に流していた。結果として:
  - AI Gateway の `application/json` エラーボディが
    `streamResponse()` の `Content-Type` フォールバック (`text/event-stream`) で
    上書きされうる経路ができていた
  - SECURITY-CHANGES.md と実コードに対称性破れ
- **修正**: `if (isStream && gwRes.body && gwRes.ok)` に変更。4xx は下の
  非ストリーミング経路で respText として pass-through する。
  4xx 経路でも `add-usage` が `tokens=0, reserved_tokens=X` で呼ばれて
  予約解放されるので二重簿記は起きない。

## 🟠 v2.2 api-backend の streamRelay にレスポンスサイズ上限を追加

- **対象**: `api-backend/index.js`
- **問題**: ai-hub 側は `MAX_RESPONSE_SIZE = 1MB` で打ち切っていたが、
  api-backend 側の `streamRelay` には同等のチェックがなく、defense-in-depth が抜けていた。
  `buffer` も改行なしのストリームが続くと無制限に成長しうる。
- **修正**: `MAX_STREAM_BYTES = 2_000_000` を導入 (ai-hub 上限の 2 倍を安全側で確保)。
  `totalBytes` を chunk ごとに加算し、超えたら `controller.error()` で打ち切り、
  `pipeTo` の catch 経由で refund が走る。

## 🟠 v2.3 wrangler dev が production [vars] を読んでいたのを修正

- **対象**: `api-backend/package.json`
- **問題**: `npm run dev` (= `wrangler dev`) は `--env` 未指定だと
  トップレベルの `[vars]` を読むため、開発中も `ENVIRONMENT="production"` /
  `AUTHORIZED_PARTIES="https://chat.ddashpot.com"` のみで起動していた。
  これにより `http://localhost:8000` からの呼び出しが
  `resolveOrigin()` で弾かれて 403 Forbidden になり、ローカル開発が事実上できなかった。
- **修正**: `"dev": "wrangler dev --env dev"` に変更。
  `[env.dev.vars]` (localhost を含む) が読まれる。
  本番デプロイ (`npm run deploy` = `wrangler deploy`) は `[vars]` のままなので影響なし。

## 🟠 v2.4 chat-app のプレースホルダ未置換をビルドで検出

- **対象**: `chat-app/scripts/check-html.mjs` (新規), `chat-app/package.json`
- **問題**: api-backend には `check-config.mjs` (predeploy) があったが、chat-app には
  なく、`index.html` の `REPLACE_WITH_YOUR_CLERK_PUBLISHABLE_KEY` /
  `REPLACE_WITH_SRI_HASH` / `REPLACE_WITH_YOUR_CLERK_FRONTEND_API` を
  置換し忘れたまま Pages デプロイすると、本番でログイン不能になっていた。
- **修正**: `check-html.mjs` を新設し `index.html` のプレースホルダを exit 1 で検出。
  `@clerk/clerk-js@latest` の使用も禁止 (SRI と矛盾するため)。
  `npm run build` (= Pages Build command) で `check:sync` → `check:html` の順に走る。
  ローカルで Clerk を使わずに HTML 確認したい場合のみ `--skip` で抑制可能。

## 🟡 v2.5 add-usage 失敗時の refund フォールバック

- **対象**: `ai-hub/index.js`, `api-backend/index.js`
- **問題**: 応答取得後の `/add-usage` が失敗 (DO 内部エラー / fetch 例外) しても
  ログを出すだけで予約 (`usage.reserved`) を解放していなかった。
  まれだが、発生すると該当ユーザー (またはアプリキー) の月次枠が腐ったまま残る。
- **修正**: `add-usage` レスポンスを見て、`!r.ok` または例外時には
  `/refund` を呼んで予約だけは戻す。tokens の実消費計上は失われるが、
  ユーザーが正常応答を受け取れない (= 課金根拠が弱い) ケースでの
  最低限の保護として優先する。

## 🟡 v2.6 SSE flush() で残バッファの最終 data: を回収

- **対象**: `ai-hub/index.js` (streamResponse), `api-backend/index.js` (streamRelay)
- **問題**: ストリーム終端のチャンクが `\n` を伴わずに来た場合、最後の
  `data: {usage: ...}` が buffer に残ったまま flush() を迎え、usage を取りこぼす可能性。
  実際の OpenAI / Anthropic / Gateway は `\n\n` で終わるので確率は低いが、
  上流挙動の前提を実装で持たない方が安全。
- **修正**: `flush()` で `buffer` を trim して `data:` プレフィックスを確認し、
  最終 JSON があれば usage を回収。

## 🟡 v2.7 usage:{month} の永続蓄積を alarm でクリーンアップ

- **対象**: `ai-hub/rate-limiter.js`, `api-backend/user-rate-limiter.js`
- **問題**: alarm() は `rate:*` (分単位スロット) しか掃除しておらず、
  `usage:YYYY-MM` は月ごとに増え続けていた。長期運用で DO ストレージのコストが嵩む。
- **修正**: alarm() で `usage:*` も走査し、「今月」「先月」以外を削除。
  先月分を残すのは、月跨ぎ直後に発生する遅延 add-usage / refund が
  先月キーを触る可能性があるため (1 ヶ月の猶予)。

## 🟡 v2.8 chat-app のビルドツールファイルを公開しない

- **対象**: `chat-app/functions/_middleware.js`
- **問題**: Cloudflare Pages はディレクトリ直配信なので、`package.json` /
  `scripts/*` も `https://chat.ddashpot.com/package.json` 等で取れていた。
  機密ではないが、無駄な情報露出。
- **修正**: `_middleware.js` の冒頭で `/package.json`, `/scripts/*`,
  `/node_modules/*` 等のパスを 404 にする。

## 🟢 v2.9 chat-app のエラーメッセージ汎用化

- **対象**: `chat-app/app.js`
- **問題**: `e.message` をそのまま画面表示しており、`AIClient HTTP 500: ...` 等の
  内部由来文字列がユーザーに見えていた。
- **修正**: `e.status` を見てユーザー向けの一般化メッセージに丸める。
  詳細は `console.error` で開発者向けにだけ残す。

## 🔴 v2.10 AIClient のエラー経路で body 二重読みバグを修正

- **対象**: `frontend-lib/ai-client.js`, `chat-app/ai-client.js` (自動同期)
- **問題**: `!res.ok` のとき以下のパターンで body を 2 回読もうとしていた:
  ```js
  try {
    const e = await res.json();   // body 消費
    ...
  } catch {
    detail = await res.text();    // ← "Body already consumed" で TypeError
  }
  ```
  api.ddashpot.com の前段で事故が起きて HTML レスポンス (Cloudflare 1xxx 系
  エラーページ, ルート設定ミス, Pages フォールバック等) が返るケースで,
  `res.json()` が `SyntaxError: Unexpected token '<', "<!DOCTYPE "...` を投げ,
  catch 内の `res.text()` も二重読みで TypeError を投げる. **結果としてユーザーには**
  `TypeError: Body is unusable: Body has already been read` という意味不明なメッセージが
  出るうえ, `e.status` が undefined になるため `chat-app/app.js` の status 分岐
  (401/403/429/500 別の親切なメッセージ) も全部効かなくなっていた.
  さらに `chatRaw` の成功経路 (line 95: `return await res.json()`) には try-catch すらなく,
  200 OK で HTML が返ってきた場合に生の `SyntaxError` がそのまま伝播していた.
- **修正**:
  - body は `await res.text()` で **1 回だけ読む** → 文字列を `JSON.parse` で試す
  - 失敗時は `summarizeNonJson()` で HTML/empty/その他を判別した人間可読ラベルに変換
  - 成功経路 (`return JSON.parse(rawText)`) にも try-catch を入れ,
    `"server returned 200 but body is not JSON"` という明確な例外に変換
  - `err.bodySnippet` で先頭 500 バイトをデバッグ用に保持 (画面表示はしない)
- **検証**: test-harness の S9/S10/S11 で 502+HTML / 200+HTML / 503+空ボディ を
  網羅. 修正前は 3 ケースすべて `err.status=undefined` (= status 分岐崩壊) で FAIL,
  修正後はそれぞれ status=502/200/503 を保ったまま `Unexpected token '<'` 系の
  生 SyntaxError をユーザーに漏らさない.

