/**
 * api-backend Worker (api.ddashpot.com)
 *
 * 各アプリ (chat.ddashpot.com 等) からの呼び出しを Clerk JWT で検証し、
 * ai-hub に Service Binding 経由で転送する。
 *
 * セキュリティ強化点 (旧版からの変更):
 *  - 認証必須エンドポイントは Origin ヘッダを必須化
 *  - Clerk verifyToken に authorizedParties を渡し、発行元の azp を検証
 *  - エラー詳細 (e.message 等) をクライアントに返さない
 *  - ローカル開発 origin は ENVIRONMENT=development のときだけ許可
 *  - ai-hub への中継を Service Binding (env.AI_HUB) 経由に変更
 *
 * Phase 1/2/3 追加分:
 *  - 1.2 AUTHORIZED_PARTIES が production で未設定なら即座に拒否 (predeploy も追加).
 *  - 1.7 /csp-report エンドポイントで CSP 違反レポートを受信 (構造化ログ).
 *  - 2.1 per-user レート制限 + 月次トークン上限 (UserRateLimiter DO).
 *  - 2.3 構造化ログ (JSON one-line).
 *  - 2.4 ai-hub が 5xx を返したら user 側の予約も refund.
 *  - 3.2/3.3 stream 中継 + 月次予約制との連動.
 */

import { verifyToken } from "@clerk/backend";
import { UserRateLimiter } from "./user-rate-limiter.js";
export { UserRateLimiter };

const SERVICE = "api-backend";

const ALLOWED_ORIGIN_PATTERN = /^https:\/\/[\w-]+\.ddashpot\.com$/;
const LOCAL_DEV_ORIGINS = new Set([
  "http://localhost:8000",
  "http://localhost:3000",
  "http://127.0.0.1:8000",
]);

const MAX_BODY_SIZE = 100_000;        // 100KB
const MAX_CSP_REPORT_SIZE = 32_000;    // CSP report-uri 受信用
// streamRelay の累積バイト上限 (defense-in-depth).
// ai-hub 側で MAX_RESPONSE_SIZE = 1MB を強制しているが,
// 万一 ai-hub が破られた・想定外の応答を返した場合に api-backend で
// 自分自身のメモリ・帯域を守るための上限.
const MAX_STREAM_BYTES = 2_000_000;    // 2MB (ai-hub 上限の 2 倍を安全側で確保)
const DEFAULT_REQUESTED_MAX_TOKENS = 1000;

// per-user の制限のフォールバック値.
// 実際の値は Clerk JWT の public_metadata から resolveUserLimits() で取り出す
// (Clerk Dashboard → JWT Templates で `public_metadata: {{user.public_metadata}}`
//  を含むテンプレートを使うこと). 未設定ユーザーには下記がそのまま適用される.
const DEFAULT_USER_RATE_PER_MINUTE = 10;
const DEFAULT_USER_MONTHLY_TOKEN_LIMIT = 100_000;
const HARD_MAX_USER_RATE_PER_MINUTE = 600;             // 1 ユーザー上限の天井 (毎秒 10)
const HARD_MAX_USER_MONTHLY_TOKEN_LIMIT = 100_000_000; // 1 ユーザー月次上限の天井

export default {
  async fetch(request, env, ctx) {
    try {
      return await dispatch(request, env, ctx);
    } catch (e) {
      logEvent("error", "unhandled", { msg: e?.message, stack: e?.stack });
      return json({ error: "Internal Server Error" }, 500, null);
    }
  },
};

