/**
 * Chat app — シングルターンチャットのテスト実装
 *
 * 認証: Clerk
 * AI 呼び出し: AIClient (api.ddashpot.com 経由)
 */

// ====== 設定 ======
const API_BASE = "https://api.ddashpot.com";
// 開発時は: const API_BASE = "http://localhost:8787";

// ====== DOM ======
const authSection = document.getElementById("auth-section");
const signInContainer = document.getElementById("sign-in-container");
const userButton = document.getElementById("user-button");
const chatMain = document.getElementById("chat-main");
const modelSelect = document.getElementById("model-select");
const messagesEl = document.getElementById("messages");
const form = document.getElementById("chat-form");
const promptEl = document.getElementById("prompt");
const sendButton = document.getElementById("send-button");

// ====== 起動 ======
window.addEventListener("load", async () => {
  try {
    await waitForClerk();
    await window.Clerk.load();
  } catch (e) {
    console.error("Clerk failed to load:", e);
    authSection.innerHTML = `<p class="muted">認証システムの読み込みに失敗しました。</p>`;
    return;
  }

  // ログイン状態の変化を監視
  window.Clerk.addListener(({ user }) => {
    updateAuthUI(!!user);
  });

  updateAuthUI(!!window.Clerk.user);
});

function waitForClerk(timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (window.Clerk) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error("Clerk SDK load timeout"));
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

function updateAuthUI(signedIn) {
  if (signedIn) {
    authSection.hidden = true;
    chatMain.hidden = false;
    // UserButton をマウント (重複マウント防止)
    if (!userButton.dataset.mounted) {
      window.Clerk.mountUserButton(userButton);
      userButton.dataset.mounted = "1";
    }
  } else {
    authSection.hidden = false;
    chatMain.hidden = true;
    if (!signInContainer.dataset.mounted) {
      window.Clerk.mountSignIn(signInContainer);
      signInContainer.dataset.mounted = "1";
    }
  }
}

// ====== チャット ======
const ai = new AIClient(API_BASE);

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = promptEl.value.trim();
  if (!text) return;

  addMessage("user", text);
  promptEl.value = "";

  const loadingId = addMessage("assistant", "考え中…");
  sendButton.disabled = true;

  try {
    let accumulated = "";
    let firstChunk = true;
    for await (const chunk of ai.chatStream(modelSelect.value, text)) {
      const piece = chunk?.choices?.[0]?.delta?.content;
      if (typeof piece !== "string" || piece.length === 0) continue;
      accumulated += piece;
      if (firstChunk) {
        // 「考え中…」を最初の chunk で完全置換
        updateMessage(loadingId, accumulated);
        firstChunk = false;
      } else {
        updateMessage(loadingId, accumulated);
      }
    }
    if (firstChunk) {
      // chunk が一度も来ずに終了 (空応答) のケース
      updateMessage(loadingId, "(空の応答)");
    }
  } catch (e) {
    // 内部情報をそのまま表示しない. status だけ意味のあるものは出す.
    let userMsg;
    if (e?.status === 401) userMsg = "セッションが切れました。再ログインしてください。";
    else if (e?.status === 403) userMsg = "このリクエストは許可されていません。";
    else if (e?.status === 429) userMsg = "リクエストが多すぎます。しばらく待って再試行してください。";
    else if (e?.status >= 500 || e?.status === 502) userMsg = "サーバー側でエラーが発生しました。少し待って再試行してください。";
    else userMsg = "送信に失敗しました。再試行してください。";
    updateMessage(loadingId, userMsg, "error");
    console.error(e);  // 開発者向けには DevTools に詳細を残す
  } finally {
    sendButton.disabled = false;
  }
});

// Enter で送信、Shift+Enter で改行
promptEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    form.requestSubmit();
  }
});

// ====== メッセージ表示 ======
function addMessage(role, text, extraClass = "") {
  const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const div = document.createElement("div");
  div.id = id;
  div.className = `message ${role}${extraClass ? " " + extraClass : ""}`;

  const roleEl = document.createElement("div");
  roleEl.className = "role";
  roleEl.textContent = role === "user" ? "You" : "Assistant";

  const body = document.createElement("div");
  body.className = "body";
  body.textContent = text;

  div.appendChild(roleEl);
  div.appendChild(body);
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return id;
}

function updateMessage(id, text, extraClass = "") {
  const el = document.getElementById(id);
  if (!el) return;
  el.querySelector(".body").textContent = text;
  if (extraClass) el.classList.add(extraClass);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
