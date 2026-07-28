import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqlitePersistenceDatabase } from '../src/persistence/database.js';
import { createSqliteDomainRepository } from '../src/persistence/sqlite-domain.repository.js';
import { DomainService } from '../src/services/domain.service.js';
const dirs:string[]=[]; const create=()=>{const dir=mkdtempSync(join(tmpdir(),'chatpro-domain-'));dirs.push(dir);const db=new SqlitePersistenceDatabase(join(dir,'db.sqlite'),join(process.cwd(),'migrations'));db.migrate();return {db,service:new DomainService(createSqliteDomainRepository(db.sqlite))}}; afterEach(()=>{dirs.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true}));});
describe('domain services',()=>{
  it('aggregates visible Inbox conversations and persisted messages by workspace',async()=>{const {db,service}=create();try{const stamp='2026-07-24T12:00:00.000Z';const event=(workspaceId:string,id:string)=>db.sqlite.prepare('INSERT INTO waha_webhook_events (workspaceId,wahaSession,externalEventId,eventType,occurredAt,payloadJson,receivedAt) VALUES (?,?,?,?,?,?,?)').run(workspaceId,'session-a',id,'message',stamp,'{}',stamp);const conversation=(workspaceId:string,id:string,visibilityState:string)=>db.sqlite.prepare('INSERT INTO conversations (id,workspaceId,wahaSession,chatId,status,lastMessage,lastMessageAt,unreadCount,createdAt,updatedAt,visibilityState) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id,workspaceId,'session-a',`${id}@c.us`,'open','Oi',stamp,0,stamp,stamp,visibilityState);const message=(workspaceId:string,id:string,eventId:string)=>db.sqlite.prepare('INSERT INTO whatsapp_messages (workspaceId,wahaSession,externalMessageId,externalEventId,chatId,direction,messageType,body,occurredAt,payloadJson,receivedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(workspaceId,'session-a',id,eventId,'5511999990000@c.us','inbound','text','Oi',stamp,'{}',stamp);conversation('workspace-a','conversation-visible','visible');conversation('workspace-a','conversation-hidden','quarantined');conversation('workspace-b','conversation-other','visible');event('workspace-a','event-a-1');event('workspace-a','event-a-2');event('workspace-b','event-b-1');message('workspace-a','message-a-1','event-a-1');message('workspace-a','message-a-2','event-a-2');message('workspace-b','message-b-1','event-b-1');expect(await service.dashboard('workspace-a')).toMatchObject({conversations:1,messages:2});expect(await service.dashboard('workspace-b')).toMatchObject({conversations:1,messages:1});}finally{db.close()}});
  it('handles contacts, tags, templates, opt-out and campaign preparation in isolation',async()=>{const {db,service}=create();try{expect(await service.dashboard('a')).toMatchObject({contacts:0,optOutContacts:0});const tag:any=await service.createTag('a',{name:'VIP',color:'#ffffff'});const c:any=await service.createContact('a',{displayName:'Ada',phoneNumber:'+55 (11) 99999-0000',tagIds:[tag.id]});expect(c.phoneNumber).toBe('5511999990000');await expect(service.createContact('a',{displayName:'Dup',phoneNumber:c.phoneNumber})).rejects.toThrow();expect((await service.contacts('b',{} )as any).total).toBe(0);await expect(service.deleteTag('a',tag.id)).rejects.toThrow();const template:any=await service.saveTemplate('a',undefined,{name:'Hello',content:'Oi {{name}}'});expect((await service.preview('a',template.id,{data:{name:'Ada'}})as any).content).toBe('Oi Ada');await service.optOut('a',c.id,{reason:'requested'});expect((await service.optOutStatus('a',c.id)as any).optedOut).toBe(true);const campaign:any=await service.saveCampaign('a',undefined,{name:'C',templateId:template.id,contactIds:[c.id]});expect(await service.prepareCampaign('a',campaign.id)).toMatchObject({eligibleRecipients:0,excludedOptOut:1,campaign:{status:'blocked'}});await service.removeOptOut('a',c.id);expect((await service.scheduleCampaign('a',campaign.id,{scheduledAt:'2030-01-01T00:00:00.000Z'})as any).status).toBe('scheduled');expect(await service.exportContacts('a')).toContain('Ada');}finally{db.close()}});
  // Parity contract for the contact listing. The Supabase provider is asserted
  // against the same expectations in supabase-domain.repository.test.ts.
  it('filters, orders and paginates contacts by search, tag and opt-out',async()=>{const {db,service}=create();try{
    const vip:any=await service.createTag('a',{name:'VIP',color:null});
    const ada:any=await service.createContact('a',{displayName:'Ada Lovelace',phoneNumber:'5511999990001',email:'ada@example.com',tagIds:[vip.id]});
    const alan:any=await service.createContact('a',{displayName:'Alan Turing',phoneNumber:'5511999990002',email:'alan@example.com'});
    const grace:any=await service.createContact('a',{displayName:'Grace Hopper',phoneNumber:'5511988880003'});
    await service.createContact('b',{displayName:'Ada from another workspace',phoneNumber:'5511999990004',email:'ada@other.example.com'});
    const stamp=(id:string,value:string)=>db.sqlite.prepare('UPDATE contacts SET createdAt=? WHERE workspaceId=? AND id=?').run(value,'a',id);
    stamp(ada.id,'2026-01-03T00:00:00.000Z');stamp(alan.id,'2026-01-02T00:00:00.000Z');stamp(grace.id,'2026-01-01T00:00:00.000Z');
    const ids=async(query:Record<string,unknown>)=>((await service.contacts('a',query)) as any).items.map((item:any)=>item.id);
    expect(await ids({})).toEqual([ada.id,alan.id,grace.id]);
    expect(await ids({search:'LOVELACE'})).toEqual([ada.id]);
    expect(await ids({search:'98888'})).toEqual([grace.id]);
    expect(await ids({search:'Alan@Example'})).toEqual([alan.id]);
    expect(await ids({search:'no-such-contact'})).toEqual([]);
    expect(await ids({tagId:vip.id})).toEqual([ada.id]);
    await service.optOut('a',alan.id,{reason:'requested'});
    expect(await ids({optOut:'true'})).toEqual([alan.id]);
    expect(await ids({optOut:'false'})).toEqual([ada.id,grace.id]);
    expect(((await service.optOutContacts('a',{})) as any).items.map((item:any)=>item.id)).toEqual([alan.id]);
    expect(await service.contacts('a',{search:'55119999',page:2,pageSize:1})).toMatchObject({items:[{id:alan.id}],page:2,pageSize:1,total:2});
    expect(await service.contacts('a',{page:4,pageSize:2})).toEqual({items:[],page:4,pageSize:2,total:3});
    await expect(service.contacts('a',{page:'not-a-number'})).rejects.toThrow();
    await expect(service.contacts('a',{page:-1})).rejects.toThrow();
    await expect(service.contacts('a',{pageSize:500})).rejects.toThrow();
  }finally{db.close()}});
  // Parity contract for reading a contact's tags. The Supabase provider is
  // asserted against the same expectations in supabase-domain.repository.test.ts.
  it('reads the tags linked to a contact so an editor can preselect them',async()=>{const {db,service}=create();try{
    const vip:any=await service.createTag('a',{name:'VIP',color:null});
    const lead:any=await service.createTag('a',{name:'Lead',color:null});
    const tagged:any=await service.createContact('a',{displayName:'Ada',phoneNumber:'5511999990001',tagIds:[vip.id,lead.id]});
    const untagged:any=await service.createContact('a',{displayName:'Grace',phoneNumber:'5511999990002'});
    expect([...await service.contactTags('a',tagged.id)].sort()).toEqual([vip.id,lead.id].sort());
    expect(await service.contactTags('a',untagged.id)).toEqual([]);
    await expect(service.contactTags('b',tagged.id)).rejects.toThrow();
    // Editing other fields must leave the links alone; only an explicit
    // tagIds replaces them.
    await service.updateContact('a',tagged.id,{displayName:'Ada Lovelace'});
    expect([...await service.contactTags('a',tagged.id)].sort()).toEqual([vip.id,lead.id].sort());
    await service.updateContact('a',tagged.id,{tagIds:[vip.id]});
    expect(await service.contactTags('a',tagged.id)).toEqual([vip.id]);
  }finally{db.close()}});
  it('initializes CRM explicitly and records lead movement and notes',async()=>{const {db,service}=create();try{const init:any=await service.initPipeline('a',{});expect(init.stages).toHaveLength(5);const lead:any=await service.saveLead('a',undefined,{stageId:init.stages[0].id,title:'Opportunity'});await service.moveLead('a',lead.id,{stageId:init.stages[1].id});await service.note('a',lead.id,{body:'Follow up'});expect(await service.activities('a',lead.id)).toHaveLength(2);const stage=(await service.funnel('a') as any[]).find(s=>s.stageId===init.stages[1].id);expect(stage.total).toBe(1);}finally{db.close()}});
  it('normalizes template variables for new, variable-free, and legacy templates',async()=>{const {db,service}=create();try{const withVariables:any=await service.saveTemplate('a',undefined,{name:'Welcome',content:'Olá {{name}}, da {{company}}'});const withoutVariables:any=await service.saveTemplate('a',undefined,{name:'Plain',content:'Olá!'});expect(withVariables.variables).toEqual(['name','company']);expect(withoutVariables.variables).toEqual([]);db.sqlite.prepare('UPDATE templates SET variablesJson=? WHERE workspaceId=? AND id=?').run('[]','a',withVariables.id);const templates=(await service.templates('a')) as any[];expect(templates.find(template=>template.id===withVariables.id).variables).toEqual(['name','company']);expect(await service.preview('a',withVariables.id,{data:{name:'Ana',company:'ChatPro'}})).toEqual({content:'Olá Ana, da ChatPro',variables:['name','company']});}finally{db.close()}});
});
