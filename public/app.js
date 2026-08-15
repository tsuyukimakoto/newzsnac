const ROW_HEIGHT = 116;
const state = {
  items: [], selected: 0, mode: "fast", start: 0, end: 0,
  loading: false, filter: { type: "all" }, view: "reader", total: null,
};
const list = document.querySelector("#article-list");
const spacer = document.querySelector("#article-spacer");
const reader = document.querySelector("#reader");

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

function statusLabel(item) {
  if (item.extractionStatus === "failed") return '<span class="badge failed">本文取得失敗</span>';
  if (item.translationStatus === "ready") return '<span class="badge ready">翻訳済み</span>';
  if (item.translationStatus === "pending") return '<span class="badge">翻訳中</span>';
  if (!item.summary) return '<span class="badge">要約準備中</span>';
  return "";
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
    card.className = `article-card ${index === state.selected ? "selected" : ""} ${item.isRead ? "read" : ""}`;
    card.style.transform = `translateY(${index * ROW_HEIGHT}px)`;
    card.setAttribute("role", "option");
    card.setAttribute("aria-selected", String(index === state.selected));
    card.innerHTML = `<div class="card-top"><span>${escapeHtml(item.source || "SOURCE")} · <time class="publication" datetime="${escapeHtml(item.publishedAt || "")}">${escapeHtml(formatPublishedAt(item.publishedAt))}</time></span>${statusLabel(item)}</div><h2>${escapeHtml(item.title)}</h2><p>${escapeHtml(item.summary || "要約を作成しています…")}</p>`;
    card.onclick = () => select(index);
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
  const heading = `<div class="kicker">${escapeHtml(item.source || "ARTICLE")} · <time datetime="${escapeHtml(item.publishedAt || "")}">${escapeHtml(published)}</time></div><h1>${escapeHtml(item.title)}</h1><div class="byline">${escapeHtml(item.author || "著者不明")}　／　公開 ${escapeHtml(published)}</div>`;
  if (state.mode === "deep") {
    reader.innerHTML = `<div class="reader-content deep-reading">${heading}${item.summary ? `<div class="summary compact">${escapeHtml(item.summary)}</div>` : ""}<div class="body article-body">${escapeHtml(item.content || "保存済み本文はありません。").replace(/\n/g, "<br>")}</div><div class="status-line">${statusLabel(item) || "ローカルに保存済み"}</div></div>`;
    return;
  }
  const labels = (item.labels || []).map((label) => `<span>${escapeHtml(label)}</span>`).join("");
  const reasons = (item.reasons || []).map((reason) => `<li>${escapeHtml(reason)}</li>`).join("");
  const analysis = item.summary
    ? `<section class="reader-summary"><div class="section-label">SUMMARY</div><p>${escapeHtml(item.summary)}</p></section><section class="reader-points"><div class="section-label">KEY POINTS</div>${reasons ? `<ol>${reasons}</ol>` : "<p>判断ポイントはありません。</p>"}</section>${labels ? `<div class="reader-labels">${labels}</div>` : ""}`
    : `<section class="analysis-pending"><span class="pending-mark">◌</span><div><div class="section-label">ANALYSIS</div><h2>要約を準備しています</h2><p>分析が完了すると、ここに要約とポイントを表示します。全文は <kbd>Space</kbd> で確認できます。</p></div></section>`;
  reader.innerHTML = `<div class="reader-content fast-reading">${heading}${analysis}<button class="deep-mode-button" type="button">全文を読む <kbd>Space</kbd></button><div class="status-line">${statusLabel(item) || "分析済み"}</div></div>`;
  reader.querySelector(".deep-mode-button").onclick = () => { setMode("deep"); renderReader(); };
}

function select(index) {
  state.view = "reader";
  state.selected = Math.max(0, Math.min(state.items.length - 1, index));
  renderList();
  renderReader();
  document.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
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

async function loadItems(query = "", preservePosition = false) {
  if (state.loading) return;
  state.loading = true;
  try {
    const url = new URL("/api/items", location.origin);
    if (query) url.searchParams.set("q", query);
    if (!query && state.filter.type === "source") url.searchParams.set("sourceId", state.filter.id);
    if (!query && state.filter.type === "saved") url.searchParams.set("saved", "true");
    const response = await fetch(url);
    const data = await response.json();
    const selectedId = preservePosition ? state.items[state.selected]?.id : null;
    const scrollTop = list.scrollTop;
    state.items = data.items || [];
    state.selected = selectedId ? Math.max(0, state.items.findIndex((item) => item.id === selectedId)) : 0;
    list.scrollTop = preservePosition ? scrollTop : 0;
    document.querySelector("#empty").hidden = state.items.length > 0;
    renderList();
    renderReader();
  } finally {
    state.loading = false;
  }
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
    ? `SQLite · LM Studio (${runtime.activeModel || runtime.configuredModel})`
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
document.addEventListener("keydown", (event) => {
  const input = event.target.closest?.("input,textarea,select,[contenteditable=true]");
  if (input) { if (event.key === "Escape") input.blur(); return; }
  const item = state.items[state.selected];
  if (event.key === "j") {
    event.preventDefault();
    if (item && !item.isRead) {
      item.isRead = true;
      executeOperation("article.read", { articleId: item.id, read: true }).then(loadDashboard).catch(() => { item.isRead = false; renderList(); });
    }
    select(state.selected + 1);
  } else if (event.key === "k") {
    event.preventDefault(); select(state.selected - 1);
  } else if (event.code === "Space") {
    event.preventDefault(); setMode(state.mode === "deep" ? "fast" : "deep"); renderReader();
  } else if (event.key === "/") {
    event.preventDefault(); document.querySelector("#search").focus();
  } else if (event.key === "s" && item) {
    const before = item.isSaved; item.isSaved = !before; renderList();
    executeOperation("article.save", { articleId: item.id, saved: item.isSaved }).then(loadDashboard).catch(() => { item.isSaved = before; renderList(); });
  } else if (event.key === "u" && item) {
    const before = item.isRead; item.isRead = !before; renderList();
    executeOperation("article.read", { articleId: item.id, read: item.isRead }).then(loadDashboard).catch(() => { item.isRead = before; renderList(); });
  } else if (event.key === "t" && item) {
    const before = item.translationStatus; item.translationStatus = "pending"; renderList(); renderReader();
    executeOperation("article.translate", { articleId: item.id }).catch(() => { item.translationStatus = before; renderList(); renderReader(); });
  } else if (event.key === "o" && item?.url) open(item.url, "_blank", "noopener");
});

const searchInput = document.querySelector("#search");
searchInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") { event.preventDefault(); state.view = "reader"; loadItems(searchInput.value); }
});
document.querySelector("#filter-all").onclick = (event) => { state.filter = { type: "all" }; state.view = "reader"; activateFilter(event.currentTarget); loadItems(); };
document.querySelector("#filter-saved").onclick = (event) => { state.filter = { type: "saved" }; state.view = "reader"; activateFilter(event.currentTarget); loadItems(); };
document.querySelector("#new-count").onclick = (event) => { event.currentTarget.hidden = true; state.view = "reader"; loadItems(); };
document.querySelector(".discover").addEventListener("click", showSourceManager);
new ResizeObserver(renderList).observe(list);
await Promise.all([loadDashboard(), loadItems()]);
setInterval(async () => {
  await loadDashboard();
  if (state.view === "reader" && !searchInput.value) await loadItems("", true);
}, 10_000);
