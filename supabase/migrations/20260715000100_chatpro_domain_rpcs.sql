-- Compound domain writes.  These functions run as SECURITY INVOKER so RLS is
-- still the authority for non-server callers; the API uses the server role.
create or replace function public.chatpro_require_workspace(p_workspace_id text)
returns void language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if p_workspace_id is null or btrim(p_workspace_id) = '' then
    raise exception using errcode = '22023', message = 'workspace_id is required';
  end if;
end $$;

create or replace function public.chatpro_create_contact(p_workspace_id text, p_contact jsonb, p_tag_ids text[] default '{}')
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_id text := coalesce(p_contact->>'id', gen_random_uuid()::text); v_now timestamptz := now(); v_row contacts%rowtype; v_tag text;
begin
  perform chatpro_require_workspace(p_workspace_id);
  foreach v_tag in array coalesce(p_tag_ids, '{}') loop
    if not exists (select 1 from tags where workspace_id=p_workspace_id and id=v_tag) then raise exception using errcode='P0001', message='tag not found in workspace'; end if;
  end loop;
  insert into contacts(id,workspace_id,display_name,phone_number,email,company,created_at,updated_at)
  values(v_id,p_workspace_id,p_contact->>'displayName',p_contact->>'phoneNumber',p_contact->>'email',p_contact->>'company',v_now,v_now)
  returning * into v_row;
  foreach v_tag in array coalesce(p_tag_ids, '{}') loop insert into contact_tags(workspace_id,contact_id,tag_id,created_at) values(p_workspace_id,v_id,v_tag,v_now); end loop;
  return to_jsonb(v_row);
exception when unique_violation then raise exception using errcode='23505', message='contact phone number already exists in workspace';
end $$;

create or replace function public.chatpro_update_contact(p_workspace_id text, p_contact_id text, p_contact jsonb, p_tag_ids text[] default null)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_row contacts%rowtype; v_tag text;
begin
  perform chatpro_require_workspace(p_workspace_id);
  select * into v_row from contacts where workspace_id=p_workspace_id and id=p_contact_id for update;
  if not found then raise exception using errcode='P0002', message='contact not found in workspace'; end if;
  if p_tag_ids is not null then foreach v_tag in array p_tag_ids loop if not exists(select 1 from tags where workspace_id=p_workspace_id and id=v_tag) then raise exception using errcode='P0001',message='tag not found in workspace'; end if; end loop; end if;
  update contacts set display_name=coalesce(p_contact->>'displayName',v_row.display_name), phone_number=coalesce(p_contact->>'phoneNumber',v_row.phone_number), email=case when p_contact ? 'email' then p_contact->>'email' else v_row.email end, company=case when p_contact ? 'company' then p_contact->>'company' else v_row.company end, updated_at=now() where workspace_id=p_workspace_id and id=p_contact_id returning * into v_row;
  if p_tag_ids is not null then delete from contact_tags where workspace_id=p_workspace_id and contact_id=p_contact_id; foreach v_tag in array p_tag_ids loop insert into contact_tags(workspace_id,contact_id,tag_id,created_at) values(p_workspace_id,p_contact_id,v_tag,now()); end loop; end if;
  return to_jsonb(v_row);
exception when unique_violation then raise exception using errcode='23505', message='contact phone number already exists in workspace';
end $$;

create or replace function public.chatpro_initialize_pipeline(p_workspace_id text, p_name text default 'Pipeline padrão')
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_pipeline pipelines%rowtype; v_stage text; v_position integer := 0;
begin
  perform chatpro_require_workspace(p_workspace_id);
  if exists(select 1 from pipelines where workspace_id=p_workspace_id) then raise exception using errcode='23505',message='workspace already has a pipeline'; end if;
  insert into pipelines(id,workspace_id,name,created_at,updated_at) values(gen_random_uuid()::text,p_workspace_id,p_name,now(),now()) returning * into v_pipeline;
  foreach v_stage in array array['Novo','Em atendimento','Aguardando cliente','Proposta enviada','Concluído'] loop insert into stages(id,workspace_id,pipeline_id,name,position,created_at,updated_at) values(gen_random_uuid()::text,p_workspace_id,v_pipeline.id,v_stage,v_position,now(),now()); v_position:=v_position+1; end loop;
  return jsonb_build_object('pipeline',to_jsonb(v_pipeline),'stages',(select coalesce(jsonb_agg(to_jsonb(s) order by position),'[]'::jsonb) from stages s where workspace_id=p_workspace_id and pipeline_id=v_pipeline.id));
