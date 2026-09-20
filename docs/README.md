# Docs — gesty-backend

Índice de documentación de producto y arquitectura de **este** repo.

| Documento | Qué es |
|-----------|--------|
| [FEATURES.md](./FEATURES.md) | Catálogo de features (ofrecible / remunerable / estado) |
| [planes-accion/](./planes-accion/) | Planes de acción y briefs de este backend |
| [adr/](./adr/) | Architecture Decision Records |
| [arquitectura/](./arquitectura/) | Notas de arquitectura / roadmap migración |

Rule asociada: `.cursor/rules/features-catalog.mdc` (`alwaysApply`).

---

## Planes de acción

| Plan | Estado | FEATURES IDs | Notas |
|------|--------|--------------|-------|
| [PLAN-ACCION-INBOX-EQUIPO.md](./planes-accion/PLAN-ACCION-INBOX-EQUIPO.md) | Fases A–C implementadas en código | WA-05…WA-11 | SQL: `prisma/sql/inbox_equipo_fase_a_c.sql`. Viewers = parcial (in-memory). |
| [CONTEXTO-BACKEND-INBOX-EQUIPO.md](./planes-accion/CONTEXTO-BACKEND-INBOX-EQUIPO.md) | Brief (origen admin) | — | Contexto de producto; no es el plan de implementación. |
| [PLAN-ACCION-STRIPE-BILLING.md](./planes-accion/PLAN-ACCION-STRIPE-BILLING.md) | Backend Fases 0–5 entregadas; Fase 6 = UI otro repo | BILL-01…BILL-05 | Gate bot + Checkout/Portal/webhook. |
| [PLAN-ACCION-CAPABILITIES-BOOTSTRAP.md](./planes-accion/PLAN-ACCION-CAPABILITIES-BOOTSTRAP.md) | Fases 1–5 implementadas | BE-01, BE-02 | Fase 6 opcional. |
| [PLAN-ACCION-ADMIN-CAPABILITIES-SETUP.md](./planes-accion/PLAN-ACCION-ADMIN-CAPABILITIES-SETUP.md) | Handoff — **no ejecutar en este repo** | — | Contrato/invariantes para el panel admin. |

### Pendientes de ejecución en este repo

- Nada bloqueante de los planes arriba (código A–C / billing / capabilities ya está).
- Operativo: aplicar SQL inbox si el entorno aún no tiene columnas/tablas.
- Mejoras de producto abiertas: ver sección **Pipeline** en [FEATURES.md](./FEATURES.md) (WA-13, BOT-05, RES-04, etc.).
- Viewers multi-réplica (cerrar WA-09 `parcial`) si hay 2+ instancias.

### Inventario legado

- [`PENDING-FEATURES.md`](../PENDING-FEATURES.md) (raíz) — gaps históricos; priorizar `docs/FEATURES.md` ante conflictos.
