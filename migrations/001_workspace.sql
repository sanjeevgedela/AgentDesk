-- One aggregate per owner. Each domain collection resides in the JSONB document;
-- SELECT FOR UPDATE serializes mutations of portfolios and budget reservations.
create table if not exists agentdesk_workspace (
  owner text primary key,
  state jsonb not null,
  updated_at timestamptz not null default now()
);
alter table agentdesk_workspace enable row level security;
revoke all on agentdesk_workspace from anon, authenticated;
