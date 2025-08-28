// api/build-booking-link.js
// Returns 200 with: { success:true, url: "<link> || <link>" } OR { success:true, url: "ERROR: ..." }

export default async function handler(req, res) {
  try {
    res.setHeader('Cache-Control', 'no-store');

    const src = req.method === 'POST' ? (req.body || {}) : (req.query || {});
    const checkin    = normDate(src.startDate || src.checkin);
    const checkout   = normDate(src.endDate   || src.checkout);
    const adults     = toInt(src.adults, 2);
    const children   = toInt(src.children, 0);
    const currency   = normCurrency(src.currency);
    const roomTypeId = toStr(src.roomTypeId);
    const ratePlanId = toStr(src.ratePlanId);
    const promoCode  = toStr(src.promoCode);

    const desiredPropertyID = toStr(src.propertyID);  // prioritize this property first
    const preferredSlot     = toStr(src.provider);    // or slot=1|2|3
    const fallback          = toBool(src.fallback, true);

    if (!checkin || !checkout) return ok(res, `ERROR: Missing check-in or check-out (YYYY-MM-DD).`);
    const nights = diffDays(checkin, checkout);
    if (nights <= 0) return ok(res, `ERROR: checkout must be after checkin`);

    const providers = orderProviders(loadProvidersFromEnv(), desiredPropertyID, preferredSlot);
    if (!providers.length) return ok(res, `ERROR: No providers configured.`);

    const foundLinks = [];
    const attempts   = [];

    for (const p of providers) {
      const attempt = { name: p.name, reason: '' };
      attempts.push(attempt);

      if (!p.apiKey)     { attempt.reason = 'Missing API key';      if (!fallback) break; else continue; }
      if (!p.propertyID) { attempt.reason = 'Missing property ID';  if (!fallback) break; else continue; }
      if (!p.bookingBase){ attempt.reason = 'Missing booking link'; if (!fallback) break; else continue; }

      // Cloudbeds: getRatePlans
      const url = new URL(`${p.apiBase}/getRatePlans`);
      url.searchParams.set('propertyID', p.propertyID);
      url.searchParams.set('startDate',  checkin);
      url.searchParams.set('endDate',    checkout);
      url.searchParams.set('adults',     String(adults));
      url.searchParams.set('children',   String(children));
      url.searchParams.set('detailedRates', 'true');
      if (promoCode) url.searchParams.set('promoCode', promoCode);

      let json = null;
      try {
        const resp = await fetch(url.toString(), { headers: { 'x-api-key': p.apiKey } });
        json = await resp.json().catch(() => ({}));
        if (!resp.ok || json?.success === false) {
          attempt.reason = json?.message || `Cloudbeds HTTP ${resp.status}`;
          if (!fallback) break; else continue;
        }
      } catch (e) {
        attempt.reason = `Fetch error`;
        if (!fallback) break; else continue;
      }

      const plans = Array.isArray(json?.data) ? json.data : [];
      if (plans.length === 0) {
        attempt.reason = 'No plans found';
        if (!fallback) break; else continue;
      }

      // Optional filters
      const filtered = plans
        .filter(pl => (!ratePlanId || String(pl?.ratePlanId) === ratePlanId))
        .map(pl => ({ ...pl, details: Array.isArray(pl?.roomRateDetailed) ? pl.roomRateDetailed : [] }))
        .filter(pl => !roomTypeId || hasRoomType(pl, roomTypeId));

      if (!filtered.length) { attempt.reason = 'No matching room/rate plan'; if (!fallback) break; else continue; }

      // Validate stay rules
      const candidate = filtered[0];
      const details   = candidate.details;
      const lastNight = addDays(checkin, nights - 1);
      const window    = details.filter(d => d?.date >= checkin && d?.date <= lastNight);

      if (window.length < nights) { attempt.reason = 'Missing nightly rates'; if (!fallback) break; else continue; }
      const arrival = details.find(d => d?.date === checkin);
      const minLos  = inferMinLos(details, arrival);
      if (nights < minLos) { attempt.reason = `Minimum stay ${minLos}`; if (!fallback) break; else continue; }
      if (arrival?.closedToArrival) { attempt.reason = 'Closed to arrival'; if (!fallback) break; else continue; }
      const depClosed = details.find(d => d?.date === checkout)?.closedToDeparture ||
                        details.find(d => d?.date === lastNight)?.closedToDeparture || false;
      if (depClosed) { attempt.reason = 'Closed to departure'; if (!fallback) break; else continue; }
      if (window.some(d => toInt(d?.roomsAvailable,0) === 0)) { attempt.reason = 'No availability'; if (!fallback) break; else continue; }
      if (window.some(d => toNum(d?.rate,0) <= 0)) { attempt.reason = 'No published rate'; if (!fallback) break; else continue; }

      // SUCCESS → add booking link
      const qs = new URLSearchParams({
        checkin, checkout,
        adults: String(adults),
        children: String(children),
      });
      if (currency)   qs.set('currency',  currency);
      if (roomTypeId) qs.set('roomTypeId', roomTypeId);
      if (ratePlanId) qs.set('ratePlanId', ratePlanId);
      if (promoCode)  qs.set('promoCode',  promoCode);

      foundLinks.push(`${p.bookingBase}?${qs.toString()}`);
    }

    if (foundLinks.length) return ok(res, foundLinks.join(' || '));

    const reason = attempts.map(a => `${a.name}: ${a.reason || 'failed'}`).join(' | ');
    return ok(res, `ERROR: ${reason}`);

  } catch (e) {
    console.error('build-booking-link error:', e);
    return ok(res, `ERROR: Unexpected server error.`);
  }
}

