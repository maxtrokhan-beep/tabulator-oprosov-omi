const state = {
  meta: null,
  config: {
    var_types: {},
    scale_maps: {},
    top2: {},
    multi_groups: [],
  },
  lastResult: null,
  hasWeight: false,
  scaleEditingVar: null,
};

function $(id) {
  return document.getElementById(id);
}

function setStatus(msg) {
  $("status").textContent = msg || "";
}

function showScreen(name) {
  const map = {
    upload: "screen-upload",
    vars: "screen-vars",
    tab: "screen-tab",
  };
  for (const k of Object.values(map)) {
    $(k).classList.add("hidden");
  }
  $(map[name]).classList.remove("hidden");

  for (const btn of document.querySelectorAll(".tab")) {
    btn.classList.toggle("active", btn.dataset.screen === name);
  }
}

async function apiJson(url, opts = {}) {
  const res = await fetch(url, {
    credentials: "include",
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.detail || data.error || "Ошибка запроса");
  }
  return data;
}

async function uploadFile() {
  const file = $("file").files?.[0];
  if (!file) return alert("Выберите файл .xlsx или .csv");

  setStatus("Загружаю файл...");
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch("/api/upload", {
    method: "POST",
    credentials: "include",
    body: fd,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    setStatus("");
    return alert(data.detail || "Ошибка загрузки");
  }

  state.hasWeight = !!data.has_weight;
  $("upload-result").innerHTML =
    `Файл загружен: <b>${data.filename || file.name}</b>. Переменных: <b>${data.variables?.length || 0}</b>.` +
    (state.hasWeight ? ` Найдена переменная <code>weight</code>.` : "");

  await loadMetadata();
  showScreen("vars");
  setStatus("");
}

function defaultVarType(varName) {
  if (String(varName).trim().toLowerCase() === "weight") return "service";
  return "categorical";
}

function renderVarsTable() {
  const tbody = $("vars-table").querySelector("tbody");
  tbody.innerHTML = "";

  const q = ($("var-search").value || "").toLowerCase().trim();
  const vars = state.meta?.variables || [];

  for (const v of vars) {
    const text = `${v.name} ${v.question || ""}`.toLowerCase();
    if (q && !text.includes(q)) continue;

    const tr = document.createElement("tr");

    const uniqPreview = (v.unique_values || []).slice(0, 8).map(String).join(", ");
    const uniqMore = (v.unique_count || 0) > 8 ? ` … (+${v.unique_count - 8})` : "";

    const type = state.config.var_types[v.name] || defaultVarType(v.name);
    state.config.var_types[v.name] = type;

    tr.innerHTML = `
      <td><b>${escapeHtml(v.name)}</b></td>
      <td>${escapeHtml(v.question || "")}</td>
      <td><small>${escapeHtml(uniqPreview + uniqMore)}</small></td>
      <td>
        <select data-var="${escapeAttr(v.name)}" class="input" style="min-width: 180px;">
          <option value="categorical">Категориальная</option>
          <option value="scale">Шкальная</option>
          <option value="service">Служебная</option>
        </select>
      </td>
      <td>
        <button class="btn" data-scale="${escapeAttr(v.name)}">Шкала/Top‑2</button>
      </td>
    `;

    const sel = tr.querySelector("select");
    sel.value = type;
    sel.addEventListener("change", (e) => {
      state.config.var_types[v.name] = e.target.value;
      renderListsForTabulation();
      renderMcCols();
    });

    const btn = tr.querySelector("button[data-scale]");
    btn.disabled = (sel.value !== "scale");
    sel.addEventListener("change", () => (btn.disabled = (sel.value !== "scale")));
    btn.addEventListener("click", () => openScaleModal(v.name));

    tbody.appendChild(tr);
  }
}

function renderMcCols() {
  const box = $("mc-cols");
  box.innerHTML = "";
  const vars = state.meta?.variables || [];

  for (const v of vars) {
    const t = state.config.var_types[v.name] || defaultVarType(v.name);
    if (t === "service") continue;
    // для MVP разрешаем выбирать любые колонки как варианты
    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `<label><input type="checkbox" data-mc-col="${escapeAttr(v.name)}" /> ${escapeHtml(v.name)}</label>`;
    box.appendChild(div);
  }
}

function suggestMcByPrefix() {
  const name = ($("mc-name").value || "").trim();
  if (!name) return alert("Введите имя группы, например Q5");
  const prefix = name + "_";
  for (const cb of document.querySelectorAll("input[data-mc-col]")) {
    cb.checked = cb.dataset.mcCol?.startsWith(prefix) || cb.getAttribute("data-mc-col")?.startsWith(prefix);
  }
}

function addMcGroup() {
  const name = ($("mc-name").value || "").trim();
  if (!name) return alert("Имя группы обязательно (например Q5)");
  const question = ($("mc-question").value || "").trim();
  const cols = [];
  for (const cb of document.querySelectorAll("input[data-mc-col]")) {
    if (cb.checked) cols.push(cb.getAttribute("data-mc-col"));
  }
  if (cols.length < 2) return alert("Выберите минимум 2 колонки для множественного выбора.");

  // помечаем как multi (псевдо-вопрос), сами колонки оставляем как service, чтобы не дублировались в строках
  for (const c of cols) state.config.var_types[c] = "service";

  state.config.multi_groups = (state.config.multi_groups || []).filter((g) => g.name !== name);
  state.config.multi_groups.push({ name, question, columns: cols });

  renderMcGroups();
  renderVarsTable();
  renderListsForTabulation();
  renderMcCols();
}

function renderMcGroups() {
  const box = $("mc-groups");
  const groups = state.config.multi_groups || [];
  if (!groups.length) {
    box.textContent = "Пока нет групп.";
    return;
  }
  box.innerHTML = "";
  for (const g of groups) {
    const div = document.createElement("div");
    div.className = "pill";
    div.innerHTML = `<b>${escapeHtml(g.name)}</b> (${g.columns.length} кол.)`;
    div.title = (g.columns || []).join(", ");
    box.appendChild(div);
  }
}

function clearMcGroups() {
  if (!confirm("Удалить все группы множественного выбора?")) return;
  state.config.multi_groups = [];
  // не пытаемся восстановить типы колонок — пользователь может заново выставить
  renderMcGroups();
  renderVarsTable();
  renderListsForTabulation();
}

function openScaleModal(varName) {
  state.scaleEditingVar = varName;
  $("scale-modal-title").textContent = `Шкала: ${varName}`;
  $("scale-modal").classList.remove("hidden");

  const v = state.meta.variables.find((x) => x.name === varName);
  const uniq = (v?.unique_values || []).slice(0, 50).map(String);

  const smap = state.config.scale_maps[varName] || {};
  const top = state.config.top2[varName] || { mode: "top_n", n: 2, values: [] };

  const box = $("scale-map");
  box.innerHTML = "";
  for (const lab of uniq) {
    const row = document.createElement("div");
    row.className = "kv";
    row.innerHTML = `
      <div class="k">${escapeHtml(lab)}</div>
      <div><input class="input" data-scale-label="${escapeAttr(lab)}" value="${escapeAttr(smap[lab] ?? "")}" placeholder="код" /></div>
    `;
    box.appendChild(row);
  }

  // Top-2
  document.querySelectorAll("input[name=top2mode]").forEach((r) => (r.checked = r.value === top.mode));
  $("top2-n").value = top.n || 2;
  $("top2-manual").value = (top.values || []).join(",");
}

function closeScaleModal() {
  $("scale-modal").classList.add("hidden");
  state.scaleEditingVar = null;
}

function saveScaleModal() {
  const varName = state.scaleEditingVar;
  if (!varName) return;

  const smap = {};
  document.querySelectorAll("input[data-scale-label]").forEach((inp) => {
    const lab = inp.getAttribute("data-scale-label");
    const val = (inp.value || "").trim();
    if (!val) return;
    const num = Number(val.replace(",", "."));
    if (!Number.isFinite(num)) return;
    smap[lab] = num;
  });
  state.config.scale_maps[varName] = smap;

  const mode = document.querySelector("input[name=top2mode]:checked")?.value || "top_n";
  const n = Number($("top2-n").value || "2");
  const manual = ($("top2-manual").value || "")
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isFinite(x));

  state.config.top2[varName] = {
    mode,
    n: Number.isFinite(n) && n > 0 ? n : 2,
    values: manual,
  };

  closeScaleModal();
}

