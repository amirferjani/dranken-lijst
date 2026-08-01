export default function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Alleen GET is toegestaan." });
  }

  res.setHeader("Cache-Control", "no-store");
  const hasApiKey = Boolean(String(process.env.OPENAI_API_KEY || "").trim());
  const hasAppPin = String(process.env.APP_PIN || "").trim().length >= 12;
  return res.status(200).json({
    ok: true,
    configured: hasApiKey && hasAppPin,
    requiresPin: true
  });
}
