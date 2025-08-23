// api/get-reservation.js
// Returns ONLY { valid, reason }
// - valid=false if min stay not met, no rooms, rate=0, closed arrival/departure, bad dates, etc.
// - reason is a short human string (always present). When valid=true => "OK"
// ENV: CLOUDBEDS_API_KEY = cbat_...

export default async function handler(req, res) {
  try {
    const API_KEY = process.env.CLOUDBEDS_API_KEY;

    // Accept GET query or POST body
    const src = req.method === 'POST' ? (req.body || {}) : (req.query || {});
    const propertyID = String(src.propertyID || '198424');
    const startDate  = normDate(src.startDate || src.checkin);
    const endDate    = normDate(src.endDate   || src.checkout);
    const adults     = toInt(src.adults, 2);
    const children   = toInt(src.children, 0);

    // Quick input checks
    const nights = diffDays(startDate, endDate);
    if (!startDate || !endDate) {
      return ok({ valid: false, reason: 'Fechas inválidas: faltan check-in o check-out (YYYY-MM-DD).' });
    }
    if (nights <= 0) {
      return ok({ valid: false, reason: 'Fechas inválidas: el check-out debe ser posterior al check-in.' });
    }
    if (!API_KEY) {
      return ok({ valid: false, reason: 'Configuración del servidor faltante.' });
    }

    // Build Cloudbeds getRatePlans
    const url = new URL('https://api.cloudbeds.com/api/v1.3/getRatePlans');
    url.searchParams.set('propertyID', propertyID);
    url.searchParams.set('startDate', startDate);
    url.searchParams.set('endDate', endDate);
    url.searchParams.set('adults', String(adults));
    url.searchParams.set('children', String(children));
    url.searchParams.set('detailedRates', 'true');

    // Call Cloudbeds
    const r = await fetch(url.toString(), { headers: { 'x-api-key': API_KEY } });
    const j = await r.json().catch(() => ({}));

    // Basic API sanity
    const plans = Array.isArray(j?.data) ? j.data : [];
    if (!r.ok || j?.success === false || plans.length === 0) {
      return ok({ valid: false, reason: 'No hay planes/tarifas disponibles para ese rango.' });
    }

    // Use first plan’s details (sufficient for validity checks)
    const details = Array.isArray(plans[0]?.roomRateDetailed) ? plans[0].roomRateDetailed : [];
    if (details.length === 0) {
      return ok({ valid: false, reason: 'No hay datos de tarifa para el rango solicitado.' });
    }

    // Compute minLos: prefer arrival-day; else max across details; default 1
    let minLos = 1;
    const arrival = details.find(d => d?.date === startDate);
    if (toInt(arrival?.minLos, 0) > 0) {
      minLos = toInt(arrival.minLos, 1);
    } else {
      const mins = details.map(d => toInt(d?.minLos, 0)).filter(n => n > 0);
      if (mins.length) minLos = Math.max(...mins);
    }

    // Build the window [startDate, endDate)
    const lastNight = addDays(endDate, -1);
    const windowDays = details.filter(d => d?.date >= startDate && d?.date <= lastNight);
    if (windowDays.length < nights) {
      return ok({ valid: false, reason: 'No hay datos de tarifa para todas las noches solicitadas.' });
    }

    // Rule 1: minimum stay
    if (nights < minLos) {
      return ok({ valid: false, reason: `La estadía mínima es de ${minLos} noches.` });
    }

    // Rule 2: closed to arrival / departure
    if (arrival?.closedToArrival) {
      return ok({ valid: false, reason: 'No se permite llegada en la fecha seleccionada.' });
    }
    const depClosed =
      details.find(d => d?.date === endDate)?.closedToDeparture ||
      details.find(d => d?.date === lastNight)?.closedToDeparture || false;
    if (depClosed) {
      return ok({ valid: false, reason: 'No se permite salida en la fecha seleccionada.' });
    }

    // Rule 3: availability & nightly rates across the whole window
    if (windowDays.some(d => toInt(d?.roomsAvailable, 0) === 0)) {
      return ok({ valid: false, reason: 'No hay disponibilidad en una o más noches.' });
    }
    if (windowDays.some(d => toNum(d?.rate, 0) <= 0)) {
      return ok({ valid: false, reason: 'No hay tarifa publicada para una o más noches.' });
    }

    // All good
    return ok({ valid: true, reason: 'OK' });

  } catch {
    // Always return the same shape
    return ok({ valid: false, reason: 'Error al procesar la solicitud.' });
  }

  // helpers scoped to handler
  function ok(obj) { return res.status(200).json(obj); }
}

// --- helpers ---
function normDate(v) {
  if (!v) return '';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  const d = new Date(v);
  return Number.isNaN(+d) ? '' : d.toISOString().slice(0, 10);
}
function toInt(v, d = 0) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
}
function toNum(v, d = 0) {
  if (v == null) return d;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : d;
}
function diffDays(a, b) {
  if (!a || !b) return 0;
  return Math.ceil((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}
function addDays(isoYmd, days) {
  const d = new Date(isoYmd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
