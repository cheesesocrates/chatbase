reserve.js

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  }

  try {
    const response = await fetch("https://hotels.cloudbeds.com/api/v1.2/postReservation", {
      method: "POST",
      headers: {
        "Authorization": Bearer ${process.env.CLOUDBEDS_API_KEY},
        "Content-Type": "application/json"
      },
      body: JSON.stringify(req.body)
    });

    const data = await response.json();
    res.status(response.status).json(data);

  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}
