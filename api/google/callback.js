const {
  CALLBACK_URL,
  encryptRefreshToken,
  exchangeCode,
  getCookie,
  securePageHeaders,
} = require("../../lib/google-business-profile");

function page(title, message, encryptedToken = "") {
  const token = encryptedToken.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:16px system-ui,sans-serif;max-width:720px;margin:10vh auto;padding:24px;color:#17203d;background:#fbf7ef}main{background:#fff;padding:28px;border-radius:16px;border:1px solid #e6dcc6}h1{font-size:26px}textarea{width:100%;min-height:100px;box-sizing:border-box}button{padding:12px 18px;background:#c9961a;border:0;border-radius:24px;font-weight:700;margin-top:12px}p{line-height:1.6}</style><main><h1>${title}</h1><p>${message}</p>${token ? `<label for="token">Encrypted refresh token (copy into Vercel as <code>GBP_REFRESH_TOKEN_ENC</code>)</label><p><textarea id="token" readonly>${token}</textarea></p><button type="button" onclick="navigator.clipboard.writeText(document.getElementById('token').value)">Copy encrypted token</button>` : ""}<p>You can close this page.</p></main></html>`;
}

module.exports = async function handler(req, res) {
  securePageHeaders(res);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
  if (req.method !== "GET") return res.status(405).send(page("Not available", "This request is not supported."));
  const expected = getCookie(req, "awara_gbp_state");
  const received = String(req.query.state || "");
  res.setHeader("Set-Cookie", "awara_gbp_state=; HttpOnly; Secure; SameSite=Lax; Path=/api/google; Max-Age=0");
  if (!expected || !received || expected !== received) return res.status(400).send(page("Connection not completed", "Please restart the Google connection from Awara’s setup link."));
  if (req.query.error || !req.query.code) return res.status(400).send(page("Connection not completed", "Google did not authorize the connection. You can close this page."));
  try {
    const tokens = await exchangeCode(String(req.query.code), CALLBACK_URL);
    if (!tokens.refresh_token) throw new Error("Google did not return a refresh token. Restart the connection and approve offline access.");
    const encrypted = encryptRefreshToken(tokens.refresh_token);
    return res.status(200).send(page("Google connection ready", "The connection token has been encrypted. Copy only the encrypted value into the Vercel environment variable named GBP_REFRESH_TOKEN_ENC. Never put the plain refresh token in source code.", encrypted));
  } catch (error) {
    console.error("[google-oauth-callback]", error && error.message ? error.message : "unknown error");
    return res.status(500).send(page("Connection could not be completed", "Check the Google client settings and try the connection again. No token was saved."));
  }
};
