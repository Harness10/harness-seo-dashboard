import { createClient } from '@supabase/supabase-js';

export const config = { maxDuration: 60 };

const supabase = () => createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function ahrefsCall(endpoint, params) {
  const url = new URL(`https://api.ahrefs.com/v3/${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') url.searchParams.set(k, v);
  }
  url.searchParams.set('output', 'json');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch(url.toString(), {
      signal: ctrl.signal,
      headers: { 'Authorization': `Bearer ${process.env.AHREFS_API_KEY}`, 'Accept': 'application/json' }
    });
    clearTimeout(timer);
    const text = await r.text();
    try { return JSON.parse(text); } catch { return null; }
  } catch { clearTimeout(timer); return null; }
}

function fmtDate(d) { return d.toISOString().split('T')[0]; }
function daysAgo(d, n) { const x = new Date(d); x.setDate(x.getDate() - n); return x; }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const apiKey = process.env.AHREFS_API_KEY;
  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_KEY;
  if (!apiKey || !sbUrl || !sbKey) return res.status(500).json({ error: 'Missing env vars' });

  const { project_id } = req.body || req.query;
  if (!project_id) return res.status(400).json({ error: 'project_id required' });

  const db = supabase();
  const pid = parseInt(project_id);

  // Get project info
  const { data: proj } = await db.from('projects').select('*').eq('id', pid).single();
  if (!proj) return res.status(404).json({ error: 'Project not found' });

  const today = new Date();
  const date = fmtDate(today);
  const dateCmp = fmtDate(daysAgo(today, 30));
  const dateFrom = fmtDate(daysAgo(today, 365));
  const domain = proj.url.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const rootDomain = domain.split('/')[0];

  try {
    // Fetch all data from Ahrefs in parallel
    const [rtRes, orgRes, drRes, metricsRes, blRes, histRes, pagesRes, compsRes] = await Promise.all([
      ahrefsCall('rank-tracker/overview', { project_id: pid, date, date_compared: dateCmp, device: 'mobile', limit: 100, select: 'keyword,position,position_prev,position_diff,volume,traffic,traffic_diff,keyword_difficulty,url,tags,location,best_position_kind,serp_features,is_informational,is_transactional,is_commercial,is_local' }),
      ahrefsCall('site-explorer/organic-keywords', { target: domain, date, country: 'us', mode: proj.mode || 'subdomains', limit: 50, order_by: 'sum_traffic:desc', select: 'keyword,best_position,sum_traffic,volume,keyword_difficulty,best_position_url,is_local,is_commercial,is_transactional,is_informational' }),
      ahrefsCall('site-explorer/domain-rating', { target: domain, date }),
      ahrefsCall('site-explorer/metrics', { target: domain, date, country: 'us' }),
      ahrefsCall('site-explorer/backlinks-stats', { target: domain, date }),
      ahrefsCall('site-explorer/metrics-history', { target: domain, date_from: dateFrom, country: 'us', history_grouping: 'monthly' }),
      ahrefsCall('site-explorer/top-pages', { target: domain, date, country: 'us', limit: 50, select: 'url,sum_traffic,value,keywords,top_keyword,top_keyword_best_position', order_by: 'sum_traffic:desc' }),
      ahrefsCall('site-explorer/organic-competitors', { target: domain, date, country: 'us', limit: 30, select: 'competitor_domain,keywords_common,traffic,share,domain_rating', order_by: 'keywords_common:desc' }),
    ]);

    // Fetch audit + GSC
    const auditDomain = proj.url.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
    let auditProjects = null;
    try {
      const ap = await ahrefsCall('site-audit/projects', {});
      const match = (ap?.healthscores || []).find(a => {
        const d = (a.target_url || '').replace(/^www\./, '').replace(/\/+$/, '');
        return d === auditDomain || d === auditDomain.split('/')[0];
      });
      auditProjects = match;
    } catch {}

    let auditIssues = [];
    if (auditProjects) {
      try { const ai = await ahrefsCall('site-audit/issues', { project_id: auditProjects.project_id }); auditIssues = ai?.issues || []; } catch {}
    }

    const gscFrom = fmtDate(daysAgo(today, 90));
    const [gscKwRes, gscHistRes, gscPagesRes] = await Promise.all([
      ahrefsCall('gsc/keywords', { project_id: pid, date_from: gscFrom, date_to: date, limit: 100 }).catch(() => null),
      ahrefsCall('gsc/performance-history', { project_id: pid, date_from: fmtDate(daysAgo(today, 180)), date_to: date, history_grouping: 'weekly' }).catch(() => null),
      ahrefsCall('gsc/pages', { project_id: pid, date_from: gscFrom, date_to: date, limit: 50 }).catch(() => null),
    ]);

    // Parse data
    const rt = rtRes?.overviews || [];
    const org = orgRes?.keywords || [];
    const dr = drRes?.domain_rating || {};
    const metrics = metricsRes?.metrics || {};
    const bl = blRes?.metrics || {};
    const hist = histRes?.metrics || [];
    const pages = pagesRes?.pages || [];
    const comps = compsRes?.competitors || [];
    const gscKw = gscKwRes?.keywords || [];
    const gscHist = gscHistRes?.metrics || [];
    const gscPages = gscPagesRes?.pages || [];

    // Compute RT stats
    const ranked = rt.filter(k => k.position != null);
    const rtTop3 = ranked.filter(k => k.position <= 3).length;
    const rtTop10 = ranked.filter(k => k.position <= 10).length;
    const rtTop20 = ranked.filter(k => k.position <= 20).length;
    const t1120 = ranked.filter(k => k.position > 10 && k.position <= 20).length;
    const healthIndex = rt.length > 0 ? Math.round((rtTop3 * 3 + (rtTop10 - rtTop3) * 2 + t1120) / (rt.length * 3) * 100) : 0;
    const improved = rt.filter(k => k.position_diff != null && k.position_diff < 0).length;
    const declined = rt.filter(k => k.position_diff != null && k.position_diff > 0).length;
    const aioSerps = rt.filter(k => (k.serp_features || []).some(f => f.startsWith('ai_overview'))).length;
    const aioCited = rt.filter(k => k.best_position_kind === 'ai_overview' || k.best_position_kind === 'ai_overview_sitelink').length;

    // Write to Supabase — delete today's data first, then insert fresh
    const snapshotDate = date;

    // Upsert project snapshot
    await db.from('project_snapshots').upsert({
      project_id: pid, snapshot_date: snapshotDate,
      domain_rating: dr.domain_rating, ahrefs_rank: dr.ahrefs_rank,
      org_traffic: metrics.org_traffic, org_keywords: metrics.org_keywords, org_cost: metrics.org_cost,
      backlinks_live: bl.live, backlinks_all_time: bl.all_time, refdomains_live: bl.live_refdomains, refdomains_all_time: bl.all_time_refdomains,
      audit_project_id: auditProjects?.project_id, health_score: auditProjects?.health_score,
      audit_errors: auditProjects?.urls_with_errors, audit_warnings: auditProjects?.urls_with_warnings,
      rt_total: rt.length, rt_ranked: ranked.length, rt_top3: rtTop3, rt_top10: rtTop10, rt_top20: rtTop20,
      health_index: healthIndex, improved, declined, aio_serps: aioSerps, aio_cited: aioCited,
      fetched_at: new Date().toISOString(),
    }, { onConflict: 'project_id,snapshot_date' });

    // Helper: delete + insert batch
    const replaceData = async (table, rows) => {
      await db.from(table).delete().eq('project_id', pid).eq('snapshot_date', snapshotDate);
      if (rows.length > 0) {
        // Insert in chunks of 500
        for (let i = 0; i < rows.length; i += 500) {
          await db.from(table).insert(rows.slice(i, i + 500));
        }
      }
    };

    await Promise.all([
      replaceData('rank_tracker_keywords', rt.map(k => ({ project_id: pid, snapshot_date: snapshotDate, keyword: k.keyword, position: k.position, position_prev: k.position_prev, position_diff: k.position_diff, volume: k.volume, traffic: k.traffic, traffic_diff: k.traffic_diff, keyword_difficulty: k.keyword_difficulty, url: k.url, tags: k.tags, location: k.location, best_position_kind: k.best_position_kind, serp_features: k.serp_features, is_informational: k.is_informational, is_transactional: k.is_transactional, is_commercial: k.is_commercial, is_local: k.is_local }))),
      replaceData('organic_keywords', org.map(k => ({ project_id: pid, snapshot_date: snapshotDate, keyword: k.keyword, best_position: k.best_position, sum_traffic: k.sum_traffic, volume: k.volume, keyword_difficulty: k.keyword_difficulty, best_position_url: k.best_position_url, is_local: k.is_local, is_commercial: k.is_commercial, is_transactional: k.is_transactional, is_informational: k.is_informational }))),
      replaceData('top_pages', pages.map(p => ({ project_id: pid, snapshot_date: snapshotDate, url: p.url, sum_traffic: p.sum_traffic, value: p.value, keywords: p.keywords, top_keyword: p.top_keyword, top_keyword_best_position: p.top_keyword_best_position }))),
      replaceData('organic_competitors', comps.map(c => ({ project_id: pid, snapshot_date: snapshotDate, competitor_domain: c.competitor_domain, keywords_common: c.keywords_common, traffic: c.traffic, share: c.share, domain_rating: c.domain_rating }))),
      replaceData('traffic_history', hist.map(h => ({ project_id: pid, snapshot_date: snapshotDate, month_date: h.date?.split('T')[0], org_traffic: h.org_traffic }))),
      replaceData('site_audit_issues', auditIssues.map(i => ({ project_id: pid, snapshot_date: snapshotDate, issue_id: i.issue_id, name: i.name, category: i.category, importance: i.importance, crawled: i.crawled, change: i.change, is_indexable: i.is_indexable }))),
      replaceData('gsc_keywords', gscKw.map(k => ({ project_id: pid, snapshot_date: snapshotDate, keyword: k.keyword, clicks: k.clicks, impressions: k.impressions, ctr: k.ctr, position: k.position, top_url: k.top_url }))),
      replaceData('gsc_pages', gscPages.map(p => ({ project_id: pid, snapshot_date: snapshotDate, url: p.url, clicks: p.clicks, impressions: p.impressions, ctr: p.ctr, position: p.position }))),
      replaceData('gsc_performance_history', gscHist.map(h => ({ project_id: pid, snapshot_date: snapshotDate, week_date: h.date?.split('T')[0], clicks: h.clicks, impressions: h.impressions, ctr: h.ctr, position: h.position }))),
    ]);

    return res.status(200).json({ success: true, project_id: pid, snapshot_date: snapshotDate, rt_keywords: rt.length, org_keywords: org.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
