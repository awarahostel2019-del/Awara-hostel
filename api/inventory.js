const { availabilityForDays, ensureSchema, getPool, isoDays } = require("../lib/booking-store");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed." });
  const stayType = String(req.query.stayType || "");
  if (!["hall", "fourBed", "eightBed", "cooler", "ac", "twoBhk"].includes(stayType)) return res.status(400).json({ error: "Choose a valid room type." });
  const days = isoDays(String(req.query.checkIn || ""), String(req.query.checkOut || ""));
  if (!days.length) return res.status(400).json({ error: "Choose valid dates for a stay of up to 90 nights." });
  let db;
  try {
    db = getPool();
    await ensureSchema(db);
    const client = await db.connect();
    try {
      const availability = await availabilityForDays(client, days, stayType);
      const available = availability.every((night) => night.remaining > 0);
      return res.status(200).json({ available, availability });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("[inventory]", error && error.message ? error.message : "database error");
    return res.status(503).json({ error: "Live availability is temporarily unavailable. Please try again shortly." });
  } finally {
    if (db) await db.end().catch(() => {});
  }
};
