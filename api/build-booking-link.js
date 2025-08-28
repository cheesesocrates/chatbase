// api/build-booking-link.js
// Always 200 with: { success: true, url: "<message or links>" }

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

    // Selection inputs
    const desiredPropertyID = toStr(src.propertyID);   // REQUIRED from Chatbase (no default)
    const preferredSlot     = toStr(src.provider);     // optional override if no propertyID
    const fallback          = toBool(src.fallback, true);

    // Basic sanity
    if (!checkin || !checkout)
      return ok(res, `ERROR: Missing check-in or check-out (YYYY-MM-DD).`);
    const nights = diffDays(checkin, checkout);
    if (nights <= 0)
      return ok(res, `ERROR: checkout must be after checkin`);
    if (!desiredPropertyID && !preferredSlot)
      return ok(res, `ERROR: propertyID is required (or provider=1|2|3 override).`);

    // Provider registry (three properties; booking links fixed per your mapping)
    const allProviders = loadProvidersFromEnv();
    if (!allProviders.length)
      return ok(res, `ERROR: No providers configured (missing API keys).`);

    // Order so desired property is first; if not given, use provider slot; else natural order
    const ordered = orderProviders(allProviders, desiredPropertyID, preferredSlot);
    const desired = ordered[0];
    const others  = ordered.slice(1);

    // 1) Try desired ONLY
    const desiredResult = await tryProvider({
      provider: desired,
      propertyID: desiredPropertyID || desired.propertyID, // prefer request value when present
      checkin, checkout, adults, children, currency, roomTypeId, ratePlanId, promoCode
    });

    if (desiredResult.ok) {
      // success → return single labeled link for desired property only
      return ok(res, `[${desired.name}] ${desiredResult.link}`);
    }

    // 2) Desired unavailable → include reason, then try the other two (if fallback)
    const reason = desiredResult.reason || 'Unavailable';
    const altLinks = [];

    if (fallback && others.length) {
      for (const p of others) {
        const r = await tryProvider({
          provider: p,
          propertyID: p.propertyID, // their own property ID from env
          checkin, checkout, adults, children, currency, roomTypeId, ratePlanId, promoCode
        });
        if (r.ok) altLinks.push(`[${p.name}] ${r.link}`);
      }
    }

    if (altLinks.length) {
      return ok(res, `Desired property unavailable: ${reason} || Alternatives: ${altLinks.join(' || ')}`);
    }

    // 3) Nothing available anywhere
    return ok(res, `ERROR: No availability found for the desired property (${desired.name}) — ${reason}. No alternatives available for your dates.`);

  } catch (e) {
    console.error('build-booking-link error:', e);
    return ok(res, `ERROR: Unexpected server error.`);
  }
}

/* ---------- provider attempt ---------- */
async function tryProvider({ provider: p, propertyID, checkin, checkout, adults, children, currency, roomTypeId, ratePlanId, promoCode }) {
  // Config checks
  if (!p?.apiKey)      return { ok:false, reason:'Missing API key' };
  if (!propertyID)     return { ok:false, reason:'Missing property ID' };
  if (!p?.bookingBase) return { ok:false, reason:'Missing booking link' };

  // Cloudbeds getRatePlans v1.3
  const url = new URL(`${p.apiBase}/getRatePlans`);
  url.searchParams.set('propertyID', propertyID);
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
      return { ok:false, reason: json?.message || `Cloudbeds HTTP ${resp.status}` };
    }
  } catch {
    return { ok:false, reason:'Network error contacting provider' };
  }

  const plans = Array.isArray(json?.data) ? json.data : [];
  if (!plans.length) return { ok:false, reason:'No plans found' };

  // Optional filters
  const filtered = plans
    .filter(pl => (!ratePlanId || String(pl?.ratePlanId) === ratePlanId))
    .map(pl => ({ ...pl, details: Array.isArray(pl?.roomRateDetailed) ? pl.roomRateDetailed : [] }))
    .filter(pl => !roomTypeId || hasRoomType(pl, roomTypeId));

  if (!filtered.length) return { ok:false, reason:'No matching room/rate plan' };

  // Validate window
  const nights = diffDays(checkin, checkout);
  const candidate = filtered[0];
  const details   = candidate.details;
  const lastNight = addDays(checkin, nights - 1);
  const window    = details.filter(d => d?.date >= checkin && d?.date <= lastNight);

  if (window.length < nights) return { ok:false, reason:'Missing nightly rates across window' };
  const arrival = details.find(d => d?.date === checkin);
  const minLos  = inferMinLos(details, arrival);
  if (nights < minLos) return { ok:false, reason:`Minimum stay is ${minLos} nights` };
  if (arrival?.closedToArrival) return { ok:false, reason:'Closed to arrival' };
  const depClosed =
    details.find(d => d?.date === checkout)?.closedToDeparture ||
    details.find(d => d?.date === lastNight)?.closedToDeparture || false;
  if (depClosed) return { ok:false, reason:'Closed to departure' };
  if (window.some(d => toInt(d?.roomsAvailable, 0) === 0)) return { ok:false, reason:'No availability on one or more nights' };
  if (window.some(d => toNum(d?.rate, 0) <= 0))            return { ok:false, reason:'No published rate on one or more nights' };

  // Success → produce link
  const qs = new URLSearchParams({
    checkin, checkout,
    adults: String(adults),
    children: String(children),
  });
  if (currency)   qs.set('currency',  currency);
  if (roomTypeId) qs.set('roomTypeId', roomTypeId);
  if (ratePlanId) qs.set('ratePlanId', ratePlanId);
  if (promoCode)  qs.set('promoCode',  promoCode);

  return { ok:true, link: `${p.bookingBase}?${qs.toString()}` };
}

/* ---------- providers: STYLE (1), COLONIAL (2), ALTOS (3) ---------- */
function loadProvidersFromEnv() {
  return [
    {
      slot: '1',
      name: 'STYLE',
      apiKey:   process.env.CLOUDBEDS_API_KEY      || '',
      apiBase:  process.env.CLOUDBEDS_API_BASE     || 'https://api.cloudbeds.com/api/v1.3',
      bookingBase: 'https://hotels.cloudbeds.com/es/reservation/svLoIs',
      // propertyID comes from request when STYLE is the desired property
      // (alternates use their own env property IDs below)
      propertyID: process.env.CLOUDBEDS_PROPERTY_ID || '', // optional; used when STYLE is tried as alternate
    },
    {
      slot: '2',
      name: 'COLONIAL',
      apiKey:   process.env.CLOUDBEDS_API_KEY_2     || '',
      apiBase:  process.env.CLOUDBEDS_API_BASE_2    || process.env.CLOUDBEDS_API_BASE || 'https://api.cloudbeds.com/api/v1.3',
      bookingBase: 'https://hotels.cloudbeds.com/es/reservation/3atiWS',
      propertyID: process.env.CLOUDBEDS_PROPERTY_ID_2 || '',
    },
    {
      slot: '3',
      name: 'ALTOS DE LA VIUDA',
      apiKey:   process.env.CLOUDBEDS_API_KEY_3     || '',
      apiBase:  process.env.CLOUDBEDS_API_BASE_3    || process.env.CLOUDBEDS_API_BASE || 'https://api.cloudbeds.com/api/v1.3',
      bookingBase: 'https://hotels.cloudbeds.com/reservation/AwNrlI',
      propertyID: process.env.CLOUDBEDS_PROPERTY_ID_3 || '',
    },
  ].filter(p => p.apiKey); // require at least API key configured
}

/* ---------- ordering helpers ---------- */
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

/* ---------- shared utils ---------- */
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
