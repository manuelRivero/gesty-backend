import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

import { listBusinessCategories } from "../publicMenu.controller";
import { BUSINESS_CATEGORY_OPTIONS } from "../../constants/businessCategory";

function mockRes() {
  const res = {
    setHeader: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis()
  };
  return res as unknown as Response & {
    setHeader: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
  };
}

describe("listBusinessCategories controller", () => {
  it("devuelve el catálogo fijo de categorías con cache pública", async () => {
    const res = mockRes();

    await listBusinessCategories({} as Request, res);

    expect(res.setHeader).toHaveBeenCalledWith(
      "Cache-Control",
      expect.stringContaining("public")
    );
    expect(res.json).toHaveBeenCalledWith({
      categories: BUSINESS_CATEGORY_OPTIONS
    });
  });
});
