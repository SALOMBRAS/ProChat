-- Atomic, workspace-scoped identity resolution.  This migration is intentionally
-- additive: 013 may already be applied and no existing contact is merged here.
CREATE OR REPLACE FUNCTION public.chatpro_resolve_contact_identity(
  p_workspace_id text,
  p_phone_number text,
  p_display_name text,
  p_identifiers jsonb,
  p_source text
) RETURNS TABLE(contact_id text, phone_number text, pending_identifier text, resolution_source text, created_contact boolean, attached_identifiers jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_contact public.contacts%ROWTYPE;
  v_identifier jsonb;
  v_identifier_value text;
  v_identifier_type text;
  v_created boolean := false;
  v_source text := 'pending';
  v_aliases text[] := ARRAY[]::text[];
BEGIN
  -- Serialize competing message/message.any resolvers for the same logical keys.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id || ':' || coalesce(p_phone_number, ''), 0));
  FOR v_identifier IN SELECT value FROM jsonb_array_elements(coalesce(p_identifiers, '[]'::jsonb)) LOOP
    v_identifier_value := lower(trim(v_identifier->>'identifier'));
    IF v_identifier_value <> '' THEN
      PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id || ':' || v_identifier_value, 0));
      v_aliases := array_append(v_aliases, v_identifier_value);
    END IF;
  END LOOP;
  v_aliases := ARRAY(SELECT DISTINCT value FROM unnest(v_aliases) AS value ORDER BY value);

  IF p_phone_number IS NOT NULL THEN
    SELECT * INTO v_contact FROM public.contacts WHERE workspace_id=p_workspace_id AND phone_number=p_phone_number LIMIT 1;
    IF v_contact.id IS NOT NULL THEN v_source := 'phone'; END IF;
  END IF;
  IF v_contact.id IS NULL AND cardinality(v_aliases) > 0 THEN
    SELECT c.* INTO v_contact FROM public.contact_identifiers i JOIN public.contacts c ON c.workspace_id=i.workspace_id AND c.id=i.contact_id WHERE i.workspace_id=p_workspace_id AND i.identifier = ANY(v_aliases) LIMIT 1;
    IF v_contact.id IS NOT NULL THEN v_source := 'alias'; END IF;
  END IF;
  IF v_contact.id IS NULL AND p_phone_number IS NOT NULL THEN
    INSERT INTO public.contacts (id,workspace_id,display_name,phone_number,email,company,created_at,updated_at)
    VALUES (gen_random_uuid()::text,p_workspace_id,coalesce(nullif(p_display_name,''),p_phone_number),p_phone_number,NULL,NULL,now(),now())
    ON CONFLICT (workspace_id,phone_number) DO UPDATE SET updated_at=public.contacts.updated_at
    RETURNING * INTO v_contact;
    v_created := true; v_source := 'created';
  END IF;
  IF v_contact.id IS NOT NULL THEN
    FOR v_identifier IN SELECT value FROM jsonb_array_elements(coalesce(p_identifiers, '[]'::jsonb)) LOOP
      v_identifier_value := lower(trim(v_identifier->>'identifier')); v_identifier_type := coalesce(nullif(v_identifier->>'type',''),'whatsapp');
      IF v_identifier_value <> '' THEN
        INSERT INTO public.contact_identifiers (id,workspace_id,contact_id,identifier,type,source,created_at)
        VALUES (gen_random_uuid()::text,p_workspace_id,v_contact.id,v_identifier_value,v_identifier_type,p_source,now())
        ON CONFLICT (workspace_id,identifier) DO NOTHING;
      END IF;
    END LOOP;
    DELETE FROM public.pending_contact_identities WHERE workspace_id=p_workspace_id AND identifier = ANY(v_aliases);
    RETURN QUERY SELECT v_contact.id, v_contact.phone_number, NULL::text, v_source, v_created, to_jsonb(v_aliases);
  ELSE
    FOR v_identifier IN SELECT value FROM jsonb_array_elements(coalesce(p_identifiers, '[]'::jsonb)) LOOP
      v_identifier_value := lower(trim(v_identifier->>'identifier')); v_identifier_type := coalesce(nullif(v_identifier->>'type',''),'whatsapp');
      IF v_identifier_value <> '' THEN
        INSERT INTO public.pending_contact_identities (id,workspace_id,identifier,type,source,created_at,updated_at)
        VALUES (gen_random_uuid()::text,p_workspace_id,v_identifier_value,v_identifier_type,p_source,now(),now())
        ON CONFLICT (workspace_id,identifier) DO UPDATE SET source=excluded.source,updated_at=excluded.updated_at;
      END IF;
    END LOOP;
    RETURN QUERY SELECT NULL::text, NULL::text, v_aliases[1], 'pending'::text, false, '[]'::jsonb;
  END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION public.chatpro_resolve_contact_identity(text,text,text,jsonb,text) TO service_role;
