-- Publication is confirmed online before a notification can be queued or sent.
CREATE TABLE public_releases (
  id text PRIMARY KEY,
  batch_key text NOT NULL UNIQUE,
  manifest_hash text NOT NULL,
  snapshot_hash text NOT NULL,
  cutoff_at timestamptz NOT NULL,
  base_url text NOT NULL,
  failed_sources jsonb NOT NULL DEFAULT '[]',
  deployment_version text,
  state text NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared','deployed','verified','failed','superseded')),
  verification jsonb,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX public_releases_active_origin ON public_releases(base_url) WHERE state = 'verified';
CREATE TABLE public_release_members (
  release_id text NOT NULL REFERENCES public_releases(id) ON DELETE CASCADE,
  subject_kind text NOT NULL CHECK (subject_kind IN ('selected','lb_event','report')),
  subject_id text NOT NULL,
  content_version text NOT NULL,
  content_hash text NOT NULL,
  probe_path text NOT NULL,
  probe_hash text NOT NULL,
  PRIMARY KEY(release_id,subject_kind,subject_id)
);
CREATE INDEX public_release_members_subject ON public_release_members(subject_kind,subject_id,release_id);

ALTER TABLE notify_targets DROP CONSTRAINT notify_targets_kind_check;
ALTER TABLE notify_targets ADD CONSTRAINT notify_targets_kind_check CHECK (kind IN ('feishu_webhook','feishu_chat','telegram','email','log'));
ALTER TABLE notify_targets ADD COLUMN settings jsonb NOT NULL DEFAULT '{}';
ALTER TABLE notify_targets ADD COLUMN preferences jsonb NOT NULL DEFAULT '{}';
ALTER TABLE notify_targets ADD COLUMN min_interval_ms integer NOT NULL DEFAULT 1500 CHECK (min_interval_ms BETWEEN 1000 AND 86400000);
ALTER TABLE notify_targets ADD COLUMN next_send_at timestamptz;
ALTER TABLE notify_targets ADD COLUMN paused_reason text;

ALTER TABLE deliveries DROP CONSTRAINT deliveries_status_check;
ALTER TABLE deliveries ADD CONSTRAINT deliveries_status_check CHECK (status IN ('pending','sending','sent','failed','unknown','skipped','cancelled'));
ALTER TABLE deliveries ADD COLUMN release_id text REFERENCES public_releases(id);
ALTER TABLE deliveries ADD COLUMN content_version text;
ALTER TABLE deliveries ADD COLUMN content_hash text;
ALTER TABLE deliveries ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE deliveries ADD COLUMN provider_message_id text;
ALTER TABLE deliveries ADD COLUMN receipt_id bigint REFERENCES receipts(id);
CREATE INDEX deliveries_dispatch_ready ON deliveries(next_attempt_at,id) WHERE status = 'pending' AND release_id IS NOT NULL;

-- Resend is a potentially paid service. Explicit operator budget configuration is required.
INSERT INTO budgets(service,per_minute,per_hour,per_day,note)
VALUES ('notify-email',0,0,0,'邮件投递默认暂停；配置预算后方可发送') ON CONFLICT(service) DO NOTHING;
