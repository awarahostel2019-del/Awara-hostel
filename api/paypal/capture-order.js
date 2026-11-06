const { accessToken, checkOrigin, getCurrencyAmount, paypalRequest, secureHeaders, verifyQuote } = require("../../lib/paypal");

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
    const orderId = String(req.body && req.body.orderId || "");
    if (!/^[A-Z0-9-]{10,40}$/.test(orderId)) return res.status(400).json({ error: "PayPal order is invalid." });
    const bearer = await accessToken();
    const order = await paypalRequest(`/v2/checkout/orders/${encodeURIComponent(orderId)}`, bearer);
    if (order.purchase_units?.[0]?.invoice_id !== quote.quoteId || order.purchase_units?.[0]?.custom_id !== quote.reference) return res.status(400).json({ error: "This payment does not match the Awara quote." });
    const amount = getCurrencyAmount(order);
    if (!amount || amount.currency !== quote.currency || amount.value !== quote.amount) return res.status(400).json({ error: "The PayPal amount does not match the confirmed quote." });
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
    const captured = getCurrencyAmount(result);
    if (!captured || captured.currency !== quote.currency || captured.value !== quote.amount) return res.status(409).json({ error: "Captured payment did not match the quote. Please contact Awara." });
    return res.status(200).json({ status: "COMPLETED", reference: quote.reference, amount: quote.amount, currency: quote.currency, captureId: result.purchase_units?.[0]?.payments?.captures?.[0]?.id || "" });
  } catch (error) {
    const message = /quote|expired/i.test(error.message || "") ? error.message : "Could not verify this PayPal payment. Please contact Awara.";
    return res.status(400).json({ error: message });
  }
};
