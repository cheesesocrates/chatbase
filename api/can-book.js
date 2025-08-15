// api/can-book.js  (ESM; works with "type":"module")
function str(v){ return (v==null?'':String(v).trim()); }
function toInt(v,d){ const n=Number(v); return Number.isFinite(n)?n:d; }
function ymd(v){ if(!v) return ''; const m=String(v).match(/^(\d{4}-\d{2}-\d{2})/); return m?m[1]:''; }
function first(...vals){ for (const v of vals) if (v!=null) return v; return null; }
function findTypesArray(payload){
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.roomTypes)) return payload.roomTypes;
  if (Array.isArray(payload?.availableRoomTypes)) return payload.availableRoomTypes;
  if (Array.isArray(payload?.rooms)) return payload.rooms;
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Use GET.' });
  }

  const API_KEY = process.env.CLOUDBEDS_API_KEY || process.env.CLOUDBEDS_CREDENTIAL;
  if (!API_KEY) {
    return res.status(500).json({ success: false, message: 'Missing CLOUDBEDS_API_KEY env' });
  }

  try {
    const propertyID = str(req.query.propertyID);
    let startDate    = ymd(req.query.startDate || req.query.checkInDate);
    let endDate      = ymd(req.query.endDate   || req.query.checkOutDate);
    const adults     = toInt(req.query.adults ?? req.query.numAdults, 2);
    const children   = toInt(req.query.children ?? req.query.numChildren, 0);
    const roomTypeID = str(req.query.roomTypeID);
    const quantity   = toInt(req.query.quantity, 1);

    const missing = [];
    if (!propertyID) missing.push('propertyID');
    if (!startDate)  missing.push('startDate');
    if (!endDate)    missing.push('endDate');
    if (missing.length) {
      return res.status(400).json({ success:false, message:`Missing required fields: ${missing.join(', ')}` });
    }
    if (new Date(endDate) <= new Date(startDate)) {
      return res.status(400).json({ success:false, message:'endDate must be after startDate.' });
    }

    // Try a few endpoint variants (Cloudbeds accounts differ)
    const bases = [
      process.env.CLOUDBEDS_BASE_URL || 'https://api.cloudbeds.com/api/v1.3',
      'https://hotels.cloudbeds.com/api/v1.3',
      'https://api.cloudbeds.com/api/v1.2',
      'https://hotels.cloudbeds.com/api/v1.2',
    ];
    const routes = ['get_getAvailableRoomTypes', 'get_getavailableroomtypes'];

    const qs = new URLSearchParams({
      propertyID,
      startDate, endDate,
      checkInDate: startDate,
      checkOutDate: endDate,
      adults: String(adults),
      children: String(children),
    });
    if (roomTypeID) qs.set('roomTypeID', roomTypeID);

    let usedUrl = null, status = 0, payload = null;

    for (const base of bases) {
      for (const route of routes) {
        const url = `${base}/${route}?${qs.toString()}`;
        const r = await fetch(url, { headers: { 'x-api-key': API_KEY } });
        status = r.status;
        const raw = await r.text();
        let data; try { data = JSON.parse(raw); } catch { data = { raw }; }
        if (status !== 404) { usedUrl = url; payload = data; break; }
      }
      if (usedUrl) break;
    }

    if (!usedUrl) {
      return res.status(502).json({ success:false, message:'Availability endpoint not found (404 on all variants).' });
    }

    if (status < 200 || status >= 300 || payload?.success === false) {
      return res.status(status || 400).json({
        success:false,
        message: payload?.message || payload?.error || 'Cloudbeds returned an error.',
        cloudbeds: payload,
        _endpoint: usedUrl
      });
    }

    const list = findTypesArray(payload);
    if (!Array.isArray(list)) {
      return res.status(200).json({
        success: true, canBook: false,
        reason: 'Could not read availability list from Cloudbeds.',
        _endpoint: usedUrl, raw: payload
      });
    }

    const normalized = list.map(row => {
      const id = str(row.roomTypeID || row.room_type_id || row.id);
      const name = str(row.roomTypeName || row.name || '');
      const available = toInt(first(row.availableRooms, row.availability, row.remainingRooms, row.roomsAvailable, row.available, row.qty), 0);
      const maxGuests = toInt(first(row.maxGuests, row.occupancy, row.max_occupancy), null);
      return { roomTypeID: id, roomTypeName: name, available, maxGuests };
    });

    const party = adults + children;
