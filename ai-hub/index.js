/**
 * ai-hub Worker
 *
 * 共通バックエンド (api-backend) からのみ Service Binding 経由で呼ばれる前提。
 * フォールバックとしてアプリキー (ahk_xxx) 認証も残してある。
 *
 * セキュリティ強化点 (旧版からの変更):
 *  - レート制限・月次利用量を Durable Object (RateLimiter) でアトミック化
 *  - リクエストボディをホワイトリスト方式で再構築
 *  - レスポンスサイズの上限を追加
 *  - max_tokens の値域を厳格化 (整数 & 0 超)
 *  - エラー詳細をクライアントへ返さない (ログのみ)
 *  - KV 上のアプリキーは SHA-256 でハッシュ化してから引く
 *  - 想定外例外を 500 に丸める top-level try/catch
 *
 * Phase 1/2/3 追加分:
 *  - 1.4 ボディサイズをバイト単位で判定 (TextEncoder).
 *  - 2.2 message.content の長さ上限.
 *  - 2.3 構造化ログ (JSON one-line).
 *  - 2.4 アップストリーム失敗時にレートスロットと予約トークンを返却.
 *  - 3.2 月次トークンの「予約制」(check時に max_tokens を予約 → 応答後に差分確定).
 *  - 3.3 ストリーミング (SSE) 対応. usage は最終チャンクから抽出して加算.
 */

export { RateLimiter } from "./rate-limiter.js";

const MAX_BODY_SIZE = 100_000;           // 100KB
const MAX_RESPONSE_SIZE = 1_000_000;      // 1MB
const MAX_MESSAGE_CONTENT_SIZE = 32_000;  // 32KB per message (Phase 2.2)
const DEFAULT_MAX_TOKENS = 1000;
const MAX_MESSAGES = 100;
const SERVICE = "ai-hub";

// OpenAI 互換 API のうち、明示的に通すフィールドだけ列挙
// (tools / response_format / logit_bias / user / metadata 等は意図的に除外)
// stream は Phase 3.3 で許可。
const ALLOWED_TOP_LEVEL_KEYS = new Set([
  "model",
  "messages",
  "max_tokens",
  "temperature",
  "top_p",
  "frequency_penalty",
  "presence_penalty",
  "stop",
  "n",
  "seed",
  "stream",
  "stream_options",
]);

const ALLOWED_MESSAGE_ROLES = new Set(["system", "user", "assistant"]);

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204 });
    }
    if (request.method !== "POST") {
      return json({ error: "Method Not Allowed" }, 405);
    }
    try {
      return await handle(request, env, ctx);
    } catch (e) {
      logEvent("error", "unhandled", { msg: e?.message, stack: e?.stack });
      return json({ error: "Internal Server Error" }, 500);
    }
  },
};

