// test-harness/harness.mjs
// Cloudflare Workers の runtime を Node.js で最小再現し、
// 修正後の ai-hub / api-backend の実コードを直接動かす.
//
// スタブするのは以下のみ:
//   - @clerk/backend.verifyToken (node_modules/ のスタブ)
//   - Durable Object (state.storage は Map, blockConcurrencyWhile は async 直列化)
//   - KV (Map)
//   - Service Binding (ai-hub の default.fetch を直接呼び出す)
//   - AI Gateway (globalThis.fetch をモックして応答 (200/4xx/5xx/SSE) を返す)
//
// Worker のコード自体は一切改変しない. dist にコピーして相対 import が
// 解決するように配置する.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

// ============================================================================
// 1. Durable Object スタブ
// ============================================================================

class FakeStorage {
  constructor() {
    this.kv = new Map();
    this.alarmTime = null;
  }
  async get(key) {
    if (Array.isArray(key)) {
      const map = new Map();
      for (const k of key) {
        if (this.kv.has(k)) map.set(k, structuredClone(this.kv.get(k)));
      }
      return map;
    }
    return this.kv.has(key) ? structuredClone(this.kv.get(key)) : undefined;
  }
  async put(key, val) {
    this.kv.set(key, structuredClone(val));
  }
  async delete(keys) {
    if (Array.isArray(keys)) {
      for (const k of keys) this.kv.delete(k);
      return;
    }
    this.kv.delete(keys);
  }
  async list({ prefix } = {}) {
    const out = new Map();
    for (const [k, v] of this.kv.entries()) {
      if (!prefix || k.startsWith(prefix)) out.set(k, structuredClone(v));
    }
    return out;
  }
  async setAlarm(t) { this.alarmTime = t; }
}

class FakeState {
  constructor() {
    this.storage = new FakeStorage();
    this._queue = Promise.resolve();
  }
  // blockConcurrencyWhile を 「前のタスクが終わるまで待ってから cb を実行」 で直列化.
  // 実 Cloudflare 同様, この間は新規受信タスクも待たされる.
  async blockConcurrencyWhile(cb) {
    const prev = this._queue;
    let release;
    this._queue = new Promise((r) => (release = r));
    try {
      await prev;
      return await cb();
    } finally {
      release();
    }
  }
}

class FakeDOInstance {
  constructor(DoClass, env) {
    this.state = new FakeState();
    this.instance = new DoClass(this.state, env);
  }
  async fetch(input, init) {
    const req = input instanceof Request ? input : new Request(input, init);
    return await this.instance.fetch(req);
  }
}

class FakeDONamespace {
  constructor(DoClass, env) {
    this.DoClass = DoClass;
    this.env = env;
    this.instances = new Map();
  }
  idFromName(name) {
    return { __name: name, toString: () => name, equals: (o) => o?.__name === name };
  }
  get(id) {
    const key = id.__name || id.toString();
    if (!this.instances.has(key)) {
      this.instances.set(key, new FakeDOInstance(this.DoClass, this.env));
    }
    return this.instances.get(key);
  }
}

// ============================================================================
// 2. ctx スタブ
// ============================================================================

function makeCtx() {
  const promises = [];
  return {
    waitUntil(p) { promises.push(Promise.resolve(p)); },
    async _drain() { await Promise.allSettled(promises); },
  };
}

// ============================================================================
// 3. AI Gateway モック
// ============================================================================

let aiGatewayHandler = null;
function setAiGateway(handler) { aiGatewayHandler = handler; }

const originalFetch = globalThis.fetch;
globalThis.fetch = async function patchedFetch(url, init) {
  const u = typeof url === "string" ? url : url.url;
  // AI Gateway 宛
  if (u.includes("gateway.ai.cloudflare.com") || u.startsWith("https://fake-gateway")) {
    if (!aiGatewayHandler) throw new Error("aiGatewayHandler unset");
    return await aiGatewayHandler(new Request(url, init));
  }
  return originalFetch(url, init);
};

// SSE 応答ビルダー
function sseResponse(events, { status = 200, contentType = "text/event-stream" } = {}) {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(c) {
      for (const ev of events) {
        c.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
        await new Promise((r) => setTimeout(r, 1));
      }
      c.enqueue(enc.encode("data: [DONE]\n\n"));
      c.close();
    },
  });
  return new Response(stream, { status, headers: { "Content-Type": contentType } });
}

// ============================================================================
// 4. Worker のロード
// ============================================================================

