// api/get-price.js
// Returns ONLY the total price for the requested room type in the requested property.

export default async function handler(req, res) {
  try {
    const src = req.method === 'POST' ? (req.body || {}) : (req.query || {});

    const propertyID = toStr(src.propertyID);
    const startDate  = normDate(src.startDate || src.checkin);
    const endDate    = normDate(src.endDate   || src.checkout);
    const adults     = toInt(src.adults, 2);
    const children   = toInt(src.children, 0);
    const ratePlanId = toStr(src.ratePlanId);
    const roomTypeNameQ = toStr(src.roomTypeName || src.roomType || src.room);
    const roomTypeIDQ   = toStr(src.roomTypeID);

    if (!propertyID || !startDate || !endDate) return only(res, 0);
    const nights = diffDays(startDate, endDate);
    if (nights <= 0) return only(res, 0);

    const provider = getProviderForProperty(propertyID);
    if (!provider) return only(res, 0);

    const url = new URL(`${provider.apiBase}/getRatePlans`);
    if (needsPropertyParam(provider)) url.searchParams.set('propertyID', propertyID);
    url.searchParams.set('startDate', startDate);
    url.searchParams.set('endDate', endDate);
    url.searchParams.set('adults', String(adults));
    url.searchParams.set('children', String(children));
    url.searchParams.set('detailedRates', 'true');

    const headers = buildAuthHeaders(provider);
    const r = await fetch(url.toString(), { headers });
    const j = await r.json().catch(() => ({}));

    if (!r.ok || j?.success === false) return only(res, 0);

    const plans = Array.isArray(j?.data) ? j.data : [];
    if (!plans.length) return only(res, 0);

    const candidates = filterByRoomType(plans, { roomTypeNameQ, roomTypeIDQ, ratePlanId });
    if (!candidates.length) return only(res, 0);

    const scored = candidates.map(pl => {
      const score = scoreRoomMatch(pl, { roomTypeNameQ, roomTypeIDQ });
      const total = computeWindowTotal(pl, startDate, endDate);
      return { plan: pl, score, total };
    }).filter(x => x.total.ok);

    if (!scored.length) return only(res, 0);

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.total.amount - b.total.amount;
    });

    const best = scored[0];
    return only(res, best.total.amount);

  } catch {
    return only(res, 0);
  }
}

/* ---------- utils ---------- */
function only(res, amount) {
  return res.status(200).json({ totalPrice: amount });
}

function getProviderForProperty(propertyID) {
  const map = {
    '198424': { apiBase: 'https://api.cloudbeds.com/api/v1.2', apiKey: process.env.CLOUDBEDS_API_KEY  || '' },
    '198425': { apiBase: 'https://api.cloudbeds.com/api/v1.3', apiKey: process.env.CLOUDBEDS_API_KEY_2 || '' },
    '303475': { apiBase: 'https://api.cloudbeds.com/api/v1.2', apiKey: process.env.CLOUDBEDS_API_KEY_3 || '' },
  };
  const p = map[String(propertyID)];
  if (!p) return null;
  const authType = String(p.apiKey || '').startsWith('cbat_') ? 'bearer' : 'x-api-key';
  return { ...p, authType };
}

function buildAuthHeaders(provider) {
  if (provider.authType === 'bearer') {
    return { 'Authorization': `Bearer ${provider.apiKey}` };
  }
  return { 'x-api-key': provider.apiKey };
}
function needsPropertyParam(provider) { return true; }

function filterByRoomType(plans, { roomTypeNameQ, roomTypeIDQ, ratePlanId }) {
  const normQ = normalize(roomTypeNameQ);
  return plans.filter(pl => {
    if (ratePlanId && String(pl?.rateID) !== String(ratePlanId)) return false;
    const id  = toStr(pl?.roomTypeID);
    const nam = toStr(pl?.roomTypeName);
    if (roomTypeIDQ && String(roomTypeIDQ) === id) return true;
    if (!normQ) return true;
    const namN = normalize(nam);
    return namN.includes(normQ) || normQ.includes(namN);
  });
}
function scoreRoomMatch(plan, { roomTypeNameQ, roomTypeIDQ }) {
  const id = toStr(plan?.roomTypeID);
  const nm = toStr(plan?.roomTypeName);
  const nmQ = normalize(roomTypeNameQ);
  if (roomTypeIDQ && String(roomTypeIDQ) === id) return 3;
  if (nmQ && normalize(nm) === nmQ) return 2;
  if (nmQ && normalize(nm).includes(nmQ)) return 1;
  return 0;
}

function computeWindowTotal(plan, startDate, endDate) {
  const nights = diffDays(startDate, endDate);
  const details = Array.isArray(plan?.roomRateDetailed) ? plan.roomRateDetailed : [];
  if (!details.length) return { ok:false, amount:0 };

  const last = addDays(startDate, nights - 1);
  const window = details.filter(d => d?.date >= startDate && d?.date <= last);
  if (window.length < nights) return { ok:false, amount:0 };

  const arrival = details.find(d => d?.date === startDate);
  const minLos  = inferMinLos(details, arrival);
  if (nights < minLos) return { ok:false, amount:0 };
  if (arrival?.closedToArrival) return { ok:false, amount:0 };
  const depClosed =
    details.find(d => d?.date === endDate)?.closedToDeparture ||
    details.find(d => d?.date === last)?.closedToDeparture || false;
  if (depClosed) return { ok:false, amount:0 };

  if (window.some(d => toInt(d?.roomsAvailable, 0) <= 0)) return { ok:false, amount:0 };
  if (window.some(d => toNum(d?.rate, 0) <= 0)) return { ok:false, amount:0 };

  let amount = toNum(plan?.roomRate, 0);
  if (amount <= 0) {
    amount = window.reduce((s, d) => s + toNum(d?.rate, 0), 0);
  }
  return { ok:true, amount };
}

/* ---------- small helpers ---------- */
function toStr(v){ return (v==null ? '' : String(v).trim()) || ''; }
function normDate(v){ if(!v) return ''; if(/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0,10); const d=new Date(v); return Number.isNaN(+d)?'':d.toISOString().slice(0,10); }
function toInt(v,d=0){ const n=parseInt(v,10); return Number.isFinite(n)?n:d; }
function toNum(v,d=0){ if(v==null) return d; const n=Number(String(v).replace(',', '.')); return Number.isFinite(n)?n:d; }
function diffDays(a,b){ return Math.ceil((new Date(b+'T00:00:00Z')-new Date(a+'T00:00:00Z'))/86400000); }
function addDays(isoYmd,days){ const d=new Date(isoYmd+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()+days); return d.toISOString().slice(0,10); }
function inferMinLos(details, arrival){
  const a = toInt(arrival?.minLos, 0);
  if (a > 0) return a;
  const mins = details.map(d => toInt(d?.minLos, 0)).filter(n => n > 0);
  return mins.length ? Math.max(...mins) : 1;
}
function normalize(s){
  s = toStr(s).toLowerCase();
  s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}
