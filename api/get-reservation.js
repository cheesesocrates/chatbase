// api/get-reservation.js
// Returns ONLY { valid, minimumNightsRequiredToStay } for Chatbase
// ENV: CLOUDBEDS_API_KEY = cbat_...

export default async function handler(req, res) {
  try {
    const API_KEY = process.env.CLOUDBEDS_API_KEY;

    // accept GET query or POST body
    const src = req.method === 'POST' ? (req.body || {}) : (req.query || {});
    const propertyID = String(src.propertyID || '198424');
    const startDate  = normDate(src.startDate || src.checkin);
    const endDate    = normDate(src.endDate   || src.checkout);
    const adults     = toInt(src.adults, 2);
    const children   = toInt(src.children, 0);

    // If dates are missing/invalid → not valid, min=1
    const nights = diffDays(startDate, endDate);
    if (!startDate || !endDate || nights <= 0 || !API_KEY) {
      return res.status(200).json({ valid: false, minimumNightsRequiredToStay: 1 });
    }

    // Call Cloudbeds getRatePlans
    const url = new URL('https://api.cloudbeds.com/api/v1.3/getRatePlans');
    url.searchParams.set('propertyID', propertyID);
    url.searchParams.set('startDate', startDate);
    url.searchParams.set('endDate', endDate);
    url.searchParams.set('adults', String(adults));
    url.searchParams.set('children', String(children));
    url.searchParams.set('detailedRates', 'true');

    const r = await fetch(url.toString(), { headers: { 'x-api-key': API_KEY } });
    const j = await r.json().catch(() => ({}));

    // If API error or no plans → treat as not valid with min=1
    const plans = Array.isArray(j?.data) ? j.data : [];
    if (!r.ok || j?.success === false || plans.length === 0) {
      return res.status(200).json({ valid: false, minimumNightsRequiredToStay: 1 });
    }

    // Use first plan's details to determine minLos & availability
    const details = Array.isArray(plans[0]?.roomRateDetailed) ? plans[0].roomRateDetailed : [];

    // minLos: prefer arrival-day value, else max across range, default 1
    let minLos = 1;
    const arrival = details.find(d => d?.date === startDate);
    if (arrival?.minLos > 0) {
      minLos = parseInt(arrival.minLos, 10);
    } else {
      const mins = details.map(d => parseInt(d?.minLos || 0, 10)).filter(n => n > 0);
      if (mins.length) minLos = Math.max(...mins);
    }

    // Basic availability validation across the requested window
    const windowDays = details.filter(d => d?.date >= startDate && d?.date < endDate);
    const anyBlocked = windowDays.some(d =>
      d?.roomsAvailable === 0 ||
      Number(d?.rate) === 0 ||
      (d?.date === startDate && d?.closedToArrival) ||
      (d?.date === endDate && d?.closedToDeparture)
    );

    const valid = nights >= minLos && !anyBlocked;

    return res.status(200).json({
      valid,
      minimumNightsRequiredToStay: minLos
    });

  } catch {
    // On any unexpected error, keep the shape exactly as requested
    return res.status(200).json({ valid: false, minimumNightsRequiredToStay: 1 });
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
function diffDays(a, b) {
  if (!a || !b) return 0;
  return Math.ceil((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}
