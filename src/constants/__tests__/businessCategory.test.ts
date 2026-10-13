import { describe, expect, it } from "vitest";

import {
  BUSINESS_CATEGORIES,
  BUSINESS_CATEGORY_OPTIONS,
  isBusinessCategory
} from "../businessCategory";

describe("BUSINESS_CATEGORIES", () => {
  it("coincide exactamente con los values de BUSINESS_CATEGORY_OPTIONS", () => {
    expect(BUSINESS_CATEGORIES).toEqual(
      BUSINESS_CATEGORY_OPTIONS.map((opt) => opt.value)
    );
  });

  it("no tiene valores duplicados", () => {
    expect(new Set(BUSINESS_CATEGORIES).size).toBe(BUSINESS_CATEGORIES.length);
  });
});

describe("isBusinessCategory", () => {
  it("acepta un código válido", () => {
    expect(isBusinessCategory("PIZZA")).toBe(true);
  });

  it("rechaza valores no pertenecientes a la lista", () => {
    expect(isBusinessCategory("TACOS")).toBe(false);
    expect(isBusinessCategory(null)).toBe(false);
    expect(isBusinessCategory(42)).toBe(false);
  });
});
