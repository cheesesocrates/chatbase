export default async function handler(req, res) {
  try {
    res.setHeader('Cache-Control', 'no-store');

    const src = req.method === 'POST' ? (req.body || {}) : (req.query || {});
    const checkin   = normDate(src.startDate || src.checkin);
    const checkout  = normDate(src.endDate   || src.checkout);
    const adults    = toInt(src.adults, 2);
    const children  = toInt(src.children, 0);
    const currency  = normCurrency(src.currency);
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
      const attempt = { slot: p.slot, reason: '' };
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

      foundLinks.push(`https://hotels.cloudbeds.com/${p.locale}/reservation/${p.bookingId}/?${qs}`);
    }

    if (foundLinks.length) return ok(res, foundLinks.join(' || '));

    const reason = attempts.map(a => `slot${a.slot}: ${a.reason||'failed'}`).join(' | ');
    return ok(res, `ERROR: ${reason}`);

  } catch { return ok(res, `ERROR: Unexpected server error.`); }
}

/* --- helpers --- */
function loadProvidersFromEnv(){
  return [
    { slot:'1', apiKey:process.env.CLOUDBEDS_API_KEY||'', propertyID:process.env.CLOUDBEDS_PROPERTY_ID||'', bookingId:process.env.CLOUDBEDS_BOOKING_ID||'', locale:process.env.CLOUDBEDS_LOCALE||'es', apiBase:process.env.CLOUDBEDS_API_BASE||'https://api.cloudbeds.com/api/v1.3'},
    { slot:'2', apiKey:process.env.CLOUDBEDS_API_KEY_2||'', propertyID:process.env.CLOUDBEDS_PROPERTY_ID_2||'', bookingId:process.env.CLOUDBEDS_BOOKING_ID_2||process.env.CLOUDBEDS_BOOKING_ID||'', locale:process.env.CLOUDBEDS_LOCALE_2||process.env.CLOUDBEDS_LOCALE||'es', apiBase:process.env.CLOUDBEDS_API_BASE_2||process.env.CLOUDBEDS_API_BASE||'https://api.cloudbeds.com/api/v1.3'},
    { slot:'3', apiKey:process.env.CLOUDBEDS_API_KEY_3||'', propertyID:process.env.CLOUDBEDS_PROPERTY_ID_3||'', bookingId:process.env.CLOUDBEDS_BOOKING_ID_3||process.env.CLOUDBEDS_BOOKING_ID||'', locale:process.env.CLOUDBEDS_LOCALE_3||process.env.CLOUDBEDS_LOCALE||'es', apiBase:process.env.CLOUDBEDS_API_BASE_3||process.env.CLOUDBEDS_API_BASE||'https://api.cloudbeds.com/api/v1.3'},
  ].filter(p=>p.apiKey||p.propertyID||p.bookingId);
}
function orderProviders(arr, propertyID, slot){ let out=[...arr]; if(propertyID){const h=out.find(p=>p.propertyID===propertyID); if(h) out=[h,...out.filter(p=>p!==h)];} else if(slot){const h=out.find(p=>p.slot===slot); if(h) out=[h,...out.filter(p=>p!==h)];} return out;}
function ok(res,str){return res.status(200).json({success:true,url:String(str)});}
function toStr(v){return(v==null?'':String(v).trim())||'';}
function toBool(v,d=false){if(v==null)return d;const s=String(v).toLowerCase();return['1','true','yes','y','on'].includes(s);}
function normDate(v){if(!v)return'';if(/^\\d{4}-\\d{2}-\\d{2}/.test(v))return v.slice(0,10);const d=new Date(v);return Number.isNaN(+d)?'':d.toISOString().slice(0,10);}
function normCurrency(v){if(!v)return'';const s=String(v).trim().toLowerCase();return/^[a-z]{3}$/.test(s)?s:'';}
function toInt(v,d=0){const n=parseInt(v,10);return Number.isFinite(n)?n:d;}
function toNum(v,d=0){if(v==null)return d;const n=Number(String(v).replace(',','.'));return Number.isFinite(n)?n:d;}
function diffDays(a,b){return Math.ceil((new Date(b+'T00:00:00Z')-new Date(a+'T00:00:00Z'))/86400000);}
function addDays(dy,ds){const d=new Date(dy+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+ds);return d.toISOString().slice(0,10);}
function hasRoomType(pl,id){if(String(pl?.roomTypeId||'')===String(id))return true;return (pl.roomRateDetailed||[]).some(d=>String(d?.roomTypeId||'')===String(id));}
function inferMinLos(det,arr){if(toInt(arr?.minLos,0)>0)return toInt(arr.minLos,1);const mins=det.map(d=>toInt(d?.minLos,0)).filter(n=>n>0);return mins.length?Math.max(...mins):1;}
