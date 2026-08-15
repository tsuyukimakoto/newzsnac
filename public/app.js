const ROW_HEIGHT = 116;
const storedHideRead = localStorage.getItem("newzsnac.hideRead");
const state = {
  items: [], selected: 0, mode: "fast", start: 0, end: 0,
  loading: false, loadGeneration: 0, navigating: false, filter: { type: "all" }, view: "reader", total: null,
  hideRead: storedHideRead !== "false",
  chats: new Map(),
  retrying: new Set(), retryErrors: new Map(),
  backHistory: [], forwardHistory: [],
};
if (storedHideRead === null) localStorage.setItem("newzsnac.hideRead", "true");
const list = document.querySelector("#article-list");
const spacer = document.querySelector("#article-spacer");
const reader = document.querySelector("#reader");
const hideRead = document.querySelector("#hide-read");
hideRead.checked = state.hideRead;

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

function formatChatText(value = "") {
  return escapeHtml(value).replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
}

function statusLabel(item) {
  if (item.extractionStatus === "failed") return '<span class="badge failed">本文取得失敗</span>';
  if (item.processingState === "analysis_failed") return '<span class="badge failed">分析失敗</span>';
  if (item.translationStatus === "ready") return '<span class="badge ready">翻訳済み</span>';
  if (item.translationStatus === "pending") return '<span class="badge">翻訳中</span>';
  if (!item.summary) return '<span class="badge">要約準備中</span>';
  if (item.recommendation) return '<span class="badge recommendation-badge">読むべきかも？</span>';
  return "";
}

function interestLabel(item) {
  return item.interest === "interested" ? '<span class="interest-mark" aria-label="気になった">◆</span>' : "";
}

function formatPublishedAt(value) {
  if (!value) return "公開日時不明";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "公開日時不明";
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(date);
}

function renderList() {
  const visible = Math.ceil(list.clientHeight / ROW_HEIGHT) + 8;
  state.start = Math.max(0, Math.floor(list.scrollTop / ROW_HEIGHT) - 4);
  state.end = Math.min(state.items.length, state.start + visible);
  spacer.style.height = `${state.items.length * ROW_HEIGHT}px`;
  list.querySelectorAll(".article-card").forEach((node) => node.remove());
  state.items.slice(state.start, state.end).forEach((item, offset) => {
    const index = state.start + offset;
    const card = document.createElement("div");
    card.className = `article-card ${index === state.selected ? "selected" : ""} ${item.isRead ? "read" : ""} ${item.interest === "interested" ? "interested" : ""} ${item.recommendation ? "recommended" : ""}`;
    card.style.transform = `translateY(${index * ROW_HEIGHT}px)`;
    card.setAttribute("role", "option");
    card.setAttribute("aria-selected", String(index === state.selected));
    card.innerHTML = `<div class="card-top"><span>${interestLabel(item)}${escapeHtml(item.source || "SOURCE")} · <time class="publication" datetime="${escapeHtml(item.publishedAt || "")}">${escapeHtml(formatPublishedAt(item.publishedAt))}</time></span>${statusLabel(item)}</div><h2>${escapeHtml(item.title)}</h2><p>${escapeHtml(item.summary || "要約を作成しています…")}</p>`;
    card.onclick = () => { void moveFocus(index); };
    list.append(card);
  });
}

