// api/reserve.js — Vercel Serverless (Node 18+)
export default async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).json({ ok: true, message: 'reserve live' });
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Method Not Allowed' });

  try {
    const API_KEY = process.env.CLOUDBEDS_API_KEY;
    if (!API_KEY) return res.status(500).json({ success: false, message: 'Missing CLOUDBEDS_API_KEY env' });

    // Hardcoded defaults (override via env if you like)
    const DEFAULTS = {
      PROPERTY_ID: process.env.PROPERTY_ID || '198424',
      ROOM_TYPE_ID: process.env.ROOM_TYPE_ID || '331133', // Duplex
      RATE_ID: process.env.RATE_ID || '860253',           // default plan
    };

    const body = req.body || {};
    const {
      propertyID = DEFAULTS.PROPERTY_ID,

      startDate, endDate, checkInDate, checkOutDate,
      guestFirstName, guestLastName, guestEmail, guestPhone, guestCountry, guestZip,
      paymentMethod = 'cash',

      // optional incoming room fields (we’ll override with defaults if missing)
      roomTypeID, roomID, rateID, quantity, numAdults, numChildren,

      // or array
      rooms,
    } = body;

    // Normalize ISO → YYYY-MM-DD
    const normalizeDate = (v) => {
      if (!v) return '';
      if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0,10);
      const d = new Date(v);
      return Number.isNaN(+d) ? '' : d.toISOString().slice(0,10);
    };
    const start = normalizeDate(startDate || checkInDate);
    const end   = normalizeDate(endDate   || checkOutDate);

    // Normalize rooms; apply hardcoded defaults
    let normalizedRooms = [];
    if (Array.isArray(rooms) && rooms.length) {
      normalizedRooms = rooms.map((r) => ({
        roomTypeID: String(r.roomTypeID || DEFAULTS.ROOM_TYPE_ID),
        roomID:     optStr(r.roomID),
        rateID:     String(r.rateID || DEFAULTS.RATE_ID),
        quantity:   numOr(r.quantity, 1),
        adults:     numOr(r.adults ?? r.numAdults, 2),
        children:   numOr(r.children ?? r.numChildren, 0),
      }));
    } else {
      normalizedRooms = [{
        roomTypeID: String(roomTypeID || DEFAULTS.ROOM_TYPE_ID),
        roomID:     optStr(roomID),
        rateID:     String(rateID || DEFAULTS.RATE_ID),
        quantity:   numOr(quantity, 1),
        adults:     numOr(numAdults, 2),
        children:   numOr(numChildren, 0),
      }];
    }

    // Basic validation
    const missing = [];
    if (!propertyID)     missing.push('propertyID');
    if (!start)          missing.push('startDate');
    if (!end)            missing.push('endDate');
    if (!guestFirstName) missing.push('guestFirstName');
    if (!guestLastName)  missing.push('guestLastName');
    if (!guestEmail)     missing.push('guestEmail');
    if (!guestCountry)   missing.push('guestCountry');
    if (!normalizedRooms.length) missing.push('rooms[0]');
    if (missing.length) return res.status(400).json({ success: false, message: `Missing required fields: ${missing.join(', ')}` });

    // Helper to build urlencoded payload
    const buildParams = (roomsList) => {
      const p = new URLSearchParams();
      p.set('propertyID', String(propertyID));
      p.set('startDate', start);
      p.set('endDate',   end);
      p.set('guestFirstName', guestFirstName);
      p.set('guestLastName',  guestLastName);
      p.set('guestEmail',     guestEmail);
      p.set('guestCountry',   guestCountry);
      if (guestZip)   p.set('guestZip', guestZip);
      if (guestPhone) p.set('guestPhone', guestPhone);
      p.set('paymentMethod', String(paymentMethod));

      roomsList.forEach((r, i) => {
        p.set(`rooms[${i}][roomTypeID]`, r.roomTypeID);
        if (r.roomID) p.set(`rooms[${i}][roomID]`, r.roomID);
        p.set(`rooms[${i}][quantity]`, String(r.quantity));
        p.set(`rooms[${i}][rateID]`,   r.rateID);

        // Required top-level occupancy arrays
        p.set(`adults[${i}][roomTypeID]`, r.roomTypeID);
        if (r.roomID) p.set(`adults[${i}][roomID]`, r.roomID);
        p.set(`adults[${i}][quantity]`, String(r.adults));

        p.set(`children[${i}][roomTypeID]`, r.roomTypeID);
        if (r.roomID) p.set(`children[${i}][roomID]`, r.roomID);
        p.set(`children[${i}][quantity]`, String(r.children));
      });
      return p;
    };

    // Call Cloudbeds once with hardcoded defaults
    const firstParams = buildParams(normalizedRooms);
    let response = await fetch('https://api.cloudbeds.com/api/v1.3/postReservation', {
      method: 'POST',
      headers: { 'x-api-key': process.env.CLOUDBEDS_API_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: firstParams.toString()
    });
    let raw = await response.text();
    let data; try { data = JSON.parse(raw); } catch { data = { raw }; }

    const failedNoRate =
      !response.ok ||
      (data && (data.success === false || data.success === 'false') &&
       typeof data.message === 'string' &&
       /no rate found/i.test(data.message));

    // If “No rate found”, fetch live availability for those dates/guests and retry with the current rateID
    if (failedNoRate) {
      const adults0   = normalizedRooms[0].adults || 2;
      const children0 = normalizedRooms[0].children || 0;

      const avURL = new URL('https://api.cloudbeds.com/api/v1.3/getAvailableRoomTypes');
      avURL.searchParams.set('propertyID', String(propertyID));
      avURL.searchParams.set('startDate', start);
      avURL.searchParams.set('endDate', end);
      avURL.searchParams.set('adults', String(adults0));
      avURL.searchParams.set('children', String(children0));

      const avResp = await fetch(avURL.toString(), { headers: { 'x-api-key': process.env.CLOUDBEDS_API_KEY } });
      const av = await avResp.json();
      const list = av?.data?.[0]?.propertyRooms || [];

      if (list.length > 0) {
        // If you truly only have one room type/rate, take the first
        const chosen = list[0];
        normalizedRooms = normalizedRooms.map((r) => ({
          ...r,
          roomTypeID: String(chosen.roomTypeID),
          rateID: String(chosen.roomRateID || chosen.rateID || DEFAULTS.RATE_ID),
        }));

        const retryParams = buildParams(normalizedRooms);
        response = await fetch('https://api.cloudbeds.com/api/v1.3/postReservation', {
          method: 'POST',
          headers: { 'x-api-key': process.env.CLOUDBEDS_API_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: retryParams.toString()
        });
        raw = await response.text();
        try { data = JSON.parse(raw); } catch { data = { raw }; }
        data._fallbackUsed = true;
      }
    }

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
    return res.status(500).json({ success: false, message: err.message, stack: err.stack });
  }
}

// helpers
function optStr(v)  { return (v == null || v === '' ? undefined : String(v)); }
function numOr(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
