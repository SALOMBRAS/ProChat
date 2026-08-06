import { z } from 'zod';

/** Single source of truth for the contact listing filters. Both providers parse
 * the same query, so SQLite and Supabase accept, reject and default identically
 * instead of drifting into two dialects of the same endpoint. */
export const contactListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(500).default(25),
  search: z.string().trim().max(120).optional(),
  tagId: z.string().uuid().optional(),
  optOut: z.enum(['true', 'false']).optional(),
  /** Origem derivada dos identificadores: 'phonebook' = algum identificador
   * nasceu da agenda do celular ('waha_contact_sync'); 'history' = nenhum.
   * O picker de contatos usa para abrir só com a agenda do celular (~150)
   * e pesquisar o resto sob demanda, em vez de baixar a base inteira. */
  origin: z.enum(['phonebook', 'history']).optional(),
});
export type ContactListFilters = z.infer<typeof contactListQuerySchema>;
export const parseContactListQuery = (query: Record<string, unknown> | undefined): ContactListFilters => contactListQuerySchema.parse(query ?? {});
