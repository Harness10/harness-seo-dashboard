export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { endpoint, ...params } = req.query;

  if (!endpoint) {
    return res.status(400).json({ error: 'Missing endpoint parameter' });
  }

  const allowed = [
    'site-explorer/domain-rating',
    'site-explorer/metrics',
    'site-explorer/backlinks-stats',
    'site-explorer/organic-keywords',
    'site-explorer/top-pages',
    'site-explorer/metrics-history',
    'site-explorer/referring-domains',
    'site-explorer/organic-competitors',
    'site-explorer/domain-rating-history',
    'site-explorer/refdomains-history',
    'site-explorer/pages-by-traffic',
    'site-explorer/broken-backlinks',
    'site-explorer/anchors',
    'rank-tracker/overview',
    'management/projects',
    'management/project-keywords',
    'management/project-competitors',
    'site-audit/issues',
    'site-audit/projects',
    'gsc/keywords',
    'gsc/pages',
    'gsc/performance-history',
  ];

  if (!allowed.includes(endpoint)) {
    return res.status(400).json({ error: `Endpoint "${endpoint}" is not allowed` });
  }

  const apiKey = process.env.AHREFS_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'AHREFS_API_KEY environment variable is not configured' });
  }

  const url = new URL(`https://api.ahrefs.com/v3/${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') {
      url.searchParams.set(key, value);
    }
  }
  url.searchParams.set('output', 'json');

  try {
    const response = await fetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
      },
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=7200');
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