function renderReader() {
  if (state.view === "source-manager") return;
  const item = state.items[state.selected];
  if (!item) {
    reader.classList.remove("open");
    reader.innerHTML = '<div class="reader-empty"><span class="big-mark">N</span><p>記事を選ぶと、ここに本文を表示します。</p><kbd>j</kbd><span>で次の記事へ</span></div>';
    return;
  }
  reader.classList.add("open");
  const published = formatPublishedAt(item.publishedAt);
  const recommendation = item.recommendation
    ? `<aside class="recommendation-note"><b>読むべきかも？</b><span>気になった「${escapeHtml(item.recommendation.sourceTitle)}」に内容が近い · 類似度 ${Math.round(item.recommendation.score * 100)}%</span></aside>` : "";
  const contentAction = item.processingState === "failed" ? "" : `<button id="stored-content-button" type="button">${state.mode === "deep" ? "要約に戻る" : "保存済み全文を読む"} <kbd>Space</kbd></button>`;
  const actions = `<div class="reader-actions">
    <button id="interest-button" type="button" aria-pressed="${item.interest === "interested"}">${item.interest === "interested" ? "◆ 気になった" : "◇ 気になった"} <kbd>i</kbd></button>
    ${contentAction}
    <a id="original-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">元の記事を開く ↗ <kbd>o</kbd></a>
  </div>`;
  const heading = `<div class="kicker">${escapeHtml(item.source || "ARTICLE")} · <time datetime="${escapeHtml(item.publishedAt || "")}">${escapeHtml(published)}</time></div><h1>${escapeHtml(item.title)}</h1><div class="byline">${escapeHtml(item.author || "著者不明")}　／　公開 ${escapeHtml(published)}</div>${actions}${recommendation}`;
  let contentClass;
  let articleMarkup;
  if (state.mode === "deep") {
    contentClass = "reader-content deep-reading";
    articleMarkup = `${heading}${item.summary ? `<div class="summary compact">${escapeHtml(item.summary)}</div>` : ""}<div class="body article-body">${escapeHtml(item.content || "保存済み本文はありません。").replace(/\n/g, "<br>")}</div><div class="status-line">${statusLabel(item) || "ローカルに保存済み"}</div>`;
  } else {
    contentClass = "reader-content fast-reading";
    const labels = (item.labels || []).map((label) => `<span>${escapeHtml(label)}</span>`).join("");
    const keyPoints = (item.keyPoints || []).map((point) => `<li><div><strong class="key-point-headline">${escapeHtml(point.headline)}</strong>${point.detail ? `<p class="key-point-detail">${escapeHtml(point.detail)}</p>` : ""}</div></li>`).join("");
    const retrying = state.retrying.has(item.id);
    const retryError = state.retryErrors.get(item.id) || "";
    const analysis = item.processingState === "failed"
      ? `<section class="extraction-failed"><span class="failure-mark">!</span><div><div class="section-label">RETRIEVAL FAILED</div><h2>本文を取得できませんでした</h2><p>元の記事が一時的に応答しなかった可能性があります。再取得すると、成功後は「準備中」へ移動します。</p><button id="retry-article" type="button" ${retrying ? "disabled" : ""}>${retrying ? "再取得しています…" : "本文を再取得"}</button><p class="retry-error" role="alert" ${retryError ? "" : "hidden"}>${escapeHtml(retryError)}</p></div></section>`
      : item.processingState === "analysis_failed"
      ? `<section class="extraction-failed analysis-failed"><span class="failure-mark">!</span><div><div class="section-label">ANALYSIS FAILED</div><h2>要約を作成できませんでした</h2><p>LM Studioの応答を処理できませんでした。再試行すると「準備中」へ戻り、保存済み本文からもう一度分析します。</p><button id="retry-article" type="button" ${retrying ? "disabled" : ""}>${retrying ? "再試行しています…" : "分析を再試行"}</button><p class="retry-error" role="alert" ${retryError ? "" : "hidden"}>${escapeHtml(retryError)}</p></div></section>`
      : item.summary
      ? `<section class="reader-summary"><div class="section-label">SUMMARY</div><p>${escapeHtml(item.summary)}</p></section><section class="reader-points"><div class="section-label">KEY POINTS</div>${keyPoints ? `<ol>${keyPoints}</ol>` : "<p>判断ポイントはありません。</p>"}</section>${labels ? `<div class="reader-labels">${labels}</div>` : ""}`
      : `<section class="analysis-pending"><span class="pending-mark">◌</span><div><div class="section-label">ANALYSIS</div><h2>要約を準備しています</h2><p>分析が完了すると、ここに要約とポイントを表示します。全文は <kbd>Space</kbd> で確認できます。</p></div></section>`;
    articleMarkup = `${heading}${analysis}<div class="status-line">${statusLabel(item) || "分析済み"}</div>`;
  }

  const existingChat = reader.querySelector(`#article-chat[data-article-id="${item.id}"]`);
  const existingContent = existingChat?.closest(".reader-content");
  const existingArticle = existingContent?.querySelector(".article-detail");
  if (existingContent && existingArticle) {
    existingContent.className = contentClass;
    existingArticle.innerHTML = articleMarkup;
  } else {
    reader.innerHTML = `<div class="${contentClass}"><div class="article-detail">${articleMarkup}</div>${item.processingState === "failed" ? "" : chatShell(item)}</div>`;
  }
  bindReaderActions(item);
}

