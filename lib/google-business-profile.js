const crypto = require("node:crypto");

const BUSINESS_SCOPE = "https://www.googleapis.com/auth/business.manage";
const CALLBACK_URL = "https://awarahostels.com/api/google/callback";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing configuration: ${name}`);
  return value;
}

function tokenKey() {
  const key = Buffer.from(requireEnv("GBP_TOKEN_ENCRYPTION_KEY"), "base64");
  if (key.length !== 32) throw new Error("Invalid token encryption configuration");
  return key;
}

function encryptRefreshToken(token) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", tokenKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
}

function decryptRefreshToken(value) {
  const parts = String(value || "").split(".");
  if (parts.length !== 3) throw new Error("Invalid saved Google connection");
  const [iv, tag, ciphertext] = parts.map((part) => Buffer.from(part, "base64url"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", tokenKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function securePageHeaders(res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
}

async function exchangeCode(code, redirectUri = CALLBACK_URL) {
  const body = new URLSearchParams({
    code,
    client_id: requireEnv("GOOGLE_CLIENT_ID"),
    client_secret: requireEnv("GOOGLE_CLIENT_SECRET"),
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = typeof result.error === "string" ? result.error : String(response.status);
    throw new Error(`Google authorization could not be completed (${code})`);
  }
  return result;
}

async function getAccessToken() {
  const refreshToken = decryptRefreshToken(requireEnv("GBP_REFRESH_TOKEN_ENC"));
  const body = new URLSearchParams({
    client_id: requireEnv("GOOGLE_CLIENT_ID"),
    client_secret: requireEnv("GOOGLE_CLIENT_SECRET"),
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.access_token) throw new Error("Google authorization needs to be renewed");
  return result.access_token;
}

async function googleJson(url, accessToken, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${accessToken}`, ...(options.headers || {}) },
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Google Business Profile request failed (${response.status})`);
  return result;
}

async function findAwaraLocation(accessToken) {
  const accountData = await googleJson("https://mybusinessaccountmanagement.googleapis.com/v1/accounts?pageSize=100", accessToken);
  const matches = [];
  for (const account of accountData.accounts || []) {
    if (!/^accounts\/[A-Za-z0-9_-]+$/.test(account.name || "")) continue;
    const url = `https://mybusinessbusinessinformation.googleapis.com/v1/${account.name}/locations?readMask=name,title,storefrontAddress&pageSize=100`;
    const data = await googleJson(url, accessToken);
    for (const location of data.locations || []) {
      const title = (location.title || "").toLowerCase();
      const address = location.storefrontAddress || {};
      const addressText = [
        ...(address.addressLines || []),
        address.locality,
        address.administrativeArea,
        address.postalCode,
      ].filter(Boolean).join(" ").toLowerCase();
      if (title.includes("awara hostels") && addressText.includes("chowk") && addressText.includes("akbar mansion")) {
        matches.push({ accountName: account.name, locationName: location.name, title: location.title });
      }
    }
  }
  if (matches.length !== 1) throw new Error(matches.length ? "More than one Awara location matched" : "Awara's Chowk location was not found");
  return matches[0];
}

async function listReviews(accessToken, accountName, locationName, maxPages = 1) {
  const reviews = [];
  let pageToken = "";
  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL(`https://mybusiness.googleapis.com/v4/${accountName}/${locationName}/reviews`);
    url.searchParams.set("pageSize", "50");
    url.searchParams.set("orderBy", "updateTime desc");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const data = await googleJson(url.toString(), accessToken);
    reviews.push(...(data.reviews || []));
    pageToken = data.nextPageToken || "";
    if (!pageToken) break;
  }
  return reviews;
}

function replyForReview(review) {
  const rating = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 }[review.starRating] || 0;
  if (rating <= 2) {
    return "Thank you for sharing your feedback. We’re sorry your stay did not meet expectations. Please contact Awara Hostels at +91 89330 13188 so we can understand your concerns and improve.";
  }
  if (rating === 3) {
    return "Thank you for your feedback. We appreciate you choosing Awara Hostels and will keep working to make every stay better. You can contact us at +91 89330 13188 if you would like to share more.";
  }
  return "Thank you for staying with Awara Hostels & Dormitory and for sharing your experience. We appreciate your review and hope to welcome you again in Lucknow.";
}

function getCookie(req, name) {
  const cookies = (req.headers.cookie || "").split(";");
  const item = cookies.map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return item ? decodeURIComponent(item.slice(name.length + 1)) : "";
}

module.exports = {
  BUSINESS_SCOPE,
  CALLBACK_URL,
  encryptRefreshToken,
  exchangeCode,
  findAwaraLocation,
  getAccessToken,
  getCookie,
  googleJson,
  listReviews,
  replyForReview,
  requireEnv,
  securePageHeaders,
};
