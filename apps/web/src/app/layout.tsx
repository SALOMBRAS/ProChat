import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ChatPro",
  description: "Projeto acadêmico de uma futura plataforma de atendimento.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
