// /api/get-reservations.js
export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  try {
    const { propertyID, startDate, endDate } = req.query;

    if (!propertyID || !startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: propertyID, startDate, endDate",
      });
    }

    const response = await fetch(
      `https://api.cloudbeds.com/api/v1.2/getAvailableRoomTypes?propertyID=${propertyID}&startDate=${startDate}&endDate=${endDate}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.CLOUDBEDS_API_KEY}`,
        },
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ success: false, data });
    }

    return res.status(200).json({ success: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}