async function dispatch(request, env, ctx) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  const isDev = env.ENVIRONMENT === "development";
  const allowedOrigin = resolveOrigin(origin, isDev);

  // Phase 1.2: production で AUTHORIZED_PARTIES が空ならランタイムでも拒否
  // (predeploy script でデプロイ前にも弾くが、二重ガードとして残す)
  if (!isDev && parseAuthorizedParties(env.AUTHORIZED_PARTIES).length === 0) {
    logEvent("error", "config_missing_authorized_parties");
    return json({ error: "Service misconfigured" }, 500, null);
  }

  // CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(allowedOrigin) });
  }

  // ヘルスチェックは Origin 不要 (監視用)
  if (request.method === "GET" && url.pathname === "/health") {
    return json({ ok: true }, 200, allowedOrigin);
  }

  // CSP report endpoint (Phase 1.7) — ブラウザが Origin を付けないことがあるので Origin 不問
  if (request.method === "POST" && url.pathname === "/csp-report") {
    return await handleCspReport(request);
  }

  if (request.method !== "POST") {
    return json({ error: "Method Not Allowed" }, 405, allowedOrigin);
  }

  // 認証必須エンドポイントは Origin ヘッダ必須 (CSRF 防御)
  if (!allowedOrigin) {
    logEvent("warn", "forbidden_origin", { origin });
    return json({ error: "Forbidden origin" }, 403, null);
  }

  if (url.pathname === "/chat") {
    return handleChat(request, env, ctx, allowedOrigin);
  }
  return json({ error: "Not Found" }, 404, allowedOrigin);
}

