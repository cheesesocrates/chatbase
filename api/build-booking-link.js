// api/build-booking-link.js
// Responde SIEMPRE 200 con: { success: true, url: "<mensaje o links>" }

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

    // Selección
    const desiredPropertyID = toStr(src.propertyID);   // Requerido (sin default)
    const preferredSlot     = toStr(src.provider);     // opcional si no hay propertyID
    const fallback          = toBool(src.fallback, true);

    // Validaciones básicas
    if (!checkin || !checkout)
      return ok(res, `Lo sentimos, necesitamos las fechas de llegada y salida en formato AAAA-MM-DD.`);
    const nights = diffDays(checkin, checkout);
    if (nights <= 0)
      return ok(res, `La fecha de salida debe ser posterior a la fecha de llegada.`);
    if (!desiredPropertyID && !preferredSlot)
      return ok(res, `Falta indicar el complejo (propertyID) o el proveedor (provider=1|2|3).`);

    // Registro de propiedades (links fijos según tu mapeo)
    const allProviders = loadProvidersFromEnv();
    if (!allProviders.length)
      return ok(res, `No hay proveedores configurados. Por favor, verificá las credenciales del servidor.`);

    // Orden: primero la propiedad deseada; si no, por slot; si no, orden natural
    const ordered = orderProviders(allProviders, desiredPropertyID, preferredSlot);
    const desired = ordered[0];
    const others  = ordered.slice(1);

    // 1) Intentar SOLO la propiedad deseada
    const desiredResult = await tryProvider({
      provider: desired,
      propertyID: desiredPropertyID || desired.propertyID, // prioriza el valor del request
      checkin, checkout, adults, children, currency, roomTypeId, ratePlanId, promoCode
    });

    if (desiredResult.ok) {
      // Éxito → devolvemos un solo link etiquetado
      return ok(res, `[${desired.name}] ${desiredResult.link}`);
    }

    // 2) Propiedad deseada sin disponibilidad → damos motivo y probamos alternativas
    const reason = desiredResult.reason || 'No hay disponibilidad para esas fechas.';
    const altLinks = [];

    if (fallback && others.length) {
      for (const p of others) {
        const r = await tryProvider({
          provider: p,
          propertyID: p.propertyID, // su propio propertyID desde env
          checkin, checkout, adults, children, currency, roomTypeId, ratePlanId, promoCode
        });
        if (r.ok) altLinks.push(`[${p.name}] ${r.link}`);
      }
    }

    if (altLinks.length) {
      return ok(res, `En el complejo elegido no encontramos disponibilidad: ${reason} || También podés reservar aquí: ${altLinks.join(' || ')}`);
    }

    // 3) Nada disponible en ninguna
    return ok(res, `Por ahora no vemos disponibilidad en el complejo seleccionado (${desired.name}) — ${reason}. Tampoco encontramos alternativas en las otras opciones para tus fechas.`);

  } catch (e) {
    console.error('build-booking-link error:', e);
    return ok(res, `Tuvimos un inconveniente al procesar tu solicitud. Por favor, volvé a intentar en unos minutos.`);
  }
}

/* ---------- intento por proveedor ---------- */
async function tryProvider({ provider: p, propertyID, checkin, checkout, adults, children, currency, roomTypeId, ratePlanId, promoCode }) {
  // Chequeos de configuración
  if (!p?.apiKey)      return { ok:false, reason:'Falta configurar la clave de acceso del servidor.' };
  if (!propertyID)     return { ok:false, reason:'Falta indicar el complejo (propertyID).' };
  if (!p?.bookingBase) return { ok:false, reason:'Falta el enlace del motor de reservas.' };

  // Cloudbeds getRatePlans
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
      return { ok:false, reason: json?.message || `No pudimos consultar disponibilidad (código ${resp.status}).` };
    }
  } catch {
    return { ok:false, reason:'No pudimos conectarnos para verificar disponibilidad. Revisá tu conexión e intentá nuevamente.' };
  }

  const plans = Array.isArray(json?.data) ? json.data : [];
  if (!plans.length) return { ok:false, reason:'No hay planes publicados para esas fechas.' };

  // Filtros opcionales
  const filtrados = plans
    .filter(pl => (!ratePlanId || String(pl?.ratePlanId) === ratePlanId))
    .map(pl => ({ ...pl, details: Array.isArray(pl?.roomRateDetailed) ? pl.roomRateDetailed : [] }))
    .filter(pl => !roomTypeId || hasRoomType(pl, roomTypeId));

  if (!filtrados.length) return { ok:false, reason:'No hay una tarifa/habitación que coincida con tu búsqueda.' };

  // Validar ventana
  const nights   = diffDays(checkin, checkout);
  const elegido  = filtrados[0];
  const details  = elegido.details;
  const lastNi   = addDays(checkin, nights - 1);
  const ventana  = details.filter(d => d?.date >= checkin && d?.date <= lastNi);

  if (ventana.length < nights) return { ok:false, reason:'Faltan precios para todas las noches solicitadas.' };
  const llegada = details.find(d => d?.date === checkin);
  const minLos  = inferMinLos(details, llegada);
  if (nights < minLos) return { ok:false, reason:`La estadía mínima para esas fechas es de ${minLos} noche(s).` };
  if (llegada?.closedToArrival) return { ok:false, reason:'Ese día no se permite hacer el check-in.' };
  const depCerrada =
    details.find(d => d?.date === checkout)?.closedToDeparture ||
    details.find(d => d?.date === lastNi)?.closedToDeparture || false;
  if (depCerrada) return { ok:false, reason:'Ese día no se permite hacer el check-out.' };
  if (ventana.some(d => toInt(d?.roomsAvailable, 0) === 0)) return { ok:false, reason:'No hay disponibilidad en una o más noches del rango elegido.' };
  if (ventana.some(d => toNum(d?.rate, 0) <= 0))            return { ok:false, reason:'No hay tarifa publicada para una o más noches del rango.' };

  // Éxito → armamos link
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

/* ---------- proveedores: STYLE (1), COLONIAL (2), ALTOS (3) ---------- */
function loadProvidersFromEnv() {
  return [
    {
      slot: '1',
      name: 'STYLE',
      apiKey:   process.env.CLOUDBEDS_API_KEY      || '',
      apiBase:  process.env.CLOUDBEDS_API_BASE     || 'https://api.cloudbeds.com/api/v1.3',
      bookingBase: 'https://hotels.cloudbeds.com/es/reservation/svLoIs',
      // cuando STYLE se usa como alternativo, se puede tomar de env:
      propertyID: process.env.CLOUDBEDS_PROPERTY_ID || '',
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
  ].filter(p => p.apiKey); // al menos debe tener API key
}

/* ---------- orden de proveedores ---------- */
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

/* ---------- utilitarios compartidos ---------- */
function ok(res, urlStr){ return res.status(200).json({ success:true, url:String(urlStr||'') }); }
function toStr(v){ return (v==null ? '' : String(v).trim()) || ''; }
function toBool(v, d=false){ if(v==null) return d; const s=String(v).toLowerCase(); return ['1','true','yes','y','on','si','sí'].includes(s); }
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
