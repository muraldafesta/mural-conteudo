-- Mural da Festa — Conteúdo do Instagram (fila de aprovação e publicação)
-- Projeto Supabase separado do app do Mural. Rode tudo de uma vez no SQL Editor.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Quem pode entrar no app
create table if not exists membros (
  email text primary key,
  nome  text not null,
  papel text not null default 'colaborador' check (papel in ('admin','colaborador')),
  criado_em timestamptz not null default now()
);

-- Uma linha por post decidido (aprovado/recusado). Os posts propostos ficam no
-- repositório (lotes/*.json); ao aprovar, o app grava aqui uma cópia do post.
create table if not exists decisoes (
  post_id        text primary key,
  lote           text not null,
  tipo           text not null check (tipo in ('reel','story','foto','carrossel')),
  titulo         text,
  legenda        text,
  midia          text[] not null,
  agendado_para  timestamptz not null,
  status         text not null check (status in ('aprovado','recusado','publicando','publicado','erro')),
  decidido_por   text,
  decidido_em    timestamptz not null default now(),
  ig_container   text,
  ig_media_id    text,
  ig_link        text,
  publicado_em   timestamptz,
  tentativas     int not null default 0,
  tocado_em      timestamptz,
  erro           text
);
create index if not exists decisoes_fila on decisoes (status, agendado_para);

-- Conexão com o Instagram (token). Ninguém lê pelo app; só as funções do servidor.
create table if not exists instagram_conexao (
  id            int primary key default 1 check (id = 1),
  api           text not null default 'ig',
  ig_user_id    text,
  usuario       text,
  token         text,
  renovado_em   timestamptz,
  atualizado_em timestamptz not null default now()
);

alter table membros           enable row level security;
alter table decisoes          enable row level security;
alter table instagram_conexao enable row level security;

create or replace function eh_membro() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from membros where email = lower(auth.jwt() ->> 'email'));
$$;
create or replace function eh_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from membros where email = lower(auth.jwt() ->> 'email') and papel = 'admin');
$$;

drop policy if exists membros_ler on membros;
create policy membros_ler on membros for select to authenticated using (eh_membro());
drop policy if exists membros_admin on membros;
create policy membros_admin on membros for all to authenticated using (eh_admin()) with check (eh_admin());

drop policy if exists decisoes_ler on decisoes;
create policy decisoes_ler on decisoes for select to authenticated using (eh_membro());
drop policy if exists decisoes_inserir on decisoes;
create policy decisoes_inserir on decisoes for insert to authenticated
  with check (eh_membro() and status in ('aprovado','recusado'));
-- Mudar de ideia: só enquanto ainda não foi para o Instagram
drop policy if exists decisoes_mudar on decisoes;
create policy decisoes_mudar on decisoes for update to authenticated
  using (eh_membro() and status in ('aprovado','recusado','erro'))
  with check (eh_membro() and status in ('aprovado','recusado'));
drop policy if exists decisoes_apagar on decisoes;
create policy decisoes_apagar on decisoes for delete to authenticated
  using (eh_membro() and status in ('aprovado','recusado','erro'));

-- Situação da conexão (sem expor o token)
create or replace function situacao_instagram() returns json
language sql stable security definer set search_path = public as $$
  select case when not eh_membro() then null else
    (select json_build_object('conectado', token is not null, 'usuario', usuario, 'renovado_em', renovado_em)
       from instagram_conexao where id = 1) end;
$$;
grant execute on function situacao_instagram() to authenticated;

-- Primeiro administrador
insert into membros (email, nome, papel) values ('muraldafesta@gmail.com', 'Luciano', 'admin')
on conflict (email) do nothing;

-- Robô: a cada 5 minutos publica o que já foi aprovado e chegou na hora
select cron.unschedule('publicar-instagram') where exists (select 1 from cron.job where jobname = 'publicar-instagram');
select cron.schedule('publicar-instagram', '*/5 * * * *', $$
  select net.http_post(
    url     := 'https://xjuuldfuutdydmuzigky.supabase.co/functions/v1/publicar',
    body    := '{}'::jsonb,
    headers := '{"Content-Type":"application/json"}'::jsonb,
    timeout_milliseconds := 120000);
$$);
