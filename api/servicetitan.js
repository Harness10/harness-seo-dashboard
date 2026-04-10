// ServiceTitan API proxy — fetches Calls, Jobs, Revenue, Leads per campaign
// Environment variables required:
//   ST_CLIENT_ID, ST_CLIENT_SECRET, ST_TENANT_ID, ST_APP_KEY
//   ST_CAMPAIGN_MAP — JSON mapping Ahrefs project_id to ST campaign UUIDs:
//     { "12345": { "gbp": "uuid-gbp", "organic": "uuid-organic" }, ... }

let tokenCache = { token: null, expires: 0 };

async function getAccessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expires) return tokenCache.token;

  const resp = await fetch('https://auth.servicetitan.io/connect/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.ST_CLIENT_ID,
      client_secret: process.env.ST_CLIENT_SECRET,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`ST auth failed (${resp.status}): ${text}`);
  }

  const data = await resp.json();
  tokenCache.token = data.access_token;
  tokenCache.expires = Date.now() + (data.expires_in - 60) * 1000;
  return data.access_token;
}

async function stFetch(path, token, params = {}) {
  const tenantId = process.env.ST_TENANT_ID;
  const url = new URL(`https://api.servicetitan.io${path.replace('{tenant_id}', tenantId)}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') url.searchParams.set(k, v);
  }

  const resp = await fetch(url.toString(), {
    headers: {
      'Authorization': `Bearer ${token}`,
      'ST-App-Key': process.env.ST_APP_KEY,
      'Content-Type': 'application/json',
    },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`ST API ${resp.status}: ${text}`);
  }
  return resp.json();
}

// Paginate through all results for a given endpoint
async function stFetchAll(path, token, params = {}, dataKey = 'data') {
  let allData = [];
  let page = 1;
  const pageSize = 100;

  while (true) {
    const result = await stFetch(path, token, { ...params, page, pageSize });
    const items = result[dataKey] || [];
    allData = allData.concat(items);
    if (!result.hasMore || items.length < pageSize) break;
    page++;
    if (page > 20) break; // safety limit
  }
  return allData;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Check if ST is configured
  if (!process.env.ST_CLIENT_ID || !process.env.ST_TENANT_ID || !process.env.ST_APP_KEY) {
    return res.status(200).json({ configured: false, error: 'ServiceTitan not configured' });
  }

  const { action, project_id, date_from, date_to } = req.query;

  if (!action) return res.status(400).json({ error: 'Missing action parameter' });

  // Load campaign map
  let campaignMap = {};
  try {
    campaignMap = JSON.parse(process.env.ST_CAMPAIGN_MAP || '{}');
  } catch (e) {
    return res.status(500).json({ error: 'Invalid ST_CAMPAIGN_MAP JSON' });
  }

  // Action: config — return whether ST is configured for this project
  if (action === 'config') {
    const projectConfig = campaignMap[project_id] || null;
    return res.status(200).json({
      configured: true,
      hasProject: !!projectConfig,
      campaigns: projectConfig,
    });
  }

  // Action: data — fetch calls, jobs, leads, revenue for this project's campaigns
  if (action === 'data') {
    if (!project_id) return res.status(400).json({ error: 'Missing project_id' });

    const projectCampaigns = campaignMap[project_id];
    if (!projectCampaigns) {
      return res.status(200).json({ configured: true, hasProject: false });
    }

    const campaignIds = [projectCampaigns.gbp, projectCampaigns.organic].filter(Boolean);
    if (campaignIds.length === 0) {
      return res.status(200).json({ configured: true, hasProject: false });
    }

    try {
      const token = await getAccessToken();
      const tenantId = process.env.ST_TENANT_ID;

      // Build date filters
      const dateFilter = {};
      if (date_from) dateFilter.createdOnOrAfter = date_from;
      if (date_to) dateFilter.createdBefore = date_to;

      // Fetch calls, jobs, and bookings for each campaign
      const results = {};
      for (const [channel, campaignId] of Object.entries(projectCampaigns)) {
        if (!campaignId) continue;

        // Fetch calls for this campaign
        const calls = await stFetchAll(
          `/telecom/v2/tenant/{tenant_id}/calls`,
          token,
          { ...dateFilter, 'campaign.id': campaignId }
        );

        // Fetch jobs for this campaign
        const jobs = await stFetchAll(
          `/jpm/v2/tenant/{tenant_id}/jobs`,
          token,
          { ...dateFilter, campaignId }
        );

        // Fetch bookings/leads for this campaign
        const bookings = await stFetchAll(
          `/crm/v2/tenant/{tenant_id}/bookings`,
          token,
          { ...dateFilter, campaignId }
        );

        // Calculate revenue from jobs
        const totalRevenue = jobs.reduce((sum, j) => sum + (j.invoice?.total || j.total || 0), 0);

        results[channel] = {
          campaignId,
          calls: {
            total: calls.length,
            answered: calls.filter(c => c.duration && c.duration > 0).length,
            missed: calls.filter(c => !c.duration || c.duration === 0).length,
            avgDuration: calls.length > 0 ? Math.round(calls.reduce((s, c) => s + (c.duration || 0), 0) / calls.length) : 0,
          },
          jobs: {
            total: jobs.length,
            completed: jobs.filter(j => j.status === 'Completed').length,
            revenue: totalRevenue,
            avgTicket: jobs.length > 0 ? Math.round(totalRevenue / jobs.length) : 0,
          },
          leads: {
            total: bookings.length,
            booked: bookings.filter(b => b.status === 'Scheduled' || b.status === 'Dispatched').length,
          },
        };
      }

      // Compute combined totals
      const channels = Object.values(results);
      const totals = {
        calls: channels.reduce((s, c) => s + c.calls.total, 0),
        callsAnswered: channels.reduce((s, c) => s + c.calls.answered, 0),
        jobs: channels.reduce((s, c) => s + c.jobs.total, 0),
        jobsCompleted: channels.reduce((s, c) => s + c.jobs.completed, 0),
        revenue: channels.reduce((s, c) => s + c.jobs.revenue, 0),
        leads: channels.reduce((s, c) => s + c.leads.total, 0),
        leadsBooked: channels.reduce((s, c) => s + c.leads.booked, 0),
      };

      res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
      return res.status(200).json({
        configured: true,
        hasProject: true,
        channels: results,
        totals,
        dateRange: { from: date_from, to: date_to },
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: `Unknown action: ${action}` });
}
