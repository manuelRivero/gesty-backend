/** Validación de CUIT argentino: 11 dígitos + dígito verificador módulo 11. */
export function isValidCuit(cuit: string): boolean {
  const digits = cuit.replace(/\D/g, "");
  if (digits.length !== 11) return false;

  const multipliers = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = multipliers.reduce((acc, m, i) => acc + m * Number(digits[i]), 0);
  const mod = sum % 11;
  const expected = mod === 0 ? 0 : mod === 1 ? 9 : 11 - mod;

  return expected === Number(digits[10]);
}
