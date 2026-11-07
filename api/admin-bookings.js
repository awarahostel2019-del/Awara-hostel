const crypto = require("node:crypto");
const { availabilityForDay, availabilityForDays, DEFAULT_CAPACITY, MAX_CAPACITY, ensureSchema, getPool, isoDays } = require("../lib/booking-store");
const { getAdminKey, signQuote } = require("../lib/paypal");
const { getUsdInrRate, toUsd } = require("../lib/fx");

const TYPES = new Set(Object.keys(MAX_CAPACITY));
const SOURCES = new Set(["offline", "booking.com", "makemytrip", "goibibo", "hostelworld", "other"]);
const PAYMENT_METHODS = new Set(["cash", "card", "upi", "ota", "other"]);
const ID_TYPES = new Set(["Aadhaar card", "Driving licence", "Voter ID card", "Passport", "Other government photo ID"]);

function dates(req) {
  const from = String(req.query.from || "");
  const to = String(req.query.to || "");
  return { from, to, days: isoDays(from, to) };
}

async function insertPayment(client, { bookingId, totalAmount, amountPaid, method, note }) {
  const previous = await client.query("SELECT COALESCE(SUM(amount_inr),0)::numeric AS paid, COUNT(*)::int AS count FROM awara_payments WHERE booking_id=$1::uuid", [bookingId]);
  const paidBefore = Number(previous.rows[0].paid);
  if (amountPaid <= 0 || paidBefore + amountPaid > totalAmount) throw Object.assign(new Error("Payment cannot exceed the remaining balance."), { publicStatus: 400 });
  const kind = paidBefore + amountPaid >= totalAmount ? "full" : (previous.rows[0].count === 0 ? "advance" : "partial");
  const seq = await client.query("SELECT nextval('awara_receipt_sequence')::text AS value");
  const receiptNumber = `AWR-${new Date().getFullYear()}-${String(seq.rows[0].value).padStart(6, "0")}`;
  const result = await client.query(
    `INSERT INTO awara_payments(booking_id,receipt_number,amount_inr,method,kind,note)
     VALUES($1::uuid,$2,$3,$4,$5,$6) RETURNING receipt_number AS "receiptNumber", amount_inr AS amount, method, kind, note, created_at AS "createdAt"`,
    [bookingId, receiptNumber, amountPaid, method, kind, String(note || "").trim().slice(0, 240)],
  );
  return result.rows[0];
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "https://www.awarahostels.com");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    return res.status(204).end();
  }
  if (!getAdminKey(req)) return res.status(401).json({ error: "Awara staff sign-in required." });
  let database;
  try {
    database = getPool();
    await ensureSchema(database);
    const db = database;
    if (req.method === "GET") {
      await db.query("UPDATE awara_bookings SET status='expired', updated_at=now() WHERE status IN ('awaiting_staff','pending_payment') AND expires_at<=now()");
      const { from, to, days } = dates(req);
      if (!days.length) return res.status(400).json({ error: "Choose a date range of 1 to 90 nights." });
      const client = await db.connect();
      try {
        const rows = await client.query(
          `SELECT id, reference, stay_type AS "stayType", check_in::text AS "checkIn", check_out::text AS "checkOut",
                  quantity, guest_count AS "guestCount", guest_name AS "guestName", guest_email AS "guestEmail", phone, note,
                  source, status, payer_country AS "payerCountry", amount_inr AS "amountInr", amount_usd AS "amountUsd", payment_provider AS "paymentProvider", payment_method AS "paymentMethod",
                  payment_capture_id AS "captureId", expires_at AS "expiresAt", created_at AS "createdAt",
                  stay_status AS "stayStatus", id_type AS "idType", (id_verified_at IS NOT NULL) AS "idVerified",
                  checked_in_at AS "checkedInAt", checked_out_at AS "checkedOutAt"
             FROM awara_bookings WHERE check_in < $2::date AND check_out > $1::date
             ORDER BY check_in, created_at DESC LIMIT 500`, [from, to],
        );
        const inventory = [];
        for (const stayType of TYPES) {
          const byDay = await availabilityForDays(client, days, stayType);
          for (const availability of byDay) inventory.push({ ...availability, stayType });
        }
        const payments = await client.query(
          `SELECT p.booking_id AS "bookingId", p.receipt_number AS "receiptNumber", p.amount_inr AS amount,
                  p.method, p.kind, p.note, p.created_at AS "createdAt"
             FROM awara_payments p JOIN awara_bookings b ON b.id=p.booking_id
            WHERE b.check_in < $2::date AND b.check_out > $1::date ORDER BY p.created_at`, [from, to],
        );
        const paymentMap = new Map();
        for (const payment of payments.rows) {
          const list = paymentMap.get(payment.bookingId) || [];
          list.push(payment); paymentMap.set(payment.bookingId, list);
        }
        const enriched = rows.rows.map((booking) => {
          const history = paymentMap.get(booking.id) || [];
          const total = Number(booking.amountInr) || 0;
          const recorded = history.reduce((sum, payment) => sum + Number(payment.amount), 0);
          const paidTotal = booking.paymentProvider === "paypal" && booking.status === "confirmed" ? Math.max(recorded, total) : recorded;
          return { ...booking, payments: history, paidTotal, balanceDue: Math.max(0, total - paidTotal) };
        });
        return res.status(200).json({ bookings: enriched, inventory });
      } finally { client.release(); }
    }
    if (req.method !== "POST" && req.method !== "PATCH") return res.status(405).json({ error: "Method not allowed." });
    const body = req.body || {};
    if (body.action === "record-payment") {
      const reference = String(body.reference || "").trim();
      const amount = Number(body.amount);
      const method = String(body.method || "");
      if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000 || !PAYMENT_METHODS.has(method)) return res.status(400).json({ error: "Enter a valid amount and payment method." });
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const found = await client.query("SELECT id, amount_inr, status FROM awara_bookings WHERE reference=$1 FOR UPDATE", [reference]);
        const booking = found.rows[0];
        if (!booking || booking.status === "cancelled") { await client.query("ROLLBACK"); return res.status(404).json({ error: "Booking not found or cancelled." }); }
        const receipt = await insertPayment(client, { bookingId: booking.id, totalAmount: Number(booking.amount_inr), amountPaid: amount, method, note: body.note });
        await client.query("UPDATE awara_bookings SET payment_method=$2, updated_at=now() WHERE id=$1::uuid", [booking.id, method]);
        await client.query("COMMIT");
        return res.status(201).json({ receipt, reference });
      } catch (error) { await client.query("ROLLBACK").catch(() => {}); if (error.publicStatus) return res.status(error.publicStatus).json({ error: error.message }); throw error; }
      finally { client.release(); }
    }
    if (body.action === "update-stay") {
      const reference = String(body.reference || "").trim();
      const action = String(body.stayAction || "");
      const idType = String(body.idType || "");
      if (!new Set(["check-in", "check-out"]).has(action)) return res.status(400).json({ error: "Choose check-in or check-out." });
      if (action === "check-in" && (!ID_TYPES.has(idType) || body.idVerified !== true)) return res.status(400).json({ error: "Select a valid photo ID and confirm you checked it." });
      const result = action === "check-in"
        ? await db.query(`UPDATE awara_bookings SET stay_status='checked_in',id_type=$2,id_verified_at=now(),checked_in_at=now(),updated_at=now() WHERE reference=$1 AND status='confirmed' AND stay_status='booked' RETURNING reference,stay_status AS "stayStatus"`, [reference, idType])
        : await db.query(`UPDATE awara_bookings SET stay_status='checked_out',checked_out_at=now(),updated_at=now() WHERE reference=$1 AND status='confirmed' AND stay_status='checked_in' RETURNING reference,stay_status AS "stayStatus"`, [reference]);
      if (!result.rowCount) return res.status(409).json({ error: "Check that this confirmed booking is at the right check-in/check-out stage." });
      return res.status(200).json(result.rows[0]);
    }
    if (body.action === "set-inventory") {
      const dayList = isoDays(String(body.from || ""), String(body.to || ""));
      const stayType = String(body.stayType || "");
      const capacity = Number(body.capacity);
      const blocked = Number(body.blocked || 0);
      if (!dayList.length || !TYPES.has(stayType) || !Number.isInteger(capacity) || capacity < 0 || capacity > MAX_CAPACITY[stayType] || !Number.isInteger(blocked) || blocked < 0 || blocked > capacity) {
        return res.status(400).json({ error: "Check the date range, room type, capacity and blocked count." });
      }
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        for (const day of dayList) {
          await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${day}:${["cooler","ac","twoBhk"].includes(stayType) ? "private_rooms" : stayType}`]);
          await client.query(
            `INSERT INTO awara_inventory(stay_date,stay_type,capacity,blocked,updated_at)
             VALUES($1::date,$2,$3,$4,now())
             ON CONFLICT(stay_date,stay_type) DO UPDATE SET capacity=EXCLUDED.capacity, blocked=EXCLUDED.blocked, updated_at=now()`,
            [day, stayType, capacity, blocked],
          );
        }
        await client.query("COMMIT");
        return res.status(200).json({ updated: dayList.length, stayType });
      } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
      finally { client.release(); }
    }
    if (body.action === "manual-booking") {
      const stayType = String(body.stayType || "");
      const dayList = isoDays(String(body.checkIn || ""), String(body.checkOut || ""));
      const quantity = Number(body.quantity);
      const guestCount = Number(body.guestCount || quantity);
      const source = String(body.source || "other");
      const totalAmount = Number(body.totalAmount);
      const amountPaid = Number(body.amountPaid || 0);
      const paymentMethod = String(body.paymentMethod || "");
      const guestLimit = { hall: 4, fourBed: 4, eightBed: 8, cooler: 2, ac: 3, twoBhk: 8 }[stayType];
      if (!TYPES.has(stayType) || !dayList.length || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_CAPACITY[stayType] || !Number.isInteger(guestCount) || guestCount < 1 || guestCount > guestLimit || (['hall','fourBed','eightBed'].includes(stayType) && guestCount > quantity) || (['cooler','ac','twoBhk'].includes(stayType) && quantity !== 1) || !SOURCES.has(source) || !Number.isFinite(totalAmount) || totalAmount < 0 || !Number.isFinite(amountPaid) || amountPaid < 0 || amountPaid > totalAmount || (amountPaid > 0 && !PAYMENT_METHODS.has(paymentMethod))) {
        return res.status(400).json({ error: "Check the dates, accommodation, guest count and booking source." });
      }
      const bookingId = crypto.randomUUID();
      const reference = `AWR-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        for (const day of dayList) await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${day}:${["cooler","ac","twoBhk"].includes(stayType) ? "private_rooms" : stayType}`]);
        for (const day of dayList) {
          const availability = await availabilityForDay(client, day, stayType);
          if (availability.remaining < quantity) {
            await client.query("ROLLBACK");
            return res.status(409).json({ error: `Inventory is already full on ${day}. Update that date’s capacity first if this is an existing OTA/offline booking.` });
          }
        }
        await client.query(
          `INSERT INTO awara_bookings(id,reference,stay_type,check_in,check_out,quantity,guest_count,guest_name,phone,note,source,status,amount_inr,payment_method)
           VALUES($1::uuid,$2,$3,$4::date,$5::date,$6,$7,$8,$9,$10,$11,'confirmed',$12,$13)`,
          [bookingId, reference, stayType, body.checkIn, body.checkOut, quantity, guestCount, String(body.guestName || "OTA / offline guest").trim().slice(0,100), String(body.phone || "").trim().slice(0,30), String(body.note || "").trim().slice(0,500), source, totalAmount, amountPaid ? paymentMethod : null],
        );
        let receipt = null;
        if (amountPaid > 0) receipt = await insertPayment(client, { bookingId, totalAmount, amountPaid, method: paymentMethod, note: "Initial payment" });
        await client.query("COMMIT");
        return res.status(201).json({ reference, status: "confirmed", receipt });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        if (error.code === "40001") return res.status(409).json({ error: "Availability changed. Refresh and record this booking again." });
        throw error;
      } finally { client.release(); }
    }
    if (body.action === "confirm-manual") {
      const reference = String(body.reference || "").trim();
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const found = await client.query(
          `SELECT id, reference, stay_type AS "stayType", check_in::text AS "checkIn", check_out::text AS "checkOut", quantity, amount_inr AS "amountInr", payer_country AS "payerCountry", status, expires_at AS "expiresAt"
             FROM awara_bookings WHERE reference=$1 FOR UPDATE`, [reference],
        );
        const booking = found.rows[0];
        if (!booking || booking.payerCountry !== "IN" || booking.status !== "awaiting_staff" || !booking.expiresAt || new Date(booking.expiresAt).getTime() <= Date.now()) {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: "This request is no longer awaiting manual confirmation." });
        }
        const dayList = isoDays(booking.checkIn, booking.checkOut);
        for (const day of dayList) await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${day}:${["cooler","ac","twoBhk"].includes(booking.stayType) ? "private_rooms" : booking.stayType}`]);
        for (const day of dayList) {
          if (booking.stayType === "twoBhk") {
            const physical = await client.query(
              `SELECT types.stay_type,
                      COALESCE(i.capacity,1)::int AS capacity,
                      COALESCE(i.blocked,0)::int AS blocked,
                      COALESCE(SUM(b.quantity),0)::int AS booked
                 FROM (VALUES ('cooler'::text),('ac'::text)) types(stay_type)
                 LEFT JOIN awara_inventory i ON i.stay_date=$1::date AND i.stay_type=types.stay_type
                 LEFT JOIN awara_bookings b ON b.stay_type IN (types.stay_type,'twoBhk')
                      AND b.id<>$2::uuid AND b.status IN ('awaiting_staff','pending_payment','confirmed')
                      AND (b.expires_at IS NULL OR b.expires_at>now())
                      AND b.check_in<=$1::date AND b.check_out>$1::date
                GROUP BY types.stay_type,i.capacity,i.blocked`, [day, booking.id],
            );
            if (physical.rows.some((room) => room.capacity - room.blocked - room.booked < 1)) throw Object.assign(new Error(`The 2BHK is no longer free on ${day}.`), { publicStatus: 409 });
          } else {
            const available = await client.query(
              `SELECT COALESCE(i.capacity,$3::int)::int AS capacity, COALESCE(i.blocked,0)::int AS blocked,
                      COALESCE(SUM(b.quantity),0)::int AS booked
                 FROM (SELECT $1::date AS stay_date) d
                 LEFT JOIN awara_inventory i ON i.stay_date=d.stay_date AND i.stay_type=$2
                 LEFT JOIN awara_bookings b ON b.stay_type=$2 AND b.id<>$4::uuid
                      AND b.status IN ('awaiting_staff','pending_payment','confirmed')
                      AND (b.expires_at IS NULL OR b.expires_at>now())
                      AND b.check_in<=d.stay_date AND b.check_out>d.stay_date
                GROUP BY i.capacity,i.blocked`, [day, booking.stayType, DEFAULT_CAPACITY[booking.stayType], booking.id],
            );
            const stock = available.rows[0];
            if (stock.capacity - stock.blocked - stock.booked < booking.quantity) throw Object.assign(new Error(`Inventory is no longer free on ${day}.`), { publicStatus: 409 });
          }
        }
      const updated = await client.query(
          `UPDATE awara_bookings SET status='confirmed', payment_provider='manual', expires_at=NULL, updated_at=now()
            WHERE id=$1::uuid AND status='awaiting_staff' RETURNING reference`, [booking.id],
        );
        if (!updated.rowCount) throw Object.assign(new Error("This request changed. Refresh and try again."), { publicStatus: 409 });
        const receipt = await insertPayment(client, { bookingId: booking.id, totalAmount: Number(booking.amountInr || 0), amountPaid: Number(booking.amountInr || 0), method: "other", note: "Manual payment verified by staff" });
        await client.query("COMMIT");
        return res.status(200).json({ reference, status: "confirmed", receipt });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        if (error.publicStatus) return res.status(error.publicStatus).json({ error: error.message });
        if (error.code === "40001") return res.status(409).json({ error: "Availability changed. Refresh and review this request again." });
        throw error;
      } finally { client.release(); }
    }
    if (body.action === "approve-2bhk") {
      const reference = String(body.reference || "").trim();
      const client = await db.connect();
      let booking;
      try {
        await client.query("BEGIN");
        const found = await client.query("SELECT id, reference, amount_inr, status, expires_at, payer_country, guest_name, guest_email, phone FROM awara_bookings WHERE reference=$1 AND stay_type='twoBhk' FOR UPDATE", [reference]);
        booking = found.rows[0];
        if (!booking || booking.status !== "awaiting_staff" || !booking.expires_at || new Date(booking.expires_at).getTime() <= Date.now()) {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: "This 2BHK request is no longer awaiting staff action." });
        }
        if (booking.payer_country === "IN") {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: "Domestic online checkout is not active. Confirm this booking only after you verify manual payment." });
        }
        let fx = null;
        let amountUsd = null;
        fx = await getUsdInrRate();
        amountUsd = toUsd(Number(booking.amount_inr), fx.inrPerUsd);
        const expiresAt = new Date(Date.now() + 6 * 3600000);
        await client.query("UPDATE awara_bookings SET status='pending_payment', amount_usd=$2, fx_rate=$3, fx_checked_at=$4, payment_provider=$5, expires_at=$6, updated_at=now() WHERE id=$1::uuid AND status='awaiting_staff' AND expires_at>now()", [booking.id, amountUsd, fx && fx.inrPerUsd, fx && fx.checkedAt, booking.payer_country === "IN" ? "payu" : "paypal", expiresAt.toISOString()]);
        await client.query("COMMIT");
        const quote = { iss: "awara", quoteId: crypto.randomBytes(12).toString("hex"), bookingId: booking.id, reference, amount: amountUsd, amountInr: String(booking.amount_inr), fxRate: String(fx.inrPerUsd), currency: "USD", exp: Math.floor(expiresAt.getTime() / 1000) };
        return res.status(200).json({ status: "pending_payment", reference, paymentUrl: `https://www.awarahostels.com/pay.html?q=${encodeURIComponent(signQuote(quote))}`, expiresAt: expiresAt.toISOString() });
      } catch (error) {
        if (client) await client.query("ROLLBACK").catch(() => {});
        if (booking) {
          await db.query("UPDATE awara_bookings SET status='awaiting_staff', payment_order_id=NULL, expires_at=now()+interval '24 hours', updated_at=now() WHERE id=$1::uuid AND status='pending_payment' AND payment_order_id IS NULL", [booking.id]).catch(() => {});
        }
        console.error("[admin-2bhk]", error && error.message ? error.message : "approval error");
        return res.status(503).json({ error: "Could not approve and quote this 2BHK request." });
      } finally { client.release(); }
    }
    if (body.action === "cancel") {
      const reference = String(body.reference || "").trim();
      const result = await db.query(
        `UPDATE awara_bookings SET status='cancelled', updated_at=now()
          WHERE reference=$1 AND (status IN ('awaiting_staff','pending_payment','expired') OR (status='confirmed' AND source <> 'website' AND payment_capture_id IS NULL))
          RETURNING reference`, [reference],
      );
      if (!result.rowCount) return res.status(409).json({ error: "Paid online bookings need payment review before cancellation. Check the payment provider first." });
      return res.status(200).json({ reference, status: "cancelled" });
    }
    return res.status(400).json({ error: "Choose a supported staff action." });
  } catch (error) {
    console.error("[admin-bookings]", error && error.message ? error.message : "database error");
    return res.status(503).json({ error: "Staff booking service is temporarily unavailable." });
  } finally {
    if (database) await database.end().catch(() => {});
  }
};
