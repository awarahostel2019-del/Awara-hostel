const { findAwaraLocation, getAccessToken, googleJson, listReviews, replyForReview, requiresHumanReview } = require("../../lib/google-business-profile");

function authorized(req) {
  const expected = process.env.CRON_SECRET || "";
  const actual = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!expected || actual.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i += 1) mismatch |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  return mismatch === 0;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  if (!authorized(req)) return res.status(401).json({ error: "Unauthorized" });
  try {
    const accessToken = await getAccessToken();
    const location = await findAwaraLocation(accessToken);
    const reviews = await listReviews(accessToken, location.accountName, location.locationName, 3);
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    let replied = 0;
    let needsManualReview = 0;
    for (const review of reviews) {
      if (review.reviewReply || !review.name) continue;
      const createdAt = Date.parse(review.createTime || "");
      if (!Number.isFinite(createdAt) || createdAt < cutoff) continue;
      if (requiresHumanReview(review)) { needsManualReview += 1; continue; }
      await googleJson(`https://mybusiness.googleapis.com/v4/${review.name}/reply`, accessToken, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comment: replyForReview(review) }),
      });
      replied += 1;
    }
    return res.status(200).json({ ok: true, checked: reviews.length, replied, needsManualReview, scope: "new reviews from the last 7 days", cadence: "daily" });
  } catch {
    return res.status(503).json({ error: "Google review replies could not be processed. Check connection and location access." });
  }
};
