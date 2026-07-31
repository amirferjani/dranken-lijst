const MAX_IMAGES = 20;
const MAX_BODY_CHARS = 4_200_000;
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 8;
const rateBuckets = new Map();

function json(res, status, payload) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded) return forwarded.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

function isRateLimited(ip) {
  const now = Date.now();
  const bucket = rateBuckets.get(ip) || [];
  const recent = bucket.filter((time) => now - time < WINDOW_MS);
  recent.push(now);
  rateBuckets.set(ip, recent);
  return recent.length > MAX_REQUESTS_PER_WINDOW;
}

function validImageDataUrl(value) {
  return typeof value === "string" && /^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/i.test(value);
}

function normalizeProducts(products) {
  if (!Array.isArray(products)) return [];
  const seen = new Set();
  const output = [];
  for (const item of products) {
    const name = String(item?.name || "").trim().slice(0, 100);
    if (!name || seen.has(name.toLocaleLowerCase("nl"))) continue;
    seen.add(name.toLocaleLowerCase("nl"));
    output.push({ name, target: Math.max(0, Math.min(999, Number.parseInt(item?.target, 10) || 0)) });
  }
  return output.slice(0, 100);
}

const outputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    products: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          observed: { type: "integer", minimum: 0 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          note: { type: "string" }
        },
        required: ["name", "observed", "confidence", "note"]
      }
    },
    unknown_items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          description: { type: "string" },
          estimated_count: { type: "integer", minimum: 0 },
          note: { type: "string" }
        },
        required: ["description", "estimated_count", "note"]
      }
    },
    warnings: {
      type: "array",
      items: { type: "string" }
    }
  },
  required: ["products", "unknown_items", "warnings"]
};