// Делаем функции доступными из HTML-атрибутов (на случай CSP/особенностей браузера)
window.closeScaleModal = closeScaleModal;
window.saveScaleModal = saveScaleModal;

async function loadMetadata() {
  setStatus("Читаю метаданные...");
  const data = await apiJson("/api/metadata");
  state.meta = data.meta;
  state.hasWeight = !!data.meta?.has_weight;

  // если config уже был сохранен на backend, подтянем
  if (data.config) {
    state.config = {
      var_types: data.config.var_types || {},
      scale_maps: data.config.scale_maps || {},
      top2: data.config.top2 || {},
      multi_groups: data.config.multi_groups || [],
    };
  }

  // проставим дефолты
  for (const v of state.meta.variables) {
    if (!state.config.var_types[v.name]) state.config.var_types[v.name] = defaultVarType(v.name);
  }

  renderVarsTable();
  renderMcCols();
  renderMcGroups();
  renderListsForTabulation();

  $("btn-run-w").disabled = !state.hasWeight;
  setStatus("");
}

async function saveConfig() {
  setStatus("Сохраняю настройки...");
  await apiJson("/api/config", {
    method: "POST",
    body: JSON.stringify(state.config),
  });
  setStatus("Настройки сохранены.");
  setTimeout(() => setStatus(""), 1200);
  showScreen("tab");
}

