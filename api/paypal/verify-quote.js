const { secureHeaders, verifyQuote } = require("../../lib/paypal");

module.exports = function handler(req, res) {
  secureHeaders(res);
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const quote = verifyQuote(String(req.query.token || ""));
    return res.status(200).json({ reference: quote.reference, amount: quote.amount, amountInr: quote.amountInr || null, currency: quote.currency, bookingId: quote.bookingId || null, expiresAt: new Date(quote.exp * 1000).toISOString() });
  } catch (error) {
    return res.status(400).json({ error: /expired/i.test(error.message || "") ? "This payment quote has expired. Ask Awara for a new link." : "This payment quote is invalid. Ask Awara for a new link." });
  }
};
