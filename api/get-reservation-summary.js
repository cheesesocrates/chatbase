// api/get-reservation-summary.js
// Vercel/Next.js (Node 18+)
//
// Returns a concise summary the bot can read easily:
// { success, startDate, endDate, nights, adults, children,
//   roomRate, minLos, rateID, roomTypeID, roomTypeName,
//   roomsAvailable, arrival: {closedToArrival}, departure: {closedToDeparture},
//   nightly: [{date, rate, minLos, roomsAvailable, closedToArrival, closedToDeparture}] }
//
// ENV: CLOUDBEDS_API_KEY = cbat_...

export default async function handler(req, res) {
  try {
    const API_KEY = process.env.CLOUDBEDS_API_KEY;
    if (!API_KEY) {
      return res.status(500).json({ success: false, message: 'Missing CLOUDBEDS_API_KEY' });
    }

    const src = req.method === 'POST' ? (req.body || {}) : (req.query || {});
    const propertyID = String(src.propertyID || '198424');
    const startDate  = normDate(src.startDate || src.checkin);
    const endDate    = normDate(src.endDate   || src.checkout);
    const adults     = toInt(src.adults, 2);
    const children   = toInt(src.children, 0);

    if (!startDate || !endDate) {
      return res.status(400).json({ success: false, message: 'startDate and endDate (YYYY-MM-DD) required' });
    }

    const nights = diffDays(startDate, endDate);
    if (nights <= 0) {
      return res.status(200).json({ success: false, message: 'checkout must be after checkin' });
    }

    const url = new URL('https://api.cloudbeds.com/api/v1.3/getRatePlans');
    url.searchParams.set('propertyID', propertyID);
    url.searchParams.set('startDate', startDate);
    url.searchParams.set('endDate', endDate);
    url.searchParams.set('adults', String(adults));
    url.searchParams.set('children', String(children));
    url.searchParams.set('detailedRates', 'true');

    const cb = await fetch(url.toString(), { headers: { 'x-api-key': API_KEY } });
    const data = await cb.json().catch(() => ({}));
    if (!cb.ok || !data || data.success === false) {
      const message = data?.message || data?.error || `Cloudbeds error ${cb.status}`;
      return res.status(502).json({ success: false, message });
    }

    const plans = Array.isArray(data.data) ? data.data : [];
    if (!plans.length) {
      return res.status(200).json({ success: true, startDate, endDate, nights, adults, children, roomRate: 0, minLos: 1, roomsAvailable: 0, nightly: [] });
    }

    // Choose a plan: prefer one with a numeric roomRate > 0; else the first plan.
    const plan = plans.find(p => toNum(p?.roomRate) > 0) || plans[0];
    const nightly = Array.isArray(plan?.roomRateDetailed) ? plan.roomRateDetailed.map(x => ({
      date: x?.date,
      rate: toNum(x?.rate),
      minLos: toInt(x?.minLos, 0),
      roomsAvailable: toInt(x?.roomsAvailable, 0),
      closedToArrival: !!x?.closedToArrival,
      closedToDeparture: !!x?.closedToDeparture
    })) : [];

    // minLos: arrival-day preferred; else max across range; default 1
    let minLos = 1;
    const arrival = nightly.find(d => d.date === startDate);
    if (arrival?.minLos > 0) minLos = arrival.minLos;
    else {
      const mins = nightly.map(d => d.minLos).filter(n => n > 0);
      if (mins.length) minLos = Math.max(...mins);
    }

    // Flags
    const arrivalClosed = arrival?.closedToArrival || false;
    const departureClosed = nightly.find(d => d.date === endDate)?.closedToDeparture || false;

    return res.status(200).json({
      success: true,
      startDate, endDate, nights,
      adults, children,
      roomRate: toNum(plan?.roomRate),
      minLos,
      rateID: plan?.rateID || null,
      roomTypeID: plan?.roomTypeID || null,
      roomTypeName: plan?.roomTypeName || null,
      roomsAvailable: toInt(plan?.roomsAvailable, 0),
      arrival: { closedToArrival: arrivalClosed },
      departure: { closedToDeparture: departureClosed },
      nightly
    });

  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

// helpers
function normDate(v) {
  if (!v) return '';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  const d = new Date(v);
  return Number.isNaN(+d) ? '' : d.toISOString().slice(0, 10);
}
function toInt(v, d = 0) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }
function toNum(v, d = 0) { if (v == null) return d; const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : d; }
function diffDays(a, b) { return Math.ceil((new Date(b+'T00:00:00Z') - new Date(a+'T00:00:00Z')) / 86400000); }
