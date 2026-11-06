const { accessToken, checkOrigin, paypalRequest, secureHeaders, verifyQuote } = require("../../lib/paypal");

module.exports = async function handler(req, res) {
  secureHeaders(res);
  if (req.method === "OPTIONS") {
    if (!checkOrigin(req, res)) return res.status(403).end();
    return res.status(204).end();
  }
  if (!checkOrigin(req, res)) return res.status(403).json({ error: "Request origin not allowed." });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const quote = verifyQuote(req.body && req.body.token);
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
    return res.status(200).json({ id: order.id });
  } catch (error) {
    const message = /quote|expired/i.test(error.message || "") ? error.message : "Could not start PayPal checkout. Please contact Awara.";
    return res.status(400).json({ error: message });
  }
};
