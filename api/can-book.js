// api/can-book.js  (ESM; package.json has "type":"module")
function ymd(v){ if(!v) return ''; const m=String(v).match(/^(\d{4}-\d{2}-\d{2})/); return m?m[1]:''; }
function toInt(v,d){ const n=Number(v); return Number.isFinite(n)?n:d; }

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ success:false, message:'Use GET.' });
  const TOKEN = process.env.CLOUDBEDS_OAUTH_TOKEN;
  if (!TOKEN) return res.status(500).json({ success:false, message:'Missing CLOUDBEDS_OAUTH_TOKEN' });

  const startDate = ymd(req.query.startDate);
  const endDate   = ymd(req.query.endDate);
  const adults    = toInt(req.query.adults ?? req.query.numAdults, 2);
  const children  = toInt(req.query.children ?? req.query.numChildren, 0);
  const roomTypeID= (req.query.roomTypeID ?? '').toString();
  const quantity  = toInt(req.query.quantity, 1);

  const missing = [];
  if (!startDate) missing.push('startDate');
  if (!endDate)   missing.push('endDate');
  if (missing.length) return res.status(400).json({ success:false, message:`Missing required fields: ${missing.join(', ')}` });

  const qs = new URLSearchParams({
    startDate, endDate, adults:String(adults), children:String(children)
  });
  if (roomTypeID) qs.set('roomTypeID', roomTypeID);

  const url = `https://api.cloudbeds.com/api/v1.2/getAvailableRoomTypes?${qs.toString()}`;
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const raw = await r.text(); let data; try { data = JSON.parse(raw); } catch { data = { raw }; }
    if (!r.ok || data?.success === false) {
      return res.status(r.status || 400).json({ success:false, message:data?.message||data?.error||'Cloudbeds error', cloudbeds:data, _endpoint:url });
    }

    const list = Array.isArray(data?.data) ? data.data
               : Array.isArray(data?.availableRoomTypes) ? data.availableRoomTypes
               : Array.isArray(data?.roomTypes) ? data.roomTypes
               : null;

    if (!Array.isArray(list)) {
      return res.status(200).json({ success:true, canBook:false, reason:'No types array in response', _endpoint:url, raw:data });
    }

    const party = adults + children;
    const match = list.find(rt => {
      const id  = String(rt.roomTypeID ?? rt.id ?? '');
      const av  = Number(rt.availableRooms ?? rt.availability ?? rt.remainingRooms ?? rt.available ?? 0);
      const cap = rt.maxGuests ?? rt.max_occupancy ?? null;
      const meetsType = roomTypeID ? id === roomTypeID : true;
      const stockOK   = av >= quantity;
      const capOK     = (cap == null) ? true : (party <= cap * quantity);
      return meetsType && stockOK && capOK;
    });

    return res.status(200).json({
      success:true,
      canBook:Boolean(!!match),
      reason: match ? 'Available.' : 'No room types meet quantity/capacity.',
      details:{ adults, children, quantity, roomTypeID, match },
      _endpoint:url
    });
  } catch (e) {
    return res.status(500).json({ success:false, message:e?.message||'Unexpected error' });
  }
}
