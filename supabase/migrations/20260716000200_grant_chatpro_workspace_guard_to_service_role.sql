-- Domain RPCs run as SECURITY INVOKER and call this private workspace guard.
-- Keep it unavailable to public roles while allowing the server role to invoke
-- the complete RPC call chain.
grant execute on function public.chatpro_require_workspace(text) to service_role;
