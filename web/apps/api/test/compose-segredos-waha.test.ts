import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** A WAHA é imagem de terceiro rodando Chromium. Enquanto os dois composes
 *  declaravam `env_file` para ela, o contêiner recebia o arquivo de ambiente
 *  **inteiro** — conferido em 03/08/2026 por `docker inspect chatpro-waha`, que
 *  mostrou `SUPABASE_SERVICE_ROLE_KEY` e `MEDIA_PROXY_TOKEN_SECRET` no ambiente
 *  de um serviço que não usa nem um nem outro.
 *
 *  O caminho é resolvido a partir deste arquivo, e não do diretório de trabalho:
 *  `vitest` roda com `cwd` em `apps/api`, mas quem invoca decide, e um caminho
 *  relativo ao processo passaria a apontar para lugar nenhum conforme o comando. */
const raiz = fileURLToPath(new URL('../../..', import.meta.url));
const compose = (caminho: string) => readFileSync(`${raiz}${caminho}`, 'utf8');

/** Lê o subconjunto de YAML que estes dois arquivos usam: chaves de serviço com
 *  dois espaços, chaves do serviço com quatro, variáveis com seis. Não é um
 *  parser de YAML e não pretende ser — mas **quebra alto** se o formato mudar,
 *  em vez de devolver um bloco vazio que faria todo `expect` abaixo passar. */
function servico(texto: string, nome: string): { declaraEnvFile: boolean; variaveis: Record<string, string> } {
  const linhas = texto.split('\n');
  const inicio = linhas.findIndex(linha => linha === `  ${nome}:`);
  if (inicio < 0) throw new Error(`serviço \`${nome}\` não encontrado — o formato do compose mudou`);
  const corpo: string[] = [];
  for (const linha of linhas.slice(inicio + 1)) { if (/^ {0,2}\S/.test(linha)) break; corpo.push(linha); }

  const declaraEnvFile = corpo.some(linha => /^ {4}env_file\b/.test(linha));
  const ambiente = corpo.findIndex(linha => /^ {4}environment:/.test(linha));
  if (ambiente < 0) throw new Error(`serviço \`${nome}\` sem bloco \`environment\` — o formato do compose mudou`);
  const variaveis: Record<string, string> = {};
  for (const linha of corpo.slice(ambiente + 1)) {
    if (/^ {0,4}\S/.test(linha)) break;
    const par = linha.match(/^ {6}([A-Z][A-Z0-9_]*): ?(.*)$/);
    if (par) variaveis[par[1]] = par[2];
  }
  if (!Object.keys(variaveis).length) throw new Error(`serviço \`${nome}\` com \`environment\` vazio — o formato do compose mudou`);
  return { declaraEnvFile, variaveis };
}

/** Segredos que pertencem à API e ao worker. Nenhum deles tem uso na WAHA. */
const alheios = ['SUPABASE_SERVICE_ROLE_KEY', 'MEDIA_PROXY_TOKEN_SECRET', 'SUPABASE_URL'] as const;
const arquivos = [
  { rotulo: 'desenvolvimento', texto: compose('docker-compose.waha.yml') },
  { rotulo: 'produção', texto: compose('deploy/docker-compose.prod.yml') },
] as const;

describe('a WAHA recebe só o que usa', () => {
  it.each(arquivos)('$rotulo: não entrega o arquivo de ambiente inteiro ao contêiner', ({ texto }) => {
    expect(servico(texto, 'waha').declaraEnvFile).toBe(false);
  });

  it.each(arquivos)('$rotulo: nenhum segredo de outro serviço aparece no ambiente da WAHA', ({ texto }) => {
    const { variaveis } = servico(texto, 'waha');
    for (const nome of alheios) expect(Object.keys(variaveis)).not.toContain(nome);
  });

  it.each(arquivos)('$rotulo: as duas chaves que ela usa continuam declaradas', ({ texto }) => {
    const { variaveis } = servico(texto, 'waha');
    expect(variaveis.WAHA_API_KEY).toBeDefined();
    expect(variaveis.WHATSAPP_HOOK_HMAC_KEY).toBeDefined();
  });

  // Sem `:?`, uma variável ausente vira string vazia: a WAHA sobe **sem exigir
  // chave** na API dela, e assina o webhook com nada — os dois em silêncio.
  it.each(arquivos)('$rotulo: as duas falham alto se a variável não estiver definida', ({ texto }) => {
    const { variaveis } = servico(texto, 'waha');
    expect(variaveis.WAHA_API_KEY).toMatch(/^\$\{WAHA_API_KEY:\?/);
    expect(variaveis.WHATSAPP_HOOK_HMAC_KEY).toMatch(/^\$\{WAHA_WEBHOOK_HMAC_KEY:\?/);
  });

  // A correção não pode ter passado do ponto: `api` e `worker` precisam do
  // arquivo inteiro, e são eles os donos legítimos daqueles segredos. Este
  // caso também prova que o leitor acima **enxerga** um `env_file` quando há —
  // sem ele, o `false` dos outros casos não valeria nada.
  it('produção: api e worker mantêm o env_file', () => {
    const texto = compose('deploy/docker-compose.prod.yml');
    expect(servico(texto, 'api').declaraEnvFile).toBe(true);
    expect(servico(texto, 'worker').declaraEnvFile).toBe(true);
  });
});
