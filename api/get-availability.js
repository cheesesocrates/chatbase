export default async function handler(req, res) {
  try {
    // Merge query + body so GET-with-body or POST both work
    const params = { ...(req.query || {}), ...(req.body || {}) };

    const normalizeDate = (v) => {
      if (!v) return "";
      if (typeof v === "string") {
        // "2025-10-17" or "2025-10-17T00:00:00.000Z"
        if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
        const d = new Date(v);
        return isNaN(+d) ? "" : d.toISOString().slice(0, 10);
      }
      if (typeof v === "number") {
        const d = new Date(v);
        return isNaN(+d) ? "" : d.toISOString().slice(0, 10);
      }
      return "";
    };

    const propertyID = String(params.propertyID || "198424");
    const startDate  = normalizeDate(params.startDate);
    const endDate    = normalizeDate(params.endDate);
    const adults     = String(params.adults ?? "2");
    const children   = String(params.children ?? "0");

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: "startDate and endDate are required (YYYY-MM-DD or ISO).",
        received: { startDate: params.startDate, endDate: params.endDate }
      });
    }

    const url = new URL("https://api.cloudbeds.com/api/v1.3/getAvailableRoomTypes");
    url.searchParams.set("propertyID", propertyID);
    url.searchParams.set("startDate", startDate);
    url.searchParams.set("endDate", endDate);
    url.searchParams.set("adults", adults);
    url.searchParams.set("children", children);

    const r = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${process.env.CLOUDBEDS_API_KEY}` }
    });

    const data = await r.json();
    return res.status(r.ok ? 200 : r.status).json(data);
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
}
