const crypto = require("node:crypto");

function credentials() {
  const key = String(process.env.PAYU_MERCHANT_KEY || "").trim();
  const secret = String(process.env.PAYU_MERCHANT_SECRET || "").trim();
  const env = String(process.env.PAYU_ENV || "").trim().toLowerCase();
  if (!key || !secret || !["test", "live"].includes(env)) {
    throw new Error("PayU merchant credentials are not configured.");
  }
  return { key, secret, env };
}

function authHeaders(body, { key, secret }) {
  const date = new Date().toUTCString();
  const signature = crypto.createHash("sha512").update(`${body}|${date}|${secret}`).digest("hex");
  return {
    "content-type": "application/json",
    date,
    authorization: `hmac username="${key}", algorithm="sha512", headers="date", signature="${signature}"`,
  };
}

async function callPayU(path, body, mode) {
  const creds = credentials();
  const base = path === "/v2/payments"
    ? (mode === "live" ? "https://api.payu.in" : "https://apitest.payu.in")
    : (mode === "live" ? "https://info.payu.in" : "https://test.payu.in");
  const bodyText = JSON.stringify(body);
  const headers = authHeaders(bodyText, creds);
  if (path === "/v3/transaction") headers["Info-Command"] = "verify_payment";
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers,
    body: bodyText,
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error("[payu-api] request failed", response.status);
    throw new Error("PayU request failed.");
  }
  return data;
}

function makeTxnId() {
  return `AWR${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(8).toString("hex").toUpperCase()}`.slice(0, 48);
}

async function createCheckout({ booking, siteUrl }) {
  const { key, env } = credentials();
  const txnId = makeTxnId();
  const [firstName, ...rest] = String(booking.guest_name).trim().split(/\s+/);
  const payload = {
    accountId: key,
    txnId,
    currency: "INR",
    order: {
      productInfo: `Awara Hostels stay ${booking.reference}`,
      paymentChargeSpecification: { price: Number(booking.amount_inr) },
      userDefinedFields: { udf1: booking.reference },
    },
    billingDetails: {
      firstName: firstName || "Guest",
      lastName: rest.join(" "),
      email: booking.guest_email,
      phone: booking.phone,
      address1: "Akbar Mansion, Chowk",
      city: "Lucknow",
      state: "Uttar Pradesh",
      country: "India",
      zipCode: "226003",
    },
    callBackActions: {
      successAction: `${siteUrl}/api/payu/return`,
      failureAction: `${siteUrl}/api/payu/return`,
      cancelAction: `${siteUrl}/api/payu/return`,
    },
    additionalInfo: { txnFlow: "nonseamless", createOrder: true, orderId: booking.reference },
  };
  const data = await callPayU("/v2/payments", payload, env);
  const checkoutUrl = data && data.result && data.result.checkoutUrl;
  let checkoutHost = "";
  try { checkoutHost = new URL(checkoutUrl).hostname; } catch {}
  if (!checkoutUrl || !checkoutHost.endsWith(".payu.in") || data.status !== "PENDING") {
    console.error("[payu-api] checkout URL missing or unexpected response");
    throw new Error("PayU did not return a checkout link.");
  }
  return { txnId, checkoutUrl };
}

async function verifyPayment(txnId) {
  const { env } = credentials();
  const response = await callPayU("/v3/transaction", { txnId: [txnId] }, env);
  const result = Array.isArray(response.result) ? response.result[0] : response.result;
  return result && typeof result === "object" ? result : null;
}

module.exports = { createCheckout, credentials, verifyPayment };
