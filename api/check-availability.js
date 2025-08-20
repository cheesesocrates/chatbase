// api/check-availability.js
// INPUT (query): startDate=YYYY-MM-DD, endDate=YYYY-MM-DD, propertyID (optional), adults, children
// OUTPUT: { success, available, reason, _endpoint, details }

function ymd(v){ if(!v) return ""; const m=String(v).match(/^(\d{4}-\d{2}-\d{2})/); return m?m[1]:""; }
function toInt(v,d){ const n=Number(v); return Number.isFinite(n)?n:d; }

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ success:false, message:"Use GET." });

  const TOKEN = process.env.CLOUDBEDS_API_TOKEN; // <-- set in Vercel
  if (!TOKEN) return res.status(500).json({ success:false, message:"Missing CLOUDBEDS_API_TOKEN" });

  const startDate  = ymd(req.query.startDate);
  const endDate    = ymd(req.query.endDate);
  const propertyID = (req.query.propertyID ?? "").toString().trim(); // some tokens are scoped; optional
  // Optional party size (doesn't affect simple vacancy, but available for later)
  const adults   = toInt(req.query.adults ?? req.query.numAdults, 2);
  const children = toInt(req.query.children ?? req.query.numChildren, 0);

  const missing = [];
  if (!startDate) missing.push("startDate");
  if (!endDate)   missing.push("endDate");
  if (missing.length) {
    return res.status(400).json({ success:false, message:`Missing required fields: ${missing.join(", ")}` });
  }
  if (new Date(endDate) <= new Date(startDate)) {
    return res.status(400).json({ success:false, message:"endDate must be after startDate" });
  }

  // Build Cloudbeds URL (v1.2 + CamelCase + Bearer)
  const qs = new URLSearchParams({
    startDate, endDate,
    adults: String(adults),
    children: String(children)
  });
  if (propertyID) qs.set("propertyID", propertyID); // include only if provided

  const url = `https://api.cloudbeds.com/api/v1.2/getAvailableRoomTypes?${qs.toString()}`;

  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const raw = await r.text();
    let data; try { data = JSON.parse(raw); } catch { data = { raw }; }

    if (!r.ok || data?.success === false) {
      // Surface their message—don’t guess “booked”
      return res.status(r.status || 400).json({
        success:false,
        available:false,
        reason: data?.message || data?.error || "Cloudbeds error",
        cloudbeds:data, _endpoint:url
      });
    }

    // Find a room-types array in the response
    const list = Array.isArray(data?.data) ? data.data
               : Array.isArray(data?.availableRoomTypes) ? data.availableRoomTypes
               : Array.isArray(data?.roomTypes) ? data.roomTypes
               : null;

    if (!Array.isArray(list)) {
      return res.status(200).json({
        success:true,
        available:false,
        reason:"No room-types list in Cloudbeds response.",
        _endpoint:url, raw:data
      });
    }

    // Vacant if ANY type has >0 available units (simple property-level vacancy)
    const hasAny = list.some(rt => {
      const av = toInt(rt?.availableRooms ?? rt?.availability ?? rt?.remainingRooms ?? rt?.available ?? rt?.qty, 0);
      return av > 0;
    });

    return res.status(200).json({
      success:true,
      available:Boolean(hasAny),
      reason: hasAny ? "At least one room type has availability." : "No available room types for these dates.",
      _endpoint:url,
      details:{ startDate, endDate, propertyID: propertyID || undefined }
    });
  } catch (e) {
    return res.status(500).json({ success:false, available:false, reason:e?.message || "Unexpected error" });
  }
}
