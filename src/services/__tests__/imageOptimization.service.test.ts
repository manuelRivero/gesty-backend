import { describe, expect, it } from "vitest";
import {
  ImageValidationError,
  assertAllowedImage,
  detectImageMime,
  buildDishImageKey
} from "../imageOptimization.service";

/** JPEG mínimo 1x1 */
const JPEG_1X1 = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGcP//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAQUCf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Bf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Bf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEABj8Cf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAT8hf//Z",
  "base64"
);

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

describe("imageOptimization.service", () => {
  it("detecta JPEG y PNG por magic bytes", () => {
    expect(detectImageMime(JPEG_1X1)).toBe("image/jpeg");
    expect(detectImageMime(PNG_1X1)).toBe("image/png");
  });

  it("rechaza SVG", () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(detectImageMime(svg)).toBeNull();
    expect(() => assertAllowedImage(svg, "image/svg+xml")).toThrow(
      ImageValidationError
    );
  });

  it("arma key con UUID bajo restaurants/{id}/dishes/", () => {
    const key = buildDishImageKey("biz-123");
    expect(key).toMatch(
      /^restaurants\/biz-123\/dishes\/[0-9a-f-]{36}\.webp$/
    );
  });
});
