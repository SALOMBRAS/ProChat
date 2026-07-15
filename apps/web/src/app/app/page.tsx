import { redirect } from "next/navigation";
import { logout } from "@/app/auth/actions";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type AppPageProps = {
  searchParams: Promise<{ error?: string }>;
};

export default async function AppPage({ searchParams }: AppPageProps) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims) {
    redirect("/login");
  }

  const { error } = await searchParams;
  const email = typeof claims.email === "string" ? claims.email : "E-mail não disponível";

  return (
    <main className="min-h-screen bg-neutral-950 px-6 py-16 text-neutral-50 sm:px-10">
      <section className="mx-auto flex min-h-[calc(100vh-8rem)] max-w-4xl flex-col justify-center">
        <p className="text-sm font-semibold uppercase tracking-[0.22em] text-emerald-400">Área autenticada</p>
        <h1 className="mt-4 text-5xl font-semibold tracking-tight sm:text-7xl">ChatPro</h1>
        <p className="mt-6 text-lg text-neutral-300">Sessão ativa para <span className="font-medium text-neutral-100">{email}</span>.</p>
        {error ? <p className="mt-6 w-fit rounded-lg border border-red-900 bg-red-950/40 p-3 text-sm text-red-200">Não foi possível encerrar a sessão. Tente novamente.</p> : null}
        <p className="mt-8 w-fit rounded-full border border-neutral-700 px-4 py-2 text-sm text-neutral-400">WhatsApp e CRM ainda não foram implementados.</p>
        <form action={logout} className="mt-8"><button type="submit" className="rounded-lg border border-neutral-600 px-4 py-2 text-sm font-semibold text-neutral-100 hover:border-emerald-400 hover:text-emerald-300">Sair</button></form>
      </section>
    </main>
  );
}
