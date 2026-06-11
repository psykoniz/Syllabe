import { describe, expect, test } from "bun:test";
import { multiply } from "./index";

describe("multiply", () => {
  test("multiplies two positive numbers", () => {
    expect(multiply(3, 4)).toBe(12);
  });

  test("multiplies by zero", () => {
    expect(multiply(5, 0)).toBe(0);
  });

  test("multiplies negative numbers", () => {
    expect(multiply(-2, 6)).toBe(-12);
    expect(multiply(-2, -6)).toBe(12);
  });
});
