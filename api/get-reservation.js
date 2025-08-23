// api/get-reservation.js
// Checks min nights (minLos) & availability and returns a simple verdict
// Response: { success, startDate, endDate, nights, valid, minimumNightsRequiredToStay }
//
// ENV: CLOUDBEDS_API_KEY = cbat_...

export default async function handler(req, res) {
  try {
    const API_KEY = process.env.CLOUDBEDS_API_KEY;
    if (!API_KEY) return res.status(500).json({ success: false, message: 'Missing CLOUDBEDS_API_KEY' });

    const src = req.method === 'POST' ? (req.body || {}) : (req.query || {});
    const propertyID = String(src.propertyID || '198424');
    const startDate  = normDate(src.startDate || src.checkin);
    const endDate    = normDate(src.endDate   || src.checkout);
    const adults     = toInt(src.adults, 2);
    const children   = toInt(src.children, 0);
    if (!startDate || !endDate) return res.status(400).json({ success: false, message: 'startDate and endDate required (YYYY-MM-DD)' });

    const nights = diffDays(startDate, endDate);
    if (nights <= 0) return res.status(200).json({ success: false, message: 'checkout must be after checkin' });

    const url = new URL('https://api.cloudbeds.com/api/v1.3/getRatePlans');
    url.searchParams.set('propertyID', propertyID);
    url.searchParams.set('startDate', startDate);
    url.searchParams.set('endDate', endDate);
    url.searchParams.set('adults', String(adults));
    url.searchParams.set('children', String(children));
    url.searchParams.set('detailedRates', 'true');

    const r = await fetch(url, { headers: { 'x-api-key': API_KEY } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j?.success === false) {
      return res.status(502).json({ success: false, message: j?.message || `Cloudbeds error ${r.status}` });
    }

    const plans = Array.isArray(j?.data) ? j.data : [];
    if (!plans.length) {
      return res.status(200).json({ success: true, startDate, endDate, nights, valid: false, minimumNightsRequiredToStay: 1 });
    }

    // Use the first plan; we only need minLos/availability signal
    const plan = plans[0];
    const details = Array.isArray(plan?.roomRateDetailed) ? plan.roomRateDetailed : [];

    // minLos: prefer arrival day; else max; default 1
    let minLos = 1;
    const arrival = details.find(d => d?.date === startDate);
    if (arrival?.minLos > 0) minLos = parseInt(arrival.minLos, 10);
    else {
      const mins = details.map(d => parseInt(d?.minLos || 0, 10)).filter(n => n > 0);
      if (mins.length) minLos = Math.max(...mins);
    }

    // Basic availability check across stay
    const range = details.filter(d => d?.date >= startDate && d?.date < endDate);
    const anyBlocked = range.some(d =>
      d?.roomsAvailable === 0 ||
      Number(d?.rate) === 0 ||
      (d?.date === startDate && d?.closedToArrival) ||
      (d?.date === endDate   && d?.closedToDeparture)
    );

    const valid = nights >= minLos && !anyBlocked;

    return res.status(200).json({
      success: true,
      startDate, endDate, nights,
      valid,
      minimumNightsRequiredToStay: minLos
    });

  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

// helpers
function normDate(v){ if(!v) return ''; if(/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0,10); const d=new Date(v); return Number.isNaN(+d)?'':d.toISOString().slice(0,10); }
function toInt(v,d=0){ const n=parseInt(v,10); return Number.isFinite(n)?n:d; }
function diffDays(a,b){ return Math.ceil((new Date(b+'T00:00:00Z')-new Date(a+'T00:00:00Z'))/86400000); }
