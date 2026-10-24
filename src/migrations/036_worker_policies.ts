export default /* sql */ `
CREATE TABLE worker_policies (
  client_id UUID PRIMARY KEY REFERENCES clients(id),
  mode TEXT NOT NULL DEFAULT 'manual' CHECK (mode IN ('manual','automatic','scheduled')),
  interval_minutes INT NOT NULL DEFAULT 1440 CHECK (interval_minutes BETWEEN 5 AND 525600),
  timezone TEXT NOT NULL DEFAULT 'UTC' CHECK (timezone = 'UTC'),
  windows JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(windows) = 'array'),
  next_due_at TIMESTAMPTZ,
  last_slot TEXT,
  revision INT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES operators(id),
  CHECK (mode <> 'manual' OR next_due_at IS NULL)
);
CREATE INDEX worker_policies_due_idx ON worker_policies(next_due_at) WHERE mode <> 'manual';
CREATE TABLE worker_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id),
  request_id UUID,
  trigger TEXT NOT NULL CHECK (trigger IN ('manual','automatic','scheduled')),
  policy_revision INT NOT NULL,
  operator_id UUID REFERENCES operators(id),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','error','interrupted')),
  networks JSONB NOT NULL DEFAULT '{}',
  error TEXT,
  UNIQUE (client_id, request_id)
);
CREATE UNIQUE INDEX worker_runs_one_running_idx ON worker_runs(client_id) WHERE status = 'running';
CREATE INDEX worker_runs_client_idx ON worker_runs(client_id, started_at DESC);
INSERT INTO usage_budgets (provider,label,unit,source)
VALUES ('worker','Worker interno','ejecuciones','metered') ON CONFLICT DO NOTHING;
`;
