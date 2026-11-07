const FX_ENDPOINT = "https://open.er-api.com/v6/latest/USD";

async function getUsdInrRate() {
  const response = await fetch(FX_ENDPOINT, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(6000) });
  if (!response.ok) throw new Error("Exchange rate service unavailable.");
  const data = await response.json();
  const inrPerUsd = Number(data && data.rates && data.rates.INR);
  const age = Math.floor(Date.now() / 1000) - Number(data && data.time_last_update_unix);
  if (data.result !== "success" || !Number.isFinite(inrPerUsd) || inrPerUsd < 20 || inrPerUsd > 250 || !Number.isFinite(age) || age < 0 || age > 172800) {
    throw new Error("Exchange rate is stale or invalid.");
  }
  return { inrPerUsd, checkedAt: new Date(Number(data.time_last_update_unix) * 1000).toISOString() };
}

function toUsd(inrAmount, inrPerUsd) {
  const cents = Math.ceil((Number(inrAmount) / inrPerUsd) * 100);
  return (cents / 100).toFixed(2);
}

module.exports = { getUsdInrRate, toUsd };