function bindReaderActions(item) {
  const button = reader.querySelector("#interest-button");
  if (button) button.onclick = () => toggleInterest(item);
  const contentButton = reader.querySelector("#stored-content-button");
  if (contentButton) contentButton.onclick = () => { setMode(state.mode === "deep" ? "fast" : "deep"); renderReader(); };
  const retryButton = reader.querySelector("#retry-article");
  if (retryButton) retryButton.onclick = () => retryArticle(item);
  renderChat(item);
}

async function retryArticle(item) {
  if (state.retrying.has(item.id)) return;
  state.retrying.add(item.id);
  state.retryErrors.delete(item.id);
  renderReader();
  try {
    const operation = item.processingState === "analysis_failed" ? "article.analysis.retry" : "article.retry";
    const result = await executeOperation(operation, { articleId: item.id });
    await loadDashboard();
    const nextFilter = result.processingState === "ready" ? "all" : result.processingState;
    state.filter = { type: nextFilter };
    state.backHistory = [];
    state.forwardHistory = [];
    activateFilter(document.querySelector(`#filter-${nextFilter}`));
    await loadItems("", false, item.id);
  } catch (error) {
    state.retryErrors.set(item.id, error.message);
  } finally {
    state.retrying.delete(item.id);
    renderReader();
  }
}

function chatShell(item) {
  return `<section id="article-chat" class="article-chat" data-article-id="${item.id}" aria-label="この記事についてローカルAIと問答"></section>`;
}

function articleChat(itemId) {
  if (!state.chats.has(itemId)) state.chats.set(itemId, { messages: [], loaded: false, loading: false, error: "", draft: "", handoff: "", copyStatus: "" });
  return state.chats.get(itemId);
}

