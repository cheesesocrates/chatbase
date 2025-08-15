// pages/api/can-book.js
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Use GET method' });
  }

  const API_KEY = process.env.CLOUDBEDS_API_KEY;
  if (!API_KEY) {
    return res.status(500).json({ success: false, message: 'Missing CLOUDBEDS_API_KEY in env' });
  }

  const { propertyID, startDate, endDate, adults = 2, children = 0, roomTypeID } = req.query;

  if (!propertyID || !startDate || !endDate) {
    return res.status(400).json({ success: false, message: 'Missing required parameters' });
  }

  const url = `https://api.cloudbeds.com/api/v1.3/get_getAvailableRoomTypes?propertyID=${propertyID}&startDate=${startDate}&endDate=${endDate}&checkInDate=${startDate}&checkOutDate=${endDate}&adults=${adults}&children=${children}${roomTypeID ? `&roomTypeID=${roomTypeID}` : ''}`;

  try {
    const resp = await fetch(url, {
      headers: { 'x-api-key': API_KEY }
    });
    const data = await resp.json();

    res.status(200).json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}
