#!/usr/bin/env node
// Lê o coverage-summary.json de cada workspace e escreve uma tabela Markdown
// em stdout. O CI redireciona a saída para $GITHUB_STEP_SUMMARY.
//
// Não impõe limiar de propósito: a intenção aqui é medir primeiro e só depois
// decidir o que exigir. Nenhum código de saída diferente de zero é emitido por
// causa de cobertura baixa.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const WORKSPACES = [
  { name: '@chatpro/contracts', dir: 'packages/contracts' },
  { name: '@chatpro/api', dir: 'apps/api' },
  { name: '@chatpro/worker', dir: 'apps/worker' },
  { name: '@chatpro/dashboard', dir: 'apps/dashboard' },
];

const METRICS = ['lines', 'statements', 'functions', 'branches'];

function readTotals(dir) {
  const path = join(webRoot, dir, 'coverage', 'coverage-summary.json');
  try {
    return JSON.parse(readFileSync(path, 'utf8')).total;
  } catch {
    return null;
  }
}

const rows = [];
const aggregate = Object.fromEntries(METRICS.map((m) => [m, { covered: 0, total: 0 }]));

for (const workspace of WORKSPACES) {
  const totals = readTotals(workspace.dir);
  if (!totals) {
    rows.push(`| ${workspace.name} | — | — | — | — |`);
    continue;
  }

  const cells = METRICS.map((metric) => {
    const { covered = 0, total = 0, pct = 0 } = totals[metric] ?? {};
    aggregate[metric].covered += covered;
    aggregate[metric].total += total;
    return `${pct.toFixed(2)}%`;
  });

  rows.push(`| ${workspace.name} | ${cells.join(' | ')} |`);
}

const totalCells = METRICS.map((metric) => {
  const { covered, total } = aggregate[metric];
  return total === 0 ? '—' : `${((covered / total) * 100).toFixed(2)}%`;
});

console.log('## Cobertura');
console.log('');
console.log('| Workspace | Linhas | Statements | Funções | Branches |');
console.log('| --- | --- | --- | --- | --- |');
for (const row of rows) console.log(row);
console.log(`| **Total** | **${totalCells.join('** | **')}** |`);
console.log('');
console.log('_Medição apenas — nenhum limiar é exigido ainda._');
