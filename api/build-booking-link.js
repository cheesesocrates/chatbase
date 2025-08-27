// api/build-booking-link.js
// Returns HTTP 200 with a single JSON field "url":
//  - success case (one or more): { success:true, url: "https://... || https://..." }
//  - failure case:                { success:true, url: "ERROR: slot1: reason | slot2: reason | slot3: reason" }

export default async function handler(req, res) {
  try {
    res.setHeader('Cache-Control', 'no-store');

    const src         = req.method === 'POST' ? (req.body || {}) : (req.query || {});
    const checkin     = normDate(src.startDate || src.checkin);
    const checkout    = normDate(src.endDate   || src.checkout);
    const adults      = toInt(src.adults,   2);
    const children    = toInt(src.children, 0);
    const currency    = normCurrency(src.currency);
    const roomTypeId  = toStr(src.roomTypeId);
    const ratePlanId  = toStr(src.ratePlanId);
    const promoCode   = toStr(src.promoCode);

    // Priority selection
    const desiredPropertyID = toStr(src.desiredPropertyID) || '';  // preferred way to pick property
    const preferredSlot     = toStr(src.provider);                 // "1"|"2"|"3" optional
    const fallback          = toBool(src.fallback, true);          // try others if first fails

    // Sanity
    if (!checkin || !checkout) return ok(res, `ERROR: Missing check-in or check-out (YYYY-MM-DD).`);
    const nights = diffDays(checkin, checkout);
    if (nights <= 0) return ok(res, `ERROR: checkout must be after checkin.`);

    // Load 1..3 providers from env (each with its own property & booking engine)
    const providers = orderProviders(loadProvidersFromEnv(), desiredPropertyID, preferredSlot);
    if (!providers.length) return ok(res, `ERROR: No providers configured.`);

    const foundLinks = [];
    const attempts   = [];

    for (const p of providers) {
      const attempt = { slot: p.slot, reason: '' };
      attempts.push(attempt);

      // Config checks first (collect explicit "what's missing")
      if (!p.apiBase)    { attempt.reason = 'Missing API base URL'; if (!fallback) break; else continue; }
      if (!p.apiKey)     { attempt.reason = 'Missing API key';      if (!fallback) break; else continue; }
      if (!p.propertyID) { attempt.reason = 'Missing property ID';  if (!fallback) break; else continue; }
      if (!p.bookingId)  { attempt.reason = 'Missing booking engine id'; if (!fallback) break; else continue; }

      // Query Cloudbeds getRatePlans (v1.3) with nightly details
      const rateUrl = new URL(joinUrl(p.apiBase, 'getRatePlans'));
      rateUrl.searchParams.set('propertyID', p.propertyID);
      rateUrl.searchParams.set('startDate',  checkin);
      rateUrl.searchParams.set('endDate',    checkout);
      rateUrl.searchParams.set('adults',     String(adults));
      rateUrl.searchParams.set('children',   String(children));
      rateUrl.searchParams.set('detailedRates', 'true');
      if (promoCode) rateUrl.searchParams.set('promoCode', promoCode);

      const resp = await fetch(rateUrl.toString(), { headers: { 'x-api-key': p.apiKey } });
      const json = await resp.json().catch(() => ({}));
      const plans = Array.isArray(json?.data) ? json.data : [];
      if (!resp.ok || json?.success === false || plans.length === 0) {
        attempt.reason = json?.message || 'No plans found';
        if (!fallback) break; else continue;
      }

      // Optional filters
      const filtered = plans
        .filter(pl => (!ratePlanId || String(pl?.ratePlanId) === ratePlanId))
        .map(pl => ({ ...pl, details: Array.isArray(pl?.roomRateDetailed) ? pl.roomRateDetailed : [] }))
        .filter(pl => !roomTypeId || hasRoomType(pl, roomTypeId));

      if (!filtered.length) {
        attempt.reason = 'No matching room/rate plan for requested filters';
        if (!fallback) break; else continue;
      }

      // Validate the stay window (min nights, closures, rates present, rooms available)
      const candidate = filtered[0];
      const details   = candidate.details;
      const lastNight = addDays(checkin, nights - 1);
      const window    = details.filter(d => d?.date >= checkin && d?.date <= lastNight);

      if (window.length < nights)                         { attempt.reason = 'Missing nightly rates across window'; if (!fallback) break; else continue; }
      const arrival = details.find(d => d?.date === checkin);
      const minLos  = inferMinLos(details, arrival);
      if (nights < minLos)                                { attempt.reason = `Minimum stay is ${minLos} nights`;   if (!fallback) break; else continue; }
      if (arrival?.closedToArrival)                       { attempt.reason = 'Closed to arrival';                  if (!fallback) break; else continue; }
      const closedToDeparture =
        details.find(d => d?.date === checkout)?.closedToDeparture ||
        details.find(d => d?.date === lastNight)?.closedToDeparture || false;
      if (closedToDeparture)                              { attempt.reason = 'Closed to departure';                if (!fallback) break; else continue; }
      if (window.some(d => toInt(d?.roomsAvailable, 0) === 0)) { attempt.reason = 'No availability on one or more nights'; if (!fallback) break; else continue; }
      if (window.some(d => toNum(d?.rate, 0) <= 0))            { attempt.reason = 'No published rate on one or more nights'; if (!fallback) break; else continue; }

      // Success: build booking link for this provider
      const qs = new URLSearchParams({
        checkin, checkout,
        adults: String(adults),
        children: String(children),
      });
      if (currency)   qs.set('currency',  currency);
      if (roomTypeId) qs.set('roomTypeId', roomTypeId);
      if (ratePlanId) qs.set('ratePlanId', ratePlanId);
      if (promoCode)  qs.set('promoCode',  promoCode);

      const link = `https://hotels.cloudbeds.com/${p.locale}/reservation/${p.bookingId}/?${qs.toString()}`;
      foundLinks.push(link);

      // Keep looking for more links? You asked to “output those two links” if others exist,
      // so we KEEP scanning the remaining providers to collect ALL valid links.
      continue;
    }

    if (foundLinks.length) {
      // Return ALL links in one "url" string, separated by " || "
      return ok(res, foundLinks.join(' || '));
    }

    // No successes → collate reasons
    const reason = attempts.map(a => `slot${a.slot}: ${a.reason || 'failed'}`).join(' | ');
    return ok(res, `ERROR: ${reason || 'No availability with any provider.'}`);

  } catch {
    return ok(res, `ERROR: Unexpected server error.`);
  }
}