function renderListsForTabulation() {
  const rowsBox = $("rows-list");
  const bannersBox = $("banners-list");
  rowsBox.innerHTML = "";
  bannersBox.innerHTML = "";

  const vars = state.meta?.variables || [];

  // строки: любые не-service + псевдо вопросы multi_groups
  const rowItems = [];
  for (const v of vars) {
    const t = state.config.var_types[v.name] || defaultVarType(v.name);
    if (t === "service") continue;
    rowItems.push({ id: v.name, label: `${v.name} — ${(v.question || "").slice(0, 70)}` });
  }
  for (const g of state.config.multi_groups || []) {
    rowItems.push({ id: g.name, label: `${g.name} — ${g.question || "множественный выбор"}` });
  }

  const bannerItems = [];
  for (const v of vars) {
    const t = state.config.var_types[v.name] || defaultVarType(v.name);
    if (t === "service") continue;
    bannerItems.push({ id: v.name, label: `${v.name} — ${(v.question || "").slice(0, 70)}` });
  }

  for (const it of rowItems) {
    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `<label><input type="checkbox" data-row="${escapeAttr(it.id)}" /> ${escapeHtml(it.label)}</label>`;
    rowsBox.appendChild(div);
  }
  for (const it of bannerItems) {
    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `<label><input type="checkbox" data-banner="${escapeAttr(it.id)}" /> ${escapeHtml(it.label)}</label>`;
    bannersBox.appendChild(div);
  }
}

function addFilterRow() {
  const box = $("filters");
  const vars = (state.meta?.variables || [])
    .map((v) => v.name)
    .filter((n) => (state.config.var_types[n] || defaultVarType(n)) !== "service");

  const row = document.createElement("div");
  row.className = "row";
  row.style.marginBottom = "8px";
  row.innerHTML = `
    <select class="input" style="max-width: 240px;">
      ${vars.map((v) => `<option value="${escapeAttr(v)}">${escapeHtml(v)}</option>`).join("")}
    </select>
    <input class="input" placeholder="Значения для включения (через запятую), как в данных" />
    <button class="btn danger">Удалить</button>
  `;
  row.querySelector("button").addEventListener("click", () => row.remove());
  box.appendChild(row);
}

function collectPayload(weighted) {
  const row_vars = [];
  document.querySelectorAll("input[data-row]").forEach((cb) => {
    if (cb.checked) row_vars.push(cb.getAttribute("data-row"));
  });
  const banner_vars = [];
  document.querySelectorAll("input[data-banner]").forEach((cb) => {
    if (cb.checked) banner_vars.push(cb.getAttribute("data-banner"));
  });

  const filters = [];
  $("filters").querySelectorAll(".row").forEach((row) => {
    const sel = row.querySelector("select");
    const inp = row.querySelector("input");
    if (!sel || !inp) return;
    const varName = sel.value;
    const include = (inp.value || "")
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x.length);
    if (!include.length) return;
    filters.push({ var: varName, include });
  });

  const show_sig = !!$("show-sig").checked;
  return { row_vars, banner_vars, filters, weighted: !!weighted, show_sig };
}

