import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("critic_test.txt contains exact required content", () => {
  expect(readFileSync("critic_test.txt", "utf8")).toBe("critic validated");
});
