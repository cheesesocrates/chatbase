// api/get-reservations.js  (ESM; your package.json has "type":"module")
// Lists reservations with optional filters. Uses OAuth Bearer.
// Query params you can pass: startDate, endDate, reservationID, email, status, propertyID, page, limit

function ymd(v) {
  if (!v) return '';
  const m = String(v).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}
function str(v) { return v == null ? '' : String(v).trim(); }

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Use GET.' });
  }

  const TOKEN = process.env.CLOUDBEDS_OAUTH_TOKEN;
  if (!TOKEN) {
    return res.status(500).json({ success: false, message: 'Missing CLOUDBEDS_OAUTH_TOKEN env' });
  }

  try {
    // ---- read & normalize filters from query ----
    const startDate    = ymd(req.query.startDate);
    const endDate      = ymd(req.query.endDate);
    const reservationID = str(req.query.reservationID);
    const email         = str(req.query.email);
    const status        = str(req.query.status);      // e.g., confirmed, cancelled (depends on Cloudbeds docs)
    const propertyID    = str(req.query.propertyID);  // optional; token may already scope it
    const page          = str(req.query.page);
    const limit         = str(req.query.limit);

    const base = 'https://api.cloudbeds.com/api/v1.2';
    const ep   = 'getReservations'; // CamelCase per Cloudbeds message

    const qs = new URLSearchParams();
    if (startDate) qs.set('startDate', startDate);
    if (endDate)   qs.set('endDate', endDate);
    if (reservationID) qs.set('reservationID', reservationID);
    if (email)         qs.set('email', email);
    if (status)        qs.set('status', status);
    if (propertyID)    qs.set('propertyID', propertyID);
    if (page)          qs.set('page', page);
    if (limit)         qs.set('limit', limit);

    const url = `${base}/${ep}${qs.toString() ? `?${qs.toString()}` : ''}`;

    const r = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    const raw = await r.text();
    let data; try { data = JSON.parse(raw); } catch { data = { raw }; }

    if (!r.ok || data?.success === false) {
      return res.status(r.status || 400).json({
        success: false,
        message: data?.message || data?.error || 'Cloudbeds returned an error.',
        cloudbeds: data,
        _endpoint: url
      });
    }

    return res.status(200).json({ success: true, data, _endpoint: url });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Unexpected server error.' });
  }
}
