import { describe, expect, it } from 'vitest';
import { campaignStatusSchema, normalizedPhoneNumberSchema, templateVariablesSchema } from '../src/index.js';

describe('persistence contracts', () => {
  it('accepts only normalized phone numbers', () => { expect(normalizedPhoneNumberSchema.parse('5511999999999')).toBe('5511999999999'); expect(() => normalizedPhoneNumberSchema.parse('+55 11 99999-9999')).toThrow(); });
  it('limits campaign states to pre-delivery states', () => { expect(campaignStatusSchema.options).toEqual(['draft', 'scheduled', 'ready', 'blocked', 'cancelled']); expect(() => campaignStatusSchema.parse('sent')).toThrow(); });
  it('requires unique template variables', () => { expect(templateVariablesSchema.parse(['firstName', 'company'])).toEqual(['firstName', 'company']); expect(() => templateVariablesSchema.parse(['firstName', 'firstName'])).toThrow(); });
});
