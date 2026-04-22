// Server-side proxy so the browser can read URLs that block CORS
// (e.g. gpxscan.com .jsp viewer pages). Deployed automatically as a
// Vercel serverless function at /api/fetch.

module.exports = async (req, res) => {
  const url = (req.query && req.query.url) || '';
  if (!url) {
    res.status(400).json({ error: 'missing ?url=' });
    return;
  }

  let target;
  try {
    target = new URL(url);
  } catch {
    res.status(400).json({ error: 'invalid url' });
    return;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    res.status(400).json({ error: 'only http/https allowed' });
    return;
  }

  try {
    const upstream = await fetch(target.toString(), {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TrafingVelocidad/1.0)',
        'Accept': '*/*',
      },
    });
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(text);
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
};
