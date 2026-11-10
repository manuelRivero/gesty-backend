import { prisma } from "../lib/prisma";

/**
 * Fase 4 de `docs/arquitectura/POS_TECHNICAL_DESIGN.md §4.C`: CRUD mínimo de
 * estaciones de preparación y su ruteo 1:1 con `menu_item`. Sin validaciones
 * de negocio adicionales (p. ej. nombres duplicados) — alcance explícitamente
 * acotado a "CRUD funcional" para el MVP.
 */

export async function listPreparationStations(params: { businessId: string }) {
  return prisma.preparation_station.findMany({
    where: { business_id: params.businessId },
    orderBy: { created_at: "asc" }
  });
}

export async function createPreparationStation(params: { businessId: string; name: string }) {
  return prisma.preparation_station.create({
    data: { business_id: params.businessId, name: params.name }
  });
}

export type AssignMenuItemStationResult =
  | { ok: true; assignment: { id: string; menu_item_id: string; station_id: string } }
  | { ok: false; reason: "STATION_NOT_FOUND" | "MENU_ITEM_NOT_FOUND" };

/** Upsert por `menu_item_id` (único) — reasignar es simplemente llamar de nuevo con otra estación. */
export async function assignMenuItemStation(params: {
  businessId: string;
  stationId: string;
  menuItemId: string;
}): Promise<AssignMenuItemStationResult> {
  const { businessId, stationId, menuItemId } = params;

  const station = await prisma.preparation_station.findFirst({
    where: { id: stationId, business_id: businessId }
  });
  if (!station) {
    return { ok: false, reason: "STATION_NOT_FOUND" };
  }

  const menuItem = await prisma.menu_item.findFirst({
    where: { id: menuItemId, business_id: businessId }
  });
  if (!menuItem) {
    return { ok: false, reason: "MENU_ITEM_NOT_FOUND" };
  }

  const assignment = await prisma.menu_item_station.upsert({
    where: { menu_item_id: menuItemId },
    update: { station_id: stationId },
    create: { menu_item_id: menuItemId, station_id: stationId }
  });

  return { ok: true, assignment };
}
