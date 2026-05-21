// chat-app/functions/_middleware.js
//
// Cloudflare Pages Function middleware.
// HTML レスポンスに対して per-request nonce を発行し、
// すべての <script> タグに nonce 属性を注入したうえで、
// CSP ヘッダを `'nonce-XXX' 'strict-dynamic'` 構成で再設定する。
//
// これにより script-src から `'unsafe-inline'` を排除でき、
// XSS 発生時に CSP が機能する。
//
// 注意:
// - style-src については Clerk SDK が動的にインラインスタイルを挿入するため、
//   現状 `'unsafe-inline'` を残す。Clerk 側が nonce 対応するまでの暫定。
//   (この制限を緩和したい場合は Clerk の `appearance` API で全スタイルを
//    自前 CSS に寄せ、`'unsafe-inline'` を外す方針が考えられる)
// - 非 HTML レスポンスには静的な `_headers` が引き続き効く。
//   Pages の挙動上、関数で同名ヘッダを設定するとそれが上書き優先となる。

const FRONTEND_API_HOST_GLOB = [
  "https://*.clerk.accounts.dev",
  "https://*.clerk.com",
];

function generateNonce() {
  // 16 bytes → base64 (約 22 文字)
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=+$/, "");
}

function buildCsp(nonce) {
  const clerk = FRONTEND_API_HOST_GLOB.join(" ");
  return [
    `default-src 'self'`,
    // strict-dynamic を入れることで nonce 付きスクリプトが import した
    // スクリプトも許可される。Clerk SDK はこのモードを推奨。
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' ${clerk}`,
    // style-src は現状 unsafe-inline を残す (Clerk 都合、上記コメント参照)
    `style-src 'self' 'unsafe-inline' ${clerk}`,
    `img-src 'self' data: ${clerk} https://img.clerk.com`,
    `font-src 'self' data: ${clerk}`,
    `connect-src 'self' https://api.ddashpot.com ${clerk}`,
    `frame-src ${clerk}`,
    `worker-src 'self' blob:`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    `report-uri https://api.ddashpot.com/csp-report`,
    `report-to csp-endpoint`,
  ].join("; ");
}

function setCommonSecurityHeaders(headers) {
  headers.set(
    "Report-To",
    JSON.stringify({
      group: "csp-endpoint",
      max_age: 10886400,
      endpoints: [{ url: "https://api.ddashpot.com/csp-report" }],
    })
  );
  headers.set(
    "Reporting-Endpoints",
    `csp-endpoint="https://api.ddashpot.com/csp-report"`
  );
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set(
    "Permissions-Policy",
    "geolocation=(), microphone=(), camera=()"
  );
  headers.set(
    "Strict-Transport-Security",
    "max-age=31536000; includeSubDomains; preload"
  );
}

class ScriptNonceInjector {
  constructor(nonce) {
    this.nonce = nonce;
  }
  element(el) {
    // 既に nonce が付与済みなら触らない
    if (el.getAttribute("nonce")) return;
    el.setAttribute("nonce", this.nonce);
  }
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  // ビルドツール系の内部ファイルは公開しない.
  // Pages はディレクトリ直配信なので, ここで明示的に塞ぐ.
  if (
    url.pathname === "/package.json" ||
    url.pathname === "/package-lock.json" ||
    url.pathname.startsWith("/scripts/") ||
    url.pathname.startsWith("/node_modules/")
  ) {
    return new Response("Not Found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const response = await context.next();

  const contentType = response.headers.get("content-type") || "";
  const isHtml = contentType.toLowerCase().includes("text/html");

  if (!isHtml) {
    // 非 HTML: 共通ヘッダのみ付与 (CSP は `_headers` のフォールバックを使う)
    const headers = new Headers(response.headers);
    setCommonSecurityHeaders(headers);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  const nonce = generateNonce();

  // HTMLRewriter で <script> タグに nonce を注入
  const rewritten = new HTMLRewriter()
    .on("script", new ScriptNonceInjector(nonce))
    .transform(response);

  const headers = new Headers(rewritten.headers);
  headers.set("Content-Security-Policy", buildCsp(nonce));
  setCommonSecurityHeaders(headers);

  return new Response(rewritten.body, {
    status: rewritten.status,
    statusText: rewritten.statusText,
    headers,
  });
}
