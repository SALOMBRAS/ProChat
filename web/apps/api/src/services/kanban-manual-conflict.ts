import { AppError } from '../errors.js';

/**
 * Quem perde para uma movimentação manual.
 *
 * O controle otimista do `chatpro_kanban_move` existe para avisar **uma pessoa**
 * que outra moveu o card enquanto ela arrastava. Contra a automação não há a
 * quem avisar — e a intenção humana é explícita, então ela ganha: a versão que
 * o operador tinha na tela está velha, mas a decisão dele não. Contra outro
 * operador é o contrário: o aviso é justamente o ponto, e sobrescrever apagaria
 * em silêncio o que a outra pessoa acabou de decidir.
 *
 * `last_transition_source` distingue os dois casos sem coluna nova: a RPC já o
 * grava, e `system`, `inbound`, `outbound` e `automation` são todas automação.
 */
export const manualWins = (lastTransitionSource: unknown) => lastTransitionSource !== 'manual';

/**
 * O 409 que o operador merece ler. A etapa entra em `details` para a tela poder
 * dizer **para onde** o card foi, em vez de "conflitou ou falhou" — que era
 * verdade sobre o código e inútil para quem estava arrastando.
 */
export const movedByOperator = (stage: { id: string; name: string }) =>
  new AppError(409, 'CONFLICT', `Outro atendente moveu este card para ${stage.name}.`, { reason: 'moved_by_operator', stageId: stage.id, stageName: stage.name });
