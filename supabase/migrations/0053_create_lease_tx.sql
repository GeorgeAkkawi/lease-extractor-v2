-- 0053 — atomic lease creation (money-path hardening C3).
--
-- createLeaseFromExtraction used to insert the lease, then its rent escalations,
-- then renewal options, then abatements as SEPARATE REST calls. If any one failed
-- (network blip, tab closed mid-import) the lease was left half-built — e.g. a lease
-- with no rent steps, or missing its free-rent windows — and the missing rows can't
-- be re-derived, so the tenant silently billed wrong. This function does all of it in
-- ONE transaction (a plpgsql function body is atomic): either the whole lease lands,
-- or nothing does.
--
-- SECURITY INVOKER on purpose: it runs as the calling user, so the existing owner_id
-- RLS policies (and the 0052 aal2 policy) still apply — owner_id is forced to
-- auth.uid() here, never trusted from the payload. The computation (which rows, what
-- amounts) stays in JS where it's unit-tested; this function only writes what it's given.

create or replace function public.create_lease_tx(
  p_lease jsonb,
  p_escalations jsonb default '[]'::jsonb,
  p_renewals jsonb default '[]'::jsonb,
  p_abatements jsonb default '[]'::jsonb
) returns uuid
  language plpgsql
  security invoker
  set search_path to public
as $$
declare
  v_owner uuid := auth.uid();
  v_lease public.leases;
  v_lease_id uuid;
  v_esc public.rent_escalations;
  v_ren public.renewal_options;
  v_ab  public.rent_abatements;
  el jsonb;
begin
  if v_owner is null then
    raise exception 'not authenticated';
  end if;

  -- Lease row: map the payload onto the columns, force owner_id, and fill the
  -- NOT NULL columns the payload may omit (so table defaults are honored).
  v_lease := jsonb_populate_record(null::public.leases, p_lease);
  v_lease.owner_id          := v_owner;
  v_lease.id                := coalesce(v_lease.id, gen_random_uuid());
  v_lease.created_at        := coalesce(v_lease.created_at, now());
  v_lease.updated_at        := coalesce(v_lease.updated_at, now());
  v_lease.source            := coalesce(v_lease.source, 'ai_extracted');
  v_lease.extraction_status := coalesce(v_lease.extraction_status, 'reviewed');
  v_lease.roof_responsible  := coalesce(v_lease.roof_responsible, false);
  v_lease.no_renewal_option := coalesce(v_lease.no_renewal_option, false);
  v_lease.is_active         := coalesce(v_lease.is_active, true);
  insert into public.leases values (v_lease.*) returning id into v_lease_id;

  for el in select * from jsonb_array_elements(coalesce(p_escalations, '[]'::jsonb)) loop
    v_esc := jsonb_populate_record(null::public.rent_escalations, el);
    v_esc.owner_id        := v_owner;
    v_esc.lease_id        := v_lease_id;
    v_esc.id              := coalesce(v_esc.id, gen_random_uuid());
    v_esc.created_at      := coalesce(v_esc.created_at, now());
    v_esc.updated_at      := coalesce(v_esc.updated_at, now());
    v_esc.escalation_type := coalesce(v_esc.escalation_type, 'manual');
    v_esc.status          := coalesce(v_esc.status, 'scheduled');
    insert into public.rent_escalations values (v_esc.*);
  end loop;

  for el in select * from jsonb_array_elements(coalesce(p_renewals, '[]'::jsonb)) loop
    v_ren := jsonb_populate_record(null::public.renewal_options, el);
    v_ren.owner_id   := v_owner;
    v_ren.lease_id   := v_lease_id;
    v_ren.id         := coalesce(v_ren.id, gen_random_uuid());
    v_ren.created_at := coalesce(v_ren.created_at, now());
    v_ren.updated_at := coalesce(v_ren.updated_at, now());
    v_ren.status     := coalesce(v_ren.status, 'pending');
    insert into public.renewal_options values (v_ren.*);
  end loop;

  for el in select * from jsonb_array_elements(coalesce(p_abatements, '[]'::jsonb)) loop
    v_ab := jsonb_populate_record(null::public.rent_abatements, el);
    v_ab.owner_id   := v_owner;
    v_ab.lease_id   := v_lease_id;
    v_ab.id         := coalesce(v_ab.id, gen_random_uuid());
    v_ab.created_at := coalesce(v_ab.created_at, now());
    v_ab.updated_at := coalesce(v_ab.updated_at, now());
    v_ab.kind       := coalesce(v_ab.kind, 'free');
    insert into public.rent_abatements values (v_ab.*);
  end loop;

  return v_lease_id;
end;
$$;

revoke all on function public.create_lease_tx(jsonb, jsonb, jsonb, jsonb) from public;
grant execute on function public.create_lease_tx(jsonb, jsonb, jsonb, jsonb) to authenticated;
