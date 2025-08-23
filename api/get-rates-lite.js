// api/get-rates-lite.js
// Vercel/Next.js (Node 18+)
// Calls Cloudbeds getRatePlans and returns ONLY { roomRate, minLos } for Chatbase.
//
// ENV (Vercel -> Settings -> Environment Variables):
//   CLOUDBEDS_API_KEY = cbat_...  (required)

export default async function handler(req, res) {
  try {
    const API_KEY = process.env.CLOUDBEDS_API_KEY;
    if (!API_KEY) {
      return res.status(500).json({ success: false, message: 'Missing CLOUDBEDS_API_KEY' });
    }

    // Accept GET (query) or POST (JSON body)
    const src = req.method === 'POST' ? (req.body || {}) : (req.query || {});

    // Inputs (defaults kept simple)
    const propertyID = String(src.propertyID || '198424');
    const adults     = toInt(src.adults, 2);
    const children   = toInt(src.children, 0);

    // Normalize dates to YYYY-MM-DD
    const start = normDate(src.startDate || src.checkin);
    const end   = normDate(src.endDate   || src.checkout);

    if (!start || !end) {
      return res.status(400).json({ success: false, message: 'startDate/checkin and endDate/checkout are required (YYYY-MM-DD)' });
    }

    // Build Cloudbeds getRatePlans URL
    const url = new URL('https://api.cloudbeds.com/api/v1.3/getRatePlans');
    url.searchParams.set('propertyID', propertyID);
    url.searchParams.set('startDate', start);
    url.searchParams.set('endDate', end);
    url.searchParams.set('adults', String(adults));
    url.searchParams.set('children', String(children));
    url.searchParams.set('detailedRates', 'true');

    // Call Cloudbeds
    const resp = await fetch(url.toString(), {
      headers: { 'x-api-key': API_KEY }
    });
    const json = await resp.json().catch(() => ({}));

    if (!resp.ok || !json || json.success === false) {
      const msg = (json && (json.message || json.error)) || `Cloudbeds error ${resp.status}`;
      return res.status(502).json({ success: false, message: msg });
    }

    const plans = Array.isArray(json.data) ? json.data : [];
    if (plans.length === 0) {
      return res.status(200).json({ success: true, roomRate: 0, minLos: 1 });
    }

    // Pick a plan: first with a numeric roomRate > 0, otherwise the first one
    const chosen = plans.find(p => toNum(p?.roomRate) > 0) || plans[0];

    // roomRate: reported by Cloudbeds for the stay window
    const roomRate = toNum(chosen?.roomRate);

    // minLos: prefer arrival-day entry; else max across details; default 1
    const details = Array.isArray(chosen?.roomRateDetailed) ? chosen.roomRateDetailed : [];
    let minLos = 1;

    const arrival = details.find(d => d?.date === start);
    if (arrival && toInt(arrival.minLos, 0) > 0) {
      minLos = toInt(arrival.minLos, 1);
    } else {
      const mins = details.map(d => toInt(d?.minLos, 0)).filter(n => n > 0);
      if (mins.length) minLos = Math.max(...mins);
    }

    return res.status(200).json({
      success: true,
      roomRate,
      minLos
    });

  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

// --- helpers ---
function normDate(v) {
  if (!v) return '';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  const d = new Date(v);
  return Number.isNaN(+d) ? '' : d.toISOString().slice(0, 10);
}
function toInt(v, d = 0) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
}
function toNum(v, d = 0) {
  if (v == null) return d;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : d;
}
