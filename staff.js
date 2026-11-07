(() => {
  const $ = (id) => document.getElementById(id);
  const KEY_NAME = "awara_staff_key";
  const labels = { hall: "Hall Dormitory", fourBed: "4-Bed Dormitory", eightBed: "8-Bed Mixed Dormitory", cooler: "1BHK Cooler Room", ac: "1BHK AC Room", twoBhk: "2BHK Entire Room" };
  const caps = { hall: 4, fourBed: 4, eightBed: 8, cooler: 1, ac: 1, twoBhk: 1 };
  const defaultCaps = { hall: 2, fourBed: 2, eightBed: 4, cooler: 1, ac: 1, twoBhk: 1 };
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
  function renderBookings(rows) {
    const body = $("booking-rows"); body.replaceChildren();
    if (!rows.length) { const row = document.createElement("tr"); td(row, "No bookings in this date range."); body.appendChild(row); return; }
    for (const booking of rows) {
      const row = document.createElement("tr");
      td(row, `${booking.reference}\n${booking.checkIn} → ${booking.checkOut}`);
      td(row, `${labels[booking.stayType] || booking.stayType}\n${booking.quantity} · ${booking.guestCount} guests`);
      td(row, `${booking.guestName || ""}${booking.phone ? `\n${booking.phone}` : ""}${booking.guestEmail ? `\n${booking.guestEmail}` : ""}`);
      td(row, booking.source);
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
    status("main-status", "Checking availability and confirming the manually paid booking…");
    try {
      const data = await api("/api/admin-bookings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "confirm-manual", reference }) });
      status("main-status", `Booking ${data.reference} is confirmed and counted in inventory.`);
      await load();
    } catch (error) { status("main-status", error.message, true); }
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
    try {
      const data = await api("/api/admin-bookings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "manual-booking", source: $("source").value, stayType: $("manual-type").value, checkIn: $("manual-in").value, checkOut: $("manual-out").value, quantity: Number($("manual-quantity").value), guestCount: Number($("manual-guests").value), guestName: $("manual-name").value, phone: $("manual-phone").value, note: $("manual-note").value }) });
      status("manual-status", `Saved as ${data.reference}; those dates now count against website availability.`); $("from-date").value = $("manual-in").value; $("to-date").value = $("manual-out").value; await load();
    } catch (error) { status("manual-status", error.message, true); }
  });

  $("manual-type").addEventListener("change", () => {
    const type = $("manual-type").value;
    $("manual-quantity").max = caps[type];
    $("manual-quantity").value = 1;
    $("manual-guests").max = ({ hall: 4, fourBed: 4, eightBed: 8, cooler: 2, ac: 3, twoBhk: 8 })[type];
    $("manual-guests").value = Math.min(Number($("manual-guests").value) || 1, Number($("manual-guests").max));
  });

  $("inventory-type").dispatchEvent(new Event("change"));
  $("manual-type").dispatchEvent(new Event("change"));
  setDefaults();
  if (staffKey) { $("staff-key").value = staffKey; $("signin").classList.add("hidden"); $("desk").classList.remove("hidden"); $("signed-label").classList.remove("hidden"); load(); }
  window.setInterval(() => { if (staffKey) load(); }, 60000);
})();
