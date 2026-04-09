import { createClient } from '@supabase/supabase-js';

const supabase = () => createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  const db = supabase();
  const { action, project_id, date, days } = req.query;

  try {
    if (action === 'projects') {
      return await getProjects(db, res);
    } else if (action === 'detail') {
      return await getDetail(db, res, project_id, date);
    } else if (action === 'history') {
      return await getHistory(db, res, project_id, days);
    } else {
      return res.status(400).json({ error: 'Unknown action. Use: projects, detail, history' });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function getProjects(db, res) {
  // Get all non-hidden projects
  const { data: projects, error: pErr } = await db
    .from('projects')
    .select('*')
    .eq('hidden', false)
    .order('project_name');
  if (pErr) throw pErr;

  // Get latest snapshot date
  const { data: latestRow } = await db
    .from('project_snapshots')
    .select('snapshot_date')
    .order('snapshot_date', { ascending: false })
    .limit(1);
  const latestDate = latestRow?.[0]?.snapshot_date;

  let snapshots = [];
  let rtKeywords = [];

  if (latestDate) {
    // Get all project snapshots for latest date
    const { data: snaps } = await db
      .from('project_snapshots')
      .select('*')
      .eq('snapshot_date', latestDate);
    snapshots = snaps || [];

    // Get RT keywords for grid cards (top keywords per project)
    const { data: rts } = await db
      .from('rank_tracker_keywords')
      .select('project_id,keyword,position,position_diff,volume,traffic,tags,best_position_kind,serp_features')
      .eq('snapshot_date', latestDate);
    rtKeywords = rts || [];
  }

  // Build snapshot map
  const snapMap = {};
  snapshots.forEach(s => { snapMap[s.project_id] = s; });

  // Build RT keywords map
  const rtMap = {};
  rtKeywords.forEach(k => {
    if (!rtMap[k.project_id]) rtMap[k.project_id] = [];
    rtMap[k.project_id].push(k);
  });

  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
  return res.status(200).json({
    projects,
    snapshots: snapMap,
    rtKeywords: rtMap,
    latestDate,
  });
}

async function getDetail(db, res, projectId, date) {
  if (!projectId) return res.status(400).json({ error: 'project_id required' });

  // If no date specified, get latest
  let snapshotDate = date;
  if (!snapshotDate) {
    const { data: latest } = await db
      .from('project_snapshots')
      .select('snapshot_date')
      .eq('project_id', projectId)
      .order('snapshot_date', { ascending: false })
      .limit(1);
    snapshotDate = latest?.[0]?.snapshot_date;
  }

  if (!snapshotDate) {
    return res.status(200).json({ empty: true, message: 'No data yet. Click Refresh to fetch from Ahrefs.' });
  }

  // Get project info
  const { data: proj } = await db.from('projects').select('*').eq('id', projectId).single();

  // Fetch all data tables in parallel
  const [snapshot, rankings, organic, pages, refs, comps, trafficHist, auditIssues, gscKw, gscPages, gscHist] = await Promise.all([
    db.from('project_snapshots').select('*').eq('project_id', projectId).eq('snapshot_date', snapshotDate).single(),
    db.from('rank_tracker_keywords').select('*').eq('project_id', projectId).eq('snapshot_date', snapshotDate),
    db.from('organic_keywords').select('*').eq('project_id', projectId).eq('snapshot_date', snapshotDate),
    db.from('top_pages').select('*').eq('project_id', projectId).eq('snapshot_date', snapshotDate).order('sum_traffic', { ascending: false }),
    db.from('referring_domains').select('*').eq('project_id', projectId).eq('snapshot_date', snapshotDate).order('domain_rating', { ascending: false }),
    db.from('organic_competitors').select('*').eq('project_id', projectId).eq('snapshot_date', snapshotDate).order('keywords_common', { ascending: false }),
    db.from('traffic_history').select('*').eq('project_id', projectId).eq('snapshot_date', snapshotDate).order('month_date'),
    db.from('site_audit_issues').select('*').eq('project_id', projectId).eq('snapshot_date', snapshotDate),
    db.from('gsc_keywords').select('*').eq('project_id', projectId).eq('snapshot_date', snapshotDate),
    db.from('gsc_pages').select('*').eq('project_id', projectId).eq('snapshot_date', snapshotDate),
    db.from('gsc_performance_history').select('*').eq('project_id', projectId).eq('snapshot_date', snapshotDate).order('week_date'),
  ]);

  const s = snapshot.data;

  // Shape data to match the existing this.detail format exactly
  const detail = {
    project: proj,
    rankings: rankings.data || [],
    organic: (organic.data || []).map(k => ({
      keyword: k.keyword, best_position: k.best_position, sum_traffic: k.sum_traffic,
      volume: k.volume, keyword_difficulty: k.keyword_difficulty, best_position_url: k.best_position_url,
      is_local: k.is_local, is_commercial: k.is_commercial, is_transactional: k.is_transactional, is_informational: k.is_informational,
    })),
    dr: s ? { domain_rating: parseFloat(s.domain_rating), ahrefs_rank: s.ahrefs_rank } : {},
    metrics: s ? { org_traffic: s.org_traffic, org_keywords: s.org_keywords, org_cost: s.org_cost } : {},
    bl: s ? { live: s.backlinks_live, all_time: s.backlinks_all_time, live_refdomains: s.refdomains_live, all_time_refdomains: s.refdomains_all_time } : {},
    history: (trafficHist.data || []).map(h => ({ date: h.month_date, org_traffic: h.org_traffic })),
    pages: pages.data || [],
    refdomains: (refs.data || []).map(r => ({
      domain: r.domain, domain_rating: parseFloat(r.domain_rating), links_to_target: r.links_to_target,
      dofollow_links: r.dofollow_links, traffic_domain: r.traffic_domain, first_seen: r.first_seen,
    })),
    competitors: (comps.data || []).map(c => ({
      competitor_domain: c.competitor_domain, keywords_common: c.keywords_common,
      traffic: c.traffic, share: parseFloat(c.share), domain_rating: parseFloat(c.domain_rating),
    })),
    audit: s?.audit_project_id ? { project_id: s.audit_project_id, health_score: s.health_score, urls_with_errors: s.audit_errors, urls_with_warnings: s.audit_warnings } : null,
    auditIssues: auditIssues.data || [],
    gscKeywords: gscKw.data || [],
    gscHistory: (gscHist.data || []).map(h => ({ date: h.week_date, clicks: h.clicks, impressions: h.impressions, ctr: parseFloat(h.ctr), position: parseFloat(h.position) })),
    gscPages: gscPages.data || [],
    snapshotDate,
  };

  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
  return res.status(200).json(detail);
}

async function getHistory(db, res, projectId, days = 30) {
  if (!projectId) return res.status(400).json({ error: 'project_id required' });

  const { data } = await db
    .from('project_snapshots')
    .select('snapshot_date,domain_rating,org_traffic,org_keywords,rt_ranked,rt_top3,rt_top10,health_index,aio_serps,aio_cited')
    .eq('project_id', projectId)
    .gte('snapshot_date', new Date(Date.now() - (days || 30) * 86400000).toISOString().split('T')[0])
    .order('snapshot_date');

  return res.status(200).json({ history: data || [] });
}
