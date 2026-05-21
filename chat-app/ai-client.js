/**
 * AIClient — ddashpot 共通バックエンド (api.ddashpot.com) のフロントエンド SDK
 *
 * 前提: ページに Clerk SDK が読み込まれており、ユーザーがログイン済み
 *      (Clerk.session が存在する状態)
 *
 * 使い方:
 *   <script src="https://YOUR_CLERK_FRONTEND_API.clerk.accounts.dev/npm/@clerk/clerk-js@latest/dist/clerk.browser.js"
 *           data-clerk-publishable-key="pk_xxx"></script>
 *   <script src="ai-client.js"></script>
 *   <script>
 *     await Clerk.load();
 *     if (Clerk.user) {
 *       const ai = new AIClient("https://api.ddashpot.com");
 *       const reply = await ai.chat("openai/gpt-4o-mini", "こんにちは");
 *     }
 *   </script>
 */
class AIClient {
  /**
   * @param {string} backendUrl - 例: "https://api.ddashpot.com"
   */
  constructor(backendUrl) {
    if (!backendUrl) throw new Error("AIClient: backendUrl is required");
    this.backendUrl = backendUrl.replace(/\/$/, "");
  }

  /**
   * Clerk から最新のセッショントークンを取得する。
   */
  async _getToken() {
    if (typeof window === "undefined" || !window.Clerk) {
      throw new Error("AIClient: Clerk SDK is not loaded");
    }
    if (!window.Clerk.session) {
      throw new Error("AIClient: not signed in");
    }
    const token = await window.Clerk.session.getToken();
    if (!token) throw new Error("AIClient: failed to get token");
    return token;
  }

  /**
   * チャット (応答テキストだけ取得する簡易版)
   *
   * @param {string} model           - "openai/gpt-4o-mini" など
   * @param {string|Array} messages  - 文字列 → user 1件、配列 → そのまま
   * @param {object} options         - temperature, max_tokens, signal など
   * @returns {Promise<string>}
   */
  async chat(model, messages, options = {}) {
    const data = await this.chatRaw(model, messages, options);
    return data?.choices?.[0]?.message?.content ?? "";
  }

  /**
   * チャット (生レスポンスを返す。usage 等も取れる)
   *
   * @returns {Promise<object>} OpenAI 互換のレスポンス
   */
  async chatRaw(model, messages, options = {}) {
    if (!model) throw new Error("AIClient: model is required");

    const token = await this._getToken();

    const msgs = typeof messages === "string"
      ? [{ role: "user", content: messages }]
      : messages;

    const { signal, ...passthrough } = options;
    const body = { model, messages: msgs, ...passthrough };

    const res = await fetch(`${this.backendUrl}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    // ボディは 1 回しか読めない. res.json() が parse 失敗した場合 res.text() は
    // "Body already consumed" で TypeError になり, 元のエラーが失われる.
    // text() を先に読んで JSON.parse を試すパターンに統一する.
    const rawText = await res.text().catch(() => "");

    if (!res.ok) {
      let detail = "";
      try {
        const e = JSON.parse(rawText);
        detail = (e && (e.error || e.message)) || rawText.slice(0, 200);
      } catch {
        // HTML / プレーンテキスト / 空 のいずれかが来た場合
        detail = summarizeNonJson(rawText, res);
      }
      const err = new Error(`AIClient HTTP ${res.status}: ${detail}`);
      err.status = res.status;
      err.bodySnippet = rawText.slice(0, 500);
      throw err;
    }

    // 成功経路でも JSON とは限らない (api.ddashpot.com の前段が事故で HTML を
    // 返すケース: ルート設定ミス, Cloudflare 1xxx エラーページ, etc.).
    // この場合は分かりやすい例外に変換する.
    try {
      return JSON.parse(rawText);
    } catch (parseErr) {
      const err = new Error(
        `AIClient: server returned 200 but body is not JSON ` +
        `(Content-Type=${res.headers.get("Content-Type") || "n/a"}). ` +
        `Body starts with: ${rawText.slice(0, 80)}`
      );
      err.status = res.status;
      err.bodySnippet = rawText.slice(0, 500);
      err.cause = parseErr;
      throw err;
    }
  }

  /**
   * ストリーミングチャット (Server-Sent Events を chunk ごとに yield する)
   *
   *   for await (const chunk of ai.chatStream(model, messages)) {
   *     // chunk は OpenAI 互換の delta オブジェクト
   *     const piece = chunk.choices?.[0]?.delta?.content ?? "";
   *     process.stdout.write(piece);
   *   }
   *
   * @param {string} model
   * @param {string|Array} messages
   * @param {object} options - temperature, max_tokens, signal など
   * @returns {AsyncGenerator<object>}
   */
  async *chatStream(model, messages, options = {}) {
    if (!model) throw new Error("AIClient: model is required");

    const token = await this._getToken();

    const msgs = typeof messages === "string"
      ? [{ role: "user", content: messages }]
      : messages;

    const { signal, ...passthrough } = options;
    const body = { model, messages: msgs, stream: true, ...passthrough };

    const res = await fetch(`${this.backendUrl}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
        "Accept": "text/event-stream",
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      // 同じく body は 1 回読みで判定. SSE 想定でも 4xx は JSON エラーで返ってくる.
      const rawText = await res.text().catch(() => "");
      let detail = "";
      try {
        const e = JSON.parse(rawText);
        detail = (e && (e.error || e.message)) || rawText.slice(0, 200);
      } catch {
        detail = summarizeNonJson(rawText, res);
      }
      const err = new Error(`AIClient HTTP ${res.status}: ${detail}`);
      err.status = res.status;
      err.bodySnippet = rawText.slice(0, 500);
      throw err;
    }

    if (!res.body) {
      throw new Error("AIClient: streaming response has no body");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buf = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        // SSE は "\n\n" でイベント区切り
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const rawEvent = buf.slice(0, idx);
          buf = buf.slice(idx + 2);

          for (const line of rawEvent.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            if (payload === "[DONE]") return;
            try {
              yield JSON.parse(payload);
            } catch {
              // パース失敗チャンクは捨てる (壊れた chunk があり得る)
            }
          }
        }
      }
    } finally {
      try { reader.releaseLock(); } catch {}
    }
  }
}

// ES Modules / CommonJS / グローバル
if (typeof module !== "undefined" && module.exports) {
  module.exports = AIClient;
}
if (typeof window !== "undefined") {
  window.AIClient = AIClient;
}

// 非 JSON ボディを「人間が読める短いラベル」に変換する.
// "Unexpected token '<', \"<!DOCTYPE \"..." のような生 SyntaxError を
// そのままユーザーに見せないために, ボディの素性 (HTML/空/その他) を判別する.
function summarizeNonJson(text, res) {
  const ct = (res.headers.get("Content-Type") || "").toLowerCase();
  if (!text || text.length === 0) {
    return `<empty body, HTTP ${res.status}>`;
  }
  const head = text.slice(0, 80).replace(/\s+/g, " ").trim();
  if (ct.includes("text/html") || /^<!DOCTYPE|^<html|^<\?xml/i.test(text)) {
    return `<HTML error page, HTTP ${res.status}, starts with: ${head}>`;
  }
  return `<non-JSON body, HTTP ${res.status}, Content-Type=${ct || "n/a"}, starts with: ${head}>`;
}
