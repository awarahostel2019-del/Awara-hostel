const { accessToken, checkOrigin, getCurrencyAmount, paypalRequest, secureHeaders, verifyQuote } = require("../../lib/paypal");
const { ensureSchema, getPool } = require("../../lib/booking-store");

module.exports = async function handler(req, res) {
  secureHeaders(res);
  if (req.method === "OPTIONS") {
    if (!checkOrigin(req, res)) return res.status(403).end();
    return res.status(204).end();
  }
  if (!checkOrigin(req, res)) return res.status(403).json({ error: "Request origin not allowed." });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  let paymentReceived = false;
  let paymentReference = "";
  let paymentCapture = "";
  let paymentValue = "";
  let paymentCurrency = "";
  let database;
  try {
    const quote = verifyQuote(req.body && req.body.token);
    const orderId = String(req.body && req.body.orderId || "");
    if (!/^[A-Z0-9-]{10,40}$/.test(orderId)) return res.status(400).json({ error: "PayPal order is invalid." });
    let booking = null;
    if (quote.bookingId) {
      database = getPool();
      await ensureSchema(database);
      const found = await database.query(
        "SELECT id, reference, status, payment_provider, payment_order_id, amount_inr::text AS amount_inr, amount_usd::text AS amount_usd, expires_at, payment_capture_id FROM awara_bookings WHERE id=$1::uuid",
        [quote.bookingId],
      );
      booking = found.rows[0];
      if (!booking || booking.reference !== quote.reference || booking.payment_order_id !== orderId || booking.payment_provider !== "paypal" || Number(booking.amount_usd) !== Number(quote.amount) || Number(booking.amount_inr) !== Number(quote.amountInr)) {
        return res.status(409).json({ error: "This PayPal order is not linked to the current Awara booking." });
      }
      if (booking.status !== "pending_payment" && !(booking.status === "confirmed" && booking.payment_capture_id)) {
        return res.status(409).json({ error: "This booking is no longer awaiting payment. Contact Awara before retrying." });
      }
    }
    const bearer = await accessToken();
    const order = await paypalRequest(`/v2/checkout/orders/${encodeURIComponent(orderId)}`, bearer);
    if (order.purchase_units?.[0]?.invoice_id !== quote.quoteId || order.purchase_units?.[0]?.custom_id !== quote.reference) return res.status(400).json({ error: "This payment does not match the Awara quote." });
    const amount = getCurrencyAmount(order);
    if (!amount || amount.currency !== quote.currency || amount.value !== quote.amount) return res.status(400).json({ error: "The PayPal amount does not match the confirmed quote." });
    if (booking && booking.status === "pending_payment" && (!booking.expires_at || new Date(booking.expires_at).getTime() <= Date.now())) {
      return res.status(409).json({ error: "This booking hold has expired. No PayPal capture was requested; contact Awara to check availability." });
    }
    let result = order;
    if (order.status !== "COMPLETED") {
      if (order.status !== "APPROVED") return res.status(409).json({ error: "PayPal has not approved this payment yet." });
      result = await paypalRequest(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, bearer, {
        method: "POST",
        headers: { "PayPal-Request-Id": `c${quote.quoteId}` },
        body: "{}",
      });
    }
    if (result.status !== "COMPLETED") return res.status(402).json({ error: "PayPal did not complete the payment." });
    paymentReceived = true;
    paymentReference = quote.reference;
    paymentValue = quote.amount;
    paymentCurrency = quote.currency;
    const captured = getCurrencyAmount(result);
    if (!captured || captured.currency !== quote.currency || captured.value !== quote.amount) return res.status(409).json({ error: "Captured payment did not match the quote. Please contact Awara." });
    const captureId = result.purchase_units?.[0]?.payments?.captures?.[0]?.id || "";
    paymentCapture = captureId;
    if (!captureId) return res.status(409).json({ error: "PayPal completed this order without a capture reference. Contact Awara before retrying." });
    let bookingConfirmed = false;
    if (booking) {
      if (booking.status === "confirmed" && booking.payment_capture_id) {
        bookingConfirmed = true;
      } else {
        const updated = await database.query(
          `UPDATE awara_bookings
              SET status='confirmed', payment_capture_id=$2, expires_at=NULL, updated_at=now()
            WHERE id=$1::uuid AND reference=$3 AND status='pending_payment' AND payment_order_id=$4 AND expires_at>now()
            RETURNING id`,
          [quote.bookingId, captureId, quote.reference, orderId],
        );
        bookingConfirmed = Boolean(updated.rowCount);
        if (!bookingConfirmed) {
          const current = await database.query(
            "SELECT status, payment_capture_id FROM awara_bookings WHERE id=$1::uuid AND payment_order_id=$2",
            [quote.bookingId, orderId],
          );
          bookingConfirmed = current.rows[0]?.status === "confirmed" && current.rows[0]?.payment_capture_id === captureId;
        }
      }
      if (!bookingConfirmed) {
        return res.status(202).json({ status: "COMPLETED", reference: quote.reference, amount: quote.amount, currency: quote.currency, captureId, bookingConfirmed: false, message: "Payment was received, but the booking needs staff review. Contact Awara with this reference." });
      }
      const existingReceipt = await database.query("SELECT 1 FROM awara_payments WHERE provider_reference=$1", [captureId]);
      if (!existingReceipt.rowCount) {
        const sequence = await database.query("SELECT nextval('awara_receipt_sequence')::text AS value");
        const receiptNumber = `AWR-${new Date().getFullYear()}-${String(sequence.rows[0].value).padStart(6, "0")}`;
        await database.query(
          `INSERT INTO awara_payments(booking_id,receipt_number,amount_inr,method,kind,provider_reference,note)
           VALUES($1::uuid,$2,$3,'paypal','full',$4,'PayPal payment verified online') ON CONFLICT(provider_reference) DO NOTHING`,
          [quote.bookingId, receiptNumber, Number(quote.amountInr), captureId],
        );
      }
    }
    return res.status(200).json({ status: "COMPLETED", reference: quote.reference, amount: quote.amount, currency: quote.currency, captureId, bookingConfirmed });
  } catch (error) {
    if (paymentReceived) {
      console.error("[paypal-capture-confirmation] payment received; booking update needs review", error && error.message ? error.message : "database error");
      return res.status(202).json({ status: "COMPLETED", reference: paymentReference, amount: paymentValue, currency: paymentCurrency, captureId: paymentCapture, bookingConfirmed: false, message: "PayPal received payment, but booking confirmation needs staff review. Contact Awara with this reference." });
    }
    const message = /quote|expired/i.test(error.message || "") ? error.message : "Could not verify this PayPal payment. Please contact Awara.";
    return res.status(400).json({ error: message });
  } finally {
    if (database) await database.end().catch(() => {});
  }
};
