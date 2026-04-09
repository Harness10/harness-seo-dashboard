-- ============================================================
-- Harness SEO Dashboard — Supabase Schema
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor)
-- ============================================================

-- 1. Projects (metadata)
CREATE TABLE IF NOT EXISTS projects (
  id BIGINT PRIMARY KEY,                    -- ahrefs project_id
  project_name TEXT NOT NULL,
  url TEXT NOT NULL,
  mode TEXT DEFAULT 'subdomains',
  keyword_count INT DEFAULT 0,
  region TEXT,
  hidden BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Daily project snapshots (summary metrics for grid view)
CREATE TABLE IF NOT EXISTS project_snapshots (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
  domain_rating NUMERIC(5,2),
  ahrefs_rank BIGINT,
  org_traffic BIGINT,
  org_keywords BIGINT,
  org_cost BIGINT,
  backlinks_live BIGINT,
  backlinks_all_time BIGINT,
  refdomains_live BIGINT,
  refdomains_all_time BIGINT,
  audit_project_id BIGINT,
  health_score INT,
  audit_errors INT,
  audit_warnings INT,
  rt_total INT DEFAULT 0,
  rt_ranked INT DEFAULT 0,
  rt_top3 INT DEFAULT 0,
  rt_top10 INT DEFAULT 0,
  rt_top20 INT DEFAULT 0,
  health_index INT DEFAULT 0,
  improved INT DEFAULT 0,
  declined INT DEFAULT 0,
  aio_serps INT DEFAULT 0,
  aio_cited INT DEFAULT 0,
  fetched_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(project_id, snapshot_date)
);

-- 3. Rank Tracker keywords
CREATE TABLE IF NOT EXISTS rank_tracker_keywords (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
  keyword TEXT NOT NULL,
  position INT,
  position_prev INT,
  position_diff INT,
  volume INT,
  traffic INT,
  traffic_diff INT,
  keyword_difficulty INT,
  url TEXT,
  tags TEXT[],
  location TEXT,
  best_position_kind TEXT,
  serp_features TEXT[],
  is_informational BOOLEAN DEFAULT FALSE,
  is_transactional BOOLEAN DEFAULT FALSE,
  is_commercial BOOLEAN DEFAULT FALSE,
  is_local BOOLEAN DEFAULT FALSE
);

-- 4. Organic keywords (Site Explorer)
CREATE TABLE IF NOT EXISTS organic_keywords (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
  keyword TEXT NOT NULL,
  best_position INT,
  sum_traffic INT,
  volume INT,
  keyword_difficulty INT,
  best_position_url TEXT,
  is_local BOOLEAN DEFAULT FALSE,
  is_commercial BOOLEAN DEFAULT FALSE,
  is_transactional BOOLEAN DEFAULT FALSE,
  is_informational BOOLEAN DEFAULT FALSE
);

-- 5. Top pages
CREATE TABLE IF NOT EXISTS top_pages (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
  url TEXT NOT NULL,
  sum_traffic BIGINT,
  value BIGINT,
  keywords INT,
  top_keyword TEXT,
  top_keyword_best_position INT
);

-- 6. Referring domains
CREATE TABLE IF NOT EXISTS referring_domains (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
  domain TEXT NOT NULL,
  domain_rating NUMERIC(5,2),
  links_to_target INT,
  dofollow_links INT,
  traffic_domain BIGINT,
  first_seen TEXT
);

-- 7. Organic competitors
CREATE TABLE IF NOT EXISTS organic_competitors (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
  competitor_domain TEXT NOT NULL,
  keywords_common INT,
  traffic BIGINT,
  share NUMERIC(8,6),
  domain_rating NUMERIC(5,2)
);

-- 8. Traffic history (12-month trend)
CREATE TABLE IF NOT EXISTS traffic_history (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
  month_date DATE NOT NULL,
  org_traffic BIGINT
);

-- 9. Site audit issues
CREATE TABLE IF NOT EXISTS site_audit_issues (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
  issue_id TEXT,
  name TEXT,
  category TEXT,
  importance TEXT,
  crawled INT DEFAULT 0,
  change INT,
  is_indexable BOOLEAN DEFAULT FALSE
);

-- 10. GSC keywords
CREATE TABLE IF NOT EXISTS gsc_keywords (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
  keyword TEXT NOT NULL,
  clicks INT DEFAULT 0,
  impressions INT DEFAULT 0,
  ctr NUMERIC(6,3),
  position NUMERIC(6,2),
  top_url TEXT
);

-- 11. GSC pages
CREATE TABLE IF NOT EXISTS gsc_pages (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
  url TEXT NOT NULL,
  clicks INT DEFAULT 0,
  impressions INT DEFAULT 0,
  ctr NUMERIC(6,3),
  position NUMERIC(6,2)
);

-- 12. GSC performance history (weekly trend)
CREATE TABLE IF NOT EXISTS gsc_performance_history (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
  week_date DATE NOT NULL,
  clicks INT DEFAULT 0,
  impressions INT DEFAULT 0,
  ctr NUMERIC(6,3),
  position NUMERIC(6,2)
);

-- ============================================================
-- INDEXES (critical for query performance)
-- ============================================================

CREATE INDEX idx_snapshots_date ON project_snapshots(snapshot_date DESC, project_id);
CREATE INDEX idx_snapshots_project ON project_snapshots(project_id, snapshot_date DESC);
CREATE INDEX idx_rtk_project_date ON rank_tracker_keywords(project_id, snapshot_date DESC);
CREATE INDEX idx_org_project_date ON organic_keywords(project_id, snapshot_date DESC);
CREATE INDEX idx_pages_project_date ON top_pages(project_id, snapshot_date DESC);
CREATE INDEX idx_refs_project_date ON referring_domains(project_id, snapshot_date DESC);
CREATE INDEX idx_comps_project_date ON organic_competitors(project_id, snapshot_date DESC);
CREATE INDEX idx_traffic_project_date ON traffic_history(project_id, snapshot_date DESC);
CREATE INDEX idx_audit_project_date ON site_audit_issues(project_id, snapshot_date DESC);
CREATE INDEX idx_gsc_kw_project_date ON gsc_keywords(project_id, snapshot_date DESC);
CREATE INDEX idx_gsc_pages_project_date ON gsc_pages(project_id, snapshot_date DESC);
CREATE INDEX idx_gsc_hist_project_date ON gsc_performance_history(project_id, snapshot_date DESC);

-- ============================================================
-- DONE! Next: seed the projects table with region data,
-- then deploy the cron job to start populating daily snapshots.
-- ============================================================
