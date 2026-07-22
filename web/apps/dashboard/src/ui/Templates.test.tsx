import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ templates: vi.fn(), saveTemplate: vi.fn(), preview: vi.fn(), active: vi.fn() }));
vi.mock('../api/domain.js', () => ({ DomainApi: class { templates = api.templates; saveTemplate = api.saveTemplate; preview = api.preview; active = api.active; } }));
import { Templates } from './App.js';

const base = { id:'00000000-0000-4000-8000-000000000001', workspaceId:'workspace-a', name:'Boas-vindas', content:'Olá {{name}}', createdAt:'2026-07-22T00:00:00.000Z', updatedAt:'2026-07-22T00:00:00.000Z', active:true };
describe('Templates',()=>{
  it('renders templates with variables',async()=>{api.templates.mockResolvedValueOnce([{...base,variables:['name']}]);render(<Templates/>);expect(await screen.findByText(/name · Ativo/)).toBeInTheDocument();});
  it('renders templates without variables and legacy records safely',async()=>{api.templates.mockResolvedValueOnce([{...base,id:'00000000-0000-4000-8000-000000000002',name:'Sem variáveis',content:'Olá',variables:[]},{...base,id:'00000000-0000-4000-8000-000000000003',name:'Legado',variables:undefined,variablesJson:'["name"]'} as any]);render(<Templates/>);expect(await screen.findAllByText(/Sem variáveis · Ativo/)).toHaveLength(2);});
  it('creates a new template from the form',async()=>{api.templates.mockResolvedValue([]);api.saveTemplate.mockResolvedValue({...base,variables:['name']});render(<Templates/>);fireEvent.click(await screen.findByRole('button',{name:'Novo template'}));fireEvent.change(screen.getByRole('textbox',{name:'Nome'}),{target:{value:'Novo'}});fireEvent.change(screen.getByRole('textbox',{name:'Conteúdo'}),{target:{value:'Oi {{name}}'}});fireEvent.click(screen.getByRole('button',{name:'Salvar'}));await waitFor(()=>expect(api.saveTemplate).toHaveBeenCalledWith(undefined,{name:'Novo',content:'Oi {{name}}'}));});
});
