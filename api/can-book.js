// api/can-book.js  (sanity check)
export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') return res.status(405).json({ ok:false, msg:'Use GET' });
    return res.status(200).json({ ok:true, echo:req.query, env:!!process.env.CLOUDBEDS_API_KEY });
  } catch (e) {
    return res.status(500).json({ ok:false, err:e?.message });
  }
}