// ai-hub と api-backend は同じ "default.fetch" の形なので, 動的 import で読む.
async function loadAiHub() {
  const mod = await import(resolve(ROOT, "ai-hub", "index.js"));
  const { RateLimiter } = await import(resolve(ROOT, "ai-hub", "rate-limiter.js"));
  return { default: mod.default, RateLimiter };
}
async function loadApiBackend() {
  const mod = await import(resolve(ROOT, "api-backend", "index.js"));
  return { default: mod.default, UserRateLimiter: mod.UserRateLimiter };
}

// ============================================================================
// 5. 配線: api-backend が呼び出す AI_HUB.fetch は ai-hub の default.fetch
// ============================================================================

async function buildEnvs() {
  const { default: aiHubWorker, RateLimiter } = await loadAiHub();
  const { default: apiBackendWorker, UserRateLimiter } = await loadApiBackend();

  // ai-hub の KV (アプリキー)
  const KEYS_KV = {
    _map: new Map(),
    async get(key, fmt) {
      const v = this._map.get(key);
      if (!v) return null;
      return fmt === "json" ? JSON.parse(v) : v;
    },
    async put(key, val) {
      this._map.set(key, typeof val === "string" ? val : JSON.stringify(val));
    },
  };

  const aiHubEnv = {
    KEYS_KV,
    AI_GATEWAY_URL: "https://fake-gateway/v1/chat/completions",
    CF_AIG_TOKEN: "gw_token_xxx",
  };
  aiHubEnv.RATE_LIMITER = new FakeDONamespace(RateLimiter, aiHubEnv);

  // api-backend の env. AI_HUB.fetch は ai-hub の default.fetch を直接呼ぶ.
  const apiEnv = {
    ENVIRONMENT: "production",
    AUTHORIZED_PARTIES: "https://chat.ddashpot.com",
    CLERK_SECRET_KEY: "sk_test_xxx",
    AI_HUB_KEY: "ahk_test_xxx",
    AI_HUB: {
      async fetch(input, init) {
        const req = input instanceof Request ? input : new Request(input, init);
        const aiHubCtx = makeCtx();
        const res = await aiHubWorker.fetch(req, aiHubEnv, aiHubCtx);
        // 後追いで drain
        res.__drainCtx = () => aiHubCtx._drain();
        return res;
      },
    },
  };
  apiEnv.USER_RATE_LIMITER = new FakeDONamespace(UserRateLimiter, apiEnv);

  // テスト用のアプリキー登録 (ai-hub の KV に SHA-256 ハッシュ化キーで)
  const enc = new TextEncoder();
  const hash = await crypto.subtle.digest("SHA-256", enc.encode(apiEnv.AI_HUB_KEY));
  const keyHash = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
  await KEYS_KV.put(`apikey:${keyHash}`, {
    enabled: true,
    allowed_models: ["openai/gpt-4o-mini"],
    rate_per_minute: 60,
    monthly_token_limit: 10_000_000,
    max_tokens_cap: 4096,
  });

  return { apiBackendWorker, apiEnv, aiHubEnv };
}

// ============================================================================
// 6. テスト用 Clerk トークン
// ============================================================================

globalThis.MOCK_TOKENS = {
  "valid.token.user1": {
    payload: {
      sub: "user_1",
      public_metadata: { ai_limits: { rate_per_minute: 30, monthly_token_limit: 1_000_000 } },
    },
  },
  "expired.token": { expired: true },
  "low.limit.user": {
    payload: {
      sub: "user_low",
      public_metadata: { ai_limits: { rate_per_minute: 30, monthly_token_limit: 100 } },
    },
  },
};

// ============================================================================
// 7. 共通アサート
// ============================================================================

// ============================================================================
// 7.5. console ログ hook (内部経路を直接観察するため)
// ============================================================================

const logBuffer = [];
const origLog = console.log, origWarn = console.warn, origError = console.error;
function startLogCapture() {
  logBuffer.length = 0;
  const cap = (level) => (msg) => {
    try {
      const e = JSON.parse(msg);
      logBuffer.push({ level, ...e });
    } catch { /* not JSON */ }
  };
  console.log = cap("info");
  console.warn = cap("warn");
  console.error = cap("error");
}
function stopLogCapture() {
  console.log = origLog; console.warn = origWarn; console.error = origError;
  return logBuffer.slice();
}

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERT FAIL: " + msg);
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

