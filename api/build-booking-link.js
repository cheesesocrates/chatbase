// api/build-booking-link.js
// Builds a Cloudbeds booking URL with prefilled params.
// Accepts GET (query) or POST (JSON body).
//
// REQUIRED ENV (set in Vercel → Settings → Environment Variables):
//   BOOKING_SLUG   = your property's booking slug, e.g. "svLoIs"
// OPTIONAL ENV:
//   BOOKING_LOCALE = "es" (default) or e.g. "en", "pt", etc.
//   BOOKING_DOMAIN = "hotels.cloudbeds.com" (default)

export default async function handler(req, res) {
  try {
    const params = { ...(req.query || {}), ...(req.body || {}) };

    // Pull your slug/locale from env (hardcode if you prefer)
    const DOMAIN = process.env.BOOKING_DOMAIN || "hotels.cloudbeds.com";
    const LOCALE = (process.env.BOOKING_LOCALE || "es").replace(/^\/+|\/+$/g, "");
    const SLUG   = (process.env.BOOKING_SLUG || "svLoIs").replace(/^\/+|\/+$/g, "");

    // Accept a few common aliases from chat tools
    const rawCheckin  = params.checkin  ?? params.startDate ?? params.checkInDate;
    const rawCheckout = params.checkout ?? params.endDate   ?? params.checkOutDate;
    const rawAdults   = params.adults   ?? params.numAdults;
    const rawChildren = params.children ?? params.numChildren ?? 0;
    const rawCurrency = params.currency; // optional

    // Normalize dates to YYYY-MM-DD (handles ISO like 2025-10-17T00:00:00.000Z)
    const normDate = (v) => {
      if (!v) return "";
      if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
      const d = new Date(v);
      return isNaN(+d) ? "" : d.toISOString().slice(0, 10);
    };
    const checkin  = normDate(rawCheckin);
    const checkout = normDate(rawCheckout);

    // Basic validation
    if (!checkin || !checkout) {
      return res.status(400).json({
        success: false,
        message: "checkin and checkout are required (YYYY-MM-DD or ISO)."
      });
    }
    if (new Date(checkout) <= new Date(checkin)) {
      return res.status(400).json({
        success: false,
        message: "checkout must be after checkin."
      });
    }

    // Adults/children defaults & safety
    const adults   = Math.max(1, parseInt(rawAdults ?? 2, 10) || 2);
    const children = Math.max(0, parseInt(rawChildren ?? 0, 10) || 0);

    // Currency (optional)
    let currency = "";
    if (typeof rawCurrency === "string" && rawCurrency.trim()) {
      currency = rawCurrency.trim().toLowerCase(); // e.g., "usd", "eur", "ars"
    }

    // Build final Cloudbeds URL
    const u = new URL(`https://${DOMAIN}/${LOCALE}/reservation/${SLUG}/`);
    u.searchParams.set("checkin",  checkin);
    u.searchParams.set("checkout", checkout);
    u.searchParams.set("adults",   String(adults));
    u.searchParams.set("children", String(children));
    if (currency) u.searchParams.set("currency", currency);

    // Return a tiny JSON the bot can display
    return res.status(200).json({
      success: true,
      url: u.toString()
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}