function renderChat(item) {
  const node = reader.querySelector(`#article-chat[data-article-id="${item.id}"]`);
  if (!node) return;
  const chat = articleChat(item.id);
  if (node.dataset.initialized !== "true") {
    node.dataset.initialized = "true";
    node.innerHTML = `<div class="chat-head"><div><div class="section-label">LOCAL Q&amp;A</div><h2>この記事について聞く</h2></div><div class="chat-privacy">記事と問答は、このMacのLM Studioだけに送られます。</div></div>
      <div class="chat-messages"></div>
      <form class="chat-form"><textarea id="chat-question" maxlength="4000" required placeholder="この記事の前提、影響、見落としを質問する"></textarea><div class="chat-form-footer"><span class="chat-hint">回答は記事と保存済み問答を参照します</span><button type="submit">ローカルAIに聞く</button></div></form>
      <p class="chat-error" role="alert" hidden></p>
      <div class="chat-tools"><span class="chat-hint">別のAIへは自動送信しません</span><button id="handoff-button" type="button">別のAI Chatへの引き継ぎ文</button></div>
      <div class="handoff-container"></div>`;

    const question = node.querySelector("#chat-question");
    question.addEventListener("input", () => { chat.draft = question.value; });
    node.querySelector(".chat-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const value = chat.draft.trim();
      if (!value || chat.loading) return;
      chat.loading = true; chat.error = ""; chat.copyStatus = "";
      renderChat(item);
      try {
        const result = await executeOperation("article.chat.ask", { articleId: item.id, question: value });
        chat.messages = result.messages || [];
        chat.loaded = true; chat.draft = ""; chat.handoff = "";
      } catch (error) {
        chat.error = error.message;
      } finally {
        chat.loading = false;
        renderChat(item);
      }
    });
    node.querySelector("#handoff-button").onclick = async () => {
      chat.error = ""; chat.copyStatus = "";
      try {
        const result = await executeOperation("article.chat.handoff", { articleId: item.id });
        chat.handoff = result.text;
      } catch (error) { chat.error = error.message; }
      renderChat(item);
    };
  }

  const messages = chat.messages.map((message) => `<div class="chat-message ${message.role}">
    <div class="chat-role">${message.role === "user" ? "YOU" : "LOCAL AI"}</div>
    <div class="chat-body"><span class="chat-content">${formatChatText(message.content)}</span>${message.modelId ? `<small class="chat-model">${escapeHtml(message.modelId)}</small>` : ""}</div>
  </div>`).join("");
  const conversation = messages || `<div class="chat-empty">記事だけでは腑に落ちない点を、手元のLM Studioに質問できます。</div>`;
  const question = node.querySelector("#chat-question");
  if (document.activeElement !== question && question.value !== chat.draft) question.value = chat.draft;
  node.querySelector(".chat-messages").innerHTML = chat.loaded
    ? conversation : '<div class="chat-empty">履歴を読み込んでいます…</div>';
  const submitButton = node.querySelector('.chat-form button[type="submit"]');
  submitButton.disabled = chat.loading;
  submitButton.textContent = chat.loading ? "考えています…" : "ローカルAIに聞く";
  const errorNode = node.querySelector(".chat-error");
  errorNode.textContent = chat.error;
  errorNode.hidden = !chat.error;
  node.querySelector("#handoff-button").disabled = chat.loading;
  const handoffContainer = node.querySelector(".handoff-container");
  handoffContainer.innerHTML = chat.handoff
    ? `<div class="handoff-panel"><label for="handoff-text">内容を確認してからコピーしてください</label><textarea id="handoff-text">${escapeHtml(chat.handoff)}</textarea><div class="chat-tools"><span class="copy-status">${escapeHtml(chat.copyStatus)}</span><button id="copy-handoff" type="button">コピー</button></div></div>` : "";
  const copyButton = node.querySelector("#copy-handoff");
  if (copyButton) copyButton.onclick = async () => {
    const text = node.querySelector("#handoff-text").value;
    try {
      await navigator.clipboard.writeText(text);
      chat.copyStatus = "コピーしました";
    } catch {
      node.querySelector("#handoff-text").select();
      chat.copyStatus = "選択しました。⌘Cでコピーできます";
    }
    renderChat(item);
  };

  if (!chat.loaded && !chat.loading) {
    chat.loading = true;
    executeOperation("article.chat.list", { articleId: item.id }).then((messagesFromServer) => {
      chat.messages = messagesFromServer || []; chat.loaded = true; chat.error = "";
    }).catch((error) => { chat.error = error.message; }).finally(() => {
      chat.loading = false;
      if (state.items[state.selected]?.id === item.id) renderChat(item);
    });
  }
}

async function toggleInterest(item) {
  const before = item.interest;
  item.interest = before === "interested" ? null : "interested";
  renderList(); renderReader();
  try {
    await executeOperation("article.interest", { articleId: item.id, interested: item.interest === "interested" });
    await loadDashboard();
    if (state.filter.type === "interested" || state.filter.type === "recommended") await loadItems("", true);
  } catch {
    item.interest = before;
    renderList(); renderReader();
  }
}

function select(index) {
  state.view = "reader";
  state.selected = Math.max(0, Math.min(state.items.length - 1, index));
  renderList();
  renderReader();
  document.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
}