/* --- Providers: STYLE, COLONIAL, ALTOS --- */
function loadProvidersFromEnv() {
  return [
    {
      slot: '1',
      name: 'STYLE',
      apiKey:     process.env.CLOUDBEDS_API_KEY      || '',
      propertyID: process.env.CLOUDBEDS_PROPERTY_ID  || '',
      bookingBase:'https://hotels.cloudbeds.com/es/reservation/svLoIs',
      apiBase:    process.env.CLOUDBEDS_API_BASE     || 'https://api.cloudbeds.com/api/v1.3',
    },
    {
      slot: '2',
      name: 'COLONIAL',
      apiKey:     process.env.CLOUDBEDS_API_KEY_2     || '',
      propertyID: process.env.CLOUDBEDS_PROPERTY_ID_2 || '',
      bookingBase:'https://hotels.cloudbeds.com/es/reservation/3atiWS',
      apiBase:    process.env.CLOUDBEDS_API_BASE_2    || process.env.CLOUDBEDS_API_BASE || 'https://api.cloudbeds.com/api/v1.3',
    },
    {
      slot: '3',
      name: 'ALTOS DE LA VIUDA',
      apiKey:     process.env.CLOUDBEDS_API_KEY_3     || '',
      propertyID: process.env.CLOUDBEDS_PROPERTY_ID_3 || '',
      bookingBase:'https://hotels.cloudbeds.com/reservation/AwNrlI',
      apiBase:    process.env.CLOUDBEDS_API_BASE_3    || process.env.CLOUDBEDS_API_BASE || 'https://api.cloudbeds.com/api/v1.3',
    },
  ].filter(p => p.apiKey || p.propertyID || p.bookingBase);
}

/* --- helpers (same as before) --- */
function orderProviders(arr, desiredPropertyID, preferredSlot) {
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
function ok(res, urlStr){ return res.status(200).json({ success:true, url:String(urlStr||'') }); }
function toStr(v){ return (v==null ? '' : String(v).trim()) || ''; }
function toBool(v, d=false){ if(v==null) return d; const s=String(v).toLowerCase(); return ['1','true','yes','y','on'].includes(s); }
function normDate(v){ if(!v) return ''; if(typeof v==='string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0,10); const d=new Date(v); return Number.isNaN(+d)?'':d.toISOString().slice(0,10); }
function normCurrency(v){ if(!v) return ''; const s=String(v).trim().toLowerCase(); return /^[a-z]{3}$/.test(s)?s:''; }
function toInt(v,d=0){ const n=parseInt(v,10); return Number.isFinite(n)?n:d; }
function toNum(v,d=0){ if(v==null) return d; const n=Number(String(v).replace(',','.')); return Number.isFinite(n)?n:d; }
function diffDays(a,b){ if(!a||!b) return 0; return Math.ceil((new Date(b+'T00:00:00Z') - new Date(a+'T00:00:00Z'))/86400000); }
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
