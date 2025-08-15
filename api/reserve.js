// api/reserve.js
// Vercel Node serverless function (CommonJS)

const axios = require("axios");
const FormData = require("form-data");

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,X-Chatbase-Token");
}

module.exports = async (req, res) => {
  cors(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Use POST." });
  }

  try {
    const ct = (req.headers["content-type"] || "").toLowerCase();
    if (!ct.includes("application/json")) {
      return res.status(415).json({ success: false, error: "Send JSON (application/json)." });
    }

    // Vercel may give parsed object OR raw string depending on body parser.
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    // ---- Minimal validation (clear messages before we call Cloudbeds) ----
    const missing = [];
    if (!body?.propertyID) missing.push("propertyID");
    if (!body?.startDate) missing.push("startDate");
    if (!body?.endDate) missing.push("endDate");
    if (!body?.paymentMethod) missing.push("paymentMethod");
    if (!body?.guest?.firstName) missing.push("guest.firstName");
    if (!body?.guest?.lastName) missing.push("guest.lastName");
    if (!body?.guest?.email) missing.push("guest.email");
    if (!body?.guest?.country) missing.push("guest.country");
    if (!Array.isArray(body?.rooms) || body.rooms.length === 0) missing.push("rooms[0]");
    if (missing.length) {
      return res.status(400).json({ success: false, error: `Missing required fields: ${missing.join(", ")}` });
    }

    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRe.test(body.startDate) || !dateRe.test(body.endDate)) {
      return res.status(400).json({ success: false, error: "Dates must be YYYY-MM-DD." });
    }
    if (new Date(body.endDate) <= new Date(body.startDate)) {
      return res.status(400).json({ success: false, error: "endDate must be after startDate." });
    }

    // ---- Build multipart/form-data exactly like your working curl ----
    const form = new FormData();
    form.append("startDate", String(body.startDate));
    form.append("endDate", String(body.endDate));
    form.append("guestFirstName", String(body.guest.firstName));
    form.append("guestLastName", String(body.guest.lastName));
    form.append("guestCountry", String(body.guest.country));
    if (body.guest.zip) form.append("guestZip", String(body.guest.zip));
    form.append("guestEmail", String(body.guest.email));
    if (body.guest.phone) form.append("guestPhone", String(body.guest.phone));
    form.append("paymentMethod", String(body.paymentMethod));
    form.append("propertyID", String(body.propertyID));

    body.rooms.forEach((r, i) => {
      const qty = r.quantity ?? 1;
      form.append(`rooms[${i}][roomTypeID]`, String(r.roomTypeID));
      if (r.roomID) form.append(`rooms[${i}][roomID]`, String(r.roomID));
      form.append(`rooms[${i}][quantity]`, String(qty));
      if (r.roomRateID) form.append(`rooms[${i}][roomRateID]`, String(r.roomRateID));

      const a = Number(r.adults);
      if (!Number.isFinite(a) || a <= 0) {
        throw new Error(`rooms[${i}].adults must be a positive number (Cloudbeds requires adults[]).`);
      }
      form.append(`adults[${i}][roomTypeID]`, String(r.roomTypeID));
      if (r.roomID) form.append(`adults[${i}][roomID]`, String(r.roomID));
      form.append(`adults[${i}][quantity]`, String(a));

      const c = Number(r.children ?? 0);
      if (c > 0) {
        form.append(`children[${i}][roomTypeID]`, String(r.roomTypeID));
        if (r.roomID) form.append(`children[${i}][roomID]`, String(r.roomID));
        form.append(`children[${i}][quantity]`, String(c));
      }
    });

    const url = `${process.env.CLOUDBEDS_BASE_URL || "https://api.cloudbeds.com/api/v1.3"}/postReservation`;

    const cbRes = await axios.post(url, form, {
      headers: {
        ...form.getHeaders(),
        "x-api-key": process.env.CLOUDBEDS_API_KEY || "",
        // If your account uses OAuth instead of API key, swap the header:
        // Authorization: `Bearer ${process.env.CLOUDBEDS_OAUTH_TOKEN}`
      },
      validateStatus: () => true, // let us handle non-2xx ourselves
    });

    const data = cbRes.data;

    if (cbRes.status < 200 || cbRes.status >= 300 || data?.success === false) {
      const errorMsg =
        data?.message || data?.error || (process.env.RESERVATION_DEBUG ? JSON.stringify(data) : "Cloudbeds returned an error.");
      return res.status(cbRes.status || 400).json({ success: false, error: errorMsg, cloudbeds: data });
    }

    return res.status(200).json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, error: err?.message || "Unexpected server error." });
  }
};
