-- Evidence stays tied to the exact analysis/input revision that produced it. Public readers must
-- join publications.analysis_id and apply current visibility/licence rules before projecting it.
CREATE TABLE article_evidence (
  analysis_id bigint PRIMARY KEY REFERENCES analyses(id) ON DELETE CASCADE,
  article_id text NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  input_revision integer NOT NULL,
  evaluation_type text CHECK (evaluation_type IN ('new_benchmark', 'evaluation_result', 'eval_method', 'eval_critique', 'safety_eval', 'agent_eval')),
  status text NOT NULL CHECK (status IN ('matched', 'needs_review')),
  payload jsonb NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX article_evidence_article_idx ON article_evidence(article_id, input_revision DESC);
CREATE INDEX article_evidence_type_idx ON article_evidence(evaluation_type, article_id);

-- Paper identity is deliberately separate from material identity: HF discoveries, arXiv renderings
-- and revisions retain their own article/source ownership while referring to one logical paper.
CREATE TABLE papers (
  id text PRIMARY KEY,
  arxiv_id text NOT NULL UNIQUE,
  canonical_url text NOT NULL,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL
);
CREATE TABLE paper_versions (
  paper_id text NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  first_seen_at timestamptz NOT NULL,
  PRIMARY KEY(paper_id, version)
);
CREATE TABLE paper_materials (
  id bigserial PRIMARY KEY,
  paper_id text NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  article_id text NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  source_id text NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  source_url text NOT NULL,
  version integer CHECK (version > 0),
  material_revision integer NOT NULL,
  discovered_at timestamptz NOT NULL,
  UNIQUE NULLS NOT DISTINCT(paper_id, article_id, source_id, source_url, version)
);
CREATE INDEX paper_materials_article_idx ON paper_materials(article_id);
CREATE INDEX paper_materials_paper_idx ON paper_materials(paper_id, version DESC, article_id);
