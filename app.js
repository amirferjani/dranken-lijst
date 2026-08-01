const STORAGE_KEY = "frigo-ai-state-v3";
const PIN_KEY = "frigo-ai-pin";
const MAX_PHOTOS = 20;
const MAX_PRODUCTS = 300;
const MAX_IMAGE_BINARY_BYTES = 2_500_000;
const MAX_REQUEST_BYTES = 3_900_000;
const MAX_TICKET_ITEMS = 150;

const DEFAULT_PRODUCTS = [
  "Carlsberg Green Label",
  "Gentse Strop",
  "Desperados",
  "Fourchette",
  "Omer",
  "Gulden Draak",
  "Westmalle Dubbel",
  "Westmalle Tripel"
];

const LEGACY_PRODUCT_NAMES = new Map([
  ["carlsberg", "Carlsberg Green Label"],
  ["desperados original", "Desperados"],
  ["gulden draak classic", "Gulden Draak"]
]);

const defaultState = () => ({
  version: 3,
  fridges: [
    {
      id: crypto.randomUUID(),
      name: "Barfrigo 1",
      products: DEFAULT_PRODUCTS.map((name) => ({ catalogId: "", name, category: "Bieren op fles", target: 0 }))
    }
  ],
  printer: {
    ip: "192.168.0.36",
    useExplicitIp: true
  },
  activeFridgeId: null
});

let state = loadState();
let checkFiles = [];
let setupFiles = [];
let checkResult = null;
let setupProducts = [];
let setupEditingId = "new";
let setupAnalysis = { warnings: [], unknown_items: [] };
let productCatalog = [];
let catalogSource = null;
let toastTimer;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function cleanText(value, maxLength = 120) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function clampInteger(value, min = 0, max = 999) {
  return Math.max(min, Math.min(max, Number.parseInt(value, 10) || 0));
}

