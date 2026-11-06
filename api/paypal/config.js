const { secureHeaders } = require("../../lib/paypal");

module.exports = function handler(req, res) {
  secureHeaders(res);
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const enabled = Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET && process.env.PAYPAL_ADMIN_KEY && ["live", "sandbox"].includes(process.env.PAYPAL_ENV));
  if (!enabled) return res.status(503).json({ enabled: false, error: "PayPal Checkout is being configured. Please contact Awara for payment." });
  return res.status(200).json({ enabled: true, clientId: process.env.PAYPAL_CLIENT_ID, environment: process.env.PAYPAL_ENV });
};
