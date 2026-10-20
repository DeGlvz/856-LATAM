// Campos de cuenta por tipo de riel para el formulario (espejo de src/fiat/rail-fields.ts; el backend es la fuente de verdad).
export interface AccField {
  key: string; label: string; required?: boolean; help: string; example: string; select?: { value: string; label: string }[];
  check?: (v: string) => string | null;
}

const re = (r: RegExp, msg: string) => (v: string) => (r.test(v) ? null : msg);
export const clabeOk = (c: string) => {
  if (!/^\d{18}$/.test(c)) return false;
  const w = [3, 7, 1];
  const s = [...c.slice(0, 17)].reduce((a, d, i) => a + ((Number(d) * w[i % 3]) % 10), 0);
  return (10 - (s % 10)) % 10 === Number(c[17]);
};
export const ibanOk = (raw: string) => {
  const s = raw.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  let rem = 0;
  for (const d of (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55))) rem = (rem * 10 + Number(d)) % 97;
  return rem === 1;
};
const abaCheck = re(/^\d{9}$/, 'La ABA/ruta debe tener exactamente 9 dígitos (sin espacios ni guiones).');
const swiftCheck = re(/^[A-Za-z]{6}[A-Za-z0-9]{2}([A-Za-z0-9]{3})?$/, 'SWIFT/BIC inválido: 8 u 11 caracteres (4 letras banco + 2 país + 2 plaza + 3 sucursal opcional).');

const F = {
  holder: { key: 'beneficiary_name', label: 'Titular / beneficiario', required: true, help: 'Nombre exacto de la cuenta, como aparece en el estado de cuenta o la app del banco. Este nombre se muestra al cliente.', example: 'Empresa Ejemplo LLC' } as AccField,
  holderType: { key: 'account_holder_type', label: 'Tipo de titular', help: 'Si la cuenta está a nombre de una persona física o de una empresa.', example: 'Empresa',
    select: [{ value: '', label: 'Sin especificar' }, { value: 'empresa', label: 'Empresa' }, { value: 'persona', label: 'Persona (personal)' }] } as AccField,
  bank: { key: 'bank_name', label: 'Banco', required: true, help: 'Nombre del banco donde está la cuenta (encabezado del estado de cuenta).', example: 'Banco Ejemplo N.A.' } as AccField,
  bankOpt: { key: 'bank_name', label: 'Banco', help: 'Nombre del banco (opcional).', example: 'Banco Ejemplo' } as AccField,
  addr: { key: 'bank_address', label: 'Dirección del banco', required: true, help: 'Dirección postal de la sucursal o sede del banco; suele estar en el pie del estado de cuenta o en la ficha de wire.', example: '100 Calle Ejemplo, Ciudad, ST 00000' } as AccField,
  acct: { key: 'account_number', label: 'Número de cuenta', required: true, help: 'Número de cuenta (no el de tarjeta). En la app: «Detalles de la cuenta». Hasta 40 caracteres.', example: '000123456789' } as AccField,
  aba: { key: 'aba', label: 'ABA / ruta', help: 'Número de ruta de 9 dígitos de bancos de EE. UU. (routing). Está en los cheques o en «Detalles de la cuenta».', example: '021000021', check: abaCheck } as AccField,
  swift: { key: 'swift', label: 'SWIFT/BIC', help: 'Código del banco para transferencias internacionales, 8 u 11 caracteres. Está en la app bancaria o ficha de wire.', example: 'FICTUS33', check: swiftCheck } as AccField,
  acctType: { key: 'account_type', label: 'Tipo de cuenta', help: 'Tipo de cuenta según el banco.', example: 'checking',
    select: [{ value: '', label: 'Elija…' }, { value: 'checking', label: 'Checking (corriente)' }, { value: 'savings', label: 'Savings (ahorro)' }, { value: 'business_checking', label: 'Business checking (empresarial)' }] } as AccField,
  interBank: { key: 'intermediary_bank', label: 'Banco intermediario', help: 'Solo si el banco lo exige para wires internacionales (opcional).', example: 'Banco Corresponsal Ejemplo' } as AccField,
  interSwift: { key: 'intermediary_swift', label: 'SWIFT intermediario', help: 'SWIFT/BIC del banco intermediario (opcional).', example: 'INTLUS33', check: swiftCheck } as AccField,
};
const req = (f: AccField): AccField => ({ ...f, required: true });

