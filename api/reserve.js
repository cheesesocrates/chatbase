// api/reserve.js — Vercel Serverless Function (Node 18+)
export default async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).json({ ok: true, message: 'Cloudbeds reserve relay live' });
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Method Not Allowed' });

  try {
    const API_KEY = process.env.CLOUDBEDS_API_KEY;
    if (!API_KEY) return res.status(500).json({ success: false, message: 'Missing CLOUDBEDS_API_KEY env' });

    const {
      propertyID,
      startDate, endDate, checkInDate, checkOutDate,
      guestFirstName, guestLastName, guestEmail, guestPhone, guestCountry, guestZip,
      paymentMethod = 'cash',
      roomTypeID, roomID, rateID, quantity, numAdults, numChildren,
      rooms
    } = req.body || {};

    // ISO -> YYYY-MM-DD
    const normalizeDate = (v) => {
      if (!v) return '';
      if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0,10);
      const d = new Date(v);
      return Number.isNaN(+d) ? '' : d.toISOString().slice(0,10);
    };
    const start = normalizeDate(startDate || checkInDate);
    const end   = normalizeDate(endDate   || checkOutDate);

    // Normalize rooms
    let normalizedRooms = [];
    if (Array.isArray(rooms) && rooms.length) {
      normalizedRooms = rooms.map((r) => ({
        roomTypeID: mustStr(r.roomTypeID),   // may be "Duplex" or "331133"
        roomID:     optStr(r.roomID),
        rateID:     mustStr(r.rateID || r.roomRateID), // may be missing/wrong
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

    // Basic requireds (we’ll try to auto-fix IDs after this)
    const missing = [];
    if (!propertyID)     missing.push('propertyID');
    if (!start)          missing.push('startDate');
    if (!end)            missing.push('endDate');
    if (!guestFirstName) missing.push('guestFirstName');
    if (!guestLastName)  missing.push('guestLastName');
    if (!guestEmail)     missing.push('guestEmail');
    if (!guestCountry)   missing.push('guestCountry');
    if (!normalizedRooms.length) missing.push('rooms[0]');
    if (missing.length)  return res.status(400).json({ success: false, message: `Missing required fields: ${missing.join(', ')}` });

    // --- Auto-fix roomTypeID names and missing/wrong rateID via availability lookup ---
    for (let i = 0; i < normalizedRooms.length; i++) {
      const r = normalizedRooms[i];
      const isNumericId = /^\d+$/.test(r.roomTypeID);
      const adults = Math.max(1, Number(r.adults || 1));
      const children = Math.max(0, Number(r.children || 0));

      // Call availability for these dates/occupancy
      const avURL = new URL('https://api.cloudbeds.com/api/v1.3/getAvailableRoomTypes');
      avURL.searchParams.set('propertyID', String(propertyID));
      avURL.searchParams.set('startDate', start);
      avURL.searchParams.set('endDate', end);
      avURL.searchParams.set('adults', String(adults));
      avURL.searchParams.set('children', String(children));

      const avResp = await fetch(avURL.toString(), { headers: { 'x-api-key': API_KEY } });
      const av = await avResp.json();

      const list = av?.data?.[0]?.propertyRooms || [];
      // Try to find by numeric ID or by name when a label like "Duplex" was provided
      let match = null;
      if (isNumericId) {
        match = list.find(x => String(x.roomTypeID) === String(r.roomTypeID));
      } else {
        match = list.find(x => (x.roomTypeName || '').toLowerCase() === String(r.roomTypeID).toLowerCase());
      }

      if (!match) {
        return res.status(400).json({
          success: false,
          message: `Room type not available for these dates/occupancy: ${r.roomTypeID}`,
          hint: 'Use the roomTypeID and roomRateID from getAvailableRoomTypes for the chosen dates.'
        });
      }

      // Fill numeric roomTypeID if a name was sent
      r.roomTypeID = String(match.roomTypeID);

      // Fill rateID if missing or not numeric
      const hasValidRate = /^\d+$/.test(r.rateID);
      const derivedRateId = String(match.roomRateID || match.rateID || '');
      if (!hasValidRate || !derivedRateId) {
        r.rateID = derivedRateId;
      }
    }

    // Final validation after auto-fix
    const postMissing = [];
    normalizedRooms.forEach((r, i) => {
      if (!/^\d+$/.test(r.roomTypeID)) postMissing.push(`rooms[${i}].roomTypeID (numeric)`);
      if (!/^\d+$/.test(r.rateID))     postMissing.push(`rooms[${i}].rateID (numeric)`);
      if (r.quantity < 1)              postMissing.push(`rooms[${i}].quantity`);
    });
    if (postMissing.length) {
      return res.status(400).json({ success: false, message: `Missing/invalid fields: ${postMissing.join(', ')}` });
    }

    // Build x-www-form-urlencoded payload
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
      params.set(`rooms[${i}][roomTypeID]`, r.roomTypeID);
      if (r.roomID) params.set(`rooms[${i}][roomID]`, r.roomID);
      params.set(`rooms[${i}][quantity]`, String(r.quantity));
      params.set(`rooms[${i}][rateID]`,   r.rateID);

      // Required top-level occupancy arrays
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
      headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
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