/* ---------------- helpers (inline) ---------------- */

function loadProvidersFromEnv() {
  const rows = [
    {
      slot: '1',
      apiKey:     process.env.CLOUDBEDS_API_KEY      || '',
      propertyID: process.env.CLOUDBEDS_PROPERTY_ID  || '',
      bookingId:  process.env.CLOUDBEDS_BOOKING_ID   || '',
      locale:     process.env.CLOUDBEDS_LOCALE       || 'es',
      apiBase:    process.env.CLOUDBEDS_API_BASE     || 'https://api.cloudbeds.com/api/v1.3',
    },
    {
      slot: '2',
      apiKey:     process.env.CLOUDBEDS_API_KEY_2     || '',
      propertyID: process.env.CLOUDBEDS_PROPERTY_ID_2 || '',
      bookingId:  process.env.CLOUDBEDS_BOOKING_ID_2  || process.env.CLOUDBEDS_BOOKING_ID || '',
      locale:     process.env.CLOUDBEDS_LOCALE_2      || process.env.CLOUDBEDS_LOCALE || 'es',
      apiBase:    process.env.CLOUDBEDS_API_BASE_2    || process.env.CLOUDBEDS_API_BASE || 'https://api.cloudbeds.com/api/v1.3',
    },
    {
      slot: '3',
      apiKey:     process.env.CLOUDBEDS_API_KEY_3     || '',
      propertyID: process.env.CLOUDBEDS_PROPERTY_ID_3 || '',
      bookingId:  process.env.CLOUDBEDS_BOOKING_ID_3  || process.env.CLOUDBEDS_BOOKING_ID || '',
      locale:     process.env.CLOUDBEDS_LOCALE_3      || process.env.CLOUDBEDS_LOCALE || 'es',
      apiBase:    process.env.CLOUDBEDS_API_BASE_3    || process.env.CLOUDBEDS_API_BASE || 'https://api.cloudbeds.com/api/v1.3',
    },
  ];
  // keep configured slots only
  return rows.filter(r => r.apiKey || r.propertyID || r.bookingId);
}

function orderProviders(arr, desiredPropertyID, preferredSlot) {
  // 1) by exact propertyID match (if provided), 2) by preferred slot, 3) as-is
  let out = [...arr];
  if (desiredPropertyID) {
    const hit = out.find(p => String(p.propertyID) === String(desiredPropertyID));
    if (hit) out = [hit, ...out.filter(p => p !== hit)];
  } else if (preferredSlot) {
    const hit = out.find(p => p.slot === String(preferredSlot));
    if (hit) out = [hit, ...out.filter(p => p !== hit)];
  }
  return out;
}

function ok(res, urlStr) { return res.status(200).json({ success: true, url: String(urlStr || '') }); }
function toStr(v){ return (v==null ? '' : String(v).trim()) || ''; }
function toBool(v, d=false){ if(v==null) return d; const s=String(v).toLowerCase(); return ['1','true','yes','y','on'].includes(s); }
function normDate(v){ if(!v) return ''; if(typeof v==='string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0,10); const d=new Date(v); return Number.isNaN(+d)?'':d.toISOString().slice(0,10); }
function normCurrency(v){ if(!v) return ''; const s=String(v).trim().toLowerCase(); return /^[a-z]{3}$/.test(s)?s:''; }
function toInt(v,d=0){ const n=parseInt(v,10); return Number.isFinite(n)?n:d; }
function toNum(v,d=0){ if(v==null) return d; const n=Number(String(v).replace(',','.')); return Number.isFinite(n)?n:d; }
function diffDays(a,b){ if(!a||!b) return 0; return Math.ceil((new Date(b+'T00:00:00Z')-new Date(a+'T00:00:00Z'))/86400000); }
function addDays(isoYmd,days){ const d=new Date(isoYmd+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()+days); return d.toISOString().slice(0,10); }
function hasRoomType(plan, roomTypeId){
  if (String(plan?.roomTypeId||'') === String(roomTypeId)) return true;
  const det = Array.isArray(plan?.roomRateDetailed) ? plan.roomRateDetailed : [];
  return det.some(d => String(d?.roomTypeId||'') === String(roomTypeId));
}
function inferMinLos(details, arrival){
  if (toInt(arrival?.minLos, 0) > 0) return toInt(arrival.minLos, 1);
  const mins = details.map(d => toInt(d?.minLos, 0)).filter(n => n > 0);
  return mins.length ? Math.max(...mins) : 1;
}
function joinUrl(base, path){ return `${base.replace(/\\/+$/,'')}/${String(path).replace(/^\\/+/, '')}`; }
