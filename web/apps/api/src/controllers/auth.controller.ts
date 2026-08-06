import type { RequestHandler } from 'express';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { MIN_PASSWORD_LENGTH, type AuthService } from '../services/auth.service.js';

const loginInput = z.object({ email: z.string().trim().email(), password: z.string().min(1) });
const passwordInput = z.object({ password: z.string().min(MIN_PASSWORD_LENGTH) });
const changePasswordInput = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(MIN_PASSWORD_LENGTH) });

const bearerToken = (header: string | undefined) => header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined;

/** Rotas de autenticação. O login é público (montado antes do middleware de
 *  auth); as demais exigem sessão e usam o usuário já resolvido em
 *  `req.context`. */
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  login: RequestHandler = async (req, res) => {
    const input = loginInput.parse(req.body);
    const workspaceId = req.header('x-workspace-id') ?? 'default-workspace';
    const result = await this.auth.login(workspaceId, input.email, input.password);
    res.json(result);
  };

  me: RequestHandler = async (req, res) => {
    res.json({ user: this.requireSessionUser(req) });
  };

  logout: RequestHandler = async (req, res) => {
    const token = bearerToken(req.header('authorization'));
    if (token) await this.auth.logout(token);
    res.status(204).end();
  };

  changePassword: RequestHandler = async (req, res) => {
    const input = changePasswordInput.parse(req.body);
    await this.auth.changePassword(this.requireSessionUser(req), input.currentPassword, input.newPassword);
    res.status(204).end();
  };

  setUserPassword: RequestHandler = async (req, res) => {
    const input = passwordInput.parse(req.body);
    const actor = this.requireSessionUser(req);
    await this.auth.adminSetPassword(actor, actor.workspaceId, z.string().uuid().parse(req.params.id), input.password);
    res.status(204).end();
  };

  /** As rotas autenticadas deste controller só fazem sentido com sessão real —
   *  o contexto legado de desenvolvimento não tem usuário de verdade para
   *  trocar senha ou revogar token. */
  private requireSessionUser(req: import('express').Request) {
    const context = req.context;
    if (!context?.userId || !context.role) throw new AppError(401, 'UNAUTHORIZED', 'Esta operação exige uma sessão autenticada.');
    return { id: context.userId, workspaceId: context.workspaceId, role: context.role } as import('@chatpro/contracts').WorkspaceUser;
  }
}
