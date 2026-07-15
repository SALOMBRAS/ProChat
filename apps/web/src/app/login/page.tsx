import Link from "next/link";
import { redirect } from "next/navigation";
import { login } from "@/app/auth/actions";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type LoginPageProps = {
  searchParams: Promise<{ error?: string; message?: string }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (claims) {
    redirect("/app");
  }

  const { error, message } = await searchParams;

  return (
    <main className="min-h-screen bg-neutral-950 px-6 py-16 text-neutral-50 sm:px-10">
      <section className="mx-auto w-full max-w-md rounded-2xl border border-neutral-800 bg-neutral-900 p-8 shadow-2xl">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-emerald-400">ChatPro</p>
        <h1 className="mt-4 text-3xl font-semibold">Entrar</h1>
        <p className="mt-3 text-sm leading-6 text-neutral-400">Use seu e-mail e senha para acessar a área mínima do projeto.</p>
        {error ? <p className="mt-5 rounded-lg border border-red-900 bg-red-950/40 p-3 text-sm text-red-200">E-mail ou senha inválidos.</p> : null}
        {message === "confirm-email" ? <p className="mt-5 rounded-lg border border-emerald-900 bg-emerald-950/40 p-3 text-sm text-emerald-200">Verifique seu e-mail para concluir o cadastro.</p> : null}
        <form action={login} className="mt-6 space-y-4">
          <label className="block text-sm text-neutral-300">E-mail<input name="email" type="email" autoComplete="email" required className="mt-2 w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-neutral-50 outline-none focus:border-emerald-400" /></label>
          <label className="block text-sm text-neutral-300">Senha<input name="password" type="password" autoComplete="current-password" minLength={6} required className="mt-2 w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-neutral-50 outline-none focus:border-emerald-400" /></label>
          <button type="submit" className="w-full rounded-lg bg-emerald-400 px-4 py-2 font-semibold text-neutral-950 hover:bg-emerald-300">Entrar</button>
        </form>
        <p className="mt-6 text-sm text-neutral-400">Ainda não possui acesso? <Link className="text-emerald-400 hover:text-emerald-300" href="/cadastro">Criar conta</Link></p>
      </section>
    </main>
  );
}
