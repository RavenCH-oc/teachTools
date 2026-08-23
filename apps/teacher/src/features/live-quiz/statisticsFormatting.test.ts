import { describe, expect, it } from "vitest";
import { formatRate, formatScore } from "./statisticsFormatting";

describe("statistics formatting", () => {
  it.each([
    [null, "—"],
    [0, "0%"],
    [0.75, "75%"],
    [2 / 3, "66.7%"],
    [2, "200%"],
    [3, "300%"],
  ])("formats rate %s as %s", (value, expected) => {
    expect(formatRate(value)).toBe(expected);
  });

  it.each([
    [null, "—"],
    [5, "5 / 5"],
    [3.5, "3.5 / 5"],
    [3.75, "3.75 / 5"],
  ])("formats score %s as %s", (value, expected) => {
    expect(formatScore(value, 5)).toBe(expected);
  });
});