async function handle(request, env, ctx) {
  // --- 1. アプリキー認証 (ハッシュ化キーで KV を引く) ---
  const auth = request.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(ahk_[a-zA-Z0-9_]+)$/);
  if (!m) {
    logEvent("warn", "auth_missing");
    return json({ error: "Unauthorized" }, 401);
  }
  const apiKey = m[1];
  const keyHash = await sha256Hex(apiKey);
  const keyHashPrefix = keyHash.slice(0, 8);

  const keyData = await env.KEYS_KV.get(`apikey:${keyHash}`, "json");
  if (!keyData || keyData.enabled !== true) {
    logEvent("warn", "auth_invalid_key", { key_hash_prefix: keyHashPrefix });
    return json({ error: "Unauthorized" }, 401);
  }
  if (!Array.isArray(keyData.allowed_models) || keyData.allowed_models.length === 0) {
    logEvent("error", "key_misconfigured", { key_hash_prefix: keyHashPrefix });
    return json({ error: "Internal Server Error" }, 500);
  }

  // --- 2. ボディサイズ制限 (Phase 1.4: バイト単位で判定) ---
  // 旧版は requestBody.length (UTF-16 code units) で見ていたため日本語等で実質倍の文字数までは通っていた。
  // 修正: Content-Length ヘッダ + 実バイト長 (ArrayBuffer.byteLength) で判定。
  const contentLength = parseInt(request.headers.get("Content-Length") || "0", 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_SIZE) {
    logEvent("warn", "body_too_large_header", { key_hash_prefix: keyHashPrefix, content_length: contentLength });
    return json({ error: "Request body too large" }, 413);
  }
  const ab = await request.arrayBuffer();
  if (ab.byteLength > MAX_BODY_SIZE) {
    // Content-Length 偽装に対する最後の砦
    logEvent("warn", "body_too_large_actual", { key_hash_prefix: keyHashPrefix, byte_length: ab.byteLength });
    return json({ error: "Request body too large" }, 413);
  }
  const requestBody = new TextDecoder("utf-8", { fatal: false }).decode(ab);

  // --- 3. JSON パース & スキーマ検証 ---
  let raw;
  try {
    raw = JSON.parse(requestBody);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return json({ error: "Bad request" }, 400);
  }
  if (typeof raw.model !== "string" || !Array.isArray(raw.messages)) {
    return json({ error: "Bad request: model and messages required" }, 400);
  }
  if (raw.messages.length === 0 || raw.messages.length > MAX_MESSAGES) {
    return json({ error: "Invalid messages length" }, 400);
  }

  const enc = new TextEncoder();
  for (const msg of raw.messages) {
    if (!msg || typeof msg !== "object") {
      return json({ error: "Invalid message" }, 400);
    }
    if (!ALLOWED_MESSAGE_ROLES.has(msg.role)) {
      return json({ error: "Invalid message role" }, 400);
    }
    if (typeof msg.content !== "string") {
      return json({ error: "Invalid message content" }, 400);
    }
    // Phase 2.2: 各 message.content の上限 (バイト単位)
    if (enc.encode(msg.content).length > MAX_MESSAGE_CONTENT_SIZE) {
      logEvent("warn", "message_content_too_large", { key_hash_prefix: keyHashPrefix });
      return json({ error: "Message content too large" }, 413);
    }
  }

  // --- 4. ホワイトリストで body 再構築 ---
  const body = {};
  for (const k of Object.keys(raw)) {
    if (ALLOWED_TOP_LEVEL_KEYS.has(k)) body[k] = raw[k];
  }
  const isStream = body.stream === true;
  // Phase 3.3: stream の場合、usage を必ず最終チャンクで得るよう stream_options を強制
  if (isStream) {
    body.stream_options = { include_usage: true };
  }

  // --- 5. モデルホワイトリスト ---
  if (!keyData.allowed_models.includes(body.model)) {
    logEvent("warn", "model_not_allowed", { key_hash_prefix: keyHashPrefix, model: body.model });
    return json({ error: "Model not allowed" }, 403);
  }

  // --- 6. max_tokens 検証 (整数かつ 0 超、上限内) ---
  const cap = Number.isInteger(keyData.max_tokens_cap) && keyData.max_tokens_cap > 0
    ? keyData.max_tokens_cap
    : DEFAULT_MAX_TOKENS;
  if (
    !Number.isInteger(body.max_tokens) ||
    body.max_tokens <= 0 ||
    body.max_tokens > cap
  ) {
    body.max_tokens = cap;
  }

  // --- 7. レート制限 + 月次予約 (Phase 3.2: 予約制) ---
  // check 時に max_tokens 分を「予約」として月次カウンタに加算しておき、
  // 応答後に実際の使用量で差分確定する。これにより並行リクエストで
  // 上限を rate × max_tokens 分超過することを防ぐ。
  const limiter = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(keyHash));
  let limitCheck;
  try {
    const res = await limiter.fetch("https://do/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rate_per_minute: Number.isInteger(keyData.rate_per_minute) ? keyData.rate_per_minute : 60,
        monthly_token_limit: Number.isInteger(keyData.monthly_token_limit)
          ? keyData.monthly_token_limit
          : null,
        reserve_tokens: body.max_tokens,
      }),
    });
    limitCheck = await res.json();
  } catch (e) {
    logEvent("error", "rate_limiter_failed", { key_hash_prefix: keyHashPrefix, msg: e?.message });
    return json({ error: "Internal Server Error" }, 500);
  }
  if (!limitCheck.allowed) {
    logEvent("info", "limit_exceeded", { key_hash_prefix: keyHashPrefix, reason: limitCheck.reason });
    if (limitCheck.reason === "rate_limit") return json({ error: "Rate limit exceeded" }, 429);
    if (limitCheck.reason === "monthly_limit") return json({ error: "Monthly token limit exceeded" }, 429);
    return json({ error: "Limit exceeded" }, 429);
  }
  const minute_slot = limitCheck.minute_slot;
  const reserved_tokens = limitCheck.reserved || 0;

  // --- 8. AI Gateway へ転送 ---
  let gwRes;
  try {
    gwRes = await fetch(env.AI_GATEWAY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "cf-aig-authorization": `Bearer ${env.CF_AIG_TOKEN}`,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    // Phase 2.4: 通信失敗時はスロット/予約を巻き戻す
    logEvent("error", "upstream_fetch_failed", { key_hash_prefix: keyHashPrefix, msg: e?.message });
    ctx.waitUntil(refund(limiter, { minute_slot, reserved_tokens, reason: "upstream_fetch_failed" }));
    return json({ error: "Upstream error" }, 502);
  }

  // Phase 2.4: HTTP 5xx もユーザー責任ではないので refund 対象
  if (gwRes.status >= 500) {
    logEvent("warn", "upstream_5xx", { key_hash_prefix: keyHashPrefix, status: gwRes.status });
    ctx.waitUntil(refund(limiter, { minute_slot, reserved_tokens, reason: "upstream_5xx" }));
    // 詳細は出さない
    return json({ error: "Upstream error" }, 502);
  }

  // --- 9. ストリーミング応答 (Phase 3.3) ---
  // gwRes.ok チェックは Phase 3.3 改修の対称修正:
  // AI Gateway が 4xx (401/403/429 等) を返したときの応答ボディは
  // application/json のエラー本文なので、SSE 経路に乗せると以下が壊れる.
  //   - streamResponse の Content-Type フォールバック (text/event-stream) が
  //     application/json を上書きしうる
  //   - クライアント側 (api-backend → AIClient) が SSE として走査して破綻する
  // 4xx は非ストリーミング経路 (下記の respText 経由) で素直に JSON pass-through する.
  // この経路でも tokens=0 / reserved_tokens=X で add-usage が呼ばれるため,
  // 予約トークンは正しく解放される (二重簿記なし).
  if (isStream && gwRes.body && gwRes.ok) {
    return streamResponse(gwRes, ctx, limiter, { minute_slot, reserved_tokens, keyHashPrefix, model: body.model });
  }

  // --- 10. 非ストリーミング: レスポンスサイズ上限 ---
  const respText = await gwRes.text();
  if (respText.length > MAX_RESPONSE_SIZE) {
    logEvent("warn", "response_too_large", { key_hash_prefix: keyHashPrefix, length: respText.length });
    ctx.waitUntil(refund(limiter, { minute_slot, reserved_tokens, reason: "response_too_large" }));
    return json({ error: "Upstream response too large" }, 502);
  }

  // --- 11. 利用量加算 (応答後に DO へ。予約分を解放しつつ実利用を加算) ---
  let used = 0;
  try {
    const parsed = JSON.parse(respText);
    used = parsed?.usage?.total_tokens || 0;
  } catch {
    /* エラーレスポンス等のパース失敗は加算しない (予約だけ解放) */
  }
  ctx.waitUntil(
    limiter.fetch("https://do/add-usage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokens: used, reserved_tokens }),
    }).then(async (r) => {
      if (!r.ok) {
        logEvent("error", "add_usage_failed", { key_hash_prefix: keyHashPrefix, status: r.status });
        await refund(limiter, { minute_slot, reserved_tokens, reason: "add_usage_failed_nonok" });
      }
    }).catch(async (e) => {
      logEvent("error", "add_usage_failed", { key_hash_prefix: keyHashPrefix, msg: e?.message });
      await refund(limiter, { minute_slot, reserved_tokens, reason: "add_usage_failed_throw" });
    })
  );

  logEvent("info", "chat_complete", {
    key_hash_prefix: keyHashPrefix,
    model: body.model,
    upstream_status: gwRes.status,
    used_tokens: used,
    reserved_tokens,
  });

  return new Response(respText, {
    status: gwRes.status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, no-store",
    },
  });
}