async function handleChat(request, env, ctx, allowedOrigin) {
  // --- 1. Clerk JWT 検証 (authorizedParties 必須) ---
  const auth = request.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/);
  if (!m) {
    logEvent("warn", "auth_missing");
    return json({ error: "Unauthorized" }, 401, allowedOrigin);
  }
  const token = m[1];

  const authorizedParties = parseAuthorizedParties(env.AUTHORIZED_PARTIES);
  if (authorizedParties.length === 0) {
    // 起動時チェックを通っていても念のため
    logEvent("error", "config_missing_authorized_parties_runtime");
    return json({ error: "Service misconfigured" }, 500, allowedOrigin);
  }

  let payload;
  try {
    payload = await verifyToken(token, {
      secretKey: env.CLERK_SECRET_KEY,
      authorizedParties,
    });
  } catch (e) {
    logEvent("warn", "clerk_verify_failed", { msg: e?.message });
    return json({ error: "Unauthorized" }, 401, allowedOrigin);
  }

  const userId = payload?.sub;
  if (!userId) {
    return json({ error: "Unauthorized" }, 401, allowedOrigin);
  }
  const userHash = await sha256Short(userId);

  // --- 2. ボディ読込 (Phase 1.4 と同様にバイト単位) ---
  const contentLength = parseInt(request.headers.get("Content-Length") || "0", 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_SIZE) {
    return json({ error: "Request body too large" }, 413, allowedOrigin);
  }
  const ab = await request.arrayBuffer();
  if (ab.byteLength > MAX_BODY_SIZE) {
    return json({ error: "Request body too large" }, 413, allowedOrigin);
  }
  const requestBody = new TextDecoder("utf-8", { fatal: false }).decode(ab);

  let body;
  try {
    body = JSON.parse(requestBody);
  } catch {
    return json({ error: "Invalid JSON" }, 400, allowedOrigin);
  }
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    typeof body.model !== "string" ||
    !Array.isArray(body.messages)
  ) {
    return json({ error: "model and messages required" }, 400, allowedOrigin);
  }

  const isStream = body.stream === true;
  const requestedMaxTokens = Number.isInteger(body.max_tokens) && body.max_tokens > 0
    ? body.max_tokens
    : DEFAULT_REQUESTED_MAX_TOKENS;

  // --- 3. Phase 2.1: per-user レート制限 + 予約 ---
  // 制限値は Clerk JWT の public_metadata から取り出す (なければデフォルト).
  const userLimits = resolveUserLimits(payload);
  const userLimiter = env.USER_RATE_LIMITER.get(env.USER_RATE_LIMITER.idFromName(userId));
  let userCheck;
  try {
    const res = await userLimiter.fetch("https://do/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rate_per_minute: userLimits.rate_per_minute,
        monthly_token_limit: userLimits.monthly_token_limit,
        reserve_tokens: requestedMaxTokens,
      }),
    });
    userCheck = await res.json();
  } catch (e) {
    logEvent("error", "user_rate_limiter_failed", { user_hash: userHash, msg: e?.message });
    return json({ error: "Internal Server Error" }, 500, allowedOrigin);
  }
  if (!userCheck.allowed) {
    logEvent("info", "user_limit_exceeded", { user_hash: userHash, reason: userCheck.reason });
    if (userCheck.reason === "rate_limit") return json({ error: "Rate limit exceeded" }, 429, allowedOrigin);
    if (userCheck.reason === "monthly_limit") return json({ error: "Monthly token limit exceeded" }, 429, allowedOrigin);
    return json({ error: "Limit exceeded" }, 429, allowedOrigin);
  }
  const userMinuteSlot = userCheck.minute_slot;
  const userReserved = userCheck.reserved || 0;

  // --- 4. ai-hub へ Service Binding 経由で転送 ---
  let aiRes;
  try {
    aiRes = await env.AI_HUB.fetch("https://ai-hub.internal/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.AI_HUB_KEY}`,
        // ai-hub 側のサイズチェックのため正確な Content-Length を渡す
        "Content-Length": String(ab.byteLength),
      },
      body: ab,
    });
  } catch (e) {
    logEvent("error", "ai_hub_fetch_failed", { user_hash: userHash, msg: e?.message });
    ctx.waitUntil(refundUser(userLimiter, { minute_slot: userMinuteSlot, reserved_tokens: userReserved, reason: "ai_hub_fetch_failed" }));
    return json({ error: "Upstream error" }, 502, allowedOrigin);
  }

  // Phase 2.4 / 3.2: ai-hub が 5xx なら user 側の予約も refund して早期 return.
  // ※ 早期 return しないと、後続の add-usage / streamRelay→flush 内の add-usage が
  //    `usage.reserved -= userReserved` を再実行し、同一 DO 内で並行している
  //    他リクエストの予約分まで `reserved` カウンタから消し去ってしまう (二重簿記バグ).
  //    ai-hub は 5xx 時に application/json でエラーボディを返すので、ここで
  //    ストリーム経路に入る意味も無い (SSE として解釈すると buffer に溜まるだけ).
  if (aiRes.status >= 500) {
    ctx.waitUntil(refundUser(userLimiter, { minute_slot: userMinuteSlot, reserved_tokens: userReserved, reason: "ai_hub_5xx" }));
    const errText = await aiRes.text().catch(() => "");
    logEvent("warn", "upstream_5xx", {
      user_hash: userHash,
      model: body.model,
      upstream_status: aiRes.status,
    });
    return new Response(errText || JSON.stringify({ error: "Upstream error" }), {
      status: aiRes.status,
      headers: {
        "Content-Type": aiRes.headers.get("Content-Type") || "application/json",
        "Cache-Control": "private, no-store",
        ...corsHeaders(allowedOrigin),
      },
    });
  }

  // --- 5. ストリーミング中継 (Phase 3.3) ---
  // 4xx エラー (ai-hub の 401/403/429 等) は SSE フォーマットではなく
  // JSON エラーボディなので streamRelay には乗せず、下の非ストリーム経路で
  // pass-through する. これにより:
  //   - クライアント (ai-client.js) は res.ok=false で素直に JSON.parse できる
  //   - SSE 想定の TransformStream に JSON を流す不整合を回避できる
  //   - tokens=0 で add-usage が呼ばれ、予約トークンは解放される (二重簿記回避)
  if (isStream && aiRes.body && aiRes.ok) {
    return streamRelay(aiRes, ctx, userLimiter, {
      userMinuteSlot,
      userReserved,
      userHash,
      allowedOrigin,
      model: body.model,
    });
  }

  // --- 6. 非ストリーミング ---
  const respText = await aiRes.text();
  let usedTokens = 0;
  try {
    const parsed = JSON.parse(respText);
    usedTokens = parsed?.usage?.total_tokens || 0;
  } catch {
    /* エラーレスポンス等は 0 */
  }
  ctx.waitUntil(
    userLimiter.fetch("https://do/add-usage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokens: usedTokens, reserved_tokens: userReserved }),
    }).then(async (r) => {
      if (!r.ok) {
        logEvent("error", "user_add_usage_failed", { user_hash: userHash, status: r.status });
        await refundUser(userLimiter, { minute_slot: userMinuteSlot, reserved_tokens: userReserved, reason: "user_add_usage_failed_nonok" });
      }
    }).catch(async (e) => {
      logEvent("error", "user_add_usage_failed", { user_hash: userHash, msg: e?.message });
      await refundUser(userLimiter, { minute_slot: userMinuteSlot, reserved_tokens: userReserved, reason: "user_add_usage_failed_throw" });
    })
  );
  logEvent("info", "chat_complete", {
    user_hash: userHash,
    model: body.model,
    upstream_status: aiRes.status,
    used_tokens: usedTokens,
    reserved_tokens: userReserved,
  });

  return new Response(respText, {
    status: aiRes.status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, no-store",
      ...corsHeaders(allowedOrigin),
    },
  });
}

