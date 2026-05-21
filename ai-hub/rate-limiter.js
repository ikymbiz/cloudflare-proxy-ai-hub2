/**
 * RateLimiter — Durable Object
 *
 * 1 アプリキー(のハッシュ) = 1 DO インスタンス。
 * - 分単位レート制限のカウント
 * - 月次トークン利用量の累積
 * を blockConcurrencyWhile でアトミックに行う。
 *
 * KV ベースの read-modify-write では並行リクエストで race condition が
 * 発生していたため、DO に置き換えた。
 *
 * Phase 2.4: アップストリーム失敗時にスロットと予約トークンを返却 (/refund).
 * Phase 3.2: 月次トークンを「予約制」に変更。check 時に max_tokens 分を予約
 *           して累計に加算 → add-usage で実利用との差分を確定する。
 *           予約済みの値は usage.reserved に蓄積される。
 *           判定: tokens + reserved + 新規予約 が monthly_token_limit を超えるなら拒否。
 */
export class RateLimiter {
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
        service: "rate-limiter",
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

  // レート + 月次予約のアトミック判定 & インクリメント
  async handleCheck({ rate_per_minute, monthly_token_limit, reserve_tokens }) {
    const now = Date.now();
    const minuteSlot = Math.floor(now / 60_000);
    const monthSlot = new Date(now).toISOString().slice(0, 7);
    const safeRate = Number.isInteger(rate_per_minute) && rate_per_minute > 0 ? rate_per_minute : 60;
    const reserveAmount = Number.isInteger(reserve_tokens) && reserve_tokens > 0 ? reserve_tokens : 0;

    return await this.state.blockConcurrencyWhile(async () => {
      // 月次予約 (Phase 3.2)
      let usage = null;
      if (Number.isInteger(monthly_token_limit) && monthly_token_limit > 0) {
        usage = (await this.state.storage.get(`usage:${monthSlot}`)) || {
          tokens: 0,
          reserved: 0,
          requests: 0,
        };
        const projected = usage.tokens + usage.reserved + reserveAmount;
        if (projected > monthly_token_limit) {
          return jsonRes({ allowed: false, reason: "monthly_limit" });
        }
      }

      // 分単位レート
      const rateKey = `rate:${minuteSlot}`;
      const current = (await this.state.storage.get(rateKey)) || 0;
      if (current >= safeRate) {
        return jsonRes({ allowed: false, reason: "rate_limit" });
      }
      await this.state.storage.put(rateKey, current + 1);

      // 月次予約を確定 (上で limit ありの場合のみ)
      let reservedNow = 0;
      if (usage && reserveAmount > 0) {
        usage.reserved += reserveAmount;
        await this.state.storage.put(`usage:${monthSlot}`, usage);
        reservedNow = reserveAmount;
      }

      // 古い rate スロットの掃除を予約
      await this.state.storage.setAlarm(now + 120_000);

      return jsonRes({ allowed: true, minute_slot: minuteSlot, reserved: reservedNow });
    });
  }

  // 利用量を加算 (応答取得後に呼ばれる)
  // Phase 3.2: reserved_tokens を解放し、実利用 tokens を確定計上する。
  async handleAddUsage({ tokens, reserved_tokens }) {
    const safeTokens = Number.isInteger(tokens) && tokens > 0 ? tokens : 0;
    const safeReserved = Number.isInteger(reserved_tokens) && reserved_tokens > 0 ? reserved_tokens : 0;
    const monthSlot = new Date().toISOString().slice(0, 7);
    return await this.state.blockConcurrencyWhile(async () => {
      const usageKey = `usage:${monthSlot}`;
      const usage = (await this.state.storage.get(usageKey)) || {
        tokens: 0,
        reserved: 0,
        requests: 0,
      };
      usage.tokens += safeTokens;
      usage.reserved = Math.max(0, usage.reserved - safeReserved);
      usage.requests += 1;
      await this.state.storage.put(usageKey, usage);
      return jsonRes({ ok: true, usage });
    });
  }

  // 失敗時の返却 (Phase 2.4)
  // - 同分の rate スロットを 1 戻す
  // - 予約トークンを解放 (実利用としては計上しない)
  async handleRefund({ minute_slot, reserved_tokens }) {
    const safeReserved = Number.isInteger(reserved_tokens) && reserved_tokens > 0 ? reserved_tokens : 0;
    const monthSlot = new Date().toISOString().slice(0, 7);
    return await this.state.blockConcurrencyWhile(async () => {
      // rate slot を戻す (同一スロットの場合のみ意味あり)
      if (Number.isInteger(minute_slot)) {
        const rateKey = `rate:${minute_slot}`;
        const current = (await this.state.storage.get(rateKey)) || 0;
        if (current > 0) {
          await this.state.storage.put(rateKey, current - 1);
        }
      }
      // 予約解放
      if (safeReserved > 0) {
        const usageKey = `usage:${monthSlot}`;
        const usage = (await this.state.storage.get(usageKey)) || {
          tokens: 0,
          reserved: 0,
          requests: 0,
        };
        usage.reserved = Math.max(0, usage.reserved - safeReserved);
        await this.state.storage.put(usageKey, usage);
      }
      return jsonRes({ ok: true });
    });
  }

  // 古いレートスロットをクリーンアップ (DO ストレージのコスト管理).
  // また 3 ヶ月以上前の usage:* も削除する (会計目的なら別ストレージに集約する前提).
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

    // 古い月次集計の掃除. 「今月」と「先月」だけ残す.
    // (refund や遅延 add-usage が月跨ぎで先月の値を触る可能性があるため 1 ヶ月の猶予).
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
