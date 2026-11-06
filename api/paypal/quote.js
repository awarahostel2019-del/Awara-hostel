const crypto = require("node:crypto");
const { checkOrigin, getAdminKey, secureHeaders, signQuote } = require("../../lib/paypal");

module.exports = function handler(req, res) {
  secureHeaders(res);
  if (req.method === "OPTIONS") {
    if (!checkOrigin(req, res)) return res.status(403).end();
    return res.status(204).end();
  }
  if (!checkOrigin(req, res)) return res.status(403).json({ error: "Request origin not allowed." });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    if (!getAdminKey(req)) return res.status(401).json({ error: "Awara authorization required." });
    const { reference, amount, expiresInHours = 6 } = req.body || {};
    const cleanReference = String(reference || "").trim();
    const numericAmount = Number(amount);
    const hours = Number(expiresInHours);
    if (!/^[A-Za-z0-9-]{3,40}$/.test(cleanReference)) return res.status(400).json({ error: "Use a booking reference with 3–40 letters, numbers or hyphens." });
    if (!Number.isFinite(numericAmount) || numericAmount < 1 || numericAmount > 10000 || Math.round(numericAmount * 100) !== numericAmount * 100) return res.status(400).json({ error: "Enter a USD amount from 1.00 to 10,000.00." });
    if (![1, 6, 12, 24].includes(hours)) return res.status(400).json({ error: "Choose a quote expiry of 1, 6, 12 or 24 hours." });
    const quote = {
      iss: "awara",
      quoteId: crypto.randomBytes(12).toString("hex"),
      reference: cleanReference,
      amount: numericAmount.toFixed(2),
      currency: "USD",
      exp: Math.floor(Date.now() / 1000) + hours * 3600,
    };
    return res.status(200).json({ token: signQuote(quote), expiresAt: new Date(quote.exp * 1000).toISOString(), amount: quote.amount, currency: quote.currency, reference: quote.reference });
  } catch (error) {
    console.error("[paypal-quote]", error && error.message ? error.message : "unknown error");
    return res.status(503).json({ error: "PayPal payment links are not configured yet." });
  }
};
