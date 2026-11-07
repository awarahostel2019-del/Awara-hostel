const crypto = require("node:crypto");
const { ensureSchema, getPool, isoDays, availabilityForDays } = require("../lib/booking-store");
const { signQuote } = require("../lib/paypal");
const { getUsdInrRate, toUsd } = require("../lib/fx");

const ROOMS = Object.freeze({
  hall: { name: "Hall Dormitory", rate: 299, kind: "beds", max: 4, maxGuests: 4 },
  fourBed: { name: "4-Bed Dormitory", rate: 350, kind: "beds", max: 4, maxGuests: 4 },
  eightBed: { name: "8-Bed Mixed Dormitory", rate: 399, kind: "beds", max: 8, maxGuests: 8 },
  cooler: { name: "1BHK Cooler Room", rate: 999, kind: "rooms", max: 1, maxGuests: 2 },
  ac: { name: "1BHK AC Room", rate: 1500, kind: "rooms", max: 1, maxGuests: 3 },
  twoBhk: { name: "2BHK Entire Room", rate: 2999, kind: "rooms", max: 1, maxGuests: 8 },
});

function clean(value, length) { return String(value || "").trim().slice(0, length); }
function makeReference() {
  const d = new Date();
  const date = `${String(d.getUTCFullYear()).slice(-2)}${String(d.getUTCMonth()+1).padStart(2,"0")}${String(d.getUTCDate()).padStart(2,"0")}`;
  return `AWR-${date}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  const origin = req.headers.origin;
  if (origin && !["https://awarahostels.com", "https://www.awarahostels.com"].includes(origin)) return res.status(403).json({ error: "Request origin not allowed." });
  if (req.method === "GET") {
    const { from = "", to = "", stayType = "" } = req.query || {};
    if (!ROOMS[String(stayType)]) return res.status(400).json({ error: "Choose a valid accommodation." });
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
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed." });
  }
  const body = req.body || {};
  const room = ROOMS[String(body.stayType || "")];
  if (!room) return res.status(400).json({ error: "Choose a valid room type." });
  const checkIn = clean(body.checkIn, 10);
  const checkOut = clean(body.checkOut, 10);
  const days = isoDays(checkIn, checkOut);
  if (!days.length) return res.status(400).json({ error: "Choose valid dates for a stay of up to 90 nights." });
  const nights = days.length;
  const guestName = clean(body.name, 100);
  const guestEmail = clean(body.email, 254).toLowerCase();
  const phone = clean(body.phone, 30);
  const note = clean(body.note, 500);
  const country = clean(body.payerCountry, 3).toUpperCase();
  const quantity = room.kind === "beds" ? Number(body.quantity) : 1;
  const guests = Number(body.guests);
  if (guestName.length < 2 || !/^\+?[0-9 ()-]{8,30}$/.test(phone)) return res.status(400).json({ error: "Enter your name and a valid phone number." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guestEmail)) return res.status(400).json({ error: "Enter a valid email address." });
  if (!Number.isInteger(guests) || guests < 1 || guests > room.maxGuests) return res.status(400).json({ error: `This accommodation allows 1 to ${room.maxGuests} guests.` });
  if (room.kind === "beds" && (!Number.isInteger(quantity) || quantity < 1 || quantity > room.max)) return res.status(400).json({ error: `Choose 1 to ${room.max} beds.` });
  if (room.kind === "beds" && guests > quantity) return res.status(400).json({ error: "Choose at least one bed for each guest." });
  if (room.kind === "rooms" && quantity !== 1) return res.status(400).json({ error: "Choose one private room." });
  if (!["IN", "INT"].includes(country)) return res.status(400).json({ error: "Choose a valid payment country." });
  const twoBhkNeedsStaff = body.stayType === "twoBhk";
  const domesticNeedsStaff = country === "IN";
  if (!twoBhkNeedsStaff && !domesticNeedsStaff && (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET || !process.env.PAYPAL_ADMIN_KEY || process.env.PAYPAL_ENV !== "live")) return res.status(503).json({ error: "International online payment is temporarily unavailable. Please contact Awara." });
  const nightlyRate = body.stayType === "twoBhk" && guests >= 6 ? 3500 : room.rate;
  const amountInr = nightlyRate * quantity * nights;
  const paymentCurrency = country === "IN" ? "INR" : "USD";
  const needsStaff = twoBhkNeedsStaff || domesticNeedsStaff;
  let fx = null;
  let amountUsd = null;
  if (paymentCurrency === "USD" && !needsStaff) {
    try {
      fx = await getUsdInrRate();
      amountUsd = toUsd(amountInr, fx.inrPerUsd);
    } catch (error) {
      console.error("[booking-fx]", error && error.message ? error.message : "rate service error");
      return res.status(503).json({ error: "A current exchange rate could not be confirmed. No payment was taken; please try again shortly." });
    }
  }
  const reference = makeReference();
  const bookingId = crypto.randomUUID();
  const status = needsStaff ? "awaiting_staff" : "pending_payment";
  const expiresAt = new Date(Date.now() + (needsStaff ? 24 : 0.25) * 3600000);
  let db;
  let client;
  try {
    db = getPool();
    await ensureSchema(db);
    client = await db.connect();
    await client.query("BEGIN");
    for (const day of days) await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${day}:${room.kind === "beds" ? body.stayType : "private_rooms"}`]);
    const availability = await availabilityForDays(client, days, body.stayType);
    for (const available of availability) {
      if (available.remaining < quantity) throw Object.assign(new Error("Those dates are no longer available. Choose fewer beds or different dates."), { publicStatus: 409 });
    }
    await client.query(
      `INSERT INTO awara_bookings (id, reference, stay_type, check_in, check_out, quantity, guest_count, guest_name, guest_email, payer_country, phone, note, status, amount_inr, amount_usd, fx_rate, fx_checked_at, payment_provider, expires_at)
       VALUES ($1::uuid,$2,$3,$4::date,$5::date,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [bookingId, reference, body.stayType, checkIn, checkOut, quantity, guests, guestName, guestEmail, country, phone, note, status, amountInr, amountUsd, fx && fx.inrPerUsd, fx && fx.checkedAt, needsStaff ? (country === "IN" ? "manual" : "paypal") : "paypal", expiresAt.toISOString()],
    );
    await client.query("COMMIT");
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    if (error.publicStatus) return res.status(error.publicStatus).json({ error: error.message });
    if (error.code === "40001") return res.status(409).json({ error: "Availability just changed. Please refresh and try again." });
    console.error("[booking-create]", error && error.message ? error.message : "database error");
    return res.status(503).json({ error: "Booking is temporarily unavailable. Please contact Awara." });
  } finally {
    if (client) client.release();
    if (db) await db.end().catch(() => {});
  }

  if (needsStaff) {
    const reason = twoBhkNeedsStaff
      ? "2BHK needs staff confirmation because it combines both 1BHK rooms."
      : "Domestic online payment is not active yet. Awara staff will confirm availability and arrange payment with you.";
    const message = `Hello Awara, I submitted booking request ${reference}.\nAccommodation: ${room.name}\nDates: ${checkIn} to ${checkOut} (${nights} nights)\nGuests: ${guests}\nEstimated total: ₹${amountInr.toLocaleString("en-IN")}\nName: ${guestName}\nPhone: ${phone}`;
    return res.status(201).json({ status, reference, amountInr, currency: "INR", expiresAt: expiresAt.toISOString(), reason, whatsappUrl: `https://wa.me/918933013188?text=${encodeURIComponent(message)}` });
  }
  const quote = {
    iss: "awara", quoteId: crypto.randomBytes(12).toString("hex"), bookingId, reference,
    amount: amountUsd, amountInr: String(amountInr), fxRate: String(fx.inrPerUsd),
    currency: "USD", exp: Math.floor(expiresAt.getTime() / 1000),
  };
  try {
    const token = signQuote(quote);
    return res.status(201).json({ status, reference, amountInr, amountUsd, currency: "USD", fxRate: fx.inrPerUsd, fxCheckedAt: fx.checkedAt, expiresAt: expiresAt.toISOString(), paymentUrl: `https://www.awarahostels.com/pay.html?q=${encodeURIComponent(token)}` });
  } catch (error) {
    console.error("[booking-quote]", error && error.message ? error.message : "signing error");
    const cleanupDb = getPool();
    try { await cleanupDb.query("UPDATE awara_bookings SET status='cancelled', updated_at=now() WHERE id=$1::uuid AND status='pending_payment'", [bookingId]); }
    catch (cleanupError) { console.error("[booking-cleanup] could not release hold", cleanupError && cleanupError.message ? cleanupError.message : "database error"); }
    finally { await cleanupDb.end().catch(() => {}); }
    return res.status(503).json({ error: "Could not prepare secure checkout. No payment was taken." });
  }
};
