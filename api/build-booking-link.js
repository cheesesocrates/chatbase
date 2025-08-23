// api/build-booking-link.js
// One-step endpoint: validates the stay with Cloudbeds and only returns a link if valid.
// Response shape (always HTTP 200):
//   - if invalid: { success:true, valid:false, reason:"..." }
//   - if valid:   { success:true, valid:true, reason:"OK", url:"https://hotels.cloudbeds.com/..."} 
//
// ENV (Vercel):
//   CLOUDBEDS_API_KEY     = cbat_...               (required)
//   CLOUDBEDS_BOOKING_ID  = your booking engine id (e.g., "svLoIs")  (required)
//   CLOUDBEDS_LOCALE      = "es" | "en" | ...      (optional, default "es")

export default async function handler(req, res) {
  try {
    const API_KEY   = process.env.CLOUDBEDS_API_KEY;
    const BOOK_ID   = process.env.CLOUDBEDS_BOOKING_ID;
    const LOCALE    = process.env.CLOUDBEDS_LOCALE || 'es';

    // accept GET or POST
    const src = req.method === 'POST' ? (req.body || {}) : (req.query || {});
    const propertyID = String(src.propertyID || '198424');
    const checkin    = normDate(src.startDate || src.checkin);
    const checkout   = normDate(src.endDate   || src.checkout);
    const adults     = toInt(src.adults, 2);
    const children   = toInt(src.children, 0);
    const currency   = normCurrency(src.currency); // optional, 3-letter lower

    // quick local checks
    const nights = diffDays(checkin, checkout);
    if (!checkin || !checkout) return ok({ valid:false, reason:'Fechas inválidas: faltan check-in o check-out (YYYY-MM-DD).' });
    if (nights <= 0)          return ok({ valid:false, reason:'Fechas inválidas: el check-out debe ser posterior al check-in.' });
    if (!API_KEY)             return ok({ valid:false, reason:'Configuración del servidor faltante (API key).' });
    if (!BOOK_ID)             return ok({ valid:false, reason:'Falta configurar el ID del motor de reservas.' });

    // call Cloudbeds getRatePlans (with details)
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
      return ok({ valid:false, reason:'No hay planes/tarifas disponibles para ese rango.' });
    }

    // Use the first plan's details for rule checks
    const details = Array.isArray(plans[0]?.roomRateDetailed) ? plans[0].roomRateDetailed : [];
    if (!details.length) return ok({ valid:false, reason:'No hay datos de tarifa para el rango solicitado.' });

    // minLos: prefer arrival-day value; else max across details; default 1
    let minLos = 1;
    const arrival = details.find(d => d?.date === checkin);
    if (toInt(arrival?.minLos, 0) > 0) {
      minLos = toInt(arrival.minLos, 1);
    } else {
      const mins = details.map(d => toInt(d?.minLos, 0)).filter(n => n > 0);
      if (mins.length) minLos = Math.max(...mins);
    }

    const lastNight = addDays(checkout, -1);
    const windowDays = details.filter(d => d?.date >= checkin && d?.date <= lastNight);

    if (windowDays.length < nights) {
      return ok({ valid:false, reason:'No hay datos de tarifa para todas las noches solicitadas.' });
    }

    // Rules: min stay → closed arrival/departure → availability → nightly rate
    if (nights < minLos) {
      return ok({ valid:false, reason:`La estadía mínima es de ${minLos} noches.` });
    }
    if (arrival?.closedToArrival) {
      return ok({ valid:false, reason:'No se permite llegada en la fecha seleccionada.' });
    }
    const depClosed =
      details.find(d => d?.date === checkout)?.closedToDeparture ||
      details.find(d => d?.date === lastNight)?.closedToDeparture || false;
    if (depClosed) {
      return ok({ valid:false, reason:'No se permite salida en la fecha seleccionada.' });
    }
    if (windowDays.some(d => toInt(d?.roomsAvailable, 0) === 0)) {
      return ok({ valid:false, reason:'No hay disponibilidad en una o más noches.' });
    }
    if (windowDays.some(d => toNum(d?.rate, 0) <= 0)) {
      return ok({ valid:false, reason:'No hay tarifa publicada para una o más noches.' });
    }

    // All good → build URL
    const urlParams = new URLSearchParams({
      checkin, checkout,
      adults: String(adults),
      children: String(children)
    });
    if (currency) urlParams.set('currency', currency);

    const bookingUrl = `https://hotels.cloudbeds.com/${LOCALE}/reservation/${BOOK_ID}/?${urlParams.toString()}`;

    return ok({ success:true, valid:true, reason:'OK', url: bookingUrl });

  } catch {
    return ok({ valid:false, reason:'Error al procesar la solicitud.' });
  }

  function ok(body) { return res.status(200).json(body); }
}

// --- helpers ---
function normDate(v) {
  if (!v) return '';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0,10);
  const d = new Date(v);
  return Number.isNaN(+d) ? '' : d.toISOString().slice(0,10);
}
function normCurrency(v) {
  if (!v) return '';
  const s = String(v).trim().toLowerCase();
  return /^[a-z]{3}$/.test(s) ? s : '';
}
function toInt(v, d=0) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }
function toNum(v, d=0) { if (v==null) return d; const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : d; }
function diffDays(a,b){ if(!a||!b) return 0; return Math.ceil((new Date(b+'T00:00:00Z') - new Date(a+'T00:00:00Z'))/86400000); }
function addDays(isoYmd, days){ const d=new Date(isoYmd+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()+days); return d.toISOString().slice(0,10); }