end $$;

create or replace function public.chatpro_move_lead(p_workspace_id text, p_lead_id text, p_stage_id text)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_lead leads%rowtype; v_from text;
begin
  perform chatpro_require_workspace(p_workspace_id);
  select * into v_lead from leads where workspace_id=p_workspace_id and id=p_lead_id for update; if not found then raise exception using errcode='P0002',message='lead not found in workspace'; end if;
  if not exists(select 1 from stages where workspace_id=p_workspace_id and id=p_stage_id) then raise exception using errcode='P0001',message='stage not found in workspace'; end if;
  v_from:=v_lead.stage_id; update leads set stage_id=p_stage_id,updated_at=now() where workspace_id=p_workspace_id and id=p_lead_id returning * into v_lead;
  insert into activities(id,workspace_id,lead_id,type,details_json,occurred_at,created_at,updated_at) values(gen_random_uuid()::text,p_workspace_id,p_lead_id,'lead.moved',jsonb_build_object('fromStageId',v_from,'toStageId',p_stage_id),now(),now(),now()); return to_jsonb(v_lead);
end $$;

create or replace function public.chatpro_set_lead_tag(p_workspace_id text, p_lead_id text, p_tag_id text, p_add boolean)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  perform chatpro_require_workspace(p_workspace_id);
  if not exists(select 1 from leads where workspace_id=p_workspace_id and id=p_lead_id) or not exists(select 1 from tags where workspace_id=p_workspace_id and id=p_tag_id) then raise exception using errcode='P0001',message='lead or tag not found in workspace'; end if;
  if p_add then insert into lead_tags(workspace_id,lead_id,tag_id,created_at) values(p_workspace_id,p_lead_id,p_tag_id,now()) on conflict do nothing; else delete from lead_tags where workspace_id=p_workspace_id and lead_id=p_lead_id and tag_id=p_tag_id; end if;
  return jsonb_build_object('leadId',p_lead_id,'tagId',p_tag_id);
end $$;

create or replace function public.chatpro_add_note(p_workspace_id text, p_lead_id text, p_body text)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_note lead_notes%rowtype;
begin
  perform chatpro_require_workspace(p_workspace_id); if not exists(select 1 from leads where workspace_id=p_workspace_id and id=p_lead_id) then raise exception using errcode='P0002',message='lead not found in workspace'; end if;
  insert into lead_notes(id,workspace_id,lead_id,body,created_at,updated_at) values(gen_random_uuid()::text,p_workspace_id,p_lead_id,p_body,now(),now()) returning * into v_note;
  insert into activities(id,workspace_id,lead_id,type,details_json,occurred_at,created_at,updated_at) values(gen_random_uuid()::text,p_workspace_id,p_lead_id,'note.added',jsonb_build_object('noteId',v_note.id),now(),now(),now()); return to_jsonb(v_note);
end $$;

