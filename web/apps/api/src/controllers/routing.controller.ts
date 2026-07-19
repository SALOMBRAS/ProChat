import type { RequestHandler } from 'express';
import { z } from 'zod';
import { RoutingService } from '../services/routing.service.js';
const id = z.string().uuid();
const queueInput = z.object({ name: z.string().trim().min(1).max(120), description: z.string().trim().max(500).nullable().optional(), teamId: id.nullable().optional(), isActive: z.boolean().optional(), strategy: z.enum(['round_robin','least_loaded','manual']).optional(), maxOpenConversationsPerAgent: z.number().int().positive().nullable().optional() });
const memberInput = z.object({ userId: id, priorityWeight: z.number().int().positive().optional(), isAvailable: z.boolean().optional() });
export class RoutingController {
  constructor(private readonly routing: RoutingService) {}
  queues: RequestHandler = async (req, res) => res.json(await this.routing.list(req.context!));
  createQueue: RequestHandler = async (req, res) => res.status(201).json(await this.routing.create(req.context!, queueInput.parse(req.body)));
  updateQueue: RequestHandler = async (req, res) => res.json(await this.routing.update(req.context!, id.parse(req.params.id), queueInput.partial().refine(value => Object.keys(value).length > 0).parse(req.body)));
  members: RequestHandler = async (req, res) => res.json(await this.routing.members(req.context!, id.parse(req.params.id)));
  saveMember: RequestHandler = async (req, res) => res.status(201).json(await this.routing.saveMember(req.context!, id.parse(req.params.id), memberInput.parse(req.body)));
  removeMember: RequestHandler = async (req, res) => { await this.routing.removeMember(req.context!, id.parse(req.params.id), id.parse(req.params.userId)); res.status(204).end(); };
  distribute: RequestHandler = async (req, res) => { const conversationId = id.parse(z.object({ conversationId: id }).parse(req.body).conversationId); const result=await this.routing.distribute(req.context!, conversationId, id.parse(req.params.id)); res.status((result as {queued?:boolean}).queued?202:200).json(result); };
  moveConversation: RequestHandler = async (req, res) => { const result=await this.routing.moveConversation(req.context!, id.parse(req.params.id), z.object({ queueId: id.nullable() }).parse(req.body).queueId); res.status((result as {queued?:boolean}).queued?202:200).json(result); }
  redistribute: RequestHandler = async (req, res) => res.json(await this.routing.redistribute(req.context!, id.parse(req.params.id)));
  job: RequestHandler = async (req,res) => res.json(this.routing.getJob(req.context!,id.parse(req.params.id)));
  cancelJob: RequestHandler = async (req,res) => res.json(this.routing.cancelJob(req.context!,id.parse(req.params.id)));
  status: RequestHandler = async (req,res) => res.json(this.routing.routingStatus(req.context!,id.parse(req.params.id)));
}
