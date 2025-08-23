// api/get-price.js
// Returns the total price for the stay window.
// Response: { success, startDate, endDate, nights, totalPrice }
//
// Uses plan.roomRate if present (>0); otherwise sums nightly rates in the range.

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
    if (!plans.length) return res.status(200).json({ success: true, startDate, endDate, nights, totalPrice: 0 });

    // Prefer a plan with a numeric roomRate>0
    const plan = plans.find(p => toNum(p?.roomRate) > 0) || plans[0];
    let totalPrice = toNum(plan?.roomRate, 0);

    if (totalPrice <= 0) {
      const details = Array.isArray(plan?.roomRateDetailed) ? plan.roomRateDetailed : [];
      totalPrice = details
        .filter(d => d?.date >= startDate && d?.date < endDate)
        .reduce((s, d) => s + toNum(d?.rate, 0), 0);
    }

    return res.status(200).json({ success: true, startDate, endDate, nights, totalPrice });

  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
}

// helpers
function normDate(v){ if(!v) return ''; if(/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0,10); const d=new Date(v); return Number.isNaN(+d)?'':d.toISOString().slice(0,10); }
function toInt(v,d=0){ const n=parseInt(v,10); return Number.isFinite(n)?n:d; }
function toNum(v,d=0){ if(v==null) return d; const n=Number(String(v).replace(',', '.')); return Number.isFinite(n)?n:d; }
function diffDays(a,b){ return Math.ceil((new Date(b+'T00:00:00Z')-new Date(a+'T00:00:00Z'))/86400000); }
