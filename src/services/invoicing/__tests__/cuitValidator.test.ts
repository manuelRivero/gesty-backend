import { describe, expect, it } from "vitest";
import { isValidCuit } from "../cuitValidator";

describe("isValidCuit", () => {
  it("acepta un CUIT válido (dígito verificador correcto)", () => {
    expect(isValidCuit("20-12345678-6")).toBe(true);
  });

  it("rechaza un CUIT con dígito verificador incorrecto", () => {
    expect(isValidCuit("20-12345678-9")).toBe(false);
  });

  it("rechaza un CUIT con longitud incorrecta", () => {
    expect(isValidCuit("123456789")).toBe(false);
  });

  it("rechaza valores no numéricos", () => {
    expect(isValidCuit("abc-defghij-k")).toBe(false);
  });
});
