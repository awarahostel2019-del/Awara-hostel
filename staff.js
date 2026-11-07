(() => {
  const $ = (id) => document.getElementById(id);
  const KEY_NAME = "awara_staff_key";
  const labels = { hall: "Hall Dormitory", fourBed: "4-Bed Dormitory", eightBed: "8-Bed Mixed Dormitory", cooler: "1BHK Cooler Room", ac: "1BHK AC Room", twoBhk: "2BHK Entire Room" };
  const paymentLabels = { cash: "Cash", card: "Card", upi: "UPI", ota: "Collected through OTA", pending: "Not collected yet", paypal: "PayPal", payu: "PayU", manual: "Manual payment" };
  const caps = { hall: 4, fourBed: 4, eightBed: 8, cooler: 1, ac: 1, twoBhk: 1 };
  const defaultCaps = { hall: 2, fourBed: 2, eightBed: 4, cooler: 1, ac: 1, twoBhk: 1 };
  const rates = { hall: 299, fourBed: 350, eightBed: 399, cooler: 999, ac: 1500, twoBhk: 2999 };
  let staffKey = sessionStorage.getItem(KEY_NAME) || "";
  let bookings = [];
  let loading = false;

  function localIso(date) { return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`; }
  function addDays(value, amount) { const d = new Date(`${value}T12:00:00`); d.setDate(d.getDate()+amount); return localIso(d); }
  function show(id, value) { $(id).textContent = value; }
  function status(id, message, error = false) { show(id, message); $(id).classList.toggle("error", error); }
  function td(row, value) { const cell = document.createElement("td"); cell.textContent = value == null ? "" : String(value); row.appendChild(cell); return cell; }
  function pill(row, value) { const cell = document.createElement("td"); const tag = document.createElement("span"); tag.className = `pill ${String(value || "").replace(/[^a-z_]/g,"")}`; tag.textContent = value || "—"; cell.appendChild(tag); row.appendChild(cell); return cell; }
  async function api(path, options = {}) {
    const response = await fetch(path, { cache: "no-store", ...options, headers: { Authorization: `Bearer ${staffKey}`, ...(options.headers || {}) } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "The booking desk could not complete that action.");
    return data;
  }
  function setDefaults() {
    const today = localIso(new Date());
    $("from-date").value = today; $("to-date").value = addDays(today, 30);
    $("inventory-from").value = today; $("inventory-to").value = addDays(today, 1);
    $("manual-in").value = today; $("manual-out").value = addDays(today, 1);
      $("capacity").value = defaultCaps[$("inventory-type").value];
  }
  async function load() {
    if (!staffKey || loading) return;
    loading = true;
    status("main-status", "Loading bookings and availability…");
    try {
      const query = new URLSearchParams({ from: $("from-date").value, to: $("to-date").value });
      const data = await api(`/api/admin-bookings?${query}`);
      bookings = data.bookings || [];
      renderInventory(data.inventory || []);
      renderBookings(bookings);
      const pending = bookings.filter((b) => ["awaiting_staff","pending_payment"].includes(b.status)).length;
      const confirmed = bookings.filter((b) => b.status === "confirmed").length;
      show("pending-count", pending); show("confirmed-count", confirmed); show("booking-count", bookings.length);
      status("main-status", `Updated just now · ${data.inventory.length} night/type rows`);
    } catch (error) {
      if (/staff sign-in/i.test(error.message)) signOut();
      status("main-status", error.message, true);
    } finally { loading = false; }
  }
  function renderInventory(rows) {
    const body = $("inventory-rows"); body.replaceChildren();
    for (const item of rows) {
      const row = document.createElement("tr");
      td(row, item.date); td(row, labels[item.stayType] || item.stayType);
      td(row, `${item.capacity} ${["hall","fourBed","eightBed"].includes(item.stayType) ? "beds" : "room"}`);
      td(row, item.blocked); td(row, item.booked); td(row, item.remaining);
      body.appendChild(row);
    }
  }
  function actionButton(cell, text, action, className = "secondary") {
    const button = document.createElement("button"); button.type = "button"; button.textContent = text; button.className = className; button.addEventListener("click", action); cell.appendChild(button);
  }
  function printReceipt(booking, payment, invoice = false, existingWindow = null) {
    const paid = Number(booking.paidTotal || 0);
    const total = Number(booking.amountInr || 0);
    const safe = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[c]);
    const lines = invoice ? (booking.payments || []).map((p) => `<tr><td>${safe(p.receiptNumber)} · ${safe(new Date(p.createdAt).toLocaleString("en-IN"))}</td><td>${safe(p.method.toUpperCase())}</td><td>₹${Number(p.amount).toLocaleString("en-IN")}</td></tr>`).join("") : `<tr><td>${safe(payment.receiptNumber)} · ${safe(new Date(payment.createdAt).toLocaleString("en-IN"))}</td><td>${safe(payment.method.toUpperCase())}</td><td>₹${Number(payment.amount).toLocaleString("en-IN")}</td></tr>`;
    const win = existingWindow || window.open("", "_blank", "width=760,height=850");
    if (!win) { status("main-status", "Allow pop-ups for this site to print a receipt or invoice.", true); return; }
    win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${invoice ? "Final invoice" : "Payment receipt"} ${safe(booking.reference)}</title><style>body{font:15px/1.55 Arial,sans-serif;color:#18213c;max-width:760px;margin:30px auto;padding:24px;border:1px solid #ddd}header{display:flex;align-items:center;gap:18px;border-bottom:2px solid #d1ae50;padding-bottom:16px}header img{width:76px;height:76px;object-fit:contain}h1{margin:0;font:28px Georgia,serif}h2{font:20px Georgia,serif;margin-top:26px}table{border-collapse:collapse;width:100%;margin-top:12px}td,th{text-align:left;padding:10px;border-bottom:1px solid #ddd}.total{font-size:18px;font-weight:bold}.terms{margin-top:24px;padding:14px;background:#f8f6f0;font-size:13px}.muted{color:#555}@media print{body{margin:0 auto;border:0}}</style></head><body><header><img src="${location.origin}/awara-logo.jpg"><div><h1>Awara Hostels &amp; Dormitory</h1><div>2nd Floor, Akbar Mansion, Chowk, Lucknow · +91 522 4738695</div></div></header><h2>${invoice ? "Final stay invoice" : `${safe(payment.kind).toUpperCase()} payment receipt`}</h2><p><b>Receipt / Booking reference:</b> ${safe(invoice ? booking.reference : payment.receiptNumber)}<br><b>Guest:</b> ${safe(booking.guestName)}${booking.phone ? ` · ${safe(booking.phone)}` : ""}<br><b>Stay:</b> ${safe(labels[booking.stayType])} · ${safe(booking.checkIn)} to ${safe(booking.checkOut)} · ${booking.guestCount} guest(s)<br><b>Source:</b> ${safe(booking.source)}${booking.idType ? `<br><b>ID checked:</b> ${safe(booking.idType)} · ${booking.idVerified ? "Verified by staff" : "Not verified"}` : ""}</p><table><thead><tr><th>${invoice ? "Payment record" : "Payment"}</th><th>Mode</th><th>Amount</th></tr></thead><tbody>${lines}</tbody></table><p class="total">Stay total: ₹${total.toLocaleString("en-IN")}<br>Paid: ₹${paid.toLocaleString("en-IN")}<br>Balance due: ₹${Math.max(0,total-paid).toLocaleString("en-IN")}</p><p class="muted">${invoice ? "Thank you for staying with Awara Hostels." : "This receipt records the payment listed above."} Taxes, if applicable, are not separately stated on this receipt.</p><div class="terms"><b>Terms &amp; conditions</b><br>Booking dates and accommodation are as listed. Check-in/check-out timing and house rules should be confirmed with Awara. Valid government photo ID is required at check-in. Cancellation or refund requests must be made directly to Awara and are reviewed individually. Please retain this receipt and contact Awara promptly if any detail is incorrect.</div><p class="muted">Generated from Awara staff booking desk · ${new Date().toLocaleString("en-IN")}</p><script>window.onload=()=>{document.querySelector('img').onerror=()=>document.querySelector('img').remove();setTimeout(()=>window.print(),350)}<\/script></body></html>`);
    win.document.close();
  }
  async function updateStay(booking, action) {
    let payload = { action: "update-stay", reference: booking.reference, stayAction: action };
    if (action === "check-in") {
      const idType = prompt("Select photo ID type by entering number:\n1 Aadhaar card\n2 Driving licence\n3 Voter ID card\n4 Passport\n5 Other government photo ID", "1");
      const types = { "1":"Aadhaar card", "2":"Driving licence", "3":"Voter ID card", "4":"Passport", "5":"Other government photo ID" };
      if (!types[idType]) return;
      if (!confirm(`Confirm staff physically checked the guest’s ${types[idType]}? Only type and verification status are saved; no ID number/photo.`)) return;
      payload.idType = types[idType]; payload.idVerified = true;
    }
    try { await api("/api/admin-bookings", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(payload) }); await load(); }
    catch (error) { status("main-status", error.message, true); }
  }
  async function recordPayment(booking) {
    const amount = Number(prompt(`Balance due: ₹${Number(booking.balanceDue).toLocaleString("en-IN")}\nEnter amount actually received`, String(booking.balanceDue || "")));
    if (!Number.isFinite(amount) || amount <= 0) return;
    const modeNumber = prompt("Payment mode: 1 Cash, 2 Card, 3 UPI, 4 OTA collected, 5 Other", "1");
    const modes = {"1":"cash","2":"card","3":"upi","4":"ota","5":"other"};
    if (!modes[modeNumber]) return;
    const printWindow = window.open("", "_blank", "width=760,height=850");
    try {
      const data = await api("/api/admin-bookings", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ action:"record-payment", reference:booking.reference, amount, method:modes[modeNumber] }) });
      await load();
      const refreshed = bookings.find((b) => b.reference === booking.reference) || booking;
      if (printWindow) printReceipt({ ...refreshed, paidTotal:Number(booking.paidTotal||0)+amount }, data.receipt, false, printWindow);
      else status("main-status", `Payment saved (${data.receipt.receiptNumber}). Allow pop-ups to print its receipt.`);
    } catch (error) { if (printWindow) printWindow.close(); status("main-status", error.message, true); }
  }
  function renderBookings(rows) {
    const body = $("booking-rows"); body.replaceChildren();
    if (!rows.length) { const row = document.createElement("tr"); td(row, "No bookings in this date range."); body.appendChild(row); return; }
    for (const booking of rows) {
      const row = document.createElement("tr");
      td(row, `${booking.reference}\n${booking.checkIn} → ${booking.checkOut}`);
      td(row, `${labels[booking.stayType] || booking.stayType}\n${booking.quantity} · ${booking.guestCount} guests`);
      td(row, `${booking.guestName || ""}${booking.phone ? `\n${booking.phone}` : ""}${booking.guestEmail ? `\n${booking.guestEmail}` : ""}`);
      td(row, booking.source);
      td(row, paymentLabels[booking.paymentMethod] || paymentLabels[booking.paymentProvider] || "Not recorded");
      td(row, Number(booking.amountInr) > 0 ? `₹${Number(booking.amountInr).toLocaleString("en-IN")}${booking.amountUsd ? ` / $${Number(booking.amountUsd).toFixed(2)}` : ""}` : "—");
      pill(row, booking.status);
      const cell = document.createElement("td");
      if (booking.status === "awaiting_staff" && booking.payerCountry === "IN") {
        actionButton(cell, "Confirm after manual payment", () => confirmManual(booking.reference));
      } else if (booking.status === "awaiting_staff" && booking.stayType === "twoBhk") {
        actionButton(cell, "Approve & prepare PayPal link", () => approveTwoBhk(booking.reference));
      } else if (booking.status === "pending_payment") {
        cell.textContent = "Payment link expires soon; payment confirms stay.";
      } else if (booking.status === "confirmed" && booking.source !== "website") {
        actionButton(cell, "Remove booking", () => cancelBooking(booking.reference), "danger");
      } else if (booking.status === "confirmed" && ["paypal", "payu"].includes(booking.paymentProvider)) {
        cell.textContent = `Paid · ${booking.captureId || (booking.paymentProvider === "payu" ? "PayU" : "PayPal")}`;
      }
      if (booking.status === "confirmed") {
        const stay = document.createElement("div"); stay.className = "help"; stay.textContent = `Stay: ${booking.stayStatus || "booked"} · ID: ${booking.idType ? `${booking.idType}${booking.idVerified ? " (verified)" : ""}` : "not recorded"}`; cell.appendChild(stay);
        if (booking.stayStatus === "booked") actionButton(cell, "Check in · verify ID", () => updateStay(booking,"check-in"));
        if (booking.stayStatus === "checked_in") {
          actionButton(cell, "Mark checked out", () => updateStay(booking,"check-out"));
          if (booking.phone) { const wa = document.createElement("a"); wa.className = "pill"; wa.target = "_blank"; wa.rel = "noopener"; const digits = String(booking.phone).replace(/\D/g, ""); wa.href = `https://wa.me/${digits}?text=${encodeURIComponent(`Hello ${booking.guestName || ""}, this is Awara Hostels. A reminder that your scheduled checkout date is ${booking.checkOut}. Please contact reception if you need assistance.`)}`; wa.textContent = `Prepare checkout reminder · ${booking.checkOut}`; cell.appendChild(wa); }
        }
        if (Number(booking.balanceDue) > 0) actionButton(cell, `Collect balance · ₹${Number(booking.balanceDue).toLocaleString("en-IN")}`, () => recordPayment(booking));
        if ((booking.payments || []).length) for (const payment of booking.payments) actionButton(cell, `Print ${payment.kind} receipt`, () => printReceipt(booking,payment));
        if (booking.stayStatus === "checked_out") actionButton(cell, "Print final invoice", () => printReceipt(booking,null,true));
      }
      row.appendChild(cell); body.appendChild(row);
    }
  }
  async function approveTwoBhk(reference) {
    status("main-status", "Checking the 2BHK request and preparing a PayPal link…");
    try {
      const data = await api("/api/admin-bookings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "approve-2bhk", reference }) });
      let copied = false;
      try { if (navigator.clipboard) { await navigator.clipboard.writeText(data.paymentUrl); copied = true; } } catch {}
      status("main-status", copied
        ? `2BHK availability approved. PayPal link copied for ${reference}; share it with that guest.`
        : `2BHK availability approved for ${reference}. Copy this payment link and send it to the guest: ${data.paymentUrl}`);
      await load();
    } catch (error) { status("main-status", error.message, true); }
  }
  async function confirmManual(reference) {
    if (!confirm(`Only continue after checking the dates and verifying the guest’s manual payment in your bank or UPI app. Mark ${reference} as confirmed?`)) return;
    const printWindow = window.open("", "_blank", "width=760,height=850");
    status("main-status", "Checking availability and confirming the manually paid booking…");
    try {
      const data = await api("/api/admin-bookings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "confirm-manual", reference }) });
      status("main-status", `Booking ${data.reference} is confirmed and counted in inventory.`);
      await load();
      const booking = bookings.find((b) => b.reference === reference);
      if (data.receipt && booking && printWindow) printReceipt(booking, data.receipt, false, printWindow);
      else if (printWindow) printWindow.close();
    } catch (error) { if (printWindow) printWindow.close(); status("main-status", error.message, true); }
  }
  async function cancelBooking(reference) {
    if (!confirm(`Remove this OTA/offline reservation ${reference} from the Awara website calendar?`)) return;
    try {
      await api("/api/admin-bookings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "cancel", reference }) });
      status("main-status", `Removed ${reference} from the website calendar.`); await load();
    } catch (error) { status("main-status", error.message, true); }
  }
  function signOut() { staffKey = ""; sessionStorage.removeItem(KEY_NAME); $("desk").classList.add("hidden"); $("signed-label").classList.add("hidden"); $("signin").classList.remove("hidden"); $("staff-key").value = ""; }
  $("inventory-type").addEventListener("change", () => { $("capacity").max = caps[$("inventory-type").value]; $("blocked").max = caps[$("inventory-type").value]; $("capacity").value = defaultCaps[$("inventory-type").value]; $("blocked").value = 0; });
  $("login-form").addEventListener("submit", async (event) => {
    event.preventDefault(); staffKey = $("staff-key").value;
    try {
      sessionStorage.setItem(KEY_NAME, staffKey);
      $("signin").classList.add("hidden"); $("desk").classList.remove("hidden"); $("signed-label").classList.remove("hidden");
      await load();
    } catch (error) { status("login-status", error.message, true); }
  });
  $("logout").addEventListener("click", signOut);
  $("range-form").addEventListener("submit", (event) => { event.preventDefault(); load(); });
  $("inventory-form").addEventListener("submit", async (event) => {
    event.preventDefault(); status("inventory-status", "Saving inventory…");
    try {
      const data = await api("/api/admin-bookings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "set-inventory", from: $("inventory-from").value, to: $("inventory-to").value, stayType: $("inventory-type").value, capacity: Number($("capacity").value), blocked: Number($("blocked").value) }) });
      status("inventory-status", `Saved ${data.updated} nights.`); $("from-date").value = $("inventory-from").value; $("to-date").value = $("inventory-to").value; await load();
    } catch (error) { status("inventory-status", error.message, true); }
  });
  $("manual-form").addEventListener("submit", async (event) => {
    event.preventDefault(); status("manual-status", "Recording the reservation…");
    const printWindow = Number($("manual-paid").value || 0) > 0 ? window.open("", "_blank", "width=760,height=850") : null;
    try {
      const amountPaid = Number($("manual-paid").value || 0);
      const data = await api("/api/admin-bookings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "manual-booking", source: $("source").value, paymentMethod: $("manual-payment-mode").value, totalAmount: Number($("manual-total").value), amountPaid, stayType: $("manual-type").value, checkIn: $("manual-in").value, checkOut: $("manual-out").value, quantity: Number($("manual-quantity").value), guestCount: Number($("manual-guests").value), guestName: $("manual-name").value, phone: $("manual-phone").value, note: $("manual-note").value }) });
      status("manual-status", `Saved as ${data.reference}; dates are reserved${data.receipt ? ` and receipt ${data.receipt.receiptNumber} is ready` : ""}.`); $("from-date").value = $("manual-in").value; $("to-date").value = $("manual-out").value; await load();
      if (data.receipt) { const booking = bookings.find((b) => b.reference === data.reference) || { reference:data.reference, guestName:$("manual-name").value, phone:$("manual-phone").value, stayType:$("manual-type").value, checkIn:$("manual-in").value, checkOut:$("manual-out").value, guestCount:Number($("manual-guests").value), source:$("source").value, amountInr:Number($("manual-total").value), paidTotal:Number($("manual-paid").value), payments:[] }; if (printWindow) printReceipt(booking,data.receipt,false,printWindow); else status("manual-status", "Booking saved. Allow pop-ups to print the receipt."); }
    } catch (error) { if (printWindow) printWindow.close(); status("manual-status", error.message, true); }
  });

  $("manual-type").addEventListener("change", () => {
    const type = $("manual-type").value;
    $("manual-quantity").max = caps[type];
    $("manual-quantity").value = 1;
    $("manual-guests").max = ({ hall: 4, fourBed: 4, eightBed: 8, cooler: 2, ac: 3, twoBhk: 8 })[type];
    $("manual-guests").value = Math.min(Number($("manual-guests").value) || 1, Number($("manual-guests").max));
    updateEstimate();
  });
  function updateEstimate() {
    const nights = Math.max(1, Math.round((Date.parse(`${$("manual-out").value}T00:00:00Z`) - Date.parse(`${$("manual-in").value}T00:00:00Z`))/86400000));
    const type = $("manual-type").value;
    const nightly = type === "twoBhk" && Number($("manual-guests").value) > 5 ? 3500 : rates[type];
    const quantity = ["hall","fourBed","eightBed"].includes(type) ? Number($("manual-quantity").value || 1) : 1;
    $("manual-total").value = String(nightly * nights * quantity);
  }
  ["manual-in","manual-out","manual-quantity","manual-guests"].forEach((id) => $(id).addEventListener("change", updateEstimate));

  $("inventory-type").dispatchEvent(new Event("change"));
  $("manual-type").dispatchEvent(new Event("change"));
  setDefaults();
  if (staffKey) { $("staff-key").value = staffKey; $("signin").classList.add("hidden"); $("desk").classList.remove("hidden"); $("signed-label").classList.remove("hidden"); load(); }
  window.setInterval(() => { if (staffKey) load(); }, 60000);
})();
