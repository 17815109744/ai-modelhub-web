-- Run in Supabase SQL editor after applying Prisma migrations.
-- This enables pgvector, RLS, and tenant-scoped policies.

create extension if not exists pgcrypto;
create extension if not exists vector;

create or replace function public.is_org_member(target_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organization_members om
    where om."orgId" = target_org_id
      and om."userId" = auth.uid()
  );
$$;

create or replace function public.is_org_admin(target_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organization_members om
    where om."orgId" = target_org_id
      and om."userId" = auth.uid()
      and om.role in ('owner', 'admin')
  );
$$;

alter table public.profiles enable row level security;
alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.api_credentials enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.model_requests enable row level security;
alter table public.usage_records enable row level security;
alter table public.billing_orders enable row level security;
alter table public.organization_settings enable row level security;
alter table public.prompt_templates enable row level security;
alter table public.knowledge_bases enable row level security;
alter table public.documents enable row level security;
alter table public.document_chunks enable row level security;
alter table public.batch_jobs enable row level security;
alter table public.batch_job_items enable row level security;
alter table public.audit_logs enable row level security;

create policy "profiles_select_self"
on public.profiles for select
using (id = auth.uid());

create policy "profiles_update_self"
on public.profiles for update
using (id = auth.uid())
with check (id = auth.uid());

create policy "organizations_member_select"
on public.organizations for select
using (public.is_org_member(id));

create policy "organization_members_member_select"
on public.organization_members for select
using (public.is_org_member("orgId"));

create policy "organization_members_admin_write"
on public.organization_members for all
using (public.is_org_admin("orgId"))
with check (public.is_org_admin("orgId"));

create policy "conversations_member_all"
on public.conversations for all
using (public.is_org_member("orgId"))
with check (public.is_org_member("orgId"));

create policy "messages_member_all"
on public.messages for all
using (
  exists (
    select 1 from public.conversations c
    where c.id = "conversationId"
      and public.is_org_member(c."orgId")
  )
)
with check (
  exists (
    select 1 from public.conversations c
    where c.id = "conversationId"
      and public.is_org_member(c."orgId")
  )
);

create policy "model_requests_member_select"
on public.model_requests for select
using (public.is_org_member("orgId"));

create policy "usage_records_member_select"
on public.usage_records for select
using (public.is_org_member("orgId"));

create policy "billing_orders_admin_select"
on public.billing_orders for select
using (public.is_org_admin("orgId"));

create policy "organization_settings_member_all"
on public.organization_settings for all
using (public.is_org_member("orgId"))
with check (public.is_org_member("orgId"));

create policy "prompt_templates_member_all"
on public.prompt_templates for all
using ("orgId" is null or public.is_org_member("orgId"))
with check ("orgId" is null or public.is_org_member("orgId"));

create policy "knowledge_bases_member_all"
on public.knowledge_bases for all
using (public.is_org_member("orgId"))
with check (public.is_org_member("orgId"));

create policy "documents_member_all"
on public.documents for all
using (public.is_org_member("orgId"))
with check (public.is_org_member("orgId"));

create policy "document_chunks_member_select"
on public.document_chunks for select
using (public.is_org_member("orgId"));

create policy "batch_jobs_member_all"
on public.batch_jobs for all
using (public.is_org_member("orgId"))
with check (public.is_org_member("orgId"));

create policy "batch_job_items_member_select"
on public.batch_job_items for select
using (
  exists (
    select 1 from public.batch_jobs j
    where j.id = "jobId"
      and public.is_org_member(j."orgId")
  )
);

create policy "audit_logs_admin_select"
on public.audit_logs for select
using ("orgId" is null or public.is_org_admin("orgId"));

-- api_credentials intentionally has no user-facing policies.
-- Access it only from the backend with the Supabase service role or direct DB credentials.
revoke all on public.api_credentials from anon, authenticated;
