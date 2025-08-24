// api/build-booking-link.js
// Chatbase-friendly: no booleans for validity, no nulls.
// Always HTTP 200 with top-level strings: reason/message/... and url ("" if none).

export default async function handler(req, res) {
  try {
    const API_KEY = process.env.CLOUDBEDS_API_KEY;

    const src = req.method === 'POST' ? (req.body || {}) : (req.query || {});
    const BOOK_ID = (src.bookingId && String(src.bookingId)) || process.env.CLOUDBEDS_BOOKING_ID;
    const LOCALE  = (src.locale && String(src.locale)) || process.env.CLOUDBEDS_LOCALE || 'es';

    const propertyID = String(src.propertyID || '198424');
    const checkin    = normDate(src.startDate || src.checkin);
    const checkout   = normDate(src.endDate   || src.checkout);
    const adults     = toInt(src.adults, 2);
    const children   = toInt(src.children, 0);
    const currency   = normCurrency(src.currency); // optional

    // Local checks
    const nights = diffDays(checkin, checkout);
    if (!checkin || !checkout) return reply(res, 'invalid', 'Fechas inválidas: faltan check-in o check-out (YYYY-MM-DD).', '');
    if (nights <= 0)          return reply(res, 'invalid', 'Fechas inválidas: el check-out debe ser posterior al check-in.', '');
    if (!API_KEY)             return reply(res, 'invalid', 'Configuración del servidor faltante (API key).', '');
    if (!BOOK_ID)             return reply(res, 'invalid', 'Falta configurar el ID del motor de reservas (bookingId).', '');

    // Cloudbeds: getRatePlans (detailed)
    const url = new URL('https://api.cloudbeds.com/api/v1.3/getRatePlans');
    url.searchParams.set('propertyID', propertyID);
    url.searchParams.set('startDate',  checkin);
    url.searchParams.set('endDate',    checkout);
    url.searchParams.set('adults',     String(adults));
    url.searchParams.set('children',   String(children));
    url.searchParams.set('detailedRates', 'true');

    const resp = await fetch(url.toString(), { headers: { 'x-api-key': API_KEY } });
    const json = await resp.json().catch(() => ({}));

    const plans = Array.isArray(json?.data) ? json.data : [];
    if (!resp.ok || json?.success === false || plans.length === 0) {
      return reply(res, 'invalid', 'No hay planes/tarifas disponibles para ese rango.', '');
    }

    const details = Array.isArray(plans[0]?.roomRateDetailed) ? plans[0].roomRateDetailed : [];
    if (!details.length) return reply(res, 'invalid', 'No hay datos de tarifa para el rango solicitado.', '');

    // min stay (minLos)
    let minLos = 1;
    const arrival = details.find(d => d?.date === checkin);
    if (toInt(arrival?.minLos, 0) > 0) {
      minLos = toInt(arrival.minLos, 1);
    } else {
      const mins = details.map(d => toInt(d?.minLos, 0)).filter(n => n > 0);
      if (mins.length) minLos = Math.max(...mins);
    }

    const lastNight  = addDays(checkout, -1);
    const windowDays = details.filter(d => d?.date >= checkin && d?.date <= lastNight);

    if (windowDays.length < nights) return reply(res, 'invalid', 'No hay datos de tarifa para todas las noches solicitadas.', '');
    if (nights < minLos)           return reply(res, 'invalid', `La estadía mínima es de ${minLos} noches.`, '');
    if (arrival?.closedToArrival)  return reply(res, 'invalid', 'No se permite llegada en la fecha seleccionada.', '');

    const depClosed =
      details.find(d => d?.date === checkout)?.closedToDeparture ||
      details.find(d => d?.date === lastNight)?.closedToDeparture || false;
    if (depClosed)                  return reply(res, 'invalid', 'No se permite salida en la fecha seleccionada.', '');
    if (windowDays.some(d => toInt(d?.roomsAvailable, 0) === 0))
      return reply(res, 'invalid', 'No hay disponibilidad en una o más noches.', '');
    if (windowDays.some(d => toNum(d?.rate, 0) <= 0))
      return reply(res, 'invalid', 'No hay tarifa publicada para una o más noches.', '');

    // Build URL (valid path)
    const qs = new URLSearchParams({
      checkin, checkout,
      adults: String(adults),
      children: String(children)
    });
    if (currency) qs.set('currency', currency);

    const outUrl = `https://hotels.cloudbeds.com/${LOCALE}/reservation/${BOOK_ID}/?${qs.toString()}`;
    return reply(res, 'valid', 'OK', outUrl);

  } catch {
    return reply(res, 'invalid', 'Error al procesar la solicitud.', '');
  }
}

// ——— reply helper (no booleans, no nulls; reason first; duplicate keys) ———
function reply(res, state, reason, urlStr) {
  const payload = {
    // put the explanation first; Chatbase often surfaces early keys
    reason,                         // main explanation
    message: reason,                // common alias many UIs display
    description: reason,            // another alias
    error: state === 'invalid' ? reason : '',

    // state & url as strings (no null/boolean)
    state,                          // "valid" | "invalid"
    url: String(urlStr || ''),

    // keep success last; always true to avoid being dropped
    success: true
  };
  return res
    .status(200)
    .setHeader('Content-Type', 'application/json; charset=utf-8')
    .json(payload);
}

// ——— helpers ———
function normDate(v){ if(!v) return ''; if(typeof v==='string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0,10); const d=new Date(v); return Number.isNaN(+d)?'':d.toISOString().slice(0,10); }
function normCurrency(v){ if(!v) return ''; const s=String(v).trim().toLowerCase(); return /^[a-z]{3}$/.test(s)?s:''; }
function toInt(v,d=0){ const n=parseInt(v,10); return Number.isFinite(n)?n:d; }
function toNum(v,d=0){ if(v==null) return d; const n=Number(String(v).replace(',','.')); return Number.isFinite(n)?n:d; }
function diffDays(a,b){ if(!a||!b) return 0; return Math.ceil((new Date(b+'T00:00:00Z')-new Date(a+'T00:00:00Z'))/86400000); }
function addDays(isoYmd,days){ const d=new Date(isoYmd+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()+days); return d.toISOString().slice(0,10); }