/**
 * ストリーミング応答 (Phase 3.3)
 *
 * AI Gateway からの SSE をそのまま中継しつつ、TransformStream で
 *  - 累積バイト数を監視 (MAX_RESPONSE_SIZE 超で打ち切り)
 *  - 最終チャンクから usage.total_tokens を抜き取り、DO へ加算
 * を行う。stream_options.include_usage=true をリクエスト側で強制済み。
 */
function streamResponse(gwRes, ctx, limiter, { minute_slot, reserved_tokens, keyHashPrefix, model }) {
  let totalBytes = 0;
  let usageTokens = 0;
  let buffer = "";
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let aborted = false;

  const transform = new TransformStream({
    transform(chunk, controller) {
      if (aborted) return;
      totalBytes += chunk.byteLength;
      if (totalBytes > MAX_RESPONSE_SIZE) {
        aborted = true;
        logEvent("warn", "stream_too_large", { key_hash_prefix: keyHashPrefix, total: totalBytes });
        controller.error(new Error("Upstream response too large"));
        return;
      }
      // SSE 解析 (usage 抽出目的。chunk 自体はそのまま転送)
      try {
        buffer += decoder.decode(chunk, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          try {
            const obj = JSON.parse(data);
            if (obj?.usage?.total_tokens) usageTokens = obj.usage.total_tokens;
          } catch { /* 中間 chunk は無視 */ }
        }
      } catch { /* デコード失敗時も転送は継続 */ }
      controller.enqueue(chunk);
    },
    flush() {
      // 残バッファに最終 data: 行が残っていれば回収する.
      // 通常 SSE は \n\n で終わるので末尾も改行付きで来るが,
      // 上流が改行を出さずに close した場合の取りこぼし対策.
      if (buffer.length > 0) {
        const tail = buffer.trim();
        buffer = "";
        if (tail.startsWith("data:")) {
          const data = tail.slice(5).trim();
          if (data && data !== "[DONE]") {
            try {
              const obj = JSON.parse(data);
              if (obj?.usage?.total_tokens) usageTokens = obj.usage.total_tokens;
            } catch { /* ignore */ }
          }
        }
      }
      const tokens = usageTokens;
      // add-usage が失敗した場合は予約解放が止まらないよう refund にフォールバック.
      // 正常応答 (gwRes.ok) なので tokens は実消費を計上したいが,
      // DO への到達自体が壊れた場合は最低でも予約だけは戻しておく.
      ctx.waitUntil(
        limiter.fetch("https://do/add-usage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tokens, reserved_tokens }),
        }).then(async (r) => {
          if (!r.ok) {
            logEvent("error", "add_usage_failed_stream", { key_hash_prefix: keyHashPrefix, status: r.status });
            await refund(limiter, { minute_slot, reserved_tokens, reason: "add_usage_failed_stream_nonok" });
          }
        }).catch(async (e) => {
          logEvent("error", "add_usage_failed_stream", { key_hash_prefix: keyHashPrefix, msg: e?.message });
          await refund(limiter, { minute_slot, reserved_tokens, reason: "add_usage_failed_stream_throw" });
        })
      );
      logEvent("info", "stream_complete", {
        key_hash_prefix: keyHashPrefix,
        model,
        used_tokens: tokens,
        reserved_tokens,
      });
    },
  });

  // pipeTo はバックグラウンドで走る。失敗時は refund.
  gwRes.body.pipeTo(transform.writable).catch((e) => {
    logEvent("error", "stream_pipe_failed", { key_hash_prefix: keyHashPrefix, msg: e?.message });
    ctx.waitUntil(refund(limiter, { minute_slot, reserved_tokens, reason: "stream_pipe_failed" }));
  });

  return new Response(transform.readable, {
    status: gwRes.status,
    headers: {
      "Content-Type": gwRes.headers.get("Content-Type") || "text/event-stream",
      "Cache-Control": "private, no-store",
    },
  });
}

async function refund(limiter, { minute_slot, reserved_tokens, reason }) {
  try {
    await limiter.fetch("https://do/refund", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ minute_slot, reserved_tokens }),
    });
    logEvent("info", "refund_ok", { reason, minute_slot, reserved_tokens });
  } catch (e) {
    logEvent("error", "refund_failed", { reason, msg: e?.message });
  }
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, no-store",
    },
  });
}

function logEvent(level, event, fields = {}) {
  const entry = JSON.stringify({
    service: SERVICE,
    level,
    event,
    ts: new Date().toISOString(),
    ...fields,
  });
  if (level === "error") console.error(entry);
  else if (level === "warn") console.warn(entry);
  else console.log(entry);
}
