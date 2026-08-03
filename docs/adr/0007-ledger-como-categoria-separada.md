# ADR-0007 — El Ledger es una categoría separada

**Estado:** Aceptado · **Fecha:** 2026-07-11

## Contexto

El sistema necesita recordar cosas sobre **su propio comportamiento**: cuántas veces ofreció algo, cuándo lo ofreció por última vez, cuántas veces el cliente esquivó dar un dato, si el cliente pidió explícitamente que no insista.

Hoy eso vive disperso entre los flags del estado de conversación, mezclado con datos del negocio. Ya existen al menos seis encarnaciones del mismo concepto —contadores de rechazo, banners ya mostrados, cooldowns de sugerencias— cada una con su nombre, su formato y su limpieza.

Pero el argumento decisivo es otro, y es estructural: **ADR-0005 exige que los Intents sean derivados y puros.** Un Intent derivado se recalcula desde cero cada turno y **no recuerda nada** — esa amnesia es precisamente lo que lo hace incorruptible. Pero **un sistema que no recuerda cuántas veces preguntó algo pregunta lo mismo para siempre.**

## Decisión

**El Ledger es una categoría de primera clase: la memoria del sistema sobre su propio comportamiento.**

Guarda el conteo **por fuera del Intent**, indexado de forma estable. El Intent se recalcula limpio en cada turno; el conteo sobrevive.

**Esto resuelve una tensión que de otro modo sería irreconciliable: pureza de derivación y memoria de comportamiento, a la vez.** Sin Ledger, cada Intent tendría que persistirse solo para llevar su contador, y toda la capa perdería su propiedad más valiosa.

**La distinción que lo define:**

| | **Memoria transaccional** (Facts) | **Memoria conversacional** (Ledger) |
|---|---|---|
| Recuerda | lo que le pasó **al mundo** | lo que hizo **el sistema** |
| Ejemplo | "el pedido tiene 2 ítems" | "ya le ofrecí postre 2 veces" |
| Ante discrepancia | **gana** | se descarta |
| Si se pierde | 🔴 se corrompe el negocio | 🟡 el bot se vuelve repetitivo |

**Pertenece al Ledger:** presupuestos de insistencia · rechazos · **abandono explícito** · cooldowns · expiraciones · trazabilidad de qué Intent se planteó cada turno y por qué el sistema lo eligió.

## Consecuencias

**Se gana:**
- Los Intents pueden ser derivados y puros sin que el sistema pierda memoria de lo que ya intentó.
- **Una sola política de insistencia** en vez de seis contadores ad-hoc.
- Trazabilidad: ante *"¿por qué el bot dijo eso?"*, hay una respuesta. Sin el Ledger, esta arquitectura es una caja negra peor que la actual.

**El test que lo delimita:**

> **El Ledger debe poder borrarse entero sin consecuencias financieras.**
> Si borrarlo rompe algo más que el tono del bot, algo que no pertenecía se coló adentro.

**Queda prohibido:**
- Datos del negocio o estado transaccional en el Ledger.
- Que el Ledger decida quién habla. *(Si lo hace, se convirtió en Ownership.)*

## Alternativas descartadas

**Absorber el Ledger dentro de los Intents** (cada Intent lleva su contador). Un concepto menos. Se descarta porque **obliga a persistir todos los Intents** solo para no perder el conteo — y con eso se cae ADR-0005 y toda la pureza de derivación. El costo es exactamente lo que esta arquitectura vino a eliminar.

**Absorber el Ledger dentro de los Facts.** Se descarta porque contamina la fuente de verdad del negocio con ruido de comportamiento, y le da a datos con consecuencias legales el mismo ciclo de vida descartable que a un contador de UI. El daño es asimétrico en ambas direcciones.