async function moveFocus(index) {
  if (state.navigating || state.items.length === 0) return;
  const targetIndex = Math.max(0, Math.min(state.items.length - 1, index));
  if (targetIndex === state.selected) return;
  const current = state.items[state.selected];
  const targetId = state.items[targetIndex]?.id;
  if (!current || !targetId) return;
  state.navigating = true;
  document.querySelector("#stream-error").textContent = "";
  try {
    if (!current.isRead && current.processingState === "ready") {
      await executeOperation("article.read", { articleId: current.id, read: true });
      current.isRead = true;
      await loadDashboard();
    }
    pushHistory(state.backHistory, current);
    state.forwardHistory = [];
    if (state.hideRead) await loadItems(document.querySelector("#search").value.trim(), true, targetId);
    else select(targetIndex);
  } catch (error) {
    current.isRead = false;
    document.querySelector("#stream-error").textContent = `既読状態を更新できませんでした: ${error.message}`;
    renderList();
  } finally {
    state.navigating = false;
  }
}

function pushHistory(history, item) {
  if (history.at(-1)?.id !== item.id) history.push(item);
}

function showHistoryItem(item) {
  let index = state.items.findIndex((candidate) => candidate.id === item.id);
  if (index < 0) {
    state.items = [item, ...state.items];
    index = 0;
  }
  select(index);
}

function moveBackward() {
  if (state.navigating || state.items.length === 0) return;
  const current = state.items[state.selected];
  let target = state.backHistory.pop();
  if (!target && state.selected > 0) target = state.items[state.selected - 1];
  if (!current || !target || target.id === current.id) return;
  pushHistory(state.forwardHistory, current);
  showHistoryItem(target);
}

async function moveForward() {
  if (state.navigating || state.items.length === 0) return;
  const target = state.forwardHistory.at(-1);
  if (!target) {
    await moveFocus(state.selected + 1);
    return;
  }
  const current = state.items[state.selected];
  if (!current || target.id === current.id) return;
  state.navigating = true;
  document.querySelector("#stream-error").textContent = "";
  try {
    if (!current.isRead && current.processingState === "ready") {
      await executeOperation("article.read", { articleId: current.id, read: true });
      current.isRead = true;
      await loadDashboard();
    }
    state.forwardHistory.pop();
    pushHistory(state.backHistory, current);
    if (state.hideRead && !target.isRead) {
      await loadItems(document.querySelector("#search").value.trim(), true, target.id);
    } else {
      showHistoryItem(target);
    }
  } catch (error) {
    current.isRead = false;
    document.querySelector("#stream-error").textContent = `既読状態を更新できませんでした: ${error.message}`;
    renderList();
  } finally {
    state.navigating = false;
  }
}

function setMode(mode) {
  state.mode = mode;
  document.querySelector("#mode").textContent = mode === "deep" ? "精読モード" : "高速モード";
  reader.classList.toggle("open", mode === "deep");
}

