-- Explicit permissions are separate from the ability to fetch upstream data internally.
CREATE TABLE lb_source_policies (
  source_key text PRIMARY KEY,
  public_rows boolean NOT NULL DEFAULT false,
  public_derived boolean NOT NULL DEFAULT false,
  public_events boolean NOT NULL DEFAULT false,
  license_name text NOT NULL,
  evidence_url text,
  attribution text NOT NULL DEFAULT '',
  reviewed_at timestamptz,
  expected_interval_hours integer NOT NULL DEFAULT 6 CHECK (expected_interval_hours > 0),
  stale_after_hours integer NOT NULL DEFAULT 24 CHECK (stale_after_hours >= expected_interval_hours),
  max_published_age_hours integer CHECK (max_published_age_hours > 0),
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT (public_rows OR public_derived OR public_events) OR (evidence_url IS NOT NULL AND reviewed_at IS NOT NULL AND attribution <> ''))
);

CREATE TABLE lb_source_checks (
  source_key text PRIMARY KEY,
  last_attempt_at timestamptz NOT NULL,
  last_success_at timestamptz,
  upstream_published_at timestamptz,
  last_attempt_ok boolean NOT NULL,
  error text
);

ALTER TABLE lb_aliases ADD COLUMN review_status text NOT NULL DEFAULT 'unreviewed' CHECK (review_status IN ('unreviewed', 'confirmed'));
ALTER TABLE lb_aliases ADD COLUMN reviewed_at timestamptz;
ALTER TABLE lb_aliases ADD COLUMN reviewed_by text;
CREATE TABLE lb_alias_reviews (
  id text PRIMARY KEY,
  source_key text NOT NULL,
  alias text NOT NULL,
  previous_model_id text REFERENCES lb_models(id),
  model_id text NOT NULL REFERENCES lb_models(id),
  reviewed_by text NOT NULL,
  reason text NOT NULL,
  reviewed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE lb_events (
  id text PRIMARY KEY,
  event_key text NOT NULL UNIQUE,
  source_key text NOT NULL,
  type text NOT NULL CHECK (type IN ('new_leader', 'top10_entry', 'new_board', 'methodology_change')),
  metric_key text,
  configuration_key text,
  model_id text REFERENCES lb_models(id),
  previous_snapshot_id text NOT NULL REFERENCES lb_snapshots(id) ON DELETE CASCADE,
  snapshot_id text NOT NULL REFERENCES lb_snapshots(id) ON DELETE CASCADE,
  protocol text NOT NULL,
  previous_protocol text NOT NULL,
  state text NOT NULL CHECK (state IN ('comparable', 'observation')),
  occurred_at timestamptz NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  time_basis text NOT NULL CHECK (time_basis IN ('upstream_publication', 'first_observed')),
  payload jsonb NOT NULL,
  withdrawn_at timestamptz
);
CREATE INDEX lb_events_public_order ON lb_events (occurred_at DESC, id DESC) WHERE withdrawn_at IS NULL;
CREATE INDEX lb_events_source_order ON lb_events (source_key, occurred_at DESC);
