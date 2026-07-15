"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

function credentialsFrom(formData: FormData) {
  const email = formData.get("email");
  const password = formData.get("password");

  if (
    typeof email !== "string" ||
    typeof password !== "string" ||
    !email.includes("@") ||
    password.length < 6
  ) {
    return null;
  }

  return { email: email.trim(), password };
}

export async function login(formData: FormData) {
  const credentials = credentialsFrom(formData);

  if (!credentials) {
    redirect("/login?error=invalid-credentials");
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(credentials);

  if (error) {
    redirect("/login?error=invalid-credentials");
  }

  revalidatePath("/", "layout");
  redirect("/app");
}

export async function signup(formData: FormData) {
  const credentials = credentialsFrom(formData);

  if (!credentials) {
    redirect("/cadastro?error=invalid-registration");
  }

  const requestHeaders = await headers();
  const origin = requestHeaders.get("origin");
  const emailRedirectTo = origin
    ? new URL("/auth/callback?next=/app", origin).toString()
    : undefined;

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    ...credentials,
    options: emailRedirectTo ? { emailRedirectTo } : undefined,
  });

  if (error) {
    redirect("/cadastro?error=registration-unavailable");
  }

  revalidatePath("/", "layout");

  if (!data.session) {
    redirect("/login?message=confirm-email");
  }

  redirect("/app");
}

export async function logout() {
  const supabase = await createClient();
  const { error } = await supabase.auth.signOut({ scope: "local" });

  if (error) {
    redirect("/app?error=logout-unavailable");
  }

  revalidatePath("/", "layout");
  redirect("/login");
}
