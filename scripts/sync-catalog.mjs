import { readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import path from "node:path";

const REPOSITORY = "amirferjani/DLL_Injector";
const sourceDirectory = process.argv[2] ? path.resolve(process.argv[2]) : null;
let sourceRevision = process.argv[3] || "";
let liveBase = "";

if (sourceDirectory && !/^[a-f0-9]{40}$/.test(sourceRevision)) {
  throw new Error("Geef bij een lokale kassacheckout ook de volledige 40-teken commit-SHA mee.");
}

if (!sourceDirectory) {
  if (!sourceRevision) {
    const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/commits/master`, {
      headers: { "Accept": "application/vnd.github+json", "User-Agent": "frigo-ai-catalog-sync" },
      signal: AbortSignal.timeout(20_000)
    });
    if (!response.ok) throw new Error(`Kon de actuele kassarevisie niet bepalen (${response.status}).`);
    sourceRevision = String((await response.json())?.sha || "");
  }
  if (!/^[a-f0-9]{40}$/.test(sourceRevision)) throw new Error("De kassarevisie is geen geldige commit-SHA.");
  liveBase = `https://raw.githubusercontent.com/${REPOSITORY}/${sourceRevision}`;
}

async function readSource(relativePath) {
  if (sourceDirectory) return readFile(path.join(sourceDirectory, relativePath), "utf8");
  const response = await fetch(`${liveBase}/${relativePath}`, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Kon ${relativePath} niet ophalen (${response.status}).`);
  return response.text();
}

function activePartCount(loaderSource) {
  const match = loaderSource.match(/Array\.from\(\{length:(\d+)\}[^\n]+app\.full\./);
  const count = Number(match?.[1]);
  if (!Number.isInteger(count) || count < 1 || count > 20) {
    throw new Error("Het actieve aantal kassabundeldelen kon niet veilig worden bepaald.");
  }
  return count;
}

function validateProducts(value) {
  if (!Array.isArray(value) || value.length < 200 || value.length > 1_000) {
    throw new Error(`Onverwacht aantal kassaproducten: ${Array.isArray(value) ? value.length : "geen lijst"}.`);
  }

  const ids = new Set();
  return value.map((item, index) => {
    const id = String(item?.id || "").trim();
    const name = String(item?.name || "").trim();
    const category = String(item?.category || "").trim();
    if (!id || !name || !category || ids.has(id)) {
      throw new Error(`Ongeldig of dubbel kassaproduct op positie ${index + 1}.`);
    }
    ids.add(id);
    return {
      id,
      name,
      category,
      aliases: [...new Set((Array.isArray(item.aliases) ? item.aliases : [])
        .map((alias) => String(alias || "").trim())
        .filter(Boolean))],
      favorite: Boolean(item.favorite)
    };
  });
}

const loaderSource = await readSource("loader.js");
const partCount = activePartCount(loaderSource);
const encodedParts = await Promise.all(
  Array.from({ length: partCount }, (_, index) => readSource(`assets/app.full.${String(index + 1).padStart(2, "0")}.b64`))
);
const compressed = Buffer.from(encodedParts.join("").replace(/\s+/g, ""), "base64");
const applicationSource = gunzipSync(compressed).toString("utf8");
const catalogMatch = applicationSource.match(/const PRODUCTS = (\[.*?\]);\n/s);
if (!catalogMatch) throw new Error("PRODUCTS werd niet in de actieve kassabundel gevonden.");

const products = validateProducts(JSON.parse(catalogMatch[1]));
const snapshot = {
  schemaVersion: 1,
  source: {
    repository: REPOSITORY,
    revision: sourceRevision,
    activeParts: partCount,
    syncedAt: new Date().toISOString()
  },
  products
};

await writeFile(new URL("../catalog.json", import.meta.url), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
console.log(`catalog.json bijgewerkt: ${products.length} producten uit ${partCount} actieve bundeldelen.`);