const results = [];
async function step(name, fn) {
  process.stdout.write(`[ run ] ${pad(name, 60)}`);
  try {
    await fn();
    console.log("OK");
    results.push({ name, ok: true });
  } catch (e) {
    console.log("FAIL");
    console.log("   ", e.message);
    if (e.stack) console.log("   ", e.stack.split("\n").slice(1, 4).join("\n    "));
    results.push({ name, ok: false, err: e });
  }
}

// ============================================================================
// 8. シナリオ
// ============================================================================

async function getUsageState(env, userId) {
  const inst = env.USER_RATE_LIMITER.instances.get(userId);
  if (!inst) return null;
  const month = new Date().toISOString().slice(0, 7);
  return inst.state.storage.kv.get(`usage:${month}`) || null;
}
async function getKeyUsage(env, keyHashHex) {
  const inst = env.RATE_LIMITER.instances.get(keyHashHex);
  if (!inst) return null;
  const month = new Date().toISOString().slice(0, 7);
  return inst.state.storage.kv.get(`usage:${month}`) || null;
}

async function main() {
  const { apiBackendWorker, apiEnv, aiHubEnv } = await buildEnvs();

  // ----------------------------------------------------------------------
  // S1: 正常系 (非ストリーム)
  // ----------------------------------------------------------------------
  await step("S1 非ストリーム正常系: 200 + usage 反映 + 予約解放", async () => {
    setAiGateway(async (_req) => {
      return new Response(
        JSON.stringify({
          id: "chatcmpl-1",
          choices: [{ message: { role: "assistant", content: "hello" } }],
          usage: { total_tokens: 17 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const ctx = makeCtx();
    const res = await apiBackendWorker.fetch(
      new Request("https://api.ddashpot.com/chat", {
        method: "POST",
        headers: {
          "Authorization": "Bearer valid.token.user1",
          "Origin": "https://chat.ddashpot.com",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "openai/gpt-4o-mini",
          max_tokens: 100,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      apiEnv,
      ctx
    );
    const json = await res.json();
    assert(res.status === 200, `status=${res.status}`);
    assert(json.choices?.[0]?.message?.content === "hello", `content=${json.choices?.[0]?.message?.content}`);
    await ctx._drain();

    const usage = await getUsageState(apiEnv, "user_1");
    assert(usage, "usage record exists");
    assert(usage.reserved === 0, `reserved=${usage.reserved} (expected 0)`);
    assert(usage.tokens === 17, `tokens=${usage.tokens} (expected 17)`);
    assert(usage.requests === 1, `requests=${usage.requests}`);
  });

  // ----------------------------------------------------------------------
  // S2: SSE ストリーム正常系
  // ----------------------------------------------------------------------
  await step("S2 SSE 正常系: 中継 + usage 抽出 + 予約解放", async () => {
    setAiGateway(async (_req) => {
      return sseResponse([
        { choices: [{ delta: { content: "Hel" } }] },
        { choices: [{ delta: { content: "lo!" } }] },
        { choices: [{ finish_reason: "stop" }], usage: { total_tokens: 25 } },
      ]);
    });

    const ctx = makeCtx();
    const res = await apiBackendWorker.fetch(
      new Request("https://api.ddashpot.com/chat", {
        method: "POST",
        headers: {
          "Authorization": "Bearer valid.token.user1",
          "Origin": "https://chat.ddashpot.com",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "openai/gpt-4o-mini",
          max_tokens: 200,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      apiEnv,
      ctx
    );
    assert(res.status === 200, `status=${res.status}`);
    assert((res.headers.get("Content-Type") || "").includes("text/event-stream"), "is SSE");

    // body をすべて読む
    const reader = res.body.getReader();
    let acc = "";
    const dec = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      acc += dec.decode(value, { stream: true });
    }
    assert(acc.includes("Hel"), "Hel in stream");
    assert(acc.includes("[DONE]"), "[DONE] forwarded");
    await ctx._drain();
    // ai-hub 側の waitUntil も最終的に走るので少し待つ
    await new Promise((r) => setTimeout(r, 50));

    const usage = await getUsageState(apiEnv, "user_1");
    // 累積: S1 で 17 → S2 で +25 = 42
    assert(usage.tokens === 42, `tokens=${usage.tokens} (expected 42)`);
    assert(usage.reserved === 0, `reserved=${usage.reserved} (expected 0)`);
  });

  // ----------------------------------------------------------------------
  // S3: AI Gateway 5xx → ai-hub / api-backend 両方で refund
  // ----------------------------------------------------------------------
  await step("S3 上流 5xx: 両方で予約解放, 二重簿記なし", async () => {
    setAiGateway(async () =>
      new Response(JSON.stringify({ error: "internal" }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      })
    );

    const beforeUsage = await getUsageState(apiEnv, "user_1");
    const beforeTokens = beforeUsage.tokens;
    const beforeReserved = beforeUsage.reserved;

    const ctx = makeCtx();
    const res = await apiBackendWorker.fetch(
      new Request("https://api.ddashpot.com/chat", {
        method: "POST",
        headers: {
          "Authorization": "Bearer valid.token.user1",
          "Origin": "https://chat.ddashpot.com",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "openai/gpt-4o-mini",
          max_tokens: 1000,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      apiEnv,
      ctx
    );
    assert(res.status === 502, `status=${res.status}`);
    await ctx._drain();
    await new Promise((r) => setTimeout(r, 50));

    const after = await getUsageState(apiEnv, "user_1");
    assert(after.reserved === beforeReserved, `reserved unchanged (${after.reserved} vs ${beforeReserved})`);
    assert(after.tokens === beforeTokens, `tokens unchanged (${after.tokens} vs ${beforeTokens})`);
  });

  // ----------------------------------------------------------------------
  // S4: ⭐ 主要修正: ai-hub が 4xx (429) を返すケース.
  //    修正後: SSE 経路に乗らず, 4xx JSON pass-through. 予約は解放される.
  // ----------------------------------------------------------------------
  await step("S4 上流 4xx: SSE 経路に乗らない (主要修正)", async () => {
    setAiGateway(async () =>
      new Response(JSON.stringify({ error: "rate limit" }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      })
    );

    const beforeUsage = await getUsageState(apiEnv, "user_1");
    const beforeTokens = beforeUsage.tokens;

    const ctx = makeCtx();
    const res = await apiBackendWorker.fetch(
      new Request("https://api.ddashpot.com/chat", {
        method: "POST",
        headers: {
          "Authorization": "Bearer valid.token.user1",
          "Origin": "https://chat.ddashpot.com",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "openai/gpt-4o-mini",
          max_tokens: 500,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      apiEnv,
      ctx
    );
    // 4xx は JSON で返ってくるべき (text/event-stream ではない)
    const ct = res.headers.get("Content-Type") || "";
    assert(!ct.includes("text/event-stream"), `Content-Type should NOT be SSE: ${ct}`);
    // api-backend は ai-hub の 4xx を非ストリーム経路で pass-through するので, 応答ボディは JSON
    const body = await res.text();
    let parsed;
    try { parsed = JSON.parse(body); } catch { /* fallthrough */ }
    assert(parsed && parsed.error, `parsable JSON error body: ${body}`);

    await ctx._drain();
    await new Promise((r) => setTimeout(r, 50));

    const after = await getUsageState(apiEnv, "user_1");
    // 予約は解放されているはず. tokens は変わらず (実消費 0).
    assert(after.tokens === beforeTokens, `tokens unchanged after 4xx (${after.tokens} vs ${beforeTokens})`);
    assert(after.reserved === 0, `reserved=${after.reserved} (expected 0)`);
  });

  // ----------------------------------------------------------------------
  // S4b: ai-hub を直接呼んで, 内部の **ログイベント** から経路を区別.
  //      修正前は `stream_complete` (SSE 経路) が ai-hub から出る.
  //      修正後は `chat_complete` (非ストリーム経路) が ai-hub から出る.
  // ----------------------------------------------------------------------
  await step("S4b ai-hub 直接 4xx: 内部経路が非ストリームに切り替わる", async () => {
    setAiGateway(async () =>
      new Response(JSON.stringify({ error: "rate limit on gw" }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      })
    );

    startLogCapture();
    try {
      const res = await apiEnv.AI_HUB.fetch("https://ai-hub.internal/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer ahk_test_xxx",
        },
        body: JSON.stringify({
          model: "openai/gpt-4o-mini",
          max_tokens: 500,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      // body を drain しないと flush が呼ばれない (SSE 経路の場合)
      if (res.body) {
        const reader = res.body.getReader();
        while (true) { const { done } = await reader.read(); if (done) break; }
      }
      if (res.__drainCtx) await res.__drainCtx();
      await new Promise((r) => setTimeout(r, 100));
      assert(res.status === 429, `status should be 429, got ${res.status}`);
    } finally {
      var captured = stopLogCapture();
    }

    // ai-hub の完了イベントを探す
    const aiHubEvents = captured
      .filter((e) => e.service === "ai-hub")
      .map((e) => e.event);

    const hasStreamComplete = aiHubEvents.includes("stream_complete");
    const hasChatComplete = aiHubEvents.includes("chat_complete");

    // 修正後の期待: 非ストリーム経路を通っているので chat_complete.
    // 修正前は stream_complete が出てしまう (== 4xx で SSE 経路に乗っているバグ).
    assert(hasChatComplete && !hasStreamComplete,
      `expected non-stream path. events=${JSON.stringify(aiHubEvents)}`);
  });

  // ----------------------------------------------------------------------
  // S5: per-user monthly limit 到達 (低限度ユーザー)
  // ----------------------------------------------------------------------
  await step("S5 monthly limit 到達で 429", async () => {
    setAiGateway(async () =>
      new Response(
        JSON.stringify({
          id: "c", choices: [{ message: { role: "assistant", content: "x" } }],
          usage: { total_tokens: 80 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const lowEnv = apiEnv; // 同じ env, 別ユーザー
    // 1 回目: max_tokens=80 → 予約 80 → 通る
    let ctx = makeCtx();
    let res = await apiBackendWorker.fetch(
      new Request("https://api.ddashpot.com/chat", {
        method: "POST",
        headers: {
          "Authorization": "Bearer low.limit.user",
          "Origin": "https://chat.ddashpot.com",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "openai/gpt-4o-mini",
          max_tokens: 80,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      lowEnv,
      ctx
    );
    assert(res.status === 200, `1st status=${res.status}`);
    await ctx._drain();
    await new Promise((r) => setTimeout(r, 50));

    // 2 回目: monthly_token_limit=100, 既に 80 tokens 消費済み → max_tokens=50 を予約しようとすると 130 > 100
    ctx = makeCtx();
    res = await apiBackendWorker.fetch(
      new Request("https://api.ddashpot.com/chat", {
        method: "POST",
        headers: {
          "Authorization": "Bearer low.limit.user",
          "Origin": "https://chat.ddashpot.com",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "openai/gpt-4o-mini",
          max_tokens: 50,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      lowEnv,
      ctx
    );
    assert(res.status === 429, `2nd status=${res.status}`);
    const j = await res.json();
    assert(/Monthly/i.test(j.error || ""), `error=${j.error}`);
  });

  // ----------------------------------------------------------------------
  // S6: 認証なし → 401
  // ----------------------------------------------------------------------
  await step("S6 認証なし → 401", async () => {
    const ctx = makeCtx();
    const res = await apiBackendWorker.fetch(
      new Request("https://api.ddashpot.com/chat", {
        method: "POST",
        headers: {
          "Origin": "https://chat.ddashpot.com",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "openai/gpt-4o-mini",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      apiEnv,
      ctx
    );
    assert(res.status === 401, `status=${res.status}`);
  });

  // ----------------------------------------------------------------------
  // S7: Origin なし → 403
  // ----------------------------------------------------------------------
  await step("S7 Origin なし → 403", async () => {
    const ctx = makeCtx();
    const res = await apiBackendWorker.fetch(
      new Request("https://api.ddashpot.com/chat", {
        method: "POST",
        headers: {
          "Authorization": "Bearer valid.token.user1",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "openai/gpt-4o-mini",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      apiEnv,
      ctx
    );
    assert(res.status === 403, `status=${res.status}`);
  });

  // ----------------------------------------------------------------------
  // S8: 並行リクエストでの monthly 超過防止 (予約制の正しさ)
  // ----------------------------------------------------------------------
  await step("S8 並行 5 リクエストで予約制が機能", async () => {
    // 新規ユーザーで, monthly_token_limit=3000 にする
    globalThis.MOCK_TOKENS["concur.token"] = {
      payload: {
        sub: "user_concur",
        public_metadata: { ai_limits: { rate_per_minute: 30, monthly_token_limit: 3000 } },
      },
    };
    setAiGateway(async () =>
      new Response(
        JSON.stringify({
          id: "c", choices: [{ message: { role: "assistant", content: "x" } }],
          usage: { total_tokens: 50 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    // max_tokens=1000 × 5 並列 → 予約合計 5000 > limit 3000 → 一部は 429 になるはず
    const reqs = Array.from({ length: 5 }).map(() => {
      const ctx = makeCtx();
      return apiBackendWorker.fetch(
        new Request("https://api.ddashpot.com/chat", {
          method: "POST",
          headers: {
            "Authorization": "Bearer concur.token",
            "Origin": "https://chat.ddashpot.com",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "openai/gpt-4o-mini",
            max_tokens: 1000,
            messages: [{ role: "user", content: "hi" }],
          }),
        }),
        apiEnv,
        ctx
      ).then((r) => ({ status: r.status, ctx }));
    });
    const responses = await Promise.all(reqs);
    for (const { ctx } of responses) await ctx._drain();
    await new Promise((r) => setTimeout(r, 100));

    const ok = responses.filter((r) => r.status === 200).length;
    const limited = responses.filter((r) => r.status === 429).length;
    assert(ok <= 3, `at most 3 should succeed; ok=${ok}`);
    assert(limited >= 2, `at least 2 should be 429; limited=${limited}`);
    assert(ok + limited === 5, `total mismatch ok=${ok} limited=${limited}`);
  });

  // ----------------------------------------------------------------------
  // S9: ⭐ HTML エラーページ (Cloudflare 1xxx 系等) で AIClient が
  //     "Unexpected token '<', \"<!DOCTYPE \"..." を漏らさないこと
  // ----------------------------------------------------------------------
  await step("S9 AIClient: 502 + HTML ボディを生の SyntaxError にしない", async () => {
    const { default: AIClient } = await import(resolve(ROOT, "frontend-lib", "ai-client.js"));
    globalThis.window = {
      Clerk: { session: { getToken: async () => "valid.token.user1" } },
    };
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        `<!DOCTYPE html><html><head><title>Error</title></head>` +
        `<body><h1>502 Bad Gateway</h1><p>Cloudflare error 1xxx</p></body></html>`,
        { status: 502, headers: { "Content-Type": "text/html" } }
      );

    const ai = new AIClient("https://api.ddashpot.com");
    let caught;
    try {
      await ai.chatRaw("openai/gpt-4o-mini", "hi");
    } catch (e) {
      caught = e;
    }
    globalThis.fetch = origFetch;

    assert(caught, "should throw");
    assert(caught.status === 502, `err.status=${caught.status}`);
    assert(!/Unexpected token '<'/.test(caught.message),
      `must not leak raw SyntaxError: ${caught.message}`);
    assert(/HTML error page/.test(caught.message) || /<!DOCTYPE/.test(caught.bodySnippet || ""),
      `must indicate HTML in message/snippet: ${caught.message}`);
  });

  // ----------------------------------------------------------------------
  // S10: 200 OK で HTML が返ってくる事故 (ルート設定ミス等)
  // ----------------------------------------------------------------------
  await step("S10 AIClient: 200 + 非 JSON でも分かりやすい例外", async () => {
    const { default: AIClient } = await import(resolve(ROOT, "frontend-lib", "ai-client.js"));
    globalThis.window = { Clerk: { session: { getToken: async () => "valid.token.user1" } } };
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response("<!DOCTYPE html><html>oops, hit wrong route</html>",
        { status: 200, headers: { "Content-Type": "text/html" } });

    const ai = new AIClient("https://api.ddashpot.com");
    let caught;
    try {
      await ai.chatRaw("openai/gpt-4o-mini", "hi");
    } catch (e) {
      caught = e;
    }
    globalThis.fetch = origFetch;

    assert(caught, "should throw on 200+HTML");
    assert(caught.status === 200, `err.status=${caught.status}`);
    assert(!/Unexpected token '<'/.test(caught.message),
      `must not leak raw SyntaxError: ${caught.message}`);
    assert(/not JSON/.test(caught.message),
      `should say "not JSON": ${caught.message}`);
  });

  // ----------------------------------------------------------------------
  // S11: 空ボディも SyntaxError にしない
  // ----------------------------------------------------------------------
  await step("S11 AIClient: 503 + 空ボディも親切なメッセージに", async () => {
    const { default: AIClient } = await import(resolve(ROOT, "frontend-lib", "ai-client.js"));
    globalThis.window = { Clerk: { session: { getToken: async () => "valid.token.user1" } } };
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response("", { status: 503, headers: { "Content-Type": "text/plain" } });

    const ai = new AIClient("https://api.ddashpot.com");
    let caught;
    try {
      await ai.chatRaw("openai/gpt-4o-mini", "hi");
    } catch (e) {
      caught = e;
    }
    globalThis.fetch = origFetch;

    assert(caught, "should throw");
    assert(caught.status === 503, `err.status=${caught.status}`);
    assert(/empty body/.test(caught.message),
      `should mention empty body: ${caught.message}`);
  });

  // ============================================================================
  console.log("");
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`==== ${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ""} ====`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error("Harness error:", e);
  process.exit(2);
});
