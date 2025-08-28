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

    const desiredPropertyID = toStr(src.propertyID);
    const preferredSlot     = toStr(src.provider);
    const fallback          = toBool(src.fallback, true);

    if (!checkin || !checkout) return ok(res, `ERROR: Missing check-in or check-out`);
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
      if (!p.bookingId)  { attempt.reason = 'Missing booking ID';   if (!fallback) break; else continue; }

      const url = new URL(`${p.apiBase}/getRatePlans`);
      url.searchParams.set('propertyID', p.propertyID);
      url.searchParams.set('startDate',  checkin);
      url.searchParams.set('endDate',    checkout);
      url.searchParams.set('adults',     String(adults));
      url.searchParams.set('children',   String(children));
      url.searchParams.set('detailedRates', 'true');
      if (promoCode) url.searchParams.set('promoCode', promoCode);

      const resp = await fetch(url.toString(), { headers: { 'x-api-key': p.apiKey } });
      const json = await resp.json().catch(() => ({}));
      const plans = Array.isArray(json?.data) ? json.data : [];
      if (!resp.ok || json?.success === false || plans.length === 0) {
        attempt.reason = json?.message || 'No plans found';
        if (!fallback) break; else continue;
      }

      const filtered = plans
        .filter(pl => (!ratePlanId || String(pl?.ratePlanId) === ratePlanId))
        .map(pl => ({ ...pl, details: Array.isArray(pl?.roomRateDetailed) ? pl.roomRateDetailed : [] }))
        .filter(pl => !roomTypeId || hasRoomType(pl, roomTypeId));

      if (!filtered.length) { attempt.reason = 'No matching room/rate plan'; if (!fallback) break; else continue; }

      const candidate = filtered[0];
      const details   = candidate.details;
      const lastNight = addDays(checkin, nights - 1);
      const window    = details.filter(d => d?.date >= checkin && d?.date <= lastNight);

      if (window.length < nights) { attempt.reason = 'Missing nightly rates'; if (!fallback) break; else continue; }
      const arrival = details.find(d => d?.date === checkin);
      const minLos  = inferMinLos(details, arrival);
      if (nights < minLos) { attempt.reason = `Minimum stay ${minLos}`; if (!fallback) break; else continue; }
      if (arrival?.closedToArrival) { attempt.reason = 'Closed to arrival'; if (!fallback) break; else continue; }
      const depClosed = details.find(d => d?.date === checkout)?.closedToDeparture || details.find(d => d?.date === lastNight)?.closedToDeparture;
      if (depClosed) { attempt.reason = 'Closed to departure'; if (!fallback) break; else continue; }
      if (window.some(d => toInt(d?.roomsAvailable,0) === 0)) { attempt.reason = 'No availability'; if (!fallback) break; else continue; }
      if (window.some(d => toNum(d?.rate,0) <= 0)) { attempt.reason = 'No rate'; if (!fallback) break; else continue; }

      // SUCCESS → booking link
      const qs = new URLSearchParams({ checkin, checkout, adults: String(adults), children: String(children) });
      if (currency)  qs.set('currency', currency);
      if (roomTypeId) qs.set('roomTypeId', roomTypeId);
      if (ratePlanId) qs.set('ratePlanId', ratePlanId);
      if (promoCode)  qs.set('promoCode', promoCode);

      foundLinks.push(`${p.bookingBase}?${qs.toString()}`);
    }

    if (foundLinks.length) return ok(res, foundLinks.join(' || '));

    const reason = attempts.map(a => `${a.name}: ${a.reason||'failed'}`).join(' | ');
    return ok(res, `ERROR: ${reason}`);

  } catch { return ok(res, `ERROR: Unexpected server error.`); }
}

/* --- Provider config --- */
function loadProvidersFromEnv(){
  return [
    {
      slot:'1',
      name:'COLONIAL',
      apiKey:process.env.CLOUDBEDS_API_KEY||'',
      propertyID:process.env.CLOUDBEDS_PROPERTY_ID||'',
      bookingId:process.env.CLOUDBEDS_BOOKING_ID||'',
      apiBase:process.env.CLOUDBEDS_API_BASE||'https://api.cloudbeds.com/api/v1.3',
      bookingBase:'https://hotels.cloudbeds.com/es/reservation/3atiWS'
    },
    {
      slot:'2',
      name:'ALTOS DE LA VIUDA',
      apiKey:process.env.CLOUDBEDS_API_KEY_2||'',
      propertyID:process.env.CLOUDBEDS_PROPERTY_ID_2||'',
      bookingId:process.env.CLOUDBEDS_BOOKING_ID_2||'',
      apiBase:process.env.CLOUDBEDS_API_BASE_2||process.env.CLOUDBEDS_API_BASE||'https://api.cloudbeds.com/api/v1.3',
      bookingBase:'https://hotels.cloudbeds.com/reservation/AwNrlI'
    },
    {
      slot:'3',
      name:'THIRD',
      apiKey:process.env.CLOUDBEDS_API_KEY_3||'',
      propertyID:process.env.CLOUDBEDS_PROPERTY_ID_3||'',
      bookingId:process.env.CLOUDBEDS_BOOKING_ID_3||'',
      apiBase:process.env.CLOUDBEDS_API_BASE_3||process.env.CLOUDBEDS_API_BASE||'https://api.cloudbeds.com/api/v1.3',
      bookingBase:'https://hotels.cloudbeds.com/es/reservation/svLoIs' // replace with actual third link
    }
  ].filter(p=>p.apiKey||p.propertyID);
}
