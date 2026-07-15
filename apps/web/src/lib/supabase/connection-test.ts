/**
 * Temporary server-side diagnostic. It does not access application tables or
 * authenticate users; remove it once the Supabase foundation is verified.
 */
export async function verifySupabaseConnection() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !publishableKey) {
    return {
      configured: false,
      reachable: false,
      reason: "Missing Supabase public environment variables.",
    };
  }

  try {
    const response = await fetch(new URL("/auth/v1/health", url), {
      cache: "no-store",
      headers: {
        apikey: publishableKey,
        Authorization: `Bearer ${publishableKey}`,
      },
    });

    return {
      configured: true,
      reachable: response.ok,
      status: response.status,
    };
  } catch {
    return {
      configured: true,
      reachable: false,
      reason: "Supabase Data API could not be reached.",
    };
  }
}
