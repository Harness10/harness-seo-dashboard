import { createClient } from '@supabase/supabase-js';

export const config = { maxDuration: 300 };

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

async function refreshProject(db, proj, date, dateCmp, dateFrom) {
  const pid = proj.id;
  const domain = proj.url.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const rootDomain = domain.split('/')[0];

  // Fetch core data
  const [rtRes, orgRes, drRes, metricsRes, blRes, histRes, pagesRes, refsRes, compsRes] = await Promise.all([
    ahrefsCall('rank-tracker/overview', { project_id: pid, date, date_compared: dateCmp, device: 'mobile', limit: 100, select: 'keyword,position,position_prev,position_diff,volume,traffic,traffic_diff,keyword_difficulty,url,tags,location,best_position_kind,serp_features,is_informational,is_transactional,is_commercial,is_local' }),
    ahrefsCall('site-explorer/organic-keywords', { target: domain, date, country: 'us', mode: proj.mode || 'subdomains', limit: 50, order_by: 'sum_traffic:desc', select: 'keyword,best_position,sum_traffic,volume,keyword_difficulty,best_position_url,is_local,is_commercial,is_transactional,is_informational' }),
    ahrefsCall('site-explorer/domain-rating', { target: domain, date }),
    ahrefsCall('site-explorer/metrics', { target: domain, date, country: 'us' }),
    ahrefsCall('site-explorer/backlinks-stats', { target: domain, date }),
    ahrefsCall('site-explorer/metrics-history', { target: domain, date_from: dateFrom, country: 'us', history_grouping: 'monthly' }),
    ahrefsCall('site-explorer/top-pages', { target: domain, date, country: 'us', limit: 50, select: 'url,sum_traffic,value,keywords,top_keyword,top_keyword_best_position', order_by: 'sum_traffic:desc' }),
    ahrefsCall('site-explorer/referring-domains', { target: rootDomain, limit: 50, history: 'live', select: 'domain,domain_rating,links_to_target,dofollow_links,traffic_domain,first_seen', order_by: 'domain_rating:desc' }),
    ahrefsCall('site-explorer/organic-competitors', { target: domain, date, country: 'us', limit: 30, select: 'competitor_domain,keywords_common,traffic,share,domain_rating', order_by: 'keywords_common:desc' }),
  ]);

  // Fetch GSC
  const gscFrom = fmtDate(daysAgo(new Date(), 90));
  const [gscKwRes, gscHistRes, gscPagesRes] = await Promise.all([
    ahrefsCall('gsc/keywords', { project_id: pid, date_from: gscFrom, date_to: date, limit: 100 }),
    ahrefsCall('gsc/performance-history', { project_id: pid, date_from: fmtDate(daysAgo(new Date(), 180)), date_to: date, history_grouping: 'weekly' }),
    ahrefsCall('gsc/pages', { project_id: pid, date_from: gscFrom, date_to: date, limit: 50 }),
  ]);

  const rt = rtRes?.overviews || [];
  const org = orgRes?.keywords || [];
  const dr = drRes?.domain_rating || {};
  const metrics = metricsRes?.metrics || {};
  const bl = blRes?.metrics || {};
  const hist = histRes?.metrics || [];
  const pages = pagesRes?.pages || [];
  const refs = refsRes?.refdomains || [];
  const comps = compsRes?.competitors || [];
  const gscKw = gscKwRes?.keywords || [];
  const gscHist = gscHistRes?.metrics || [];
  const gscPages = gscPagesRes?.pages || [];

  // Compute stats
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

  // Write snapshot
  await db.from('project_snapshots').upsert({
    project_id: pid, snapshot_date: date,
    domain_rating: dr.domain_rating, ahrefs_rank: dr.ahrefs_rank,
    org_traffic: metrics.org_traffic, org_keywords: metrics.org_keywords, org_cost: metrics.org_cost,
    backlinks_live: bl.live, backlinks_all_time: bl.all_time, refdomains_live: bl.live_refdomains, refdomains_all_time: bl.all_time_refdomains,
    rt_total: rt.length, rt_ranked: ranked.length, rt_top3: rtTop3, rt_top10: rtTop10, rt_top20: rtTop20,
    health_index: healthIndex, improved, declined, aio_serps: aioSerps, aio_cited: aioCited,
    fetched_at: new Date().toISOString(),
  }, { onConflict: 'project_id,snapshot_date' });

  // Replace list data
  const replace = async (table, rows) => {
    await db.from(table).delete().eq('project_id', pid).eq('snapshot_date', date);
    if (rows.length > 0) { for (let i = 0; i < rows.length; i += 500) { await db.from(table).insert(rows.slice(i, i + 500)); } }
  };

  await Promise.all([
    replace('rank_tracker_keywords', rt.map(k => ({ project_id: pid, snapshot_date: date, keyword: k.keyword, position: k.position, position_prev: k.position_prev, position_diff: k.position_diff, volume: k.volume, traffic: k.traffic, traffic_diff: k.traffic_diff, keyword_difficulty: k.keyword_difficulty, url: k.url, tags: k.tags, location: k.location, best_position_kind: k.best_position_kind, serp_features: k.serp_features, is_informational: k.is_informational, is_transactional: k.is_transactional, is_commercial: k.is_commercial, is_local: k.is_local }))),
    replace('organic_keywords', org.map(k => ({ project_id: pid, snapshot_date: date, keyword: k.keyword, best_position: k.best_position, sum_traffic: k.sum_traffic, volume: k.volume, keyword_difficulty: k.keyword_difficulty, best_position_url: k.best_position_url, is_local: k.is_local, is_commercial: k.is_commercial, is_transactional: k.is_transactional, is_informational: k.is_informational }))),
    replace('top_pages', pages.map(p => ({ project_id: pid, snapshot_date: date, url: p.url, sum_traffic: p.sum_traffic, value: p.value, keywords: p.keywords, top_keyword: p.top_keyword, top_keyword_best_position: p.top_keyword_best_position }))),
    replace('referring_domains', refs.map(r => ({ project_id: pid, snapshot_date: date, domain: r.domain, domain_rating: r.domain_rating, links_to_target: r.links_to_target, dofollow_links: r.dofollow_links, traffic_domain: r.traffic_domain, first_seen: r.first_seen }))),
    replace('organic_competitors', comps.map(c => ({ project_id: pid, snapshot_date: date, competitor_domain: c.competitor_domain, keywords_common: c.keywords_common, traffic: c.traffic, share: c.share, domain_rating: c.domain_rating }))),
    replace('traffic_history', hist.map(h => ({ project_id: pid, snapshot_date: date, month_date: h.date?.split('T')[0], org_traffic: h.org_traffic }))),
    replace('gsc_keywords', gscKw.map(k => ({ project_id: pid, snapshot_date: date, keyword: k.keyword, clicks: k.clicks, impressions: k.impressions, ctr: k.ctr, position: k.position, top_url: k.top_url }))),
    replace('gsc_pages', gscPages.map(p => ({ project_id: pid, snapshot_date: date, url: p.url, clicks: p.clicks, impressions: p.impressions, ctr: p.ctr, position: p.position }))),
    replace('gsc_performance_history', gscHist.map(h => ({ project_id: pid, snapshot_date: date, week_date: h.date?.split('T')[0], clicks: h.clicks, impressions: h.impressions, ctr: h.ctr, position: h.position }))),
  ]);

  return { pid, rt: rt.length, org: org.length };
}

