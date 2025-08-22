// api/reserve.js — Vercel Serverless Function (Node 18+)
// Receives JSON, relays to Cloudbeds postReservation as application/x-www-form-urlencoded

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, message: 'Cloudbeds reserve relay live' });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  }

  try {
    const API_KEY = process.env.CLOUDBEDS_API_KEY;
    if (!API_KEY) {
      return res.status(500).json({ success: false, message: 'Missing CLOUDBEDS_API_KEY env' });
    }

    const {
      // stay / property
      propertyID,
      startDate, endDate, checkInDate, checkOutDate,

      // guest
      guestFirstName, guestLastName, guestEmail, guestPhone, guestCountry, guestZip,

      // payment
      paymentMethod = 'cash',

      // single-room convenience fields (optional)
      roomTypeID, roomID, rateID, quantity, numAdults, numChildren,

      // preferred: array of rooms
      // rooms: [{ roomTypeID, roomID?, rateID, quantity, adults, children }]
      rooms,
    } = req.body || {};

    // Normalize ISO → YYYY-MM-DD
    const normalizeDate = (v) => {
      if (!v) return '';
      if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
      const d = new Date(v);
      return Number.isNaN(+d) ? '' : d.toISOString().slice(0, 10);
    };
    const start = normalizeDate(startDate || checkInDate);
    const end   = normalizeDate(endDate   || checkOutDate);

    // Normalize rooms
    let normalizedRooms = [];
    if (Array.isArray(rooms) && rooms.length) {
      normalizedRooms = rooms.map((r) => ({
        roomTypeID: mustStr(r.roomTypeID),
        roomID:     optStr(r.roomID),
        rateID:     mustStr(r.rateID || r.roomRateID),
        quantity:   numOr(r.quantity, 1),
        adults:     numOr(r.adults ?? r.numAdults, 2),
        children:   numOr(r.children ?? r.numChildren, 0),
      }));
    } else if (roomTypeID || rateID) {
      normalizedRooms = [{
        roomTypeID: mustStr(roomTypeID),
        roomID:     optStr(roomID),
        rateID:     mustStr(rateID),
        quantity:   numOr(quantity, 1),
        adults:     numOr(numAdults, 2),
        children:   numOr(numChildren, 0),
      }];
    }

    // Validate
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
      if (!r.rateID)     missing.push(`rooms[${i}].rateID`);
      if (r.quantity < 1) missing.push(`rooms[${i}].quantity`);
    });
    if (missing.length) {
      return res.status(400).json({ success: false, message: `Missing required fields: ${missing.join(', ')}` });
    }

    // Build application/x-www-form-urlencoded body
    const params = new URLSearchParams();
    params.set('propertyID', String(propertyID));
    params.set('startDate', start);
    params.set('endDate',   end);
    params.set('guestFirstName', guestFirstName);
    params.set('guestLastName',  guestLastName);
    params.set('guestEmail',     guestEmail);
    params.set('guestCountry',   guestCountry);
    if (guestZip)   params.set('guestZip', guestZip);
    if (guestPhone) params.set('guestPhone', guestPhone);
    params.set('paymentMethod', String(paymentMethod));

    normalizedRooms.forEach((r, i) => {
      // rooms[i][...]
      params.set(`rooms[${i}][roomTypeID]`, r.roomTypeID);
      if (r.roomID) params.set(`rooms[${i}][roomID]`, r.roomID);
      params.set(`rooms[${i}][quantity]`, String(r.quantity));
      params.set(`rooms[${i}][rateID]`,   r.rateID);

      // REQUIRED top-level occupancy blocks
      params.set(`adults[${i}][roomTypeID]`, r.roomTypeID);
      if (r.roomID) params.set(`adults[${i}][roomID]`, r.roomID);
      params.set(`adults[${i}][quantity]`, String(r.adults));

      params.set(`children[${i}][roomTypeID]`, r.roomTypeID);
      if (r.roomID) params.set(`children[${i}][roomID]`, r.roomID);
      params.set(`children[${i}][quantity]`, String(r.children));
    });

    const endpoint = 'https://api.cloudbeds.com/api/v1.3/postReservation';
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'x-api-key': API_KEY,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });

    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = { raw }; }

    return res.status(response.status).json({
      ...data,
      _sentPreview: {
        propertyID,
        startDate: start, endDate: end,
        guestFirstName, guestLastName, guestEmail, guestCountry,
        rooms: normalizedRooms
      }
    });

  } catch (err) {
    // Surface the error so you can see it in the response & Vercel logs
    return res.status(500).json({ success: false, message: err.message, stack: err.stack });
  }
}

// helpers
function mustStr(v) { return (v == null ? '' : String(v)); }
function optStr(v)  { return (v == null || v === '' ? undefined : String(v)); }
function numOr(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
