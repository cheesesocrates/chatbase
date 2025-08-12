export default async function handler(req, res) {
  // health check if you open in browser
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, message: 'Cloudbeds relay live' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  }

  try {
    // Accept both naming styles
    const {
      propertyID,
      startDate,
      endDate,
      checkInDate,
      checkOutDate,
      roomTypeID,
      numAdults,
      numChildren,
      guestFirstName,
      guestLastName,
      guestEmail,
      guestCountry
    } = req.body || {};

    const start = startDate || checkInDate;
    const end   = endDate   || checkOutDate;

    // Basic validation
    const missing = [];
    if (!propertyID)     missing.push('propertyID');
    if (!start)          missing.push('startDate');
    if (!end)            missing.push('endDate');
    if (!roomTypeID)     missing.push('roomTypeID');
    if (!numAdults)      missing.push('numAdults');
    if (!guestFirstName) missing.push('guestFirstName');
    if (!guestLastName)  missing.push('guestLastName');
    if (!guestEmail)     missing.push('guestEmail');
    if (!guestCountry)   missing.push('guestCountry');

    if (missing.length) {
      return res.status(400).json({ success: false, message: `Missing required fields: ${missing.join(', ')}` });
    }

    // Build x-www-form-urlencoded body (required by Cloudbeds)
    const form = new URLSearchParams({
      propertyID: String(propertyID),
      startDate:  String(start),
      endDate:    String(end),
      roomTypeID: String(roomTypeID),
      numAdults:  String(numAdults),
      numChildren: String(numChildren ?? 0),
      guestFirstName: String(guestFirstName),
      guestLastName:  String(guestLastName),
      guestEmail:     String(guestEmail),
      guestCountry:   String(guestCountry)
    });

    const r = await fetch('https://api.cloudbeds.com/api/v1.2/postReservation', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.CLOUDBEDS_API_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: form.toString()
    });

    const data = await r.json().catch(() => ({}));
    return res.status(r.status).json(data);
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}
