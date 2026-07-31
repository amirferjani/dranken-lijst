export default function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Alleen GET is toegestaan." });
  }

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    ok: true,
    configured: Boolean(process.env.OPENAI_API_KEY),
    model: process.env.OPENAI_MODEL || "gpt-5-mini"
  });
}
