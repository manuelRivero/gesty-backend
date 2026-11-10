import { describe, expect, it } from "vitest";
import { z } from "zod";
import { queryBoolean } from "../zodHelpers";

/**
 * `?includeUnavailable=false` llegaba a `z.coerce.boolean()` como el string
 * `"false"`, y `Boolean("false") === true` — el caso real que reportó el
 * usuario: pedir explícitamente que NO se incluyan ítems no disponibles
 * terminaba incluyéndolos. `queryBoolean` existe específicamente para no
 * repetir ese bug en ningún endpoint nuevo.
 */
describe("queryBoolean", () => {
  const schema = z.object({ flag: queryBoolean(false) });

  it('parsea el string "false" de un query param como false, no como true', () => {
    expect(schema.parse({ flag: "false" }).flag).toBe(false);
  });

  it('parsea el string "true" como true', () => {
    expect(schema.parse({ flag: "true" }).flag).toBe(true);
  });

  it("acepta un booleano real sin alterarlo", () => {
    expect(schema.parse({ flag: false }).flag).toBe(false);
    expect(schema.parse({ flag: true }).flag).toBe(true);
  });

  it("aplica el default cuando el campo se omite", () => {
    expect(schema.parse({}).flag).toBe(false);
  });

  it("es insensible a mayúsculas/espacios", () => {
    expect(schema.parse({ flag: " FALSE " }).flag).toBe(false);
    expect(schema.parse({ flag: "True" }).flag).toBe(true);
  });
});
