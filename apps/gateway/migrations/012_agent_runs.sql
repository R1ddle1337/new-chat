CREATE TABLE IF NOT EXISTS agent_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id UUID NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  model_public_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  input_prompt TEXT NOT NULL,
  final_response TEXT,
  error_message TEXT,
  steps_used INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_user_created_at
  ON agent_runs (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_runs_thread_created_at
  ON agent_runs (thread_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_run_events (
  id BIGSERIAL PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id UUID NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  event_kind TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_run_events_run_id_id
  ON agent_run_events (run_id, id ASC);