async function executeOperation(operation, input) {
  const response = await fetch(`/api/operations/${encodeURIComponent(operation)}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  });
  const result = await response.json();
  if (!result.ok) throw new Error(result.error?.message || "操作に失敗しました");
  return result.data;
}

async function loadItems(query = "", preservePosition = false, preferredId = null) {
  if (!preservePosition && preferredId === null) {
    state.backHistory = [];
    state.forwardHistory = [];
  }
  const generation = ++state.loadGeneration;
  state.loading = true;
  try {
    const url = new URL("/api/items", location.origin);
    if (query) url.searchParams.set("q", query);
    if (["pending", "failed", "analysis_failed"].includes(state.filter.type)) url.searchParams.set("status", state.filter.type);
    if (!query && state.filter.type === "source") url.searchParams.set("sourceId", state.filter.id);
    if (!query && state.filter.type === "saved") url.searchParams.set("saved", "true");
    if (!query && state.filter.type === "interested") url.searchParams.set("interested", "true");
    if (!query && state.filter.type === "recommended") url.searchParams.set("recommended", "true");
    if (state.hideRead) url.searchParams.set("unread", "true");
    const response = await fetch(url);
    const data = await response.json();
    if (generation !== state.loadGeneration) return;
    const selectedItem = preservePosition ? state.items[state.selected] : null;
    const selectedId = preferredId ?? selectedItem?.id ?? null;
    const scrollTop = list.scrollTop;
    const refreshedItems = data.items || [];
    if (preservePosition && state.hideRead) {
      const historyIds = new Set([
        ...state.forwardHistory.map((item) => item.id),
        ...(selectedItem && preferredId === null ? [selectedItem.id] : []),
      ]);
      const refreshedIds = new Set(refreshedItems.map((item) => item.id));
      const visibleHistory = state.items.filter((item) => item.isRead && historyIds.has(item.id) && !refreshedIds.has(item.id));
      state.items = [...visibleHistory, ...refreshedItems];
    } else {
      state.items = refreshedItems;
    }
    const selectedIndex = selectedId ? state.items.findIndex((item) => item.id === selectedId) : -1;
    state.selected = selectedIndex >= 0 ? selectedIndex : 0;
    list.scrollTop = preservePosition ? scrollTop : 0;
    document.querySelector("#empty").hidden = state.items.length > 0;
    document.querySelector("#visible-count").textContent = `${state.items.length}件を表示`;
    renderStreamContext();
    renderList();
    renderReader();
  } finally {
    if (generation === state.loadGeneration) state.loading = false;
  }
}

const streamContexts = {
  all: { kicker: "INBOX", title: "今日の読みもの", emptyTitle: "読める記事はまだありません", emptyDetail: "分析が終わった記事はここに表示されます。" },
  pending: { kicker: "PROCESSING", title: "準備中", emptyTitle: "準備中の記事はありません", emptyDetail: "新しい記事を取得すると、分析が終わるまでここに表示されます。" },
  failed: { kicker: "RETRIEVAL", title: "取得失敗", emptyTitle: "取得に失敗した記事はありません", emptyDetail: "本文を取得できなかった記事だけがここに表示されます。" },
  analysis_failed: { kicker: "ANALYSIS", title: "分析失敗", emptyTitle: "分析に失敗した記事はありません", emptyDetail: "再試行上限に達した記事だけがここに表示されます。" },
};

function renderStreamContext() {
  const context = streamContexts[state.filter.type] || streamContexts.all;
  document.querySelector("#stream-kicker").textContent = context.kicker;
  document.querySelector("#stream-title").textContent = context.title;
  document.querySelector("#empty-title").textContent = context.emptyTitle;
  document.querySelector("#empty-detail").textContent = context.emptyDetail;
}

function formatMinutes(minutes) {
  if (minutes < 60) return `約 ${minutes}分`;
  return `約 ${Math.floor(minutes / 60)}時間${minutes % 60 ? `${minutes % 60}分` : ""}`;
}

function activateFilter(button) {
  document.querySelectorAll(".source").forEach((node) => node.classList.remove("active"));
  button.classList.add("active");
}

async function loadDashboard() {
  const response = await fetch("/api/dashboard");
  const data = await response.json();
  const summary = data.summary || {};
  const total = Number(summary.total || 0);
  if (state.total !== null && total > state.total) {
    const newCount = document.querySelector("#new-count");
    newCount.hidden = false;
    newCount.querySelector("b").textContent = total - state.total;
  }
  state.total = total;
  document.querySelector("#total-count").textContent = total;
  document.querySelector("#saved-count").textContent = summary.saved || 0;
  document.querySelector("#interested-count").textContent = summary.interested || 0;
  document.querySelector("#recommended-count").textContent = summary.recommended || 0;
  document.querySelector("#pending-count").textContent = summary.pending || 0;
  document.querySelector("#failed-count").textContent = summary.failed || 0;
  document.querySelector("#analysis-failed-count").textContent = summary.analysisFailed || 0;
  document.querySelector("#unread-count").textContent = `未読 ${summary.unread || 0}`;
  document.querySelector("#reading-time").textContent = formatMinutes(summary.readingMinutes || 0);
  const sourceList = document.querySelector("#source-list");
  sourceList.replaceChildren();
  for (const source of data.sources || []) {
    const button = document.createElement("button");
    button.className = "source";
    button.innerHTML = `<i class="dot ${source.status === "active" ? "green" : "gold"}"></i><span>${escapeHtml(source.displayName)}</span><b>${source.unread}</b>`;
    button.onclick = () => {
      state.filter = { type: "source", id: source.id };
      state.view = "reader";
      activateFilter(button);
      loadItems();
    };
    sourceList.append(button);
  }
  const runtime = data.runtime || {};
  const connected = runtime.lmStudio === "connected";
  document.querySelector("#runtime-dot").classList.toggle("warning", !connected);
  document.querySelector("#runtime-status").textContent = connected
    ? `SQLite · LM Studio (${runtime.activeModel || runtime.configuredModel})${runtime.embedding?.configured ? ` · 推薦 ${runtime.embedding.recommendations}` : " · 埋め込み未設定"}`
    : `SQLite · LM Studio 未接続 (${runtime.configuredModel || "qwen"})`;
}

function showSourceManager() {
  state.view = "source-manager";
  reader.classList.add("open");
  reader.innerHTML = `<div class="reader-content source-manager">
    <div class="kicker">ADD SOURCE</div><h1>情報源を追加</h1>
    <p>RSS/Atom またはWebサイトのURL、Hacker News、Zenn URL、Blueskyハンドルを入力してください。</p>
    <form id="source-form"><label for="source-input">URL またはハンドル</label><div class="source-input-row"><input id="source-input" required placeholder="https://example.com/feed.xml または @name.bsky.social"><button type="submit">内容を確認</button></div></form>
    <div id="source-message" class="source-message"></div><div id="source-preview"></div>
  </div>`;
  const form = document.querySelector("#source-form");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = document.querySelector("#source-input").value.trim();
    const message = document.querySelector("#source-message");
    const previewNode = document.querySelector("#source-preview");
    message.textContent = "取得内容を確認しています…";
    previewNode.replaceChildren();
    try {
      const preview = await executeOperation("source.preview", { input });
      message.textContent = "";
      previewNode.innerHTML = `<section class="preview-card"><div class="kicker">${escapeHtml(preview.kind)}</div><h2>${escapeHtml(preview.displayName)}</h2><p class="canonical">${escapeHtml(preview.canonicalUrl)}</p><p>推定 週${preview.estimatedWeeklyCount}件 · 既存記事との重複 ${Math.round(preview.overlapRatio * 100)}%</p><ol>${preview.recentItems.map((item) => `<li>${escapeHtml(item.title)}</li>`).join("") || "<li>プレビュー項目はありません</li>"}</ol><button id="confirm-source" class="primary">この情報源を追加</button></section>`;
      document.querySelector("#confirm-source").onclick = async () => {
        const button = document.querySelector("#confirm-source");
        button.disabled = true;
        try {
          const result = await executeOperation("source.add", { input });
          message.textContent = result.created ? "追加しました。10秒以内に最初の収集を開始します。" : "この情報源はすでに追加されています。";
          await loadDashboard();
        } catch (error) {
          message.textContent = error.message;
          button.disabled = false;
        }
      };
    } catch (error) {
      message.textContent = error.message;
    }
  });
  document.querySelector("#source-input").focus();
}

list.addEventListener("scroll", () => requestAnimationFrame(renderList));
function isTextEntryKey(event) {
  if (event.isComposing || event.key === "Process" || event.keyCode === 229) return true;
  const selector = "input,textarea,select,[contenteditable=true]";
  const path = typeof event.composedPath === "function" ? event.composedPath() : [event.target];
  const eventComesFromEditor = path.some((node) => node instanceof Element && node.matches(selector));
  const activeEditor = document.activeElement instanceof Element && document.activeElement.matches(selector);
  return eventComesFromEditor || activeEditor;
}

document.addEventListener("keydown", (event) => {
  if (isTextEntryKey(event)) return;
  const item = state.items[state.selected];
  if (event.key === "j") {
    event.preventDefault(); void moveForward();
  } else if (event.key === "k") {
    event.preventDefault(); moveBackward();
  } else if (event.code === "Space" && item?.processingState !== "failed") {
    event.preventDefault(); setMode(state.mode === "deep" ? "fast" : "deep"); renderReader();
  } else if (event.key === "/") {
    event.preventDefault(); document.querySelector("#search").focus();
  } else if (event.key === "s" && item) {
    const before = item.isSaved; item.isSaved = !before; renderList();
    executeOperation("article.save", { articleId: item.id, saved: item.isSaved }).then(loadDashboard).catch(() => { item.isSaved = before; renderList(); });
  } else if (event.key === "i" && item) {
    toggleInterest(item);
  } else if (event.key === "u" && item) {
    const before = item.isRead; item.isRead = !before; renderList();
    const nextId = state.items[state.selected + 1]?.id ?? state.items[state.selected - 1]?.id ?? null;
    executeOperation("article.read", { articleId: item.id, read: item.isRead }).then(async () => {
      await loadDashboard();
      if (state.hideRead && item.isRead) await loadItems(document.querySelector("#search").value.trim(), true, nextId);
    }).catch(() => { item.isRead = before; renderList(); });
  } else if (event.key === "t" && item) {
    const before = item.translationStatus; item.translationStatus = "pending"; renderList(); renderReader();
    executeOperation("article.translate", { articleId: item.id }).catch(() => { item.translationStatus = before; renderList(); renderReader(); });
  } else if (event.key === "o" && item?.url) open(item.url, "_blank", "noopener,noreferrer");
});

const searchInput = document.querySelector("#search");
searchInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") { event.preventDefault(); state.view = "reader"; loadItems(searchInput.value); }
});
document.querySelector("#filter-all").onclick = (event) => { state.filter = { type: "all" }; state.view = "reader"; activateFilter(event.currentTarget); loadItems(); };
document.querySelector("#filter-pending").onclick = (event) => { state.filter = { type: "pending" }; state.view = "reader"; activateFilter(event.currentTarget); loadItems(); };
document.querySelector("#filter-failed").onclick = (event) => { state.filter = { type: "failed" }; state.view = "reader"; activateFilter(event.currentTarget); loadItems(); };
document.querySelector("#filter-analysis_failed").onclick = (event) => { state.filter = { type: "analysis_failed" }; state.view = "reader"; activateFilter(event.currentTarget); loadItems(); };
document.querySelector("#filter-saved").onclick = (event) => { state.filter = { type: "saved" }; state.view = "reader"; activateFilter(event.currentTarget); loadItems(); };
document.querySelector("#filter-interested").onclick = (event) => { state.filter = { type: "interested" }; state.view = "reader"; activateFilter(event.currentTarget); loadItems(); };
document.querySelector("#filter-recommended").onclick = (event) => { state.filter = { type: "recommended" }; state.view = "reader"; activateFilter(event.currentTarget); loadItems(); };
hideRead.addEventListener("change", () => {
  state.hideRead = hideRead.checked;
  localStorage.setItem("newzsnac.hideRead", String(state.hideRead));
  document.querySelector("#stream-error").textContent = "";
  void loadItems(document.querySelector("#search").value.trim(), true);
});
document.querySelector("#new-count").onclick = (event) => { event.currentTarget.hidden = true; state.view = "reader"; loadItems(); };
document.querySelector(".discover").addEventListener("click", showSourceManager);
new ResizeObserver(renderList).observe(list);
await Promise.all([loadDashboard(), loadItems()]);
setInterval(async () => {
  await loadDashboard();
  if (state.view === "reader" && !searchInput.value) await loadItems("", true);
}, 10_000);