create or replace function public.chatpro_record_opt_out(p_workspace_id text, p_contact_id text, p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_row opt_out_history%rowtype;
begin perform chatpro_require_workspace(p_workspace_id); if not exists(select 1 from contacts where workspace_id=p_workspace_id and id=p_contact_id) then raise exception using errcode='P0002',message='contact not found in workspace'; end if; insert into opt_out_history(id,workspace_id,contact_id,reason,source,occurred_at,created_at,updated_at) values(gen_random_uuid()::text,p_workspace_id,p_contact_id,p_payload->>'reason',coalesce(p_payload->>'source','manual'),coalesce((p_payload->>'occurredAt')::timestamptz,now()),now(),now()) returning * into v_row; return to_jsonb(v_row); end $$;

create or replace function public.chatpro_remove_opt_out(p_workspace_id text, p_contact_id text)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
begin perform chatpro_require_workspace(p_workspace_id); if not exists(select 1 from contacts where workspace_id=p_workspace_id and id=p_contact_id) then raise exception using errcode='P0002',message='contact not found in workspace'; end if; delete from opt_out_history where workspace_id=p_workspace_id and contact_id=p_contact_id; return jsonb_build_object('contactId',p_contact_id,'optedOut',false); end $$;

create or replace function public.chatpro_save_campaign(p_workspace_id text, p_campaign_id text, p_payload jsonb, p_contact_ids text[] default null)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_row campaigns%rowtype; v_contact text;
begin
  perform chatpro_require_workspace(p_workspace_id); if p_payload ? 'templateId' and p_payload->>'templateId' is not null and not exists(select 1 from templates where workspace_id=p_workspace_id and id=p_payload->>'templateId') then raise exception using errcode='P0001',message='template not found in workspace'; end if;
  if p_campaign_id is null then insert into campaigns(id,workspace_id,name,template_id,status,scheduled_at,created_at,updated_at) values(gen_random_uuid()::text,p_workspace_id,p_payload->>'name',p_payload->>'templateId','draft',(p_payload->>'scheduledAt')::timestamptz,now(),now()) returning * into v_row; else select * into v_row from campaigns where workspace_id=p_workspace_id and id=p_campaign_id for update; if not found then raise exception using errcode='P0002',message='campaign not found in workspace'; end if; if v_row.status='cancelled' then raise exception using errcode='P0001',message='cancelled campaign cannot be edited'; end if; update campaigns set name=coalesce(p_payload->>'name',v_row.name),template_id=case when p_payload ? 'templateId' then p_payload->>'templateId' else v_row.template_id end,scheduled_at=case when p_payload ? 'scheduledAt' then (p_payload->>'scheduledAt')::timestamptz else v_row.scheduled_at end,updated_at=now() where workspace_id=p_workspace_id and id=p_campaign_id returning * into v_row; end if;
  if p_contact_ids is not null then foreach v_contact in array p_contact_ids loop if not exists(select 1 from contacts where workspace_id=p_workspace_id and id=v_contact) then raise exception using errcode='P0001',message='contact not found in workspace'; end if; end loop; delete from campaign_recipients where workspace_id=p_workspace_id and campaign_id=v_row.id; foreach v_contact in array p_contact_ids loop insert into campaign_recipients(workspace_id,campaign_id,contact_id,created_at) values(p_workspace_id,v_row.id,v_contact,now()); end loop; end if; return to_jsonb(v_row);
end $$;

create or replace function public.chatpro_prepare_campaign(p_workspace_id text, p_campaign_id text)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_campaign campaigns%rowtype; v_recipients integer; v_excluded integer; v_eligible integer; v_problems jsonb := '[]'::jsonb;
begin perform chatpro_require_workspace(p_workspace_id); select * into v_campaign from campaigns where workspace_id=p_workspace_id and id=p_campaign_id for update; if not found then raise exception using errcode='P0002',message='campaign not found in workspace'; end if; select count(*) into v_recipients from campaign_recipients where workspace_id=p_workspace_id and campaign_id=p_campaign_id; if v_campaign.template_id is null then v_problems:=v_problems||jsonb_build_array('templateId is required'); elsif not exists(select 1 from templates where workspace_id=p_workspace_id and id=v_campaign.template_id and active and btrim(content)<>'') then v_problems:=v_problems||jsonb_build_array('template is inactive or empty'); end if; if v_recipients=0 then v_problems:=v_problems||jsonb_build_array('at least one recipient is required'); end if; select count(*) filter(where exists(select 1 from opt_out_history o where o.workspace_id=r.workspace_id and o.contact_id=r.contact_id)),count(*) filter(where not exists(select 1 from opt_out_history o where o.workspace_id=r.workspace_id and o.contact_id=r.contact_id)) into v_excluded,v_eligible from campaign_recipients r where r.workspace_id=p_workspace_id and r.campaign_id=p_campaign_id; if v_eligible=0 then v_problems:=v_problems||jsonb_build_array('no eligible recipients'); end if; update campaigns set status=case when jsonb_array_length(v_problems)=0 then 'ready' else 'blocked' end,updated_at=now() where workspace_id=p_workspace_id and id=p_campaign_id returning * into v_campaign; return jsonb_build_object('campaign',to_jsonb(v_campaign),'eligibleRecipients',v_eligible,'excludedOptOut',v_excluded,'problems',v_problems); end $$;

create or replace function public.chatpro_save_settings(p_workspace_id text, p_settings jsonb)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_row workspace_settings%rowtype;
begin perform chatpro_require_workspace(p_workspace_id); insert into workspace_settings(id,workspace_id,settings_json,created_at,updated_at) values(gen_random_uuid()::text,p_workspace_id,p_settings,now(),now()) on conflict(workspace_id) do update set settings_json=workspace_settings.settings_json || excluded.settings_json,updated_at=now() returning * into v_row; return jsonb_build_object('id',v_row.id,'workspaceId',v_row.workspace_id,'settings',v_row.settings_json,'createdAt',v_row.created_at,'updatedAt',v_row.updated_at); end $$;

revoke all on function public.chatpro_require_workspace(text) from public;
revoke all on function public.chatpro_create_contact(text,jsonb,text[]) from public;
revoke all on function public.chatpro_update_contact(text,text,jsonb,text[]) from public;
revoke all on function public.chatpro_initialize_pipeline(text,text) from public;
revoke all on function public.chatpro_move_lead(text,text,text) from public;
revoke all on function public.chatpro_set_lead_tag(text,text,text,boolean) from public;
revoke all on function public.chatpro_add_note(text,text,text) from public;
revoke all on function public.chatpro_record_opt_out(text,text,jsonb) from public;
revoke all on function public.chatpro_remove_opt_out(text,text) from public;
revoke all on function public.chatpro_save_campaign(text,text,jsonb,text[]) from public;
revoke all on function public.chatpro_prepare_campaign(text,text) from public;
revoke all on function public.chatpro_save_settings(text,jsonb) from public;
grant execute on function public.chatpro_create_contact(text,jsonb,text[]) to service_role;
grant execute on function public.chatpro_update_contact(text,text,jsonb,text[]) to service_role;
grant execute on function public.chatpro_initialize_pipeline(text,text) to service_role;
grant execute on function public.chatpro_move_lead(text,text,text) to service_role;
grant execute on function public.chatpro_set_lead_tag(text,text,text,boolean) to service_role;
grant execute on function public.chatpro_add_note(text,text,text) to service_role;
grant execute on function public.chatpro_record_opt_out(text,text,jsonb) to service_role;
grant execute on function public.chatpro_remove_opt_out(text,text) to service_role;
grant execute on function public.chatpro_save_campaign(text,text,jsonb,text[]) to service_role;
grant execute on function public.chatpro_prepare_campaign(text,text) to service_role;
grant execute on function public.chatpro_save_settings(text,jsonb) to service_role;

-- Guard deletes that SQLite already treats as domain operations rather than
-- relying on cascading foreign keys to silently discard related records.
create or replace function public.chatpro_delete_tag(p_workspace_id text, p_tag_id text)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_row tags%rowtype; v_links integer;
begin
  perform chatpro_require_workspace(p_workspace_id);
  select * into v_row from tags where workspace_id=p_workspace_id and id=p_tag_id for update;
  if not found then raise exception using errcode='P0002',message='tag not found in workspace'; end if;
  select (select count(*) from contact_tags where workspace_id=p_workspace_id and tag_id=p_tag_id) + (select count(*) from lead_tags where workspace_id=p_workspace_id and tag_id=p_tag_id) into v_links;
  if v_links > 0 then raise exception using errcode='P0001',message='tag cannot be deleted while it has links'; end if;
  delete from tags where workspace_id=p_workspace_id and id=p_tag_id; return to_jsonb(v_row);
end $$;

create or replace function public.chatpro_delete_pipeline(p_workspace_id text, p_pipeline_id text)
returns void language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  perform chatpro_require_workspace(p_workspace_id);
  if not exists(select 1 from pipelines where workspace_id=p_workspace_id and id=p_pipeline_id) then raise exception using errcode='P0002',message='pipeline not found in workspace'; end if;
  if exists(select 1 from leads l join stages s on s.workspace_id=l.workspace_id and s.id=l.stage_id where s.workspace_id=p_workspace_id and s.pipeline_id=p_pipeline_id) then raise exception using errcode='P0001',message='pipeline has linked leads'; end if;
  delete from pipelines where workspace_id=p_workspace_id and id=p_pipeline_id;
end $$;

create or replace function public.chatpro_delete_stage(p_workspace_id text, p_stage_id text)
returns void language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  perform chatpro_require_workspace(p_workspace_id);
  if not exists(select 1 from stages where workspace_id=p_workspace_id and id=p_stage_id) then raise exception using errcode='P0002',message='stage not found in workspace'; end if;
  if exists(select 1 from leads where workspace_id=p_workspace_id and stage_id=p_stage_id) then raise exception using errcode='P0001',message='stage has linked leads'; end if;
  delete from stages where workspace_id=p_workspace_id and id=p_stage_id;
end $$;

revoke all on function public.chatpro_delete_tag(text,text) from public;
revoke all on function public.chatpro_delete_pipeline(text,text) from public;
revoke all on function public.chatpro_delete_stage(text,text) from public;
grant execute on function public.chatpro_delete_tag(text,text) to service_role;
grant execute on function public.chatpro_delete_pipeline(text,text) to service_role;
grant execute on function public.chatpro_delete_stage(text,text) to service_role;
