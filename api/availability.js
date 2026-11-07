const { ensureSchema, getPool, isoDays, availabilityForDays } = require("../lib/booking-store");

const STAY_TYPES = new Set(["hall", "fourBed", "eightBed", "cooler", "ac", "twoBhk"]);

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Vary", "Origin");
  const origin = req.headers.origin;
  if (origin && !["https://awarahostels.com", "https://www.awarahostels.com"].includes(origin)) {
    return res.status(403).json({ error: "Request origin not allowed." });
  }
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const { from = "", to = "", stayType = "" } = req.query || {};
  if (!STAY_TYPES.has(stayType)) return res.status(400).json({ error: "Choose a valid accommodation." });
  const days = isoDays(String(from), String(to));
  if (!days.length) return res.status(400).json({ error: "Choose valid dates for a stay of up to 90 nights." });

  let db;
  let client;
  try {
    db = getPool();
    await ensureSchema(db);
    client = await db.connect();
    const availability = await availabilityForDays(client, days, stayType);
    return res.status(200).json({ stayType, availability });
  } catch (error) {
    console.error("[availability-check]", error && error.message ? error.message : "database error");
    return res.status(503).json({ error: "Live availability is temporarily unavailable." });
  } finally {
    if (client) client.release();
    if (db) await db.end().catch(() => {});
  }
};
