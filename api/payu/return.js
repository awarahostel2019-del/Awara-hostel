const { ensureSchema, getPool } = require("../../lib/booking-store");
const { verifyPayment } = require("../../lib/payu");

function html(value) {
  return String(value || "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function resultPage(res, title, message, reference = "") {
  const safeReference = html(reference);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  return res.status(200).send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${html(title)} | Awara Hostels</title><body style="font:16px system-ui,sans-serif;max-width:680px;margin:12vh auto;padding:24px;color:#172033"><h1>${html(title)}</h1><p>${html(message)}</p>${safeReference ? `<p>Booking reference: <strong>${safeReference}</strong></p>` : ""}<p>Questions? <a href="https://wa.me/918933013188">Contact Awara on WhatsApp</a> or call <a href="tel:+915224738695">0522-4738695</a>.</p><p><a href="https://www.awarahostels.com/">Return to Awara Hostels</a></p></body></html>`);
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!["GET", "POST"].includes(req.method)) return res.status(405).send("Method not allowed.");
  const payload = { ...(req.query || {}), ...(req.body && typeof req.body === "object" ? req.body : {}) };
  const txnId = String(payload.txnId || payload.txnid || payload.transactionId || "").trim().slice(0, 50);
  if (!/^[A-Za-z0-9_-]{8,50}$/.test(txnId)) return resultPage(res, "Payment not confirmed", "We could not identify this PayU transaction. Please contact Awara before retrying.");

  let database;
  let reference = "";
  try {
    database = getPool();
    await ensureSchema(database);
    const lookup = await database.query(
      "SELECT id, reference, status, payment_provider, payment_order_id, amount_inr::text AS amount_inr, expires_at FROM awara_bookings WHERE payment_order_id=$1 AND payment_provider='payu'",
      [txnId],
    );
    const booking = lookup.rows[0];
    if (!booking) return resultPage(res, "Payment not matched", "The payment reference did not match a current booking. Please contact Awara before making another payment.");
    reference = booking.reference;

    const verified = await verifyPayment(txnId);
    const validAmount = verified && Number(verified.originalAmount ?? verified.amount) === Number(booking.amount_inr);
    const validSuccess = verified && verified.txnId === txnId && verified.status === "success" && verified.unmappedStatus === "captured" && (verified.originalCurrency || "INR") === "INR" && validAmount;
    if (validSuccess) {
      const confirmed = await database.query(
        `UPDATE awara_bookings
            SET status='confirmed', payment_capture_id=$2, updated_at=now()
          WHERE id=$1::uuid AND payment_provider='payu' AND payment_order_id=$3
            AND status='pending_payment' AND expires_at>now()
          RETURNING reference`,
        [booking.id, String(verified.mihpayId || "").slice(0, 100), txnId],
      );
      if (confirmed.rowCount) return resultPage(res, "Booking confirmed", "PayU has verified your full payment. Your Awara Hostels booking is confirmed.", reference);
      if (booking.status === "confirmed") return resultPage(res, "Booking confirmed", "PayU has verified your full payment. Your Awara Hostels booking is confirmed.", reference);
      return resultPage(res, "Payment received · confirmation needed", "PayU reports successful payment, but the booking hold needs staff review. Contact Awara now and share your booking reference.", reference);
    }

    const failed = verified && ["failure", "failed", "bounced", "usercancelled", "user_cancelled"].includes(String(verified.status || verified.unmappedStatus || "").toLowerCase());
    if (failed && booking.status === "pending_payment") {
      await database.query("UPDATE awara_bookings SET status='cancelled', updated_at=now() WHERE id=$1::uuid AND status='pending_payment' AND payment_order_id=$2", [booking.id, txnId]);
      return resultPage(res, "Payment not completed", "PayU did not complete this payment. You can return to Awara and submit a fresh booking request.", reference);
    }
    return resultPage(res, "Payment is still being checked", "PayU has not yet returned a confirmed payment result. Do not pay again yet; contact Awara with your booking reference.", reference);
  } catch (error) {
    console.error("[payu-return]", error && error.message ? error.message : "verification failed");
    return resultPage(res, "Payment needs review", "We could not verify the payment right now. Do not pay again yet; contact Awara and share your booking reference.", reference);
  } finally {
    if (database) await database.end().catch(() => {});
  }
};
