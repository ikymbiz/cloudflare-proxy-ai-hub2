# test-harness

修正後コードの動作を Node.js 上で再現する検証ハーネス.

Cloudflare Workers の runtime を最小限のスタブで再現し、
**実コード (ai-hub/index.js, api-backend/index.js, rate-limiter, user-rate-limiter)
を 1 行も改変せずそのまま** import して動かす.

## できること

- chat-app → api-backend → ai-hub → AI Gateway (mock) の一連の流れを実コードで確認
- 8 シナリオ (正常系 / 5xx / 4xx / monthly limit / 並行リクエスト / 認証エラー / Origin エラー / SSE 内部経路観察) を自動アサート
- 修正前後の差を比較可能 (主要バグ修正の効果を確認できる)

## 使い方

```bash
# 一度だけ: Clerk のスタブを node_modules に置く
mkdir -p ../node_modules/@clerk/backend
cat > ../node_modules/@clerk/backend/package.json <<'EOF'
{ "name": "@clerk/backend", "version": "1.0.0-stub", "type": "module", "main": "index.js", "exports": "./index.js" }
EOF
cat > ../node_modules/@clerk/backend/index.js <<'EOF'
export async function verifyToken(token, opts) {
  const m = (globalThis.MOCK_TOKENS || {})[token];
  if (!m) throw new Error("invalid token");
  if (m.expired) throw new Error("token expired");
  return m.payload;
}
EOF

# 実行
node harness.mjs
```

## スタブ範囲

実コードに改変を一切加えないため、以下だけスタブする:

- `@clerk/backend.verifyToken` — グローバル `MOCK_TOKENS` を引いて検証結果を返す
- `Durable Object` (`state.storage` は `Map`, `blockConcurrencyWhile` は Promise の直列化)
- `KV` (`Map`)
- `Service Binding` (`env.AI_HUB.fetch` は ai-hub の `default.fetch` を直接呼ぶ)
- `globalThis.fetch` — `gateway.ai.cloudflare.com` 宛だけ `aiGatewayHandler` に向ける

その他 (`Request`/`Response`/`TransformStream`/`TextEncoder`/`crypto.subtle`/etc.) は
Node.js 22+ の標準でそのまま動く.

## シナリオ一覧

| ID | 内容 | 不変条件 |
|---|---|---|
| S1 | 非ストリーム正常系 | usage.tokens += 実消費, reserved → 0 |
| S2 | SSE 正常系 | 中継しつつ最終チャンクから usage 抽出 |
| S3 | 上流 5xx | ai-hub + api-backend 両方で refund. tokens 加算なし |
| S4 | 上流 4xx (api-backend 経由) | 内部で非ストリーム経路を通る. 予約解放 |
| S4b | 上流 4xx (ai-hub 直接) | `chat_complete` イベント (`stream_complete` ではない) |
| S5 | monthly limit 到達 | 累積予約超過で 429 |
| S6 | 認証なし | 401 |
| S7 | Origin なし | 403 |
| S8 | 並行リクエストでの予約制 | max_tokens × 並行数 > limit のとき余剰が 429 |

## 修正前バージョンとの比較

`ai-hub/index.js` L241 で `gwRes.ok` チェックを抜くと S4b だけ FAIL する.
これが「修正前バグ」の唯一の差分:

```diff
-  if (isStream && gwRes.body && gwRes.ok) {
+  if (isStream && gwRes.body) {
     return streamResponse(...);
   }
```

S4b の FAIL メッセージ:
```
ASSERT FAIL: expected non-stream path. events=["stream_complete"]
```
