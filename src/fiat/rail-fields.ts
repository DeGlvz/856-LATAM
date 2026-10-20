// Campos de cuenta por tipo de riel (sin dependencias de DB para poder probarlos en unitarias).
// Requeridos: banco, dirección, titular y cuenta en wire/ach; el resto según subtipo. Lo opcional acepta vacío.
import { z } from 'zod';

const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const txt = (max = 140) => z.string().trim().min(1, 'Obligatorio').max(max);
const opt = (max = 140) => z.preprocess(blank, z.string().trim().min(1).max(max).optional());

export const isValidClabe = (c: string) => {
  if (!/^\d{18}$/.test(c)) return false;
  const w = [3, 7, 1];
  const sum = [...c.slice(0, 17)].reduce((s, d, i) => s + ((Number(d) * w[i % 3]) % 10), 0);
  return (10 - (sum % 10)) % 10 === Number(c[17]);
};
export const isValidIban = (raw: string) => {
  const s = raw.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  const n = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
  let rem = 0;
  for (const d of n) rem = (rem * 10 + Number(d)) % 97;
  return rem === 1;
};

const aba = z.string().trim().regex(/^\d{9}$/, 'La ABA/ruta tiene exactamente 9 dígitos');
const swift = z.string().trim().toUpperCase().regex(/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/, 'SWIFT/BIC inválido: 8 u 11 caracteres (4 letras de banco, 2 de país, 2 de plaza y 3 de sucursal opcionales)');
const holderType = z.enum(['persona', 'empresa']);
const accountType = z.enum(['checking', 'savings', 'business_checking']);

export const FIELD_SCHEMAS = {
  // wire: nacional (ABA) o internacional (SWIFT); al menos uno de los dos
  wire: z.object({
    beneficiary_name: txt(), bank_name: txt(), bank_address: txt(300), account_number: txt(40),
    aba: z.preprocess(blank, aba.optional()), swift: z.preprocess(blank, swift.optional()),
    account_type: z.preprocess(blank, accountType.optional()), account_holder_type: z.preprocess(blank, holderType.optional()),
    intermediary_bank: opt(), intermediary_swift: z.preprocess(blank, swift.optional()),
  }).strict().superRefine((d, ctx) => {
    if (!d.aba && !d.swift) ctx.addIssue({ code: 'custom', path: ['swift'], message: 'Indique SWIFT/BIC o ABA (al menos uno)' });
  }),
  ach: z.object({
    beneficiary_name: txt(), bank_name: txt(), bank_address: txt(300), account_number: txt(40), aba,
    account_type: accountType, account_holder_type: z.preprocess(blank, holderType.optional()),
  }).strict(),
  sepa: z.object({
    beneficiary_name: txt(), bank_name: opt(), bank_address: opt(300), account_holder_type: z.preprocess(blank, holderType.optional()),
    iban: z.string().trim().transform((s) => s.replace(/\s+/g, '').toUpperCase()).refine(isValidIban, 'IBAN inválido (formato o dígitos de control)'),
    bic: z.preprocess(blank, swift.optional()),
  }).strict(),
  spei: z.object({
    beneficiary_name: txt(), bank_name: opt(), account_holder_type: z.preprocess(blank, holderType.optional()),
    clabe: z.string().trim().refine(isValidClabe, 'CLABE inválida: 18 dígitos con dígito verificador correcto'),
  }).strict(),
  pix: z.object({
    beneficiary_name: txt(), pix_key: txt(77), key_type: z.preprocess(blank, z.enum(['cpf_cnpj', 'email', 'phone', 'random']).optional()),
    account_holder_type: z.preprocess(blank, holderType.optional()),
  }).strict(),
  generic: z.object({
    beneficiary_name: txt(), bank_name: opt(), account_number: opt(60), details: opt(500), account_holder_type: z.preprocess(blank, holderType.optional()),
  }).strict(),
} as const;
export type RailType = keyof typeof FIELD_SCHEMAS;
export const schemaFor = (railType: string) => FIELD_SCHEMAS[(railType === 'otc' ? 'generic' : railType) as RailType];

export const LABELS: Record<string, string> = {
  beneficiary_name: 'Titular / beneficiario', bank_name: 'Banco', bank_address: 'Dirección del banco', account_number: 'Cuenta', aba: 'ABA / ruta', swift: 'SWIFT/BIC', bic: 'BIC',
  intermediary_bank: 'Banco intermediario', intermediary_swift: 'SWIFT intermediario', account_type: 'Tipo de cuenta',
  account_holder_type: 'Tipo de titular', iban: 'IBAN', clabe: 'CLABE', pix_key: 'Llave PIX', key_type: 'Tipo de llave', details: 'Detalles',
};