function buildPrompt({ mode, fridgeName, products, imageCount }) {
  const shared = `
Je bent een zeer nauwkeurige voorraadcontroleur in een Belgisch café.
Je krijgt ${imageCount} foto's van DEZELFDE frigo, genomen vanuit verschillende hoeken.
Analyseer alle foto's gezamenlijk als één 3D-situatie.

HARD REGELS:
- Tel fysieke flessen en blikjes, geen etiketten, spiegelingen, afbeeldingen of lege plekken.
- Hetzelfde exemplaar kan op meerdere foto's voorkomen: tel het dan maar één keer.
- Gebruik overlap, positie ten opzichte van rekken, doppen, etiketten en buurflessen om dubbeltelling te vermijden.
- Tel alleen wat werkelijk zichtbaar of redelijk traceerbaar is. Verzin geen verborgen voorraad.
- Maak onderscheid tussen varianten zoals Dubbel/Tripel, alcoholvrij/gewoon en verschillende merken.
- Bij twijfel: lager confidence, noteer waarom en zet een niet-herkend product bij unknown_items.
- Een partly verborgen fles telt alleen wanneer het duidelijk een afzonderlijk exemplaar is.
- Geef waarschuwingen voor slechte hoeken, reflectie, sterke overlap of onvoldoende zicht.
- Schrijf productnamen kort en herkenbaar voor barpersoneel.
- Antwoord uitsluitend volgens het opgegeven JSON-schema.
Frigo: ${fridgeName || "Onbenoemde frigo"}.
`;

  if (mode === "discover") {
    return `${shared}
DOEL: dit is een kalibratie van een volle of gewenste frigo.
Ontdek alle duidelijk herkenbare drankproducten en tel hun totale zichtbare aantallen over alle foto's.
Voeg geen generieke categorie toe wanneer merk/variant leesbaar is.
Sorteer products logisch: per rek van boven naar beneden, en ongeveer links naar rechts wanneer mogelijk.
Gebruik confidence >= 0,55 voor products; zet lagere zekerheid bij unknown_items.`;
  }

  return `${shared}
DOEL: tel de actuele voorraad en vergelijk later met de ingestelde doelvoorraad.
TOEGESTANE PRODUCTEN (gebruik exact deze namen en geef elk product exact één keer terug):
${JSON.stringify(products, null, 2)}

Belangrijk:
- Gebruik uitsluitend namen uit deze lijst in products.
- Staat een toegestaan product nergens zichtbaar, zet observed op 0.
- Andere dranken horen bij unknown_items.
- target is alleen context; observed moet volledig uit de foto's komen.`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: "Alleen POST is toegestaan." });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return json(res, 503, { error: "De server mist OPENAI_API_KEY." });

  const requiredPin = String(process.env.APP_PIN || "").trim();
  if (requiredPin && String(req.headers["x-app-pin"] || "") !== requiredPin) {
    return json(res, 401, { error: "Onjuiste app-toegangscode." });
  }

  const ip = getClientIp(req);
  if (isRateLimited(ip)) return json(res, 429, { error: "Te veel analyses. Wacht één minuut." });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return json(res, 400, { error: "Ongeldige JSON." }); }
  }
  if (!body || typeof body !== "object") return json(res, 400, { error: "Ongeldige aanvraag." });

  const mode = body.mode === "discover" ? "discover" : "count";
  const fridgeName = String(body.fridgeName || "Frigo").trim().slice(0, 100);
  const products = normalizeProducts(body.products);
  const images = Array.isArray(body.images) ? body.images.filter(validImageDataUrl) : [];

  if (!images.length) return json(res, 400, { error: "Voeg minstens één geldige foto toe." });
  if (images.length > MAX_IMAGES) return json(res, 400, { error: `Maximum ${MAX_IMAGES} foto's per analyse.` });
  if (mode === "count" && !products.length) return json(res, 400, { error: "Deze frigo heeft nog geen producten/doelvoorraad." });
  if (JSON.stringify(body).length > MAX_BODY_CHARS) return json(res, 413, { error: "De foto's zijn samen te groot. Kies minder foto's of probeer opnieuw." });

  const content = [
    { type: "input_text", text: buildPrompt({ mode, fridgeName, products, imageCount: images.length }) },
    ...images.map((image_url) => ({ type: "input_image", image_url, detail: "high" }))
  ];

  const requestBody = {
    model: process.env.OPENAI_MODEL || "gpt-5-mini",
    store: false,
    input: [{ role: "user", content }],
    text: {
      format: {
        type: "json_schema",
        name: "fridge_inventory",
        strict: true,
        schema: outputSchema
      }
    }
  };

  let openaiResponse;
  try {
    openaiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(55_000)
    });
  } catch (error) {
    const message = error?.name === "TimeoutError" ? "De AI-analyse duurde te lang." : "Geen verbinding met OpenAI.";
    return json(res, 504, { error: message });
  }

  const raw = await openaiResponse.json().catch(() => ({}));
  if (!openaiResponse.ok) {
    const message = raw?.error?.message || `OpenAI-fout (${openaiResponse.status}).`;
    return json(res, openaiResponse.status >= 500 ? 502 : 400, { error: message });
  }

  const outputText = raw?.output
    ?.flatMap((item) => item?.content || [])
    ?.find((item) => item?.type === "output_text")
    ?.text;

  if (!outputText) return json(res, 502, { error: "De AI gaf geen bruikbaar resultaat terug." });

  let result;
  try {
    result = JSON.parse(outputText);
  } catch {
    return json(res, 502, { error: "Het AI-resultaat kon niet worden gelezen." });
  }

  if (mode === "count") {
    const byName = new Map((result.products || []).map((item) => [String(item.name).toLocaleLowerCase("nl"), item]));
    result.products = products.map((product) => {
      const found = byName.get(product.name.toLocaleLowerCase("nl")) || {};
      return {
        name: product.name,
        observed: Math.max(0, Number.parseInt(found.observed, 10) || 0),
        confidence: Math.max(0, Math.min(1, Number(found.confidence) || 0)),
        note: String(found.note || "")
      };
    });
  }

  return json(res, 200, {
    ...result,
    meta: {
      model: raw.model || requestBody.model,
      imageCount: images.length,
      analyzedAt: new Date().toISOString()
    }
  });
}
