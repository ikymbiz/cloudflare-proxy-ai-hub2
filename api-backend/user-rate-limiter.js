/**
 * UserRateLimiter — Durable Object (Phase 2.1)
 *
 * 1 Clerk userId = 1 DO インスタンス。
 * ai-hub の RateLimiter と同じ責務をユーザー単位で持つ。
 *  - 分単位レート
 *  - 月次トークン (予約制)
 *  - 失敗時の refund
 *
 * 値はデフォルト共通だが、将来 Clerk metadata / D1 でユーザー別の制限値を
 * 渡せるよう、handleCheck の引数で受け取る設計にしている。
 */
export class UserRateLimiter {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/check") {
        return await this.handleCheck(await request.json());
      }
      if (url.pathname === "/add-usage") {
        return await this.handleAddUsage(await request.json());
      }
      if (url.pathname === "/refund") {
        return await this.handleRefund(await request.json());
      }
      return new Response("Not Found", { status: 404 });
    } catch (e) {
      console.error(JSON.stringify({
        service: "user-rate-limiter",
        level: "error",
        event: "do_error",
        msg: e?.message,
        ts: new Date().toISOString(),
      }));
      return new Response(JSON.stringify({ error: "internal" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  async handleCheck({ rate_per_minute, monthly_token_limit, reserve_tokens }) {
    const now = Date.now();
    const minuteSlot = Math.floor(now / 60_000);
    const monthSlot = new Date(now).toISOString().slice(0, 7);
    const safeRate = Number.isInteger(rate_per_minute) && rate_per_minute > 0 ? rate_per_minute : 10;
    const reserveAmount = Number.isInteger(reserve_tokens) && reserve_tokens > 0 ? reserve_tokens : 0;

    return await this.state.blockConcurrencyWhile(async () => {
      let usage = null;
      if (Number.isInteger(monthly_token_limit) && monthly_token_limit > 0) {
        usage = (await this.state.storage.get(`usage:${monthSlot}`)) || {
          tokens: 0, reserved: 0, requests: 0,
        };
        const projected = usage.tokens + usage.reserved + reserveAmount;
        if (projected > monthly_token_limit) {
          return jsonRes({ allowed: false, reason: "monthly_limit" });
        }
      }

      const rateKey = `rate:${minuteSlot}`;
      const current = (await this.state.storage.get(rateKey)) || 0;
      if (current >= safeRate) {
        return jsonRes({ allowed: false, reason: "rate_limit" });
      }
      await this.state.storage.put(rateKey, current + 1);

      let reservedNow = 0;
      if (usage && reserveAmount > 0) {
        usage.reserved += reserveAmount;
        await this.state.storage.put(`usage:${monthSlot}`, usage);
        reservedNow = reserveAmount;
      }

      await this.state.storage.setAlarm(now + 120_000);
      return jsonRes({ allowed: true, minute_slot: minuteSlot, reserved: reservedNow });
    });
  }

  async handleAddUsage({ tokens, reserved_tokens }) {
    const safeTokens = Number.isInteger(tokens) && tokens > 0 ? tokens : 0;
    const safeReserved = Number.isInteger(reserved_tokens) && reserved_tokens > 0 ? reserved_tokens : 0;
    const monthSlot = new Date().toISOString().slice(0, 7);
    return await this.state.blockConcurrencyWhile(async () => {
      const usageKey = `usage:${monthSlot}`;
      const usage = (await this.state.storage.get(usageKey)) || {
        tokens: 0, reserved: 0, requests: 0,
      };
      usage.tokens += safeTokens;
      usage.reserved = Math.max(0, usage.reserved - safeReserved);
      usage.requests += 1;
      await this.state.storage.put(usageKey, usage);
      return jsonRes({ ok: true, usage });
    });
  }

  async handleRefund({ minute_slot, reserved_tokens }) {
    const safeReserved = Number.isInteger(reserved_tokens) && reserved_tokens > 0 ? reserved_tokens : 0;
    const monthSlot = new Date().toISOString().slice(0, 7);
    return await this.state.blockConcurrencyWhile(async () => {
      if (Number.isInteger(minute_slot)) {
        const rateKey = `rate:${minute_slot}`;
        const current = (await this.state.storage.get(rateKey)) || 0;
        if (current > 0) {
          await this.state.storage.put(rateKey, current - 1);
        }
      }
      if (safeReserved > 0) {
        const usageKey = `usage:${monthSlot}`;
        const usage = (await this.state.storage.get(usageKey)) || {
          tokens: 0, reserved: 0, requests: 0,
        };
        usage.reserved = Math.max(0, usage.reserved - safeReserved);
        await this.state.storage.put(usageKey, usage);
      }
      return jsonRes({ ok: true });
    });
  }

  async alarm() {
    const now = Date.now();
    const minuteSlot = Math.floor(now / 60_000);
    const items = await this.state.storage.list({ prefix: "rate:" });
    const toDelete = [];
    for (const [key] of items) {
      const slot = parseInt(key.slice("rate:".length), 10);
      if (Number.isFinite(slot) && slot < minuteSlot - 2) {
        toDelete.push(key);
      }
    }

    // 古い月次集計の掃除. 「今月」「先月」だけ残し, それより古いものは消す.
    const d = new Date(now);
    const thisMonth = d.toISOString().slice(0, 7);
    const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
    const lastMonth = prev.toISOString().slice(0, 7);
    const usageItems = await this.state.storage.list({ prefix: "usage:" });
    for (const [key] of usageItems) {
      const month = key.slice("usage:".length);
      if (month !== thisMonth && month !== lastMonth) {
        toDelete.push(key);
      }
    }

    if (toDelete.length > 0) {
      await this.state.storage.delete(toDelete);
    }
  }
}

function jsonRes(obj) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
