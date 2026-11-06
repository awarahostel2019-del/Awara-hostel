(() => {
  const form = document.getElementById("quote-form");
  const button = document.getElementById("create");
  const status = document.getElementById("status");
  const resultBox = document.getElementById("result");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    button.disabled = true;
    status.textContent = "Creating a signed, expiring quote…";
    resultBox.hidden = true;
    try {
      const response = await fetch("/api/paypal/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${document.getElementById("key").value}` },
        body: JSON.stringify({
          reference: document.getElementById("reference").value.trim(),
          amount: document.getElementById("amount").value,
          expiresInHours: Number(document.getElementById("expiry").value),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not create the payment link.");
      const link = new URL("/pay.html", location.origin);
      link.searchParams.set("q", data.token);
      resultBox.replaceChildren();
      const summary = document.createElement("p");
      summary.textContent = `${data.reference} · ${data.amount} ${data.currency} · Expires ${new Date(data.expiresAt).toLocaleString()}`;
      const anchor = document.createElement("a");
      anchor.href = link.toString();
      anchor.textContent = link.toString();
      anchor.target = "_blank";
      anchor.rel = "noopener";
      const copy = document.createElement("button");
      copy.type = "button";
      copy.textContent = "Copy payment link";
      copy.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(link.toString()); copy.textContent = "Copied"; }
        catch { copy.textContent = "Copy the link above"; }
      });
      resultBox.append(summary, anchor, document.createElement("br"), copy);
      resultBox.hidden = false;
      status.textContent = "Link ready. Send it only to the guest for this confirmed quote.";
      form.reset();
      document.getElementById("expiry").value = "6";
    } catch (error) {
      status.textContent = error.message || "Could not create the payment link.";
      status.classList.add("error");
    } finally {
      button.disabled = false;
    }
  });
})();
