# chat-app (chat.ddashpot.com)

最小のシングルターン・チャットアプリ。
共通バックエンド (`api.ddashpot.com`) と Clerk 認証の動作確認用。

## ファイル構成

```
chat-app/
├── index.html              — UI 本体 (Clerk SDK の URL / SRI 書き換え必須)
├── style.css               — スタイル
├── app.js                  — チャットロジック (ストリーミング対応)
├── ai-client.js            — frontend-lib/ai-client.js から自動同期 (直接編集禁止)
├── _headers                — Cloudflare Pages のセキュリティヘッダ
├── package.json            — npm scripts (sync / check / build)
├── scripts/
│   └── sync-frontend-lib.mjs — frontend-lib との同期スクリプト
├── functions/
│   └── _middleware.js      — CSP nonce 注入 (HTML レスポンス全般)
└── README.md
```

## ai-client.js の同期について

`ai-client.js` の真実の源は `../frontend-lib/ai-client.js` で、`chat-app/ai-client.js`
は静的サイト配信のためのコピー。**直接編集しないこと**。

```bash
# frontend-lib 側を編集したあと:
npm run sync              # コピーを更新
npm run check             # 同期されているか確認 (CI 用、差分があれば exit 1)
```

Cloudflare Pages の Build settings:

| 項目 | 値 |
|---|---|
| Build command | `npm run build` (= `npm run check` と同義) |
| Build output dir | `chat-app` |

`Build command` を設定しておくと、`frontend-lib` 側だけ更新して `chat-app/ai-client.js`
の同期を忘れた状態の本番デプロイをビルド時に弾ける。

## セットアップ

### 1. Clerk SDK の URL / Publishable Key / SRI を書き換え

`index.html` の `<script>` タグ:

```html
<script
  async
  crossorigin="anonymous"
  data-clerk-publishable-key="pk_test_xxx..."
  integrity="sha384-XXXX..."
  src="https://YOUR_FRONTEND_API.clerk.accounts.dev/npm/@clerk/clerk-js@5.50.0/dist/clerk.browser.js"
  type="text/javascript"
></script>
```

- `YOUR_FRONTEND_API` … Clerk ダッシュボード → API Keys の "Frontend API" の
  サブドメイン部分 (例 `clean-llama-12`)
- バージョンは **必ず固定** (`@latest` 禁止)。ここでは `@5.50.0` を例示
- `integrity` は固定したバージョンの実 URL に対して以下で生成:

```bash
curl -sL "https://YOUR_FRONTEND_API.clerk.accounts.dev/npm/@clerk/clerk-js@5.50.0/dist/clerk.browser.js" \
  | openssl dgst -sha384 -binary \
  | openssl base64 -A
```

出力された文字列を `integrity="sha384-..."` に貼る。
**バージョンを上げた時は必ず再計算する。**

### 2. Clerk Dashboard でドメイン許可

- 開発時: `http://localhost:8000` を Allowed origins に追加
- 本番時: `https://chat.ddashpot.com` を追加

### 3. ローカル動作確認

```bash
cd chat-app
python3 -m http.server 8000
# → http://localhost:8000 にアクセス
```

ローカルでは Pages Function (`functions/_middleware.js`) は走らないので
`_headers` の CSP がそのまま効く (`unsafe-inline` 入りの暫定 CSP)。
本番デプロイ後に nonce 入り CSP が有効になる。

ローカル動作時は `app.js` の `API_BASE` を一時的に `http://localhost:8787`
(api-backend を `wrangler dev` で起動した場合) に変えても OK。

### 4. GitHub + Cloudflare Pages デプロイ

#### 4-1. GitHub にリポジトリ作成

```bash
cd ddashpot-ai
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin git@github.com:YOUR_USER/ddashpot-ai.git
git push -u origin main
```

#### 4-2. Cloudflare Pages で新規プロジェクト作成

1. Cloudflare ダッシュボード → Workers & Pages → Create application → Pages
2. **Connect to Git** → GitHub 連携 → ddashpot-ai リポジトリ選択
3. **Build settings**:
   - Framework preset: `None`
   - Build command: (空)
   - Build output directory: `chat-app`
4. **Deploy**

`functions/_middleware.js` は Pages 側が自動的に検出して関数として実行する
(追加設定不要)。

#### 4-3. カスタムドメイン

Pages プロジェクト → Custom domains → `chat.ddashpot.com` を追加。
DNS は Cloudflare 内なので自動設定。

## セキュリティの仕組み

| 項目 | 場所 | 概要 |
|---|---|---|
| HSTS preload | `_headers` | `max-age=31536000; includeSubDomains; preload` |
| 静的セキュリティヘッダ | `_headers` | X-Content-Type-Options / X-Frame-Options / Referrer-Policy / Permissions-Policy |
| CSP (HTML) | `functions/_middleware.js` | 動的 nonce + `'strict-dynamic'` |
| CSP (非 HTML / フォールバック) | `_headers` | `'unsafe-inline'` 入り暫定版 |
| CSP 違反レポート | `_headers` + `_middleware.js` | `report-uri` / `report-to` で api-backend `/csp-report` |
| Clerk SDK 改ざん対策 | `index.html` | バージョン固定 + SRI |

## 動作確認チェックリスト

- [ ] ページを開くと Clerk のログイン UI が表示される
- [ ] Google または メアドでログインできる
- [ ] ログイン後にチャット UI が表示される
- [ ] 「こんにちは」と送ると AI が **文字単位で流れて** 返答する
- [ ] モデルを切り替えて返答する
- [ ] ログアウトすると再びログイン画面に戻る
- [ ] DevTools の Network タブで `api.ddashpot.com` への通信 (SSE) が確認できる
- [ ] DevTools の Console / CSP 違反レポートにエラーが出ていない
- [ ] Response Headers に `Content-Security-Policy: ... 'nonce-...' 'strict-dynamic' ...` が入っている
- [ ] Response Headers に `Strict-Transport-Security: ...; preload` が入っている
