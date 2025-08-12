export default async function handler(req, res) {
  // Only accept POST requests
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method Not Allowed" });
  }

  try {
    const {
      propertyID,
      checkInDate,
      checkOutDate,
      roomTypeID,
      numAdults,
      numChildren,
      guestFirstName,
      guestLastName,
      guestEmail,
      guestCountry
    } = req.body;

    // Validate required fields
    if (
      !propertyID || !checkInDate || !checkOutDate || !roomTypeID ||
      !numAdults || !guestFirstName || !guestLastName ||
      !guestEmail || !guestCountry
    ) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    // Send request to Cloudbeds
    const cloudbedsRes = await fetch("https://hotels.cloudbeds.com/api/v1.2/postReservation", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.CLOUDBEDS_API_KEY}`, // API key from environment variable
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        propertyID,
        startDate: checkInDate,  // Cloudbeds expects "startDate"
        endDate: checkOutDate,   // Cloudbeds expects "endDate"
        roomTypeID,
        numAdults,
        numChildren,
        guestFirstName,
        guestLastName,
        guestEmail,
        guestCountry
      })
    });

    const data = await cloudbedsRes.json();

    return res.status(cloudbedsRes.status).json(data);

  } catch (error) {
    console.error("Error making reservation:", error);
    return res.status(500).json({ success: false, message: "Server Error", error: error.message });
  }
}
