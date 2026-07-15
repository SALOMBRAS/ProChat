export default function Home() {
  return (
    <main className="min-h-screen bg-neutral-950 px-6 py-16 text-neutral-50 sm:px-10">
      <section className="mx-auto flex min-h-[calc(100vh-8rem)] max-w-4xl flex-col justify-center">
        <p className="mb-4 text-sm font-semibold uppercase tracking-[0.22em] text-emerald-400">
          Projeto acadêmico
        </p>
        <h1 className="text-5xl font-semibold tracking-tight sm:text-7xl">
          ChatPro
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-8 text-neutral-300 sm:text-xl">
          Fundação técnica ativa para uma futura plataforma web de atendimento.
        </p>
        <p className="mt-8 w-fit rounded-full border border-neutral-700 px-4 py-2 text-sm text-neutral-400">
          WhatsApp e CRM ainda não foram implementados.
        </p>
      </section>
    </main>
  );
}
