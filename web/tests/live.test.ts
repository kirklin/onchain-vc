import { describe, expect, it } from "vitest";
import { countdown } from "~/chain/live";

const now = new Date("2026-01-01T00:00:00Z");

function after(seconds: number): Date {
  return new Date(now.getTime() + seconds * 1000);
}

describe("countdown", () => {
  it("shows hours, minutes and seconds", () => {
    expect(countdown(after(3 * 3600 + 4 * 60 + 5), now)).toEqual({ days: 0, clock: "03:04:05" });
    expect(countdown(after(59), now)).toEqual({ days: 0, clock: "00:00:59" });
  });

  it("counts whole days apart from the clock", () => {
    expect(countdown(after(86_400), now)).toEqual({ days: 1, clock: "00:00:00" });
    expect(countdown(after(86_400 - 1), now)).toEqual({ days: 0, clock: "23:59:59" });
    expect(countdown(after(30 * 86_400 + 3600), now)).toEqual({ days: 30, clock: "01:00:00" });
  });

  it("rounds a started second up, so the last second shows as one", () => {
    expect(countdown(new Date(now.getTime() + 400), now)).toEqual({ days: 0, clock: "00:00:01" });
  });

  it("stays at zero once the moment has passed", () => {
    expect(countdown(now, now)).toEqual({ days: 0, clock: "00:00:00" });
    expect(countdown(after(-500), now)).toEqual({ days: 0, clock: "00:00:00" });
  });
});
