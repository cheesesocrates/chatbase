// pages/api/reserve.js
// Next.js (Vercel) API route — Node 18+
// PURPOSE: Relay bookings from your bot/frontend to Cloudbeds postReservation
// FORMAT: multipart/form-data (the format Cloudbeds support validated)

// ENV (set in Vercel):
//   CLOUDBEDS_API_KEY   -> your cbat_... key  (required)

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, message: 'Cloudbeds reserve relay live' });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  }

  try {
    const API_KEY = process.env.CLOUDBEDS_API_KEY || process.env.CLOUDBEDS_CREDENTIAL;
    if (!API_KEY) {
      return res.status(500).json({ success: false, message: 'Missing CLOUDBEDS_API_KEY env' });
    }

    // Accept flexible input (single-room or rooms[])
    const {
      // stay / property
      propertyID,
      startDate, endDate, checkInDate, checkOutDate,

      // guest
      guestFirstName, guestLastName, guestEmail, guestPhone, guestCountry, guestZip,

      // payment
      paymentMethod = 'cash',

      // single-room legacy fields (optional)
      roomTypeID, roomID, rateID, quantity, numAdults, numChildren,

      // preferred: array of rooms
      // rooms: [{ roomTypeID, roomID?, roomRateID? (or rateID), quantity, adults, children }]
      rooms,
    } = req.body || {};

    const start = startDate || checkInDate;
    const end   = endDate   || checkOutDate;

    // ---- Normalize rooms to an array of objects that match Cloudbeds multipart schema ----
    let normalizedRooms = [];
    if (Array.isArray(rooms) && rooms.length) {
      normalizedRooms = rooms.map((r) => ({
        roomTypeID : mustStr(r.roomTypeID),
        roomID     : optStr(r.roomID),
        roomRateID : optStr(r.roomRateID ?? r.rateID),
        quantity   : numOr(r.quantity, 1),
        adults     : numOr(r.adults ?? r.numAdults, 2),
        children   : numOr(r.children ?? r.numChildren, 0),
      }));
    } else if (roomTypeID || quantity || numAdults || numChildren || rateID) {
      normalizedRooms = [{
        roomTypeID : mustStr(roomTypeID),
        roomID     : optStr(roomID),
        roomRateID : optStr(rateID),
        quantity   : numOr(quantity, 1),
        adults     : numOr(numAdults, 2),
        children   : numOr(numChildren, 0),
      }];
    }

    // ---- Validation (keep it practical; Cloudbeds will also validate) ----
    const missing = [];
    if (!propertyID)     missing.push('propertyID');
    if (!start)          missing.push('startDate');
    if (!end)            missing.push('endDate');
    if (!guestFirstName) missing.push('guestFirstName');
    if (!guestLastName)  missing.push('guestLastName');
    if (!guestEmail)     missing.push('guestEmail');
    if (!guestCountry)   missing.push('guestCountry');
    if (!normalizedRooms.length) missing.push('rooms[0]');
    normalizedRooms.forEach((r, i) => {
      if (!r.roomTypeID) missing.push(`rooms[${i}].roomTypeID`);
      if (r.quantity < 1) missing.push(`rooms[${i}].quantity`);
      if (r.adults < 1)   missing.push(`rooms[${i}].adults`);
      if (r.children == null) missing.push(`rooms[${i}].children`);
    });
    if (missing.length) {
      return res.status(400).json({ success: false, message: `Missing required fields: ${missing.join(', ')}` });
    }

    // ---- Build multipart/form-data exactly like Cloudbeds support sample ----
    // Node 18+ has global FormData/Blob via undici; DO NOT set Content-Type manually.
    const form = new FormData();
    form.set('startDate', start);
    form.set('endDate', end);
    form.set('guestFirstName', guestFirstName);
    form.set('guestLastName',  guestLastName);
    form.set('guestCountry',   guestCountry);
    if (guestZip)   form.set('guestZip', guestZip);
    form.set('guestEmail',     guestEmail);
    if (guestPhone) form.set('guestPhone', guestPhone);
    form.set('paymentMethod',  String(paymentMethod));
    form.set('propertyID',     String(propertyID));

    normalizedRooms.forEach((r, i) => {
      form.set(`rooms[${i}][roomTypeID]`, r.roomTypeID);
      if (r.roomID)     form.set(`rooms[${i}][roomID]`, r.roomID);          // optional specific unit (e.g., "331133-1")
      form.set(`rooms[${i}][quantity]`, String(r.quantity));
      if (r.roomRateID) form.set(`rooms[${i}][roomRateID]`, r.roomRateID);  // rate plan id

      // Occupancy blocks aligned to the same index, as per support example
      form.set(`adults[${i}][roomTypeID]`, r.roomTypeID);
      if (r.roomID) form.set(`adults[${i}][roomID]`, r.roomID);
      form.set(`adults[${i}][quantity]`, String(r.adults));

      form.set(`children[${i}][roomTypeID]`, r.roomTypeID);
      if (r.roomID) form.set(`children[${i}][roomID]`, r.roomID);
      form.set(`children[${i}][quantity]`, String(r.children));
    });

    const endpoint = 'https://api.cloudbeds.com/api/v1.3/postReservation';
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'x-api-key': API_KEY }, // do NOT set Content-Type; fetch adds the multipart boundary
      body: form
    });

    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = { raw }; }

    // Pass Cloudbeds’ response through (status + body), and a light preview of what we sent
    return res.status(response.status).json({
      ...data,
      _endpoint: endpoint,
      _sentPreview: {
        propertyID,
        startDate: start, endDate: end,
        guestFirstName, guestLastName, guestEmail, guestCountry,
        guestZip: guestZip || undefined, guestPhone: guestPhone || undefined,
        paymentMethod,
        rooms: normalizedRooms
          .map(({ roomTypeID, roomID, roomRateID, quantity, adults, children }) =>
            ({ roomTypeID, roomID, roomRateID, quantity, adults, children }))
      }
    });

  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

// ---- helpers ----
function mustStr(v) { return (v == null ? '' : String(v)); }
function optStr(v)  { return (v == null || v === '' ? undefined : String(v)); }
function numOr(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