/**
 * ストリーミング中継 (Phase 3.3)
 * ai-hub からの SSE をそのままブラウザへ pass-through しつつ、
 * 最終チャンクから usage を抽出して per-user の月次予約を確定計上。
 */
function streamRelay(aiRes, ctx, userLimiter, { userMinuteSlot, userReserved, userHash, allowedOrigin, model }) {
  let usageTokens = 0;
  let buffer = "";
  let totalBytes = 0;
  let aborted = false;
  const decoder = new TextDecoder("utf-8", { fatal: false });

  const transform = new TransformStream({
    transform(chunk, controller) {
      if (aborted) return;
      // ai-hub 側で 1MB 上限を効かせているが, defense-in-depth として
      // api-backend でも累積バイトを監視する.
      totalBytes += chunk.byteLength;
      if (totalBytes > MAX_STREAM_BYTES) {
        aborted = true;
        logEvent("warn", "stream_too_large", { user_hash: userHash, total: totalBytes });
        controller.error(new Error("Upstream response too large"));
        return;
      }
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
          } catch { /* 中間 chunk */ }
        }
      } catch { /* デコード失敗 */ }
      controller.enqueue(chunk);
    },
    flush() {
      // 残バッファ末尾の data: を最終回収.
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
      ctx.waitUntil(
        userLimiter.fetch("https://do/add-usage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tokens, reserved_tokens: userReserved }),
        }).then(async (r) => {
          if (!r.ok) {
            logEvent("error", "user_add_usage_failed_stream", { user_hash: userHash, status: r.status });
            await refundUser(userLimiter, { minute_slot: userMinuteSlot, reserved_tokens: userReserved, reason: "user_add_usage_failed_stream_nonok" });
          }
        }).catch(async (e) => {
          logEvent("error", "user_add_usage_failed_stream", { user_hash: userHash, msg: e?.message });
          await refundUser(userLimiter, { minute_slot: userMinuteSlot, reserved_tokens: userReserved, reason: "user_add_usage_failed_stream_throw" });
        })
      );
      logEvent("info", "stream_complete", {
        user_hash: userHash,
        model,
        used_tokens: tokens,
        reserved_tokens: userReserved,
      });
    },
  });

  aiRes.body.pipeTo(transform.writable).catch((e) => {
    logEvent("error", "stream_pipe_failed", { user_hash: userHash, msg: e?.message });
    ctx.waitUntil(refundUser(userLimiter, { minute_slot: userMinuteSlot, reserved_tokens: userReserved, reason: "stream_pipe_failed" }));
  });

  return new Response(transform.readable, {
    status: aiRes.status,
    headers: {
      "Content-Type": aiRes.headers.get("Content-Type") || "text/event-stream",
      "Cache-Control": "private, no-store",
      ...corsHeaders(allowedOrigin),
    },
  });
}

