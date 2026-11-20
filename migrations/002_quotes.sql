create table if not exists agentdesk_quotes (
  symbol text not null, observed_at timestamptz not null,
  bid smallint not null check (bid between 0 and 100),
  ask smallint not null check (ask between bid and 100),
  title text not null, source text not null,
  primary key (symbol, observed_at)
);
alter table agentdesk_quotes enable row level security;
revoke all on agentdesk_quotes from anon, authenticated;
