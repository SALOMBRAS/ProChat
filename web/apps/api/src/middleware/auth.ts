import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { AppError } from '../errors.js';
import type { AuthService } from '../services/auth.service.js';
import { workspaceContext } from './context.js';

export type ManagementRole = 'owner' | 'admin' | 'manager';
const managementRoles: readonly ManagementRole[] = ['owner', 'admin', 'manager'];

export type AuthMiddlewares = {
  /** Substitui o `workspaceContext`: exige `Authorization: Bearer` e resolve o
   *  usuário da sessão. Fora de produção, uma requisição sem token cai no
   *  comportamento legado dos headers `x-workspace-id`/`x-user-id` para não
   *  quebrar testes e scripts de desenvolvimento. */
  authenticate: RequestHandler;
  /** Tudo que é gestão (dispositivos, equipe, filas, CRM, campanhas…): agente
   *  autenticado recebe 403. Contexto legado (sem role) passa — só existe fora
   *  de produção. */
  requireManagement: RequestHandler;
};

export const createAuthMiddlewares = (auth: AuthService, options: { allowLegacyHeaders: boolean }): AuthMiddlewares => {
  const authenticate: RequestHandler = async (req, _res, next) => {
    const header = req.header('authorization');
    if (header?.startsWith('Bearer ')) {
      try {
        const user = await auth.resolveSession(header.slice('Bearer '.length).trim());
        req.context = { correlationId: req.context?.correlationId ?? randomUUID(), workspaceId: user.workspaceId, userId: user.id, role: user.role };
        return next();
      } catch (error) {
        return next(error instanceof AppError ? error : new AppError(401, 'UNAUTHORIZED', 'Sessão inválida ou expirada. Faça login novamente.'));
      }
    }
    if (options.allowLegacyHeaders) return workspaceContext(req, _res, next);
    return next(new AppError(401, 'UNAUTHORIZED', 'Autenticação obrigatória. Envie o token da sessão.'));
  };
  const requireManagement: RequestHandler = (req, _res, next) => {
    const role = req.context?.role;
    if (!role) return next(); // contexto legado de desenvolvimento — ver `authenticate`.
    if ((managementRoles as readonly string[]).includes(role)) return next();
    return next(new AppError(403, 'FORBIDDEN', 'Esta área é restrita a administradores.'));
  };
  return { authenticate, requireManagement };
};