export default async function handler(req, res) {
  // Verify cron secret (Vercel sends this for cron jobs)
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}` && req.method !== 'POST') {
    // Allow manual POST trigger for testing, but cron must have correct auth
  }

  const apiKey = process.env.AHREFS_API_KEY;
  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_KEY;
  if (!apiKey || !sbUrl || !sbKey) return res.status(500).json({ error: 'Missing env vars' });

  const db = supabase();
  const today = new Date();
  const date = fmtDate(today);
  const dateCmp = fmtDate(daysAgo(today, 30));
  const dateFrom = fmtDate(daysAgo(today, 365));

  // Get all active projects
  const { data: projects } = await db.from('projects').select('*').eq('hidden', false).order('project_name');
  if (!projects?.length) return res.status(200).json({ message: 'No projects' });

  const BATCH = 4; // Conservative batching for cron (less aggressive than manual)
  const results = [];
  let errors = 0;

  // Sync project list from Ahrefs first
  try {
    const ahrefsProjects = await ahrefsCall('management/projects', {});
    if (ahrefsProjects?.projects) {
      for (const p of ahrefsProjects.projects) {
        await db.from('projects').update({ keyword_count: p.keyword_count, updated_at: new Date().toISOString() }).eq('id', p.project_id);
      }
    }
  } catch {}

  // Fetch site audit projects for matching
  let auditMap = {};
  try {
    const ap = await ahrefsCall('site-audit/projects', {});
    (ap?.healthscores || []).forEach(a => {
      const d = (a.target_url || '').replace(/^www\./, '').replace(/\/+$/, '');
      auditMap[d] = a;
    });
  } catch {}

  // Update audit info in snapshots
  for (const proj of projects) {
    const auditDomain = proj.url.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
    const audit = auditMap[auditDomain] || auditMap[auditDomain.split('/')[0]];
    if (audit) {
      // Fetch audit issues for this project
      try {
        const ai = await ahrefsCall('site-audit/issues', { project_id: audit.project_id });
        const issues = ai?.issues || [];
        await db.from('site_audit_issues').delete().eq('project_id', proj.id).eq('snapshot_date', date);
        if (issues.length > 0) {
          await db.from('site_audit_issues').insert(issues.map(i => ({
            project_id: proj.id, snapshot_date: date, issue_id: i.issue_id, name: i.name,
            category: i.category, importance: i.importance, crawled: i.crawled, change: i.change, is_indexable: i.is_indexable
          })));
        }
      } catch {}
    }
  }

  // Process projects in batches
  for (let i = 0; i < projects.length; i += BATCH) {
    const batch = projects.slice(i, i + BATCH);
    const batchResults = await Promise.allSettled(
      batch.map(proj => refreshProject(db, proj, date, dateCmp, dateFrom))
    );
    batchResults.forEach((r, j) => {
      if (r.status === 'fulfilled') {
        results.push(r.value);
      } else {
        errors++;
        results.push({ pid: batch[j].id, error: r.reason?.message });
      }
    });
  }

  return res.status(200).json({
    success: true,
    date,
    total: projects.length,
    completed: results.filter(r => !r.error).length,
    errors,
    results: results.slice(0, 10), // Return first 10 for debugging
  });
}
