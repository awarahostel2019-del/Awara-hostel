(() => {
  const status = document.getElementById("status");
  const params = new URLSearchParams(location.search);
  const quoteToken = params.get("q") || "";
  let sdkReady = false;

  function message(text, isError = false) {
    status.textContent = text;
    status.classList.toggle("error", isError);
  }

  async function post(path, data) {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Could not complete the payment.");
    return result;
  }

  async function start() {
    if (!quoteToken || quoteToken.length > 1800) {
      message("This payment link is missing or invalid. Please ask Awara for a fresh link.", true);
      return;
    }
    try {
      const quoteResponse = await fetch("/api/paypal/verify-quote?token=" + encodeURIComponent(quoteToken), { cache: "no-store" });
      const quote = await quoteResponse.json().catch(() => ({}));
      if (!quoteResponse.ok) throw new Error(quote.error || "This payment quote is invalid. Ask Awara for a new link.");
      document.getElementById("reference").textContent = quote.reference;
      document.getElementById("amount").textContent = `${quote.amount} ${quote.currency}`;
      document.getElementById("expires").textContent = new Date(quote.expiresAt).toLocaleString();
      document.getElementById("quote").hidden = false;
      const response = await fetch("/api/paypal/config", { cache: "no-store" });
      const config = await response.json().catch(() => ({}));
      if (!response.ok || !config.enabled || !config.clientId) throw new Error(config.error || "PayPal checkout is not available yet. Contact Awara.");
      const sdk = document.createElement("script");
      sdk.src = "https://www.paypal.com/sdk/js?" + new URLSearchParams([["client-id", config.clientId], ["currency", "USD"], ["intent", "capture"], ["components", "buttons"]]);
      sdk.onload = () => {
        if (!window.paypal) { message("PayPal checkout could not load. Please contact Awara.", true); return; }
        sdkReady = true;
        window.paypal.Buttons({
          style: { layout: "vertical", shape: "rect", color: "gold", label: "paypal" },
          createOrder: () => post("/api/paypal/create-order", { token: quoteToken }).then((result) => result.id),
          onApprove: (data) => {
            message("Verifying payment with PayPal…");
            return post("/api/paypal/capture-order", { token: quoteToken, orderId: data.orderID }).then((result) => {
              document.getElementById("success").hidden = false;
              document.getElementById("receipt").textContent = `Booking reference ${result.reference} · ${result.amount} ${result.currency} · PayPal capture ${result.captureId}`;
              document.getElementById("paypal-buttons").hidden = true;
              message("Payment verified.");
            });
          },
          onCancel: () => message("Payment cancelled. No payment was captured."),
          onError: (error) => { console.error("[paypal-checkout]", error); message("PayPal could not complete this payment. Please contact Awara.", true); },
        }).render("#paypal-buttons").catch((error) => { console.error("[paypal-render]", error); message("PayPal checkout could not load. Please contact Awara.", true); });
      };
      sdk.onerror = () => message("PayPal checkout could not load. Please contact Awara.", true);
      document.head.appendChild(sdk);
      message("PayPal checkout is ready. Confirm the amount above before continuing.");
    } catch (error) {
      message(error.message || "PayPal checkout is unavailable. Please contact Awara.", true);
    }
  }

  start();
})();
