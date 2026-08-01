import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const REPOSITORY = "amirferjani/DLL_Injector";
const CACHE_MS = 15 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 12_000;
const snapshot = JSON.parse(readFileSync(new URL("../catalog.json", import.meta.url), "utf8"));
let memoryCache = null;

function json(res, status, payload) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", status === 200
    ? "public, s-maxage=900, stale-while-revalidate=86400"
    : "no-store");
  res.end(JSON.stringify(payload));
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { "Accept": "application/vnd.github+json", "User-Agent": "frigo-ai-catalog-sync" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`GitHub antwoordde met ${response.status}.`);
  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Catalogusbestand antwoordde met ${response.status}.`);
  return response.text();
}

function activePartCount(loaderSource) {
  const match = loaderSource.match(/Array\.from\(\{length:(\d+)\}[^\n]+app\.full\./);
  const count = Number(match?.[1]);
  if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error("Ongeldig kassamanifest.");
  return count;
}

function validateProducts(value) {
  if (!Array.isArray(value) || value.length < 200 || value.length > 1_000) {
    throw new Error("Onverwachte kassacatalogus.");
  }
  const ids = new Set();
  return value.map((item) => {
    const id = String(item?.id || "").trim().slice(0, 64);
    const name = String(item?.name || "").trim().slice(0, 120);
    const category = String(item?.category || "").trim().slice(0, 100);
    if (!id || !name || !category || ids.has(id)) throw new Error("Ongeldig of dubbel kassaproduct.");
    ids.add(id);
    return {
      id,
      name,
      category,
      aliases: [...new Set((Array.isArray(item.aliases) ? item.aliases : [])
        .map((alias) => String(alias || "").trim().slice(0, 100))
        .filter(Boolean))].slice(0, 20),
      favorite: Boolean(item.favorite)
    };
  });
}

async function fetchLiveCatalog() {
  const commit = await fetchJson(`https://api.github.com/repos/${REPOSITORY}/commits/master`);
  const revision = String(commit?.sha || "");
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("GitHub gaf geen geldige revisie terug.");

  const rawBase = `https://raw.githubusercontent.com/${REPOSITORY}/${revision}`;
  const loaderSource = await fetchText(`${rawBase}/loader.js`);
  const partCount = activePartCount(loaderSource);
  const encodedParts = await Promise.all(
    Array.from({ length: partCount }, (_, index) => fetchText(`${rawBase}/assets/app.full.${String(index + 1).padStart(2, "0")}.b64`))
  );
  const compressed = Buffer.from(encodedParts.join("").replace(/\s+/g, ""), "base64");
  const applicationSource = gunzipSync(compressed).toString("utf8");
  const match = applicationSource.match(/const PRODUCTS = (\[.*?\]);\n/s);
  if (!match) throw new Error("PRODUCTS ontbreekt in de actieve kassabundel.");

  return {
    schemaVersion: 1,
    source: {
      repository: REPOSITORY,
      revision,
      activeParts: partCount,
      syncedAt: new Date().toISOString(),
      mode: "live"
    },
    products: validateProducts(JSON.parse(match[1]))
  };
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return json(res, 405, { error: "Alleen GET is toegestaan." });
  }

  const now = Date.now();
  if (memoryCache?.expiresAt > now) return json(res, 200, memoryCache.payload);

  let payload;
  try {
    payload = await fetchLiveCatalog();
  } catch {
    payload = {
      ...snapshot,
      source: { ...snapshot.source, mode: "snapshot" }
    };
  }
  memoryCache = { payload, expiresAt: now + CACHE_MS };
  return json(res, 200, payload);
}

export { activePartCount, validateProducts };
