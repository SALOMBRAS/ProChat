import type { RequestHandler } from 'express';
import { z } from 'zod';
import { WorkspaceDirectoryService } from '../services/workspace-directory.service.js';
import { MIN_PASSWORD_LENGTH, type AuthService } from '../services/auth.service.js';

const id = z.string().uuid();
const userInput = z.object({ email: z.string().trim().email(), displayName: z.string().trim().min(1).max(160), avatarUrl: z.string().url().nullable().optional(), role: z.enum(['owner', 'admin', 'manager', 'agent']).optional(), status: z.enum(['active', 'invited', 'disabled']).optional(),
  // Senha inicial do operador — sem ela o usuário existe no diretório mas não
  // consegue entrar (um admin define depois por /auth/users/:id/password).
  password: z.string().min(MIN_PASSWORD_LENGTH).optional() });
const userUpdate = userInput.omit({ email: true, password: true }).partial().refine(value => Object.keys(value).length > 0);
const teamInput = z.object({ name: z.string().trim().min(1).max(120), description: z.string().trim().max(500).nullable().optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(), isActive: z.boolean().optional() });
const memberInput = z.object({ userId: id, membershipRole: z.enum(['member', 'leader']).optional() });
export class WorkspaceDirectoryController {
  constructor(private readonly directory: WorkspaceDirectoryService, private readonly auth?: AuthService) {}
  users: RequestHandler = async (req, res) => res.json(await this.directory.listUsers(req.context!));
  createUser: RequestHandler = async (req, res) => {
    const { password, ...input } = userInput.parse(req.body);
    const created = await this.directory.createUser(req.context!, input);
    if (password && this.auth) {
      const context = req.context!;
      // Sem sessão (contexto legado de desenvolvimento) o ator é tratado como
      // owner — é o mesmo papel que o `ensureDevelopmentActor` provisiona.
      const actor = { id: context.userId ?? created.id, role: context.role ?? 'owner' } as import('@chatpro/contracts').WorkspaceUser;
      await this.auth.adminSetPassword(actor, created.workspaceId, created.id, password);
    }
    res.status(201).json(created);
  };
  updateUser: RequestHandler = async (req, res) => res.json(await this.directory.updateUser(req.context!, id.parse(req.params.id), userUpdate.parse(req.body)));
  disableUser: RequestHandler = async (req, res) => res.json(await this.directory.setUserStatus(req.context!, id.parse(req.params.id), 'disabled'));
  enableUser: RequestHandler = async (req, res) => res.json(await this.directory.setUserStatus(req.context!, id.parse(req.params.id), 'active'));
  teams: RequestHandler = async (req, res) => res.json(await this.directory.listTeams(req.context!));
  createTeam: RequestHandler = async (req, res) => res.status(201).json(await this.directory.createTeam(req.context!, teamInput.parse(req.body)));
  updateTeam: RequestHandler = async (req, res) => res.json(await this.directory.updateTeam(req.context!, id.parse(req.params.id), teamInput.partial().refine(value => Object.keys(value).length > 0).parse(req.body)));
  members: RequestHandler = async (req, res) => res.json(await this.directory.members(req.context!, id.parse(req.params.id)));
  addMember: RequestHandler = async (req, res) => res.status(201).json(await this.directory.addMember(req.context!, id.parse(req.params.id), memberInput.parse(req.body)));
  removeMember: RequestHandler = async (req, res) => { await this.directory.removeMember(req.context!, id.parse(req.params.id), id.parse(req.params.userId)); res.status(204).end(); };
}
