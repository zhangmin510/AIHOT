-- Scope admission is independent of importance/selection and never inferred for historical rows.
-- Decisions are append-only and bound to material revision and the named industry policy.
CREATE TABLE article_scope_decisions (
  id bigserial PRIMARY KEY,
  article_id text NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  input_revision integer NOT NULL CHECK (input_revision > 0),
  scope_key text NOT NULL,
  policy_version text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('PASS', 'BLOCK', 'UNKNOWN')),
  origin text NOT NULL CHECK (origin IN ('prefilter', 'agent-review', 'human-review')),
  reason text NOT NULL CHECK (length(trim(reason)) > 0),
  evidence_quote text,
  analysis_id bigint REFERENCES analyses(id) ON DELETE SET NULL,
  prompt_version text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX article_scope_current_idx ON article_scope_decisions
  (article_id, input_revision, scope_key, policy_version, id DESC);
