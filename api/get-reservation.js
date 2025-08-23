// api/get-reservation.js
// Returns ONLY { valid, minimumNightsRequiredToStay, reason? } for Chatbase.
// - valid=false when nights < minLos, no availability, rate=0, closed arrival/departure, etc.
// - reason is a short human string describing why it's invalid.
//
// ENV: CLOUDBEDS_API_KEY = cbat_...

export default async function handler(req, res) {
  try {
    const API_KEY = process.env.CLOUDBEDS_API_KEY;

    // accept GET query or POST body
    const src = req.method === 'POST' ? (req.body || {}) : (req.query || {});
    const propertyID = String(src.propertyID || '198424');
    const startDate  = normDate(src.startDate || src.checkin);
    const endDate    = normDate(src.endDate   || src.checkout);
    const adults     = toInt(src.adults, 2);
    const children   = toInt(src.children, 0);

    // Basic validation: if missing dates or order wrong, mark invalid with reason
    const nights = diffDays(startDate, endDate);
    if (!startDate || !endDate) {
      return res.status(200).json({
        valid: false,
        minimumNightsRequiredToStay: 1,
        reason: 'Fechas inválidas: faltan check-in o check-out (usar YYYY-MM-DD).'
      });
    }
    if (nights <= 0) {
      return res.status(200).json({
        valid: false,
        minimumNightsRequiredToStay: 1,
        reason: 'Fechas inválidas: el check-out debe ser posterior al check-in.'
      });
    }
    if (!API_KEY) {
      return res.status(200).json({
        valid: false,
        minimumNightsRequiredToStay: 1,
        reason: 'Configuración del servidor faltante.'
      });
    }

    // Call Cloudbeds getRatePlans
    const url = new URL('https://api.cloudbeds.com/api/v1.3/getRatePlans');
    url.searchParams.set('propertyID', propertyID);
    url.searchParams.set('startDate', startDate);
    url.searchParams.set('endDate', endDate);
    url.searchParams.set('adults', String(adults));
    url.searchParams.set('children', String(children));
    url.searchParams.set('detailedRates', 'true');

    const r = await fetch(url.toString(), { headers: { 'x-api-key': API_KEY } });
    const j = await r.json().catch(() => ({}));

    const plans = Array.isArray(j?.data) ? j.data : [];
    if (!r.ok || j?.success === false || plans.length === 0) {
      return res.status(200).json({
        valid: false,
        minimumNightsRequiredToStay: 1,
        reason: 'No hay planes/tarifas disponibles para ese rango.'
      });
    }

    // Use first plan for rule checks (minLos + daily availability flags)
    const plan = plans[0];
    const details = Array.isArray(plan?.roomRateDetailed) ? plan.roomRateDetailed : [];

    // Compute minLos: prefer arrival-day, else max across details, default 1
    let minLos = 1;
    const lastNight = addDays(endDate, -1);

    const arrival = details.find(d => d?.date === startDate);
    if (arrival?.minLos > 0) {
      minLos = toInt(arrival.minLos, 1);
    } else {
      const mins = details.map(d => toInt(d?.minLos, 0)).filter(n => n > 0);
      if (mins.length) minLos = Math.max(...mins);
    }

    // Build day range for the stay [startDate, endDate)
    const windowDays = details.filter(d => d?.date >= startDate && d?.date <= lastNight);

    // If daily data missing for the whole window
    if (windowDays.length < nights) {
      return res.status(200).json({
        valid: false,
        minimumNightsRequiredToStay: minLos || 1,
        reason: 'No hay datos de tarifa para todas las noches solicitadas.'
      });
    }

    // Check rules in order: min stay → closed arrival/departure → no availability → no rate
    if (nights < minLos) {
      return res.status(200).json({
        valid: false,
        minimumNightsRequiredToStay: minLos,
        reason: `La estadía mínima es de ${minLos} noches.`
      });
    }

    // Closed to arrival on check-in date?
    if (arrival?.closedToArrival) {
      return res.status(200).json({
        valid: false,
        minimumNightsRequiredToStay: minLos,
        reason: `No se permite llegada en la fecha seleccionada.`
      });
    }

    // Closed to departure on check-out date (some APIs mark it on endDate or last night)
    const departureFlag =
      details.find(d => d?.date === endDate)?.closedToDeparture ||
      details.find(d => d?.date === lastNight)?.closedToDeparture ||
      false;

    if (departureFlag) {
      return res.status(200).json({
        valid: false,
        minimumNightsRequiredToStay: minLos,
        reason: `No se permite salida en la fecha seleccionada.`
      });
    }

    // Per-night availability & rate checks
    const noRoomsDay = windowDays.find(d => toInt(d?.roomsAvailable, 0) === 0);
    if (noRoomsDay) {
      return res.status(200).json({
        valid: false,
        minimumNightsRequiredToStay: minLos,
        reason: `No hay disponibilidad en una o más noches.`
      });
    }

    const zeroRateDay = windowDays.find(d => toNum(d?.rate, 0) <= 0);
    if (zeroRateDay) {
      return res.status(200).json({
        valid: false,
        minimumNightsRequiredToStay: minLos,
        reason: `No hay tarifa publicada para una o más noches.`
      });
    }

    // If all checks pass → valid
    return res.status(200).json({
      valid: true,
      minimumNightsRequiredToStay: minLos
    });

  } catch {
    // Keep the shape minimal even on unexpected errors
    return res.status(200).json({
      valid: false,
      minimumNightsRequiredToStay: 1,
      reason: 'Error al procesar la solicitud.'
    });
  }
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
