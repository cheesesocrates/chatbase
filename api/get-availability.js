// Vercel serverless function: GET /api/get-availability
export default async function handler(req, res) {
  try {
    // Accept GET or POST (Chatbase may call either)
    const m = req.method.toUpperCase();
    const params = m === 'GET' ? req.query : (req.body || {});

    const {
      startDate,
      endDate,
      propertyID = '198424',
      adults = '2',
      children = '0'
    } = params;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: "startDate and endDate are required (YYYY-MM-DD)."
      });
    }

    // Build Cloudbeds URL
    const url = new URL('https://api.cloudbeds.com/api/v1.3/getAvailableRoomTypes');
    url.searchParams.set('propertyID', propertyID);
    url.searchParams.set('startDate', startDate);
    url.searchParams.set('endDate', endDate);
    if (adults)   url.searchParams.set('adults', adults);
    if (children) url.searchParams.set('children', children);

    // Call Cloudbeds
    const r = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${process.env.CLOUDBEDS_API_KEY}`
      }
    });

    const data = await r.json();

    // Helpful hint for this specific property (optional but nice)
    // If nothing returned and user asked < 2 nights or touches 10/15–10/16 days, tell them why.
    const nights =
      (new Date(endDate).getTime() - new Date(startDate).getTime()) / 86400000;

    const hint = (!data?.data?.length) ? {
      note: "No rooms for the requested window.",
      suggestions: [
        "Ensure stay is at least 2 nights.",
        "Try check-in on or after 2025-10-17 (earlier days may have no daily rates)."
      ]
    } : undefined;

    return res.status(r.ok ? 200 : r.status).json({ ...data, hint });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}
