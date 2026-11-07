const { accessToken, checkOrigin, paypalRequest, secureHeaders, verifyQuote } = require("../../lib/paypal");
const { ensureSchema, getPool } = require("../../lib/booking-store");

module.exports = async function handler(req, res) {
  secureHeaders(res);
  if (req.method === "OPTIONS") {
    if (!checkOrigin(req, res)) return res.status(403).end();
    return res.status(204).end();
  }
  if (!checkOrigin(req, res)) return res.status(403).json({ error: "Request origin not allowed." });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  let database;
  try {
    const quote = verifyQuote(req.body && req.body.token);
    if (quote.bookingId) {
      database = getPool();
      await ensureSchema(database);
      const booking = await database.query(
        "SELECT reference, status, amount_inr::text AS amount_inr, amount_usd::text AS amount_usd, expires_at FROM awara_bookings WHERE id=$1::uuid",
        [quote.bookingId],
      );
      const row = booking.rows[0];
      if (!row || row.reference !== quote.reference || row.status !== "pending_payment" || Number(row.amount_usd) !== Number(quote.amount) || Number(row.amount_inr) !== Number(quote.amountInr) || new Date(row.expires_at).getTime() <= Date.now()) {
        return res.status(409).json({ error: "This booking payment link is no longer active. Ask Awara for help." });
      }
    }
    const bearer = await accessToken();
    const order = await paypalRequest("/v2/checkout/orders", bearer, {
      method: "POST",
      headers: { "PayPal-Request-Id": `o${quote.quoteId}` },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [{
          reference_id: quote.quoteId,
          invoice_id: quote.quoteId,
          custom_id: quote.reference,
          description: `Awara Hostels booking ${quote.reference}`,
          amount: { currency_code: "USD", value: quote.amount },
        }],
        payment_source: { paypal: { experience_context: {
          brand_name: "Awara Hostels & Dormitory",
          landing_page: "LOGIN",
          user_action: "PAY_NOW",
          shipping_preference: "NO_SHIPPING",
          return_url: "https://www.awarahostels.com/pay.html",
          cancel_url: "https://www.awarahostels.com/pay.html",
        } } },
      }),
    });
    if (!order.id || !["CREATED", "PAYER_ACTION_REQUIRED", "APPROVED"].includes(order.status)) throw new Error("PayPal did not create a valid payment order.");
    if (quote.bookingId) {
      const saved = await database.query(
        "UPDATE awara_bookings SET payment_order_id=$2, payment_provider='paypal', updated_at=now() WHERE id=$1::uuid AND status='pending_payment' AND expires_at>now() AND (payment_order_id IS NULL OR payment_order_id=$2) RETURNING id",
        [quote.bookingId, order.id],
      );
      if (!saved.rowCount) return res.status(409).json({ error: "This booking payment link is no longer active. Ask Awara for help." });
    }
    return res.status(200).json({ id: order.id });
  } catch (error) {
    const message = /quote|expired/i.test(error.message || "") ? error.message : "Could not start PayPal checkout. Please contact Awara.";
    return res.status(400).json({ error: message });
  } finally {
    if (database) await database.end().catch(() => {});
  }
};
