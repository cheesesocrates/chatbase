export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method Not Allowed" });
  }

  try {
    const {
      propertyID, startDate, endDate, roomTypeID,
      numAdults, numChildren, guestFirstName, guestLastName,
      guestEmail, guestCountry
    } = req.body || {};

    const form = new URLSearchParams({
      propertyID: String(propertyID),
      startDate: String(startDate),
      endDate: String(endDate),
      roomTypeID: String(roomTypeID),
      numAdults: String(numAdults ?? 0),
      numChildren: String(numChildren ?? 0),
      guestFirstName: String(guestFirstName || ""),
      guestLastName: String(guestLastName || ""),
      guestEmail: String(guestEmail || ""),
      guestCountry: String(guestCountry || "")
    });

    const r = await fetch("https://api.cloudbeds.com/api/v1.2/postReservation", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.CLOUDBEDS_TOKEN}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: form.toString()
    });

    const data = await r.json().catch(() => ({}));
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
}
