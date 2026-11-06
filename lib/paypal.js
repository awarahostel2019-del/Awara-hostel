const crypto = require("node:crypto");

const MAX_AMOUNT_USD = 10000;
const ALLOWED_ORIGINS = new Set(["https://awarahostels.com", "https://www.awarahostels.com"]);

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function secureHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Vary", "Origin");
}

function checkOrigin(req, res) {
  const origin = req.headers.origin;
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return false;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Vary", "Origin");
  return true;
}

function getAdminKey(req) {
  const expected = requireEnv("PAYPAL_ADMIN_KEY");
  const received = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function signQuote(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", requireEnv("PAYPAL_ADMIN_KEY")).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function verifyQuote(token) {
  if (typeof token !== "string" || token.length > 1800) throw new Error("Payment quote is invalid.");
  const parts = token.split(".");
  if (parts.length !== 2) throw new Error("Payment quote is invalid.");
  const [body, signature] = parts;
  const expected = crypto.createHmac("sha256", requireEnv("PAYPAL_ADMIN_KEY")).update(body).digest();
  let actual;
  try { actual = Buffer.from(signature, "base64url"); } catch { throw new Error("Payment quote is invalid."); }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) throw new Error("Payment quote is invalid.");
  let payload;
  try { payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { throw new Error("Payment quote is invalid."); }
  const amount = Number(payload.amount);
  if (payload.iss !== "awara" || typeof payload.reference !== "string" || !/^[A-Za-z0-9-]{3,40}$/.test(payload.reference)) throw new Error("Payment quote is invalid.");
  if (!/^[a-f0-9]{24}$/.test(payload.quoteId || "") || payload.currency !== "USD") throw new Error("Payment quote is invalid.");
  if (!Number.isFinite(amount) || amount < 1 || amount > MAX_AMOUNT_USD || amount.toFixed(2) !== payload.amount) throw new Error("Payment quote is invalid.");
  if (!Number.isInteger(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000) || payload.exp > Math.floor(Date.now() / 1000) + 86400) throw new Error("Payment quote has expired.");
  return payload;
}

function getApiBase() {
  const mode = process.env.PAYPAL_ENV;
  if (mode === "live") return "https://api-m.paypal.com";
  if (mode === "sandbox") return "https://api-m.sandbox.paypal.com";
  throw new Error("PayPal environment is not configured.");
}

async function accessToken() {
  const credentials = Buffer.from(`${requireEnv("PAYPAL_CLIENT_ID")}:${requireEnv("PAYPAL_CLIENT_SECRET")}`).toString("base64");
  const response = await fetch(`${getApiBase()}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${credentials}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) throw new Error("PayPal authorization failed.");
  return data.access_token;
}

async function paypalRequest(path, token, options = {}) {
  const response = await fetch(`${getApiBase()}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error("[paypal-api]", response.status, data.name || "request failed");
    throw new Error("PayPal could not process this payment. Please contact Awara.");
  }
  return data;
}

function getCurrencyAmount(order) {
  const purchase = order && order.purchase_units && order.purchase_units[0];
  const amount = purchase && (purchase.amount || (purchase.payments && purchase.payments.captures && purchase.payments.captures[0] && purchase.payments.captures[0].amount));
  return amount ? { currency: amount.currency_code, value: amount.value } : null;
}

module.exports = {
  MAX_AMOUNT_USD,
  accessToken,
  checkOrigin,
  getAdminKey,
  getApiBase,
  getCurrencyAmount,
  paypalRequest,
  requireEnv,
  secureHeaders,
  signQuote,
  verifyQuote,
};
