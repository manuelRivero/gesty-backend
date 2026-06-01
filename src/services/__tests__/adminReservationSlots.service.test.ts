import { describe, expect, it } from "vitest";
import {
  reservationSlotsOverlap,
  timeToMinutes
} from "../adminReservationSlots.service";

describe("reservationSlotsOverlap", () => {
  it("detecta solapamiento parcial", () => {
    expect(
      reservationSlotsOverlap(
        timeToMinutes("10:00"),
        timeToMinutes("11:30"),
        timeToMinutes("11:00"),
        timeToMinutes("12:00")
      )
    ).toBe(true);
  });

  it("permite slots contiguos sin solaparse", () => {
    expect(
      reservationSlotsOverlap(
        timeToMinutes("10:00"),
        timeToMinutes("11:00"),
        timeToMinutes("11:00"),
        timeToMinutes("12:00")
      )
    ).toBe(false);
  });

  it("detecta slot contenido dentro de otro", () => {
    expect(
      reservationSlotsOverlap(
        timeToMinutes("10:00"),
        timeToMinutes("14:00"),
        timeToMinutes("11:00"),
        timeToMinutes("12:00")
      )
    ).toBe(true);
  });
});
