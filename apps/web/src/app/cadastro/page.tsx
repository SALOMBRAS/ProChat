import Link from "next/link";
import { redirect } from "next/navigation";
import { signup } from "@/app/auth/actions";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type SignupPageProps = {
  searchParams: Promise<{ error?: string }>;
};

export default async function SignupPage({ searchParams }: SignupPageProps) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (claims) {
    redirect("/app");
  }

  const { error } = await searchParams;

  return (
    <main className="min-h-screen bg-neutral-950 px-6 py-16 text-neutral-50 sm:px-10">
      <section className="mx-auto w-full max-w-md rounded-2xl border border-neutral-800 bg-neutral-900 p-8 shadow-2xl">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-emerald-400">ChatPro</p>
        <h1 className="mt-4 text-3xl font-semibold">Criar conta</h1>
        <p className="mt-3 text-sm leading-6 text-neutral-400">Cadastre um e-mail e uma senha. Não há OAuth nem perfil de usuário nesta fase.</p>
        {error ? <p className="mt-5 rounded-lg border border-red-900 bg-red-950/40 p-3 text-sm text-red-200">Não foi possível concluir o cadastro. Tente novamente.</p> : null}
        <form action={signup} className="mt-6 space-y-4">
          <label className="block text-sm text-neutral-300">E-mail<input name="email" type="email" autoComplete="email" required className="mt-2 w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-neutral-50 outline-none focus:border-emerald-400" /></label>
          <label className="block text-sm text-neutral-300">Senha<input name="password" type="password" autoComplete="new-password" minLength={6} required className="mt-2 w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-neutral-50 outline-none focus:border-emerald-400" /></label>
          <button type="submit" className="w-full rounded-lg bg-emerald-400 px-4 py-2 font-semibold text-neutral-950 hover:bg-emerald-300">Cadastrar</button>
        </form>
        <p className="mt-6 text-sm text-neutral-400">Já possui acesso? <Link className="text-emerald-400 hover:text-emerald-300" href="/login">Entrar</Link></p>
      </section>
    </main>
  );
}
