import { expect, test } from "bun:test";
import { multiply } from "./index";

test("multiply returns the product of two numbers", () => {
  expect(multiply(3, 4)).toBe(12);
});
