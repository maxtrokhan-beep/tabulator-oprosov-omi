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
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  if (!res.ok || data.ok === false) {
    const detail = data.detail || data.error || (text && text.slice(0, 500)) || "Ошибка запроса";
    throw new Error(`${detail} (HTTP ${res.status})`);
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
    `;

    const sel = tr.querySelector("select");
    sel.value = type;
    sel.addEventListener("change", (e) => {
      state.config.var_types[v.name] = e.target.value;
      renderListsForTabulation();
      renderMcCols();
      renderScaleMappings();
    });

    tbody.appendChild(tr);
  }
  void renderScaleMappings();
}

function _hasUserScaleCode(sm, mapKey) {
  const x = sm[mapKey];
  return x !== undefined && x !== null && x !== "" && Number.isFinite(Number(x));
}

function invertScaleCodes(varName) {
  const sm = state.config.scale_maps[varName];
  if (!sm || !Object.keys(sm).length) {
    alert("Нет кодов для инверсии. Дождитесь загрузки шкалы или введите коды вручную.");
    return;
  }
  const nums = Object.values(sm)
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x));
  if (!nums.length) {
    alert("Нет числовых кодов.");
    return;
  }
  const minC = Math.min(...nums);
  const maxC = Math.max(...nums);
  if (minC === maxC) {
    alert("Нужны как минимум два разных кода для инверсии (например 1 и 5).");
    return;
  }
  for (const k of Object.keys(sm)) {
    const c = Number(sm[k]);
    if (Number.isFinite(c)) sm[k] = minC + maxC - c;
  }
  void renderScaleMappings();
}

async function renderScaleMappings() {
  const box = $("scale-mappings");
  if (!box) return;
  box.innerHTML = "";

  const vars = state.meta?.variables || [];
  const scaleVars = vars.filter((v) => (state.config.var_types[v.name] || defaultVarType(v.name)) === "scale");
  if (!scaleVars.length) {
    box.innerHTML =
      '<p class="muted small">Нет шкальных переменных. Выберите тип «Шкальная» в таблице выше.</p>';
    return;
  }

  for (const v of scaleVars) {
    const wrap = document.createElement("div");
    wrap.className = "card inner";
    wrap.style.marginTop = "10px";

    const h = document.createElement("h4");
    h.textContent = `${v.name} — ${(v.question || "").slice(0, 140)}`;
    wrap.appendChild(h);

    const toolbar = document.createElement("div");
    toolbar.className = "row";
    const btnInv = document.createElement("button");
    btnInv.type = "button";
    btnInv.className = "btn";
    btnInv.textContent = "Инвертировать коды (min ↔ max)";
    btnInv.title =
      "Для всех заданных кодов: новый код = min + max − старый (для шкалы 1…5 это 1↔5, 2↔4).";
    btnInv.addEventListener("click", () => invertScaleCodes(v.name));
    toolbar.appendChild(btnInv);
    wrap.appendChild(toolbar);

    const status = document.createElement("p");
    status.className = "muted small";
    status.textContent = "Загрузка вариантов ответа…";
    wrap.appendChild(status);

    const tbl = document.createElement("table");
    tbl.className = "table";
    tbl.innerHTML =
      "<thead><tr><th>Ответ (как в базе)</th><th>Код</th></tr></thead><tbody></tbody>";
    wrap.appendChild(tbl);
    box.appendChild(wrap);

    try {
      const data = await apiJson(`/api/scale-values?var=${encodeURIComponent(v.name)}`);
      if (!state.config.scale_maps[v.name]) state.config.scale_maps[v.name] = {};
      const sm = state.config.scale_maps[v.name];

      const entries = data.entries || [];
      if (!entries.length) {
        status.textContent = "Нет уникальных значений.";
        continue;
      }

      const manual = {};
      for (const k of Object.keys(sm)) {
        const n = Number(sm[k]);
        if (Number.isFinite(n)) manual[k] = n;
      }

      const effRes = await apiJson("/api/scale-effective-map", {
        method: "POST",
        body: JSON.stringify({ var: v.name, manual }),
      });
      const eff = effRes.effective || {};

      for (const e of entries) {
        if (!e.needs_map || !e.map_key) continue;
        const mk = e.map_key;
        if (!_hasUserScaleCode(sm, mk) && eff[mk] !== undefined && eff[mk] !== null) {
          sm[mk] = eff[mk];
        }
      }

      status.textContent = "";
      const tbody = tbl.querySelector("tbody");
      tbody.innerHTML = "";

      for (const e of entries) {
        const tr = document.createElement("tr");
        if (!e.needs_map) {
          tr.innerHTML = `<td><small>${escapeHtml(e.display)}</small></td><td class="muted">число в данных</td>`;
        } else {
          const mk = e.map_key;
          const cur = _hasUserScaleCode(sm, mk) ? sm[mk] : "";
          tr.innerHTML = `<td>${escapeHtml(e.display)}</td><td><input type="number" step="any" class="input" style="max-width: 140px" data-scale-var="${escapeAttr(
            v.name
          )}" data-scale-key="${escapeAttr(mk)}" value="${escapeAttr(String(cur))}" /></td>`;
          const inp = tr.querySelector("input");
          inp.addEventListener("change", () => {
            const raw = String(inp.value || "").trim().replace(",", ".");
            if (raw === "") {
              delete sm[mk];
              return;
            }
            const num = Number(raw);
            if (!Number.isFinite(num)) {
              delete sm[mk];
            } else {
              sm[mk] = num;
            }
          });
        }
        tbody.appendChild(tr);
      }
    } catch (err) {
      status.textContent = err.message || String(err);
    }
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
    rowItems.push({ id: v.name, label: `${v.name} — ${v.question || ""}` });
  }
  for (const g of state.config.multi_groups || []) {
    rowItems.push({ id: g.name, label: `${g.name} — ${g.question || "множественный выбор"}` });
  }

  const bannerItems = [];
  // Для колонок разрешаем и исходные сервисные колонки (кроме weight),
  // и сгруппированные вопросы множественного выбора.
  for (const v of vars) {
    if (String(v.name).toLowerCase() === "weight") continue;
    bannerItems.push({ id: v.name, label: `${v.name} — ${v.question || ""}` });
  }
  for (const g of state.config.multi_groups || []) {
    bannerItems.push({ id: g.name, label: `${g.name} — ${g.question || "множественный выбор"}` });
  }

  for (const it of rowItems) {
    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `<label title="${escapeAttr(it.label)}"><input type="checkbox" data-row="${escapeAttr(it.id)}" /> <span class="var-label-text">${escapeHtml(it.label)}</span></label>`;
    rowsBox.appendChild(div);
  }
  for (const it of bannerItems) {
    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `<label title="${escapeAttr(it.label)}"><input type="checkbox" data-banner="${escapeAttr(it.id)}" /> <span class="var-label-text">${escapeHtml(it.label)}</span></label>`;
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

  const btnUnw = $("btn-run-unw");
  const btnW = $("btn-run-w");
  const btnExport = $("btn-export");
  btnUnw.disabled = true;
  btnW.disabled = btnW.disabled || false; // не меняем, если weight недоступен
  btnExport.disabled = true;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000); // 2 минуты

  try {
    setStatus("Считаю таблицу...");
    const data = await apiJson("/api/tabulate", {
      method: "POST",
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    state.lastResult = data.result;
    renderResultTable(state.lastResult);
    btnExport.disabled = false;
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    alert(`Не удалось построить таблицу:\n${msg}`);
  } finally {
    clearTimeout(timeout);
    btnUnw.disabled = false;
    // btnW включаем только если weight есть
    btnW.disabled = !state.hasWeight;
    setStatus("");
  }
}

async function exportExcel(weighted) {
  const payload = collectPayload(weighted);
  if (!payload.row_vars.length) return alert("Выберите хотя бы один вопрос для строк.");

  const btnExport = $("btn-export");
  btnExport.disabled = true;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000); // 2 минуты

  try {
    setStatus("Готовлю Excel...");
    const res = await fetch("/api/export", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, title: "Табуляция" }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.detail || "Ошибка экспорта");
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
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    alert(`Не удалось скачать Excel:\n${msg}`);
  } finally {
    clearTimeout(timeout);
    btnExport.disabled = false;
    setStatus("");
  }
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