// --- Phase 1.7: CSP 違反レポート受信 ---
async function handleCspReport(request) {
  try {
    const contentLength = parseInt(request.headers.get("Content-Length") || "0", 10);
    if (Number.isFinite(contentLength) && contentLength > MAX_CSP_REPORT_SIZE) {
      return new Response(null, { status: 413 });
    }
    const ab = await request.arrayBuffer();
    if (ab.byteLength > MAX_CSP_REPORT_SIZE) {
      return new Response(null, { status: 413 });
    }
    const text = new TextDecoder().decode(ab);
    let report;
    try {
      report = JSON.parse(text);
    } catch {
      return new Response(null, { status: 400 });
    }
    // CSP Level 2 (report-uri): { "csp-report": {...} }
    // CSP Level 3 / Reporting API (report-to): 配列 [{ type:"csp-violation", body:{...} }]
    const violation =
      report?.["csp-report"] ||
      (Array.isArray(report) ? report.find((r) => r?.type === "csp-violation")?.body : null) ||
      report?.body ||
      report;
    logEvent("warn", "csp_violation", {
      blocked_uri: violation?.["blocked-uri"] || violation?.blockedURL,
      violated_directive: violation?.["violated-directive"] || violation?.effectiveDirective,
      document_uri: violation?.["document-uri"] || violation?.documentURL,
      ua: (request.headers.get("User-Agent") || "").slice(0, 200),
    });
    return new Response(null, { status: 204 });
  } catch (e) {
    logEvent("error", "csp_report_failed", { msg: e?.message });
    return new Response(null, { status: 500 });
  }
}

async function refundUser(userLimiter, { minute_slot, reserved_tokens, reason }) {
  try {
    await userLimiter.fetch("https://do/refund", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ minute_slot, reserved_tokens }),
    });
    logEvent("info", "user_refund_ok", { reason, minute_slot, reserved_tokens });
  } catch (e) {
    logEvent("error", "user_refund_failed", { reason, msg: e?.message });
  }
}

function parseAuthorizedParties(value) {
  return (value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Clerk JWT の payload から per-user の制限値を取り出す.
 *
 * Clerk Dashboard → JWT Templates でテンプレートに以下を含めること:
 *   {
 *     "public_metadata": "{{user.public_metadata}}"
 *   }
 * もしくはフラットに:
 *   {
 *     "ai_limits": "{{user.public_metadata.ai_limits}}"
 *   }
 *
 * public_metadata.ai_limits の形:
 *   { "rate_per_minute": 30, "monthly_token_limit": 1000000 }
 *
 * いずれも未設定なら DEFAULT_USER_* が適用される. 値域チェックは DO 側でも
 * 行うが、ここで天井 (HARD_MAX_*) を被せることで悪意ある metadata で
 * 上限を吹き飛ばすことを防ぐ.
 */
function resolveUserLimits(payload) {
  const meta =
    (payload && (payload.public_metadata || payload.publicMetadata)) || {};
  const limits = (meta && (meta.ai_limits || meta.limits)) || payload?.ai_limits || {};

  const rateRaw = limits.rate_per_minute;
  const monthlyRaw = limits.monthly_token_limit;

  const rate =
    Number.isInteger(rateRaw) && rateRaw > 0
      ? Math.min(rateRaw, HARD_MAX_USER_RATE_PER_MINUTE)
      : DEFAULT_USER_RATE_PER_MINUTE;

  const monthly =
    Number.isInteger(monthlyRaw) && monthlyRaw > 0
      ? Math.min(monthlyRaw, HARD_MAX_USER_MONTHLY_TOKEN_LIMIT)
      : DEFAULT_USER_MONTHLY_TOKEN_LIMIT;

  return { rate_per_minute: rate, monthly_token_limit: monthly };
}

function resolveOrigin(origin, isDev) {
  if (!origin) return null;
  if (ALLOWED_ORIGIN_PATTERN.test(origin)) return origin;
  if (isDev && LOCAL_DEV_ORIGINS.has(origin)) return origin;
  return null;
}

function corsHeaders(origin) {
  if (!origin) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(obj, status, allowedOrigin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, no-store",
      ...corsHeaders(allowedOrigin),
    },
  });
}

async function sha256Short(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].slice(0, 4).map((b) => b.toString(16).padStart(2, "0")).join("");
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
