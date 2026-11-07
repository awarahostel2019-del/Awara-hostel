const TOOL = {
  name: "get_awara_hostel_information",
  description: "Read public information about Awara Hostels & Dormitory in Chowk, Lucknow.",
  inputSchema: {
    type: "object",
    properties: {
      topic: {
        type: "string",
        enum: ["overview", "facilities", "location", "contact", "booking", "tariffs"],
        description: "The public information topic to retrieve.",
      },
    },
    required: ["topic"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

const ANSWERS = {
  overview: "Awara Hostels & Dormitory offers dormitory accommodation in Chowk, Lucknow, about 300 metres from the KGMU gate, for medical students, patient attendants and travellers.",
  facilities: "Listed facilities include free Wi-Fi, 24x7 hot water, CCTV, secure lockers, kitchen and fridge, washing machine, maintained bathrooms, power backup and RO drinking water.",
  location: "2nd Floor, Akbar Mansion, Opp. Mazar, Imambara Agha Baqar, Chowk, Lucknow 226003, Uttar Pradesh, India. The site states it is about 300 metres from KGMU gate.",
  contact: "Phone: +91 522 4738695. WhatsApp: +91 89330 13188. Email: awarahostel2019@email.com.",
  tariffs: "Final discounted tariffs: Hall Dormitory ₹299 per bed/night (4 online beds); 4-Bed Dormitory ₹350 per bed/night (4 online beds); 8-Bed Mixed Dormitory ₹399 per bed/night (8 online beds); 1BHK Cooler Room ₹999 per room/night for up to 2 guests; 1BHK AC Room ₹1,500 per room/night for up to 3 guests; 2BHK Entire Room ₹2,999 per night for up to 5 guests or ₹3,500 per night for 6–8 guests (maximum 8), bookable when both 1BHK rooms are vacant for the full stay.",
  booking: "Guests choose dates and accommodation on the website. The site checks Awara's current website inventory, places a short hold and sends the guest to secure payment for the full stay. A booking is confirmed automatically only after the payment provider verifies full payment. The 2BHK is directly bookable when both 1BHK rooms are vacant for every selected night. Staff manually record offline and OTA bookings in the same calendar; there is no automatic OTA sync. WhatsApp is available for guest questions. Domestic PayU checkout appears after merchant activation; international guests use PayPal Checkout in USD. Contact Awara for cancellation and refund requests.",
};

function response(id, result) {
  return { jsonrpc: "2.0", id, result };
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Method, Mcp-Name, Mcp-Protocol-Version");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ error: "Use POST with a JSON-RPC request." });
  }
  if (!String(req.headers["content-type"] || "").toLowerCase().includes("application/json")) {
    return res.status(415).json({ error: "Content-Type must be application/json." });
  }

  let message = req.body;
  if (typeof message === "string") {
    try { message = JSON.parse(message); }
    catch { return res.status(400).json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
  }
  if (!message || Array.isArray(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return res.status(400).json({ jsonrpc: "2.0", id: message && message.id != null ? message.id : null, error: { code: -32600, message: "Invalid Request" } });
  }

  const methodHeader = req.headers["mcp-method"];
  const nameHeader = req.headers["mcp-name"];
  if ((methodHeader && methodHeader !== message.method) || (nameHeader && message.params && nameHeader !== message.params.name)) {
    return res.status(400).json({ jsonrpc: "2.0", id: message.id == null ? null : message.id, error: { code: -32600, message: "MCP routing headers do not match the request." } });
  }

  if (message.method === "notifications/initialized" || message.method.startsWith("notifications/")) return res.status(202).end();
  if (message.id == null) return res.status(400).json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Requests must include an id." } });
  if (req.headers.accept && !String(req.headers.accept).includes("application/json") && !String(req.headers.accept).includes("text/event-stream")) {
    return res.status(406).json({ jsonrpc: "2.0", id: message.id, error: { code: -32600, message: "Accept must include application/json or text/event-stream." } });
  }

  if (message.method === "initialize") {
    const requested = message.params && message.params.protocolVersion;
    const supported = ["2025-06-18", "2025-03-26"];
    return res.status(200).json(response(message.id, {
      protocolVersion: supported.includes(requested) ? requested : supported[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "awara-hostels", title: "Awara Hostels & Dormitory", version: "1.0.0" },
      instructions: "This server provides public, read-only business information. It cannot make bookings or accept payments.",
    }));
  }
  if (message.method === "ping") return res.status(200).json(response(message.id, {}));
  if (message.method === "tools/list") return res.status(200).json(response(message.id, { tools: [TOOL] }));
  if (message.method === "tools/call") {
    const params = message.params || {};
    const topic = params.arguments && params.arguments.topic;
    if (params.name !== TOOL.name || typeof topic !== "string" || !Object.prototype.hasOwnProperty.call(ANSWERS, topic)) {
      return res.status(200).json(response(message.id, {
        content: [{ type: "text", text: "Choose a supported topic: overview, facilities, location, contact, booking or tariffs." }],
        isError: true,
      }));
    }
    return res.status(200).json(response(message.id, { content: [{ type: "text", text: ANSWERS[topic] }], isError: false }));
  }

  return res.status(200).json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
};
