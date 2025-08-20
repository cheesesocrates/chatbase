// api/check-availability.js
// Answer: is ANY room type available between startDate and endDate?
// Auth: prefers OAuth Bearer (CLOUDBEDS_API_KEY). Falls back to x-api-key if not set.
// Output includes a per-type summary so you can verify the logic.

function ymd(v){ if(!v) return ""; const m=String(v).match(/^(\d{4}-\d{2}-\d{2})/); return m?m[1]:""; }
function toNum(v, d = 0){ const n = Number(v); return Number.isFinite(n) ? n : d; }

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ success:false, message:"Use GET." });

  try {
    const startDate  = ymd(req.query.startDate);
    const endDate    = ymd(req.query.endDate);
    const propertyID = (req.query.propertyID ?? "").toString().trim();
    const adults     = toNum(req.query.adults ?? req.query.numAdults, 2);
    const children   = toNum(req.query.children ?? req.query.numChildren, 0);
    const debug      = String(req.query.debug ?? "") === "1";

    const missing = [];
    if (!startDate) missing.push("startDate");
    if (!endDate)   missing.push("endDate");
    if (missing.length) {
      return res.status(400).json({ success:false, available:false, reason:`Missing: ${missing.join(", ")}` });
    }
    if (new Date(endDate) <= new Date(startDate)) {
      return res.status(400).json({ success:false, available:false, reason:"endDate must be after startDate" });
    }

    const BEARER = process.env.CLOUDBEDS_API_KEY;
    const APIKEY = process.env.CLOUDBEDS_API_KEY;
    const headers = BEARER
      ? { Authorization: `Bearer ${BEARER}` }
      : (APIKEY ? { "x-api-key": APIKEY } : null);

    if (!headers) {
      return res.status(500).json({
        success:false, available:false,
        reason:"No credentials set. Add CLOUDBEDS_API_KEY (preferred) or CLOUDBEDS_API_KEY in Vercel env."
      });
    }

    // Build the EXACT endpoint Cloudbeds gave you (v1.2 + CamelCase)
    const qs = new URLSearchParams({ startDate, endDate });
    if (propertyID) qs.set("propertyID", propertyID);
    if (!qs.has("adults"))   qs.set("adults", String(adults));
    if (!qs.has("children")) qs.set("children", String(children));

    const url = `https://api.cloudbeds.com/api/v1.2/getAvailableRoomTypes?${qs.toString()}`;

    const resp = await fetch(url, { headers });
    const raw = await resp.text();
    let payload; try { payload = JSON.parse(raw); } catch { payload = { raw }; }

    if (!resp.ok || payload?.success === false) {
      return res.status(resp.status || 400).json({
        success:false, available:false,
        reason: payload?.message || payload?.error || "Cloudbeds error",
        cloudbeds: payload, _endpoint: url
      });
    }

    // Find the list the API returned (field name varies by account)
    const list = Array.isArray(payload?.data) ? payload.data
               : Array.isArray(payload?.availableRoomTypes) ? payload.availableRoomTypes
               : Array.isArray(payload?.roomTypes) ? payload.roomTypes
               : null;

    if (!Array.isArray(list)) {
      return res.status(200).json({
        success:true, available:false,
        reason:"No room-types array in Cloudbeds response.",
        _endpoint:url, ...(debug ? { raw: payload } : {})
      });
    }

    // Compute counts explicitly and sum them
    const summary = list.map(rt => {
      const count = toNum(
        rt?.availableRooms ?? rt?.availability ?? rt?.remainingRooms ?? rt?.available ?? rt?.qty,
        0
      );
      return {
        roomTypeID: String(rt.roomTypeID ?? rt.id ?? ""),
        roomTypeName: String(rt.roomTypeName ?? rt.name ?? ""),
        availableRooms: count
      };
    });

    const totalAvailable = summary.reduce((sum, s) => sum + Math.max(0, s.availableRooms), 0);
    const available = totalAvailable > 0; // <= THIS is the decision (not inverted)

    return res.status(200).json({
      success:true,
      available,
      reason: available ? "At least one room type has availability." : "All room types show 0 available rooms.",
      totals: { totalAvailable },
      summary,          // you can eyeball this to verify the counts
      _endpoint:url
    });

  } catch (e) {
    return res.status(500).json({ success:false, available:false, reason:e?.message || "Unexpected error" });
  }
}
