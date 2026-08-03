# ADR-0006 — La máquina de estados vive en una función, nunca en una fila

**Estado:** Aceptado · **Fecha:** 2026-07-11

## Contexto

El checkout **es** una secuencia: no hay dirección sin delivery, no hay cobro sin método de pago. Esa secuencia no es un artefacto de diseño — es una restricción real del negocio, y pretender que "emerja" de un ranking de objetivos sería reemplazar una regla correcta por una heurística frágil y no determinista.

La tentación, entonces, es persistir el paso actual: *"el checkout está en 'dirección'"*. Y ahí empieza el problema.

Un paso persistido es una **segunda fuente de verdad** que puede divergir del estado real. El usuario da la dirección por otro camino y el paso guardado sigue diciendo "dirección". Aparece el reconciliador. Después el TTL. Después la limpieza.

El sistema ya tiene **la solución correcta implementada** —una función pura que deriva el paso desde los Facts— y **también** el flag persistido que hace lo mismo, más el reconciliador que los mantiene en línea. Tiene las dos, y por eso tiene el bug.

## Decisión

> **La máquina de estados puede vivir en una función. Nunca en una fila.**

El orden de un flujo transaccional se expresa como una **función pura sobre Facts** que devuelve el próximo paso. Sin estado propio. Recalculada en cada turno. **Estructuralmente incapaz de desincronizarse:** si el Fact cambia, el paso cambia. No hay nada que reconciliar porque no hay dos cosas que puedan diferir.

**El orden es un Constraint** (regla del negocio), **no una prioridad de Intents.** El ranker de Intents pregunta *"¿hay algún bloqueante?"* y, si hay varios, **delega el desempate a la función de orden**. El ranker no sabe —ni debe saber— que la dirección va antes que el pago. Esa regla tiene un solo dueño.

## Consecuencias

**Se gana:**
- Desaparece la clase de bugs "el flujo cree que está en un paso que ya se completó".
- **Es imposible re-preguntar algo que el cliente ya respondió**, por cualquier camino que lo haya respondido.
- El reconciliador que existe hoy para arreglar exactamente eso puede borrarse.

**Se pierde:**
- Nada relevante. Un query más por turno, ya presente.

**Prueba de fuego, aplicable en review:**

> Si borrás todo el estado de flujo y el sistema se comporta igual —porque todo se rederiva— tenés una **proyección**, no una FSM persistida.

Lo único que legítimamente sobrevive a ese borrado es lo que **no se puede derivar**: el abandono explícito y los contadores de insistencia *(ADR-0005, ADR-0007)*.

**Queda prohibido:**
- Persistir el paso actual de cualquier flujo.
- Que los Intents tengan transiciones, dependencias o sub-goals. **Si necesitás ordenar pasos, eso es un flujo, y los flujos ya tienen dónde vivir: en una función de orden.**

## Alternativas descartadas

**Eliminar la FSM y dejar que el orden emerja de la prioridad de los Intents.** Suena más "agéntico". Se descarta porque el orden del checkout es una regla dura del negocio, y hacerla emerger de un ranking la vuelve implícita, no testeable y sensible a cambios de prioridad hechos por otras razones. **El error no es tener una FSM: es persistirla.**
