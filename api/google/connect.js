const crypto = require("node:crypto");
const { BUSINESS_SCOPE, CALLBACK_URL, requireEnv, securePageHeaders } = require("../../lib/google-business-profile");

module.exports = function handler(req, res) {
  securePageHeaders(res);
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const state = crypto.randomBytes(32).toString("hex");
    res.setHeader("Set-Cookie", `awara_gbp_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/api/google; Max-Age=600`);
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: requireEnv("GOOGLE_CLIENT_ID"),
      redirect_uri: CALLBACK_URL,
      response_type: "code",
      scope: BUSINESS_SCOPE,
      access_type: "offline",
      prompt: "consent",
      state,
    }).toString();
    return res.redirect(302, url.toString());
  } catch {
    return res.status(503).json({ error: "Google reviews are not connected yet." });
  }
};
