const { findAwaraLocation, getAccessToken, listReviews } = require("../../lib/google-business-profile");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "public, s-maxage=900, stale-while-revalidate=3600");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Access-Control-Allow-Origin", "https://awarahostels.com");
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const accessToken = await getAccessToken();
    const location = await findAwaraLocation(accessToken);
    const reviews = await listReviews(accessToken, location.accountName, location.locationName, 1);
    return res.status(200).json({
      businessName: location.title,
      reviews: reviews.slice(0, 12).map((review) => ({
        name: review.reviewer && review.reviewer.displayName ? review.reviewer.displayName : "Google guest",
        rating: review.starRating || "",
        text: review.comment || "",
        date: review.createTime || "",
        reply: review.reviewReply && review.reviewReply.comment ? review.reviewReply.comment : "",
      })),
    });
  } catch {
    res.setHeader("Cache-Control", "no-store");
    return res.status(503).json({ error: "Google reviews are temporarily unavailable." });
  }
};