function isValidIpv4(value) {
  const parts = String(value ?? "").trim().split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function sanitizeProduct(item) {
  const originalName = cleanText(item?.name, 120);
  const name = LEGACY_PRODUCT_NAMES.get(originalName.toLocaleLowerCase("nl")) || originalName;
  if (!name) return null;
  return {
    catalogId: cleanText(item?.catalogId || item?.catalog_id, 64),
    name,
    category: cleanText(item?.category, 100),
    target: clampInteger(item?.target)
  };
}

function sanitizeState(value) {
  const defaults = defaultState();
  if (!value || !Array.isArray(value.fridges)) return defaults;
  const ids = new Set();
  const fridges = value.fridges.slice(0, 50).map((item) => {
    const id = cleanText(item?.id, 100) || crypto.randomUUID();
    const name = cleanText(item?.name, 100);
    if (!name || ids.has(id)) return null;
    ids.add(id);
    const seen = new Set();
    const products = (Array.isArray(item?.products) ? item.products : []).slice(0, MAX_PRODUCTS)
      .map(sanitizeProduct).filter(Boolean).filter((product) => {
        const key = product.catalogId ? `id:${product.catalogId}` : `name:${product.name.toLocaleLowerCase("nl")}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    return { id, name, products };
  }).filter(Boolean);

  const ip = cleanText(value?.printer?.ip, 64);
  return {
    version: 3,
    fridges,
    printer: {
      ip: isValidIpv4(ip) ? ip : defaults.printer.ip,
      useExplicitIp: value?.printer?.useExplicitIp !== false
    },
    activeFridgeId: fridges.some((fridge) => fridge.id === value.activeFridgeId)
      ? value.activeFridgeId
      : fridges[0]?.id || null
  };
}

function loadState() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY) || localStorage.getItem("frigo-ai-state-v2");
    return sanitizeState(stored ? JSON.parse(stored) : null);
  } catch {
    return defaultState();
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeCatalogPayload(value) {
  const products = Array.isArray(value?.products) ? value.products : [];
  const ids = new Set();
  return products.slice(0, 400).map((item) => {
    const id = cleanText(item?.id, 64);
    const name = cleanText(item?.name, 120);
    const category = cleanText(item?.category, 100);
    if (!id || !name || !category || ids.has(id)) return null;
    ids.add(id);
    return {
      id,
      name,
      category,
      aliases: [...new Set((Array.isArray(item.aliases) ? item.aliases : [])
        .map((alias) => cleanText(alias, 100)).filter(Boolean))].slice(0, 20)
    };
  }).filter(Boolean);
}

function findCatalogProduct(catalogId, name) {
  const id = cleanText(catalogId, 64);
  if (id) {
    const byId = productCatalog.find((item) => item.id === id);
    if (byId) return byId;
  }
  const key = cleanText(name, 120).toLocaleLowerCase("nl");
  if (!key) return null;
  const matches = productCatalog.filter((item) => (
    item.name.toLocaleLowerCase("nl") === key
    || item.aliases.some((alias) => alias.toLocaleLowerCase("nl") === key)
  ));
  return matches.length === 1 ? matches[0] : null;
}

function inventoryCatalogForVision() {
  return productCatalog.filter((item) => {
    const category = item.category.toLocaleLowerCase("nl");
    return !category.includes("cocktail")
      && !category.startsWith("koffie")
      && category !== "tapas"
      && !category.startsWith("bieren van");
  }).map(({ id, name, category, aliases }) => ({ id, name, category, aliases }));
}

function renderCatalogDatalist() {
  const list = $("#catalogProductNames");
  if (!list) return;
  list.innerHTML = "";
  productCatalog.forEach((product) => {
    const option = document.createElement("option");
    option.value = product.name;
    option.label = product.category;
    list.append(option);
  });
}

function reconcileCatalogReferences() {
  let changed = false;
  state.fridges.forEach((fridge) => {
    fridge.products.forEach((product) => {
      const match = findCatalogProduct(product.catalogId, product.name);
      if (!match) return;
      if (product.catalogId !== match.id || product.name !== match.name || product.category !== match.category) {
        product.catalogId = match.id;
        product.name = match.name;
        product.category = match.category;
        changed = true;
      }
    });
  });
  if (changed) saveState();
}

function setCatalogStatus(message, stateName = "") {
  const element = $("#catalogStatus");
  if (!element) return;
  element.className = `catalog-status ${stateName}`.trim();
  element.textContent = message;
}

async function loadProductCatalog() {
  setCatalogStatus("Kassalijst laden…");
  let payload;
  try {
    const response = await fetch("/api/catalog", { cache: "no-store" });
    if (!response.ok) throw new Error();
    payload = await response.json();
  } catch {
    try {
      const response = await fetch("/catalog.json", { cache: "no-store" });
      if (!response.ok) throw new Error();
      payload = await response.json();
    } catch {
      setCatalogStatus("Kassalijst kon niet worden geladen. Probeer opnieuw wanneer je online bent.", "bad");
      return;
    }
  }

  const products = normalizeCatalogPayload(payload);
  if (products.length < 200) {
    setCatalogStatus("De ontvangen kassalijst is onvolledig.", "bad");
    return;
  }
  productCatalog = products;
  catalogSource = payload.source || null;
  renderCatalogDatalist();
  reconcileCatalogReferences();
  setupProducts = setupProducts.map((product) => {
    const match = findCatalogProduct(product.catalogId, product.name);
    return match ? { ...product, catalogId: match.id, name: match.name, category: match.category } : product;
  });
  renderSetupProducts();
  $("#discoverProducts").disabled = false;
  const mode = catalogSource?.mode === "live" ? "live gesynchroniseerd" : "ingebouwde reservekopie";
  setCatalogStatus(`${productCatalog.length} kassaproducten gekoppeld · ${mode}`, "ok");
}

function showToast(message, ms = 3000) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), ms);
}

function setBusy(show, title = "Bezig…", text = "Even geduld.", progress = 12) {
  $("#busyTitle").textContent = title;
  $("#busyText").textContent = text;
  $("#busyProgress").style.width = `${Math.max(3, Math.min(100, progress))}%`;
  $("#busyModal").classList.toggle("hidden", !show);
}

function setProgress(progress, title, text) {
  if (title) $("#busyTitle").textContent = title;
  if (text) $("#busyText").textContent = text;
  $("#busyProgress").style.width = `${Math.max(3, Math.min(100, progress))}%`;
}

function switchTab(name) {
  $$(".tab").forEach((button) => button.classList.toggle("active", button.dataset.tab === name));
  $$(".panel").forEach((panel) => panel.classList.toggle("active", panel.id === `panel-${name}`));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderFridgeSelectors() {
  if (!state.activeFridgeId || !state.fridges.some((fridge) => fridge.id === state.activeFridgeId)) {
    state.activeFridgeId = state.fridges[0]?.id || null;
    saveState();
  }

  const check = $("#checkFridgeSelect");
  check.innerHTML = state.fridges.length
    ? state.fridges.map((fridge) => `<option value="${escapeHtml(fridge.id)}">${escapeHtml(fridge.name)}</option>`).join("")
    : `<option value="">Nog geen frigo</option>`;
  check.value = state.activeFridgeId || "";

  const setup = $("#setupFridgeSelect");
  setup.innerHTML = `<option value="new">+ Nieuwe frigo</option>` + state.fridges
    .map((fridge) => `<option value="${escapeHtml(fridge.id)}">Bewerk: ${escapeHtml(fridge.name)}</option>`).join("");
  setup.value = setupEditingId;

  updateCheckHint();
}

function getActiveFridge() {
  return state.fridges.find((fridge) => fridge.id === state.activeFridgeId) || null;
}

function updateCheckHint() {
  const fridge = getActiveFridge();
  const hint = $("#checkFridgeHint");
  const button = $("#analyzeCheck");
  if (!fridge) {
    hint.textContent = "Maak eerst een frigo aan bij ‘Frigo instellen’.";
    button.disabled = true;
    return;
  }
  const configured = fridge.products.filter((product) => Number(product.target) > 0).length;
  if (!configured) {
    hint.textContent = "De doelvoorraad staat nog op 0. Leer eerst een volle frigo aan of vul de aantallen handmatig in.";
    button.disabled = true;
  } else {
    hint.textContent = `${fridge.products.length} producten · ${configured} met ingestelde doelvoorraad.`;
    button.disabled = false;
  }
}

function renderPhotos(kind) {
  const files = kind === "check" ? checkFiles : setupFiles;
  const grid = $(`#${kind}PhotoGrid`);
  const summary = $(`#${kind}PhotoSummary`);
  const clear = kind === "check" ? $("#clearCheckPhotos") : null;

  summary.textContent = files.length
    ? `${files.length} foto${files.length === 1 ? "" : "’s"} geselecteerd. Maximum ${MAX_PHOTOS}.`
    : kind === "check" ? "Nog geen foto’s gekozen." : "Nog geen kalibratiefoto’s gekozen.";
  if (clear) clear.classList.toggle("hidden", !files.length);

  grid.innerHTML = "";
  files.forEach((file, index) => {
    const item = document.createElement("div");
    item.className = "photo-item";
    const image = document.createElement("img");
    image.src = URL.createObjectURL(file);
    image.alt = `Foto ${index + 1}`;
    image.onload = () => URL.revokeObjectURL(image.src);
    const remove = document.createElement("button");
    remove.className = "photo-remove";
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Verwijder foto ${index + 1}`);
    remove.addEventListener("click", () => {
      if (kind === "check") checkFiles.splice(index, 1);
      else setupFiles.splice(index, 1);
      renderPhotos(kind);
    });
    item.append(image, remove);
    grid.append(item);
  });
}

function addFiles(kind, fileList) {
  const incoming = [...fileList].filter((file) => file.type.startsWith("image/"));
  const target = kind === "check" ? checkFiles : setupFiles;
  const remaining = MAX_PHOTOS - target.length;
  if (remaining <= 0) return showToast(`Maximum ${MAX_PHOTOS} foto’s.`);
  target.push(...incoming.slice(0, remaining));
  if (incoming.length > remaining) showToast(`Alleen de eerste ${remaining} extra foto’s zijn toegevoegd.`);
  renderPhotos(kind);
}

async function compressFile(file, maxDimension, quality) {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    await image.decode();
    const largest = Math.max(image.naturalWidth, image.naturalHeight);
    const scale = Math.min(1, maxDimension / largest);
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "white";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Foto kon niet worden verkleind.")), "image/jpeg", quality);
    });
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Foto kon niet worden gelezen."));
    reader.readAsDataURL(blob);
  });
}

async function prepareImages(files) {
  if (!files.length) throw new Error("Neem of kies eerst minstens één foto.");
  let dimension = 1280;
  let quality = .70;
  let blobs = [];

  for (let i = 0; i < files.length; i++) {
    setProgress(8 + Math.round((i / files.length) * 40), "Foto’s voorbereiden…", `Foto ${i + 1} van ${files.length} verkleinen.`);
    blobs.push(await compressFile(files[i], dimension, quality));
  }

  let total = blobs.reduce((sum, blob) => sum + blob.size, 0);
  for (let pass = 0; total > MAX_IMAGE_BINARY_BYTES && pass < 4; pass++) {
    const ratio = Math.sqrt(MAX_IMAGE_BINARY_BYTES / total) * .92;
    dimension = Math.max(640, Math.floor(dimension * ratio));
    quality = Math.max(.40, quality * Math.max(.72, ratio));
    blobs = [];
    for (let i = 0; i < files.length; i++) {
      setProgress(30 + Math.round((i / files.length) * 25), "Foto’s optimaliseren…", `De set wordt kleiner gemaakt zodat alle foto’s samen kunnen worden geanalyseerd.`);
      blobs.push(await compressFile(files[i], dimension, quality));
    }
    total = blobs.reduce((sum, blob) => sum + blob.size, 0);
  }

  if (total > MAX_IMAGE_BINARY_BYTES) {
    throw new Error("Deze fotoreeks blijft te groot. Verwijder enkele foto’s en probeer opnieuw.");
  }

  const images = [];
  for (let i = 0; i < blobs.length; i++) {
    setProgress(56 + Math.round((i / blobs.length) * 12), "Foto’s klaarmaken…", `Foto ${i + 1} van ${blobs.length}.`);
    images.push(await blobToDataUrl(blobs[i]));
  }
  return images;
}

async function callAnalyze(payload) {
  const headers = { "Content-Type": "application/json" };
  const pin = localStorage.getItem(PIN_KEY) || "";
  if (pin) headers["x-app-pin"] = pin;

  setProgress(72, "AI bekijkt de frigo…", "Merken herkennen, flessen volgen over meerdere foto’s en dubbeltellingen vermijden.");
  const body = JSON.stringify(payload);
  if (new Blob([body]).size > MAX_REQUEST_BYTES) {
    throw new Error("De foto's zijn samen nog te groot. Verwijder enkele foto's en probeer opnieuw.");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 125_000);
  try {
    const response = await fetch("/api/analyze", {
      method: "POST",
      headers,
      body,
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Analyse mislukt (${response.status}).`);
    setProgress(96, "Resultaat verwerken…", "De aanvulhoeveelheden worden berekend.");
    return data;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("De AI-analyse duurde te lang. Probeer met minder foto's opnieuw.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function renderSetupProducts() {
  const root = $("#setupProductsList");
  if (!setupProducts.length) {
    root.innerHTML = `<div class="empty-state">Nog geen producten. Laat AI de volle frigo herkennen of voeg producten handmatig toe.</div>`;
    renderSetupAnalysisNotes();
    return;
  }
  root.innerHTML = setupProducts.map((product, index) => `
    <div class="product-edit-row" data-index="${index}">
      <input class="product-name" type="text" maxlength="120" list="catalogProductNames" value="${escapeHtml(product.name)}" aria-label="Productnaam" title="${escapeHtml(product.category || "Vrij product")}">
      <input class="product-target" type="number" min="0" max="999" inputmode="numeric" value="${Number(product.target) || 0}" aria-label="Doelaantal">
      <button class="remove-product" type="button" aria-label="Product verwijderen">×</button>
    </div>
  `).join("");

  root.querySelectorAll(".product-edit-row").forEach((row) => {
    const index = Number(row.dataset.index);
    const nameInput = row.querySelector(".product-name");
    nameInput.addEventListener("input", (event) => {
      setupProducts[index].name = event.target.value;
      const match = findCatalogProduct("", event.target.value);
      setupProducts[index].catalogId = match?.id || "";
      setupProducts[index].category = match?.category || "";
    });
    nameInput.addEventListener("change", (event) => {
      const match = findCatalogProduct(setupProducts[index].catalogId, event.target.value);
      if (!match) return;
      setupProducts[index] = { ...setupProducts[index], catalogId: match.id, name: match.name, category: match.category };
      event.target.value = match.name;
      event.target.title = match.category;
    });
    row.querySelector(".product-target").addEventListener("input", (event) => setupProducts[index].target = clampInteger(event.target.value));
    row.querySelector(".remove-product").addEventListener("click", () => {
      setupProducts.splice(index, 1);
      renderSetupProducts();
    });
  });
  renderSetupAnalysisNotes();
}

function renderSetupAnalysisNotes() {
  const root = $("#setupAnalysisNotes");
  if (!root) return;
  const warnings = Array.isArray(setupAnalysis.warnings) ? setupAnalysis.warnings : [];
  const unknownItems = Array.isArray(setupAnalysis.unknown_items) ? setupAnalysis.unknown_items : [];
  if (!warnings.length && !unknownItems.length) {
    root.innerHTML = "";
    root.classList.add("hidden");
    return;
  }
  root.classList.remove("hidden");
  root.innerHTML = `
    ${warnings.length ? `<div class="analysis-note"><strong>Controleer deze foto’s</strong><ul>${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul></div>` : ""}
    ${unknownItems.length ? `<div class="analysis-note"><strong>Nog niet zeker herkend</strong>${unknownItems.map((item, index) => `
      <div class="unknown-row">
        <span>${escapeHtml(item.estimated_count)} × ${escapeHtml(item.description)}${item.note ? ` · ${escapeHtml(item.note)}` : ""}</span>
        <button class="button small secondary add-unknown" type="button" data-index="${index}">Toevoegen</button>
      </div>`).join("")}</div>` : ""}
  `;
  root.querySelectorAll(".add-unknown").forEach((button) => button.addEventListener("click", () => {
    if (setupProducts.length >= MAX_PRODUCTS) return showToast(`Maximum ${MAX_PRODUCTS} producten per frigo.`);
    const index = Number(button.dataset.index);
    const item = setupAnalysis.unknown_items[index];
    if (!item) return;
    const match = findCatalogProduct("", item.description);
    setupProducts.push({
      catalogId: match?.id || "",
      name: match?.name || cleanText(item.description, 120),
      category: match?.category || "",
      target: clampInteger(item.estimated_count)
    });
    setupAnalysis.unknown_items.splice(index, 1);
    renderSetupProducts();
  }));
}

function loadSetupEditor(id) {
  setupEditingId = id;
  $("#setupFridgeSelect").value = id;
  if (id === "new") {
    $("#setupFridgeName").value = "";
    setupProducts = [];
    $("#deleteFridge").classList.add("hidden");
  } else {
    const fridge = state.fridges.find((item) => item.id === id);
    $("#setupFridgeName").value = fridge?.name || "";
    setupProducts = (fridge?.products || []).map((item) => ({ ...item }));
    $("#deleteFridge").classList.remove("hidden");
  }
  setupAnalysis = { warnings: [], unknown_items: [] };
  setupFiles = [];
  renderPhotos("setup");
  renderSetupProducts();
}

function normalizeEditorProducts() {
  const seen = new Set();
  return setupProducts.slice(0, MAX_PRODUCTS)
    .map((item) => {
      const match = findCatalogProduct(item.catalogId, item.name);
      return {
        catalogId: match?.id || cleanText(item.catalogId, 64),
        name: match?.name || cleanText(item.name, 120),
        category: match?.category || cleanText(item.category, 100),
        target: clampInteger(item.target)
      };
    })
    .filter((item) => {
      const key = item.catalogId ? `id:${item.catalogId}` : `name:${item.name.toLocaleLowerCase("nl")}`;
      if (!item.name || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function getComputedRows() {
  if (!checkResult) return [];
  return checkResult.products.map((item) => ({
    ...item,
    target: Math.max(0, Number(item.target) || 0),
    observed: Math.max(0, Number(item.observed) || 0),
    missing: Math.max(0, (Number(item.target) || 0) - (Number(item.observed) || 0))
  }));
}

function buildTicketText(fridgeName, rows, date = new Date()) {
  const missing = rows.filter((row) => row.missing > 0);
  const line = "--------------------------------";
  const dateText = new Intl.DateTimeFormat("nl-BE", { dateStyle: "short", timeStyle: "short" }).format(date);
  const body = missing.length
    ? missing.map((row) => `${String(row.missing).padStart(2, " ")} x ${row.name}`).join("\n")
    : "NIETS AANVULLEN";
  return `AANVULLIJST\n${fridgeName.toUpperCase()}\n${dateText}\n${line}\n${body}\n${line}\nControleer onzekere tellingen.`;
}

function renderCheckResult() {
  const root = $("#checkResult");
  if (!checkResult) {
    root.classList.add("hidden");
    root.innerHTML = "";
    return;
  }
  const rows = getComputedRows();
  const ticket = buildTicketText(checkResult.fridgeName, rows, new Date(checkResult.analyzedAt));
  const warnings = [...(checkResult.warnings || [])];
  const low = rows.filter((row) => row.confidence < .7).length;
  if (low) warnings.unshift(`${low} product${low === 1 ? "" : "en"} met lage herkenningszekerheid: controleer die aantallen.`);

  root.classList.remove("hidden");
  root.innerHTML = `
    <div class="card">
      <div class="result-head">
        <div>
          <p class="step">AI-RESULTAAT</p>
          <h2>${escapeHtml(checkResult.fridgeName)}</h2>
          <div class="result-time">${escapeHtml(new Intl.DateTimeFormat("nl-BE", { dateStyle: "medium", timeStyle: "short" }).format(new Date(checkResult.analyzedAt)))}</div>
        </div>
      </div>
      <div style="overflow-x:auto">
        <table class="result-table">
          <thead><tr><th>Drank</th><th>Doel</th><th>Gezien</th><th>Halen</th><th>Zeker</th></tr></thead>
          <tbody>
            ${rows.map((row, index) => `
              <tr class="${row.confidence < .7 ? "low-confidence" : ""}">
                <td><strong>${escapeHtml(row.name)}</strong>${row.note ? `<div class="product-note">${escapeHtml(row.note)}</div>` : ""}</td>
                <td>${row.target}</td>
                <td><input class="observed-edit" data-index="${index}" type="number" min="0" max="999" inputmode="numeric" value="${row.observed}"></td>
                <td><span class="missing-count ${row.missing === 0 ? "zero" : ""}" data-missing-index="${index}">${row.missing}</span></td>
                <td><span class="confidence">${Math.round(row.confidence * 100)}%</span></td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
      ${warnings.length ? `<ul class="alert-list">${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>` : ""}
      ${(checkResult.unknown_items || []).length ? `<ul class="alert-list">${checkResult.unknown_items.map((item) => `<li>Niet herkend: ${escapeHtml(item.estimated_count)} × ${escapeHtml(item.description)}${item.note ? ` — ${escapeHtml(item.note)}` : ""}</li>`).join("")}</ul>` : ""}
    </div>
    <div class="card">
      <p class="step">TICKET</p>
      <div class="ticket-preview" id="ticketPreview">${escapeHtml(ticket)}</div>
      <div class="result-actions">
        <button class="button primary" id="printStar">Print op Star TSP100</button>
        <button class="button secondary" id="printBrowser">Normale printfunctie</button>
      </div>
    </div>
  `;

  root.querySelectorAll(".observed-edit").forEach((input) => {
    input.addEventListener("input", (event) => {
      const index = Number(event.target.dataset.index);
      checkResult.products[index].observed = clampInteger(event.target.value);
      const row = getComputedRows()[index];
      const missing = root.querySelector(`[data-missing-index="${index}"]`);
      if (missing && row) {
        missing.textContent = row.missing;
        missing.classList.toggle("zero", row.missing === 0);
      }
      const preview = $("#ticketPreview");
      if (preview) preview.textContent = buildTicketText(checkResult.fridgeName, getComputedRows(), new Date(checkResult.analyzedAt));
    });
  });
  $("#printStar").addEventListener("click", () => printWithPassPRNT(checkResult.fridgeName, getComputedRows()));
  $("#printBrowser").addEventListener("click", () => window.print());
}

function buildTicketHtml(fridgeName, rows) {
  const missing = rows.filter((row) => row.missing > 0);
  const date = new Intl.DateTimeFormat("nl-BE", { dateStyle: "short", timeStyle: "short" }).format(new Date());
  const items = missing.length
    ? missing.map((row) => `<tr><td style="font-size:28px;font-weight:700;padding:7px 0;width:70px;vertical-align:top">${row.missing} x</td><td style="font-size:28px;font-weight:700;padding:7px 0">${escapeHtml(row.name)}</td></tr>`).join("")
    : `<tr><td style="font-size:28px;font-weight:700;text-align:center;padding:18px 0">NIETS AANVULLEN</td></tr>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="format-detection" content="telephone=no"><style>body{margin:0;padding:12px 8px;font-family:Arial,sans-serif;color:#000}.c{text-align:center}.title{font-size:34px;font-weight:900}.fridge{font-size:27px;font-weight:800;margin-top:6px}.date{font-size:18px;margin:7px 0 13px}.line{border-top:3px solid #000;margin:8px 0}table{width:100%;border-collapse:collapse}.foot{font-size:17px;text-align:center;margin-top:12px}</style></head><body><div class="c title">AANVULLIJST</div><div class="c fridge">${escapeHtml(fridgeName)}</div><div class="c date">${escapeHtml(date)}</div><div class="line"></div><table>${items}</table><div class="line"></div><div class="foot">Controleer onzekere tellingen</div></body></html>`;
}

function passPrntUrl(fridgeName, rows) {
  const params = new URLSearchParams();
  params.set("back", window.location.href.split("?")[0]);
  params.set("html", buildTicketHtml(fridgeName, rows));
  params.set("size", "576");
  params.set("cut", "partial");
  params.set("popup", "enable");
  if (state.printer.useExplicitIp && state.printer.ip) params.set("port", `TCP:${state.printer.ip.trim()}`);
  return `starpassprnt://v1/print/nopreview?${params.toString()}`;
}

function printWithPassPRNT(fridgeName, rows) {
  if (!rows.length) return showToast("Geen ticketgegevens beschikbaar.");
  if (rows.filter((row) => row.missing > 0).length > MAX_TICKET_ITEMS) {
    return showToast(`Dit ticket is te lang voor de Star-printer. Beperk het tot ${MAX_TICKET_ITEMS} aan te vullen producten.`, 6000);
  }
  const url = passPrntUrl(fridgeName, rows);
  let appOpened = false;
  const markOpened = () => { appOpened = true; };
  const markHidden = () => { if (document.visibilityState === "hidden") markOpened(); };
  document.addEventListener("visibilitychange", markHidden, { once: true });
  window.addEventListener("pagehide", markOpened, { once: true });
  window.location.href = url;
  setTimeout(() => {
    document.removeEventListener("visibilitychange", markHidden);
    window.removeEventListener("pagehide", markOpened);
    if (!appOpened && document.visibilityState === "visible") {
      showToast("PassPRNT niet geopend? Installeer/open de Star PassPRNT-app en probeer opnieuw.", 5000);
    }
  }, 1800);
}

function handlePassPrntCallback() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("passprnt_code");
  if (code === null) return;
  const message = cleanText(url.searchParams.get("passprnt_message"), 200);
  const numericCode = /^0x[0-9a-f]+$/i.test(code) ? Number.parseInt(code.slice(2), 16) : Number(code);
  if (numericCode === 0) showToast("Ticket is naar de Star-printer gestuurd.", 4500);
  else showToast(`Printen is niet gelukt${message ? `: ${message}` : ` (code ${cleanText(code, 30)})`}.`, 6000);
  url.searchParams.delete("passprnt_code");
  url.searchParams.delete("passprnt_message");
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

async function checkServer() {
  const el = $("#serverStatus");
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error();
    if (!data.configured) {
      el.className = "status-pill bad";
      el.innerHTML = `<span class="dot"></span><span>AI-server niet ingesteld</span>`;
      return;
    }
    if ((localStorage.getItem(PIN_KEY) || "").trim().length < 12) {
      el.className = "status-pill bad";
      el.innerHTML = `<span class="dot"></span><span>Vul toegangscode in</span>`;
      return;
    }
    el.className = "status-pill ok";
    el.innerHTML = `<span class="dot"></span><span>AI-server ingesteld</span>`;
  } catch {
    el.className = "status-pill bad";
    el.innerHTML = `<span class="dot"></span><span>Server niet online</span>`;
  }
}

function bindEvents() {
  $$(".tab").forEach((button) => button.addEventListener("click", () => switchTab(button.dataset.tab)));

  $("#checkFridgeSelect").addEventListener("change", (event) => {
    state.activeFridgeId = event.target.value || null;
    saveState();
    checkResult = null;
    renderCheckResult();
    updateCheckHint();
  });

  $("#checkCameraInput").addEventListener("change", (event) => { addFiles("check", event.target.files); event.target.value = ""; });
  $("#checkLibraryInput").addEventListener("change", (event) => { addFiles("check", event.target.files); event.target.value = ""; });
  $("#setupCameraInput").addEventListener("change", (event) => { addFiles("setup", event.target.files); event.target.value = ""; });
  $("#setupLibraryInput").addEventListener("change", (event) => { addFiles("setup", event.target.files); event.target.value = ""; });
  $("#clearCheckPhotos").addEventListener("click", () => { checkFiles = []; renderPhotos("check"); });

  $("#analyzeCheck").addEventListener("click", async () => {
    const fridge = getActiveFridge();
    if (!fridge) return showToast("Maak eerst een frigo aan.");
    if (!checkFiles.length) return showToast("Neem of kies eerst foto’s.");
    const configuredProducts = fridge.products.filter((product) => Number(product.target) > 0);
    if (!configuredProducts.length) return showToast("Stel eerst een doelvoorraad in.");
    try {
      setBusy(true, "Foto’s voorbereiden…", "Je iPhone verkleint de beelden.", 5);
      const images = await prepareImages(checkFiles);
      const result = await callAnalyze({ mode: "count", fridgeName: fridge.name, products: configuredProducts, images });
      checkResult = {
        fridgeName: fridge.name,
        analyzedAt: result.meta?.analyzedAt || new Date().toISOString(),
        warnings: result.warnings || [],
        unknown_items: result.unknown_items || [],
        products: configuredProducts.map((target) => {
          const found = (result.products || []).find((item) => (
            (target.catalogId && item.catalog_id === target.catalogId)
            || cleanText(item.name, 120).toLocaleLowerCase("nl") === target.name.toLocaleLowerCase("nl")
          )) || {};
          return {
            catalogId: target.catalogId || "",
            name: target.name,
            target: clampInteger(target.target),
            observed: clampInteger(found.observed),
            confidence: Math.max(0, Math.min(1, Number(found.confidence) || 0)),
            note: cleanText(found.note, 500)
          };
        })
      };
      setProgress(100, "Klaar", "De aanvullijst is gemaakt.");
      setTimeout(() => setBusy(false), 300);
      renderCheckResult();
      $("#checkResult").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) {
      setBusy(false);
      showToast(error.message || "Analyse mislukt.", 6000);
    }
  });

  $("#setupFridgeSelect").addEventListener("change", (event) => loadSetupEditor(event.target.value));

  $("#discoverProducts").addEventListener("click", async () => {
    const name = $("#setupFridgeName").value.trim() || "Nieuwe frigo";
    if (!setupFiles.length) return showToast("Neem of kies eerst foto’s van de volle frigo.");
    const catalog = inventoryCatalogForVision();
    if (!catalog.length) return showToast("Wacht tot de kassalijst geladen is en probeer opnieuw.");
    try {
      setBusy(true, "Foto’s voorbereiden…", "De volle frigo wordt klaargemaakt voor analyse.", 5);
      const images = await prepareImages(setupFiles);
      const result = await callAnalyze({ mode: "discover", fridgeName: name, catalog, images });
      setupAnalysis = {
        warnings: Array.isArray(result.warnings) ? result.warnings : [],
        unknown_items: Array.isArray(result.unknown_items) ? result.unknown_items : []
      };
      setupProducts = (result.products || [])
        .filter((item) => item.name && Number(item.observed) >= 0)
        .slice(0, MAX_PRODUCTS)
        .map((item) => {
          const match = findCatalogProduct(item.catalog_id, item.name);
          return {
            catalogId: match?.id || cleanText(item.catalog_id, 64),
            name: match?.name || cleanText(item.name, 120),
            category: match?.category || "",
            target: clampInteger(item.observed)
          };
        });
      setBusy(false);
      renderSetupProducts();
      showToast(`${setupProducts.length} producten herkend. Controleer de aantallen en druk op ‘Frigo opslaan’.`, 5000);
      $("#setupProductsCard").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) {
      setBusy(false);
      showToast(error.message || "Herkenning mislukt.", 6000);
    }
  });

  $("#addProduct").addEventListener("click", () => {
    if (setupProducts.length >= MAX_PRODUCTS) return showToast(`Maximum ${MAX_PRODUCTS} producten per frigo.`);
    setupProducts.push({ catalogId: "", name: "", category: "", target: 0 });
    renderSetupProducts();
    const inputs = $$("#setupProductsList .product-name");
    inputs.at(-1)?.focus();
  });

  $("#saveFridge").addEventListener("click", () => {
    const name = $("#setupFridgeName").value.trim();
    const products = normalizeEditorProducts();
    if (!name) return showToast("Geef de frigo een naam.");
    if (!products.length) return showToast("Voeg minstens één product toe.");
    if (setupEditingId === "new") {
      const fridge = { id: crypto.randomUUID(), name, products };
      state.fridges.push(fridge);
      state.activeFridgeId = fridge.id;
      setupEditingId = fridge.id;
    } else {
      const index = state.fridges.findIndex((fridge) => fridge.id === setupEditingId);
      if (index >= 0) state.fridges[index] = { ...state.fridges[index], name, products };
    }
    saveState();
    renderFridgeSelectors();
    loadSetupEditor(setupEditingId);
    showToast("Frigo en doelvoorraad opgeslagen.");
  });

  $("#deleteFridge").addEventListener("click", () => {
    if (setupEditingId === "new") return;
    const fridge = state.fridges.find((item) => item.id === setupEditingId);
    if (!confirm(`Frigo “${fridge?.name || ""}” verwijderen?`)) return;
    state.fridges = state.fridges.filter((item) => item.id !== setupEditingId);
    if (state.activeFridgeId === setupEditingId) state.activeFridgeId = state.fridges[0]?.id || null;
    saveState();
    setupEditingId = "new";
    renderFridgeSelectors();
    loadSetupEditor("new");
    showToast("Frigo verwijderd.");
  });

  $("#printerIp").addEventListener("change", (event) => {
    const ip = event.target.value.trim();
    if (!isValidIpv4(ip)) {
      event.target.value = state.printer.ip;
      return showToast("Vul een geldig printer-IP-adres in.");
    }
    state.printer.ip = ip;
    saveState();
  });
  $("#usePrinterIp").addEventListener("change", (event) => {
    state.printer.useExplicitIp = event.target.checked;
    saveState();
  });
  $("#testPrinter").addEventListener("click", () => {
    printWithPassPRNT("TEST FRIGO AI", [{ name: "Printerverbinding werkt", target: 1, observed: 0, missing: 1 }]);
  });

  $("#appPin").value = localStorage.getItem(PIN_KEY) || "";
  $("#savePin").addEventListener("click", () => {
    const value = $("#appPin").value.trim();
    $("#appPin").value = value;
    if (value && value.length < 12) return showToast("Gebruik een toegangscode van minstens 12 tekens.", 5000);
    if (value) localStorage.setItem(PIN_KEY, value);
    else localStorage.removeItem(PIN_KEY);
    showToast("Toegangscode lokaal opgeslagen.");
    checkServer();
  });

  $("#exportConfig").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `frigo-ai-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  $("#importConfig").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (!parsed || !Array.isArray(parsed.fridges)) throw new Error();
      state = sanitizeState(parsed);
      saveState();
      setupEditingId = "new";
      hydrate();
      showToast("Back-up geïmporteerd.");
    } catch {
      showToast("Dit is geen geldige Frigo AI-back-up.");
    }
  });

  $("#resetApp").addEventListener("click", () => {
    if (!confirm("Alle frigo’s, doelvoorraden en printerinstellingen op dit toestel wissen?")) return;
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(PIN_KEY);
    state = defaultState();
    setupEditingId = "new";
    checkFiles = [];
    setupFiles = [];
    checkResult = null;
    saveState();
    hydrate();
    showToast("Lokale gegevens gewist.");
  });
}

function hydrate() {
  renderFridgeSelectors();
  renderPhotos("check");
  renderPhotos("setup");
  loadSetupEditor(setupEditingId);
  $("#printerIp").value = state.printer.ip || "192.168.0.36";
  $("#usePrinterIp").checked = state.printer.useExplicitIp !== false;
  $("#appPin").value = localStorage.getItem(PIN_KEY) || "";
  renderCheckResult();
}

bindEvents();
hydrate();
handlePassPrntCallback();
checkServer();
loadProductCatalog();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