export type Subtype = 'wire_domestic' | 'wire_intl';
export const SUBTYPES: { value: Subtype; label: string }[] = [
  { value: 'wire_domestic', label: 'Wire / ACH nacional (con ABA/ruta)' },
  { value: 'wire_intl', label: 'Wire internacional (con SWIFT/BIC)' },
];

export function fieldsFor(railType: string, subtype: Subtype = 'wire_domestic'): AccField[] {
  switch (railType === 'otc' ? 'generic' : railType) {
    case 'wire':
      return subtype === 'wire_intl'
        ? [F.holder, F.holderType, F.bank, F.addr, F.acct, req(F.swift), { ...F.aba, help: F.aba.help + ' Opcional si ya indica SWIFT.' }, F.acctType, F.interBank, F.interSwift]
        : [F.holder, F.holderType, F.bank, F.addr, F.acct, req(F.aba), F.acctType, F.swift, F.interBank, F.interSwift];
    case 'ach':
      return [F.holder, F.holderType, F.bank, F.addr, F.acct, req(F.aba), req(F.acctType)];
    case 'sepa':
      return [F.holder, F.holderType, F.bankOpt,
        { key: 'iban', label: 'IBAN', required: true, help: 'Número internacional de cuenta, hasta 34 caracteres; empieza con 2 letras de país. Se ignoran los espacios.', example: 'DE89 3704 0044 0532 0130 00',
          check: (v) => (ibanOk(v) ? null : 'IBAN inválido: revise longitud y dígitos de control.') },
        { key: 'bic', label: 'BIC', help: 'BIC/SWIFT del banco (opcional en SEPA).', example: 'FICTDEFF', check: swiftCheck }];
    case 'spei':
      return [F.holder, F.holderType, F.bankOpt,
        { key: 'clabe', label: 'CLABE', required: true, help: 'CLABE interbancaria de 18 dígitos (app o estado de cuenta, «CLABE»). Se valida el dígito verificador.', example: '012180000112345678',
          check: (v) => (clabeOk(v) ? null : 'CLABE inválida: 18 dígitos con dígito verificador correcto.') }];
    case 'pix':
      return [F.holder, F.holderType,
        { key: 'pix_key', label: 'Llave PIX', required: true, help: 'Llave registrada en la app del banco (CPF/CNPJ, correo, teléfono o aleatoria).', example: 'pagos@ejemplo.com' },
        { key: 'key_type', label: 'Tipo de llave', help: 'Tipo de la llave PIX (opcional).', example: 'email',
          select: [{ value: '', label: 'Sin especificar' }, { value: 'cpf_cnpj', label: 'CPF/CNPJ' }, { value: 'email', label: 'Correo' }, { value: 'phone', label: 'Teléfono' }, { value: 'random', label: 'Aleatoria' }] }];
    default:
      return [F.holder, F.holderType, F.bankOpt, { key: 'account_number', label: 'Cuenta', help: 'Número o referencia de cuenta (opcional).', example: 'ref-0001' },
        { key: 'details', label: 'Detalles', help: 'Texto libre con las instrucciones (opcional).', example: 'Instrucciones del riel de contingencia' }];
  }
}

/** Mensajes de validación en vivo; "" en edición hereda el valor vigente, así que no bloquea. */
export function validate(fields: AccField[], vals: Record<string, string>, editing: boolean): Record<string, string> {
  const errs: Record<string, string> = {};
  for (const f of fields) {
    const v = (vals[f.key] ?? '').trim();
    if (!v) { if (f.required && !editing) errs[f.key] = 'Obligatorio.'; continue; }
    const m = f.check?.(v);
    if (m) errs[f.key] = m;
  }
  return errs;
}

export type Intent = 'aba' | 'swift' | 'iban' | 'clabe' | 'pix' | 'other';
export const WIZARD: { intent: Intent; label: string; railType: string; subtype?: Subtype }[] = [
  { intent: 'aba', label: 'Tengo ABA / número de ruta → ACH o wire nacional', railType: 'wire', subtype: 'wire_domestic' },
  { intent: 'swift', label: 'Tengo SWIFT/BIC → wire internacional', railType: 'wire', subtype: 'wire_intl' },
  { intent: 'iban', label: 'Tengo IBAN → SEPA', railType: 'sepa' },
  { intent: 'clabe', label: 'Tengo CLABE → SPEI', railType: 'spei' },
  { intent: 'pix', label: 'Tengo llave PIX → PIX', railType: 'pix' },
];