function renderResultTable(result) {
  const cols = result.columns || [];
  const rows = result.rows || [];

  const table = document.createElement("table");
  table.className = "table";

  const thead = document.createElement("thead");
  const hr = document.createElement("tr");
  hr.innerHTML = `<th>Показатель</th>` + cols.map((c) => {
    const letter = c.letter ? `<div class="muted small">${escapeHtml(c.letter)}</div>` : "";
    return `<th>${escapeHtml(c.label)}${letter}</th>`;
  }).join("");
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const r of rows) {
    const tr = document.createElement("tr");
    if (r.kind === "header") {
      tr.innerHTML = `<td><b>${escapeHtml(r.label || "")}</b></td>` + cols.map(() => "<td></td>").join("");
      tbody.appendChild(tr);
      continue;
    }
    if (r.kind === "base") {
      const base = r.base || {};
      tr.innerHTML = `<td><i>${escapeHtml(r.label || "База")}</i></td>` + cols.map((c) => `<td>${escapeHtml(String(base[c.key] ?? ""))}</td>`).join("");
      tbody.appendChild(tr);
      continue;
    }
    const cells = r.cells || {};
    tr.innerHTML = `<td>${escapeHtml(r.label || "")}</td>` + cols.map((c) => {
      const cell = cells[c.key] || {};
      const v = cell.value;
      const sig = cell.sig ? ` <span class="muted small">${escapeHtml(cell.sig)}</span>` : "";
      if (v == null || (typeof v === "number" && Number.isNaN(v))) return `<td></td>`;
      if (r.kind === "mean") return `<td>${escapeHtml(trimMean(v))}${sig}</td>`;
      return `<td>${escapeHtml(trimPct(v))}${sig}</td>`;
    }).join("");
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  const wrap = $("result");
  wrap.innerHTML = "";
  wrap.appendChild(table);

  const note = result.meta?.note || "";
  $("tab-note").textContent = note;
}

function trimPct(v) {
  const p = Number(v);
  if (!Number.isFinite(p)) return "";
  return `${Math.round(p * 100)}%`;
}

function trimMean(v) {
  const x = Number(v);
  if (!Number.isFinite(x)) return "";
  const s = x.toFixed(2);
  return s.replace(/\.?0+$/, "");
}

async function runTabulation(weighted) {
  const payload = collectPayload(weighted);
  if (!payload.row_vars.length) return alert("Выберите хотя бы один вопрос для строк.");
  setStatus("Считаю таблицу...");
  const data = await apiJson("/api/tabulate", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  state.lastResult = data.result;
  renderResultTable(state.lastResult);
  $("btn-export").disabled = false;
  setStatus("");
}

async function exportExcel(weighted) {
  const payload = collectPayload(weighted);
  if (!payload.row_vars.length) return alert("Выберите хотя бы один вопрос для строк.");

  setStatus("Готовлю Excel...");
  const res = await fetch("/api/export", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, title: "Табуляция" }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    setStatus("");
    return alert(data.detail || "Ошибка экспорта");
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "tabulation.xlsx";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  setStatus("");
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
function escapeAttr(s) {
  return escapeHtml(s).replaceAll("`", "");
}

window.addEventListener("DOMContentLoaded", () => {
  // Tabs
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => showScreen(btn.dataset.screen));
  });

  // Upload
  $("btn-upload").addEventListener("click", uploadFile);

  // Vars
  $("btn-load-meta").addEventListener("click", loadMetadata);
  $("btn-save-config").addEventListener("click", saveConfig);
  $("var-search").addEventListener("input", renderVarsTable);

  // Multi
  $("btn-mc-suggest").addEventListener("click", suggestMcByPrefix);
  $("btn-mc-add").addEventListener("click", addMcGroup);
  $("btn-mc-clear").addEventListener("click", clearMcGroups);

  // Scale modal
  $("btn-scale-close").addEventListener("click", closeScaleModal);
  $("btn-scale-save").addEventListener("click", saveScaleModal);
  $("scale-modal").addEventListener("click", (e) => {
    if (e.target?.id === "scale-modal") closeScaleModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeScaleModal();
  });

  // Filters
  $("btn-filter-add").addEventListener("click", addFilterRow);

  // Run / export
  $("btn-run-unw").addEventListener("click", () => runTabulation(false));
  $("btn-run-w").addEventListener("click", () => runTabulation(true));
  $("btn-export").addEventListener("click", () => {
    // экспортим в режиме последнего расчета, если он был, иначе — по текущему выбору (невзвешенно)
    const weighted = state.lastResult?.meta?.weighted ?? false;
    exportExcel(weighted);
  });

  // initial
  showScreen("upload");
  setStatus("Готово. Загрузите файл.");
});

