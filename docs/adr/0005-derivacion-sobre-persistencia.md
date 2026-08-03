# ADR-0005 — Preferir derivación sobre persistencia

**Estado:** Aceptado · **Fecha:** 2026-07-11

## Contexto

El estado de conversación acumuló ~36 flags. Casi todos nacieron igual: hacía falta recordar algo entre turnos, se agregó un booleano. Y casi todos siguieron el mismo camino: el flag necesitó una limpieza, después otra en otro lugar, después un TTL, después un reconciliador porque el usuario había respondido por un camino que el flag no contemplaba.

**El costo real de un flag no es escribirlo: es su ciclo de vida.** Y el ciclo de vida se paga en bugs, dispersos, durante años.

## Decisión

**Un Intent se deriva de Facts salvo que se demuestre que no puede derivarse.** La carga de la prueba está del lado de quien quiere persistir.

**Intents derivados** — proyección pura de Facts, recalculada cada turno, no persistida. Si el Fact desaparece, el Intent desaparece. **Son estructuralmente incapaces de quedar huérfanos, desincronizados o zombis.** No necesitan limpieza, ni TTL, ni reconciliación.

*Un Intent derivado no se "crea" ni se "cierra": se deriva, o no se deriva.* Esa es toda su mecánica.

**Intents declarados** — nacen en la conversación, no son derivables, hay que persistirlos. **Cada uno es deuda administrada.**

**Los tres casos que genuinamente exigen declaración, y son casi los únicos:**

1. **El abandono explícito.** El cliente dijo "dejalo". Los Facts no cambiaron —el pedido sigue ahí— pero la intención del sistema debe cambiar. Sin esto, el bot vuelve a insistir con algo que el cliente ya rechazó. **Es el único bit que separa un asistente de un acosador.**
2. **La tarea interrumpida.** Lo que el cliente estaba diciendo cuando el sistema lo cortó. Historia conversacional; no existe en ninguna tabla.
3. **La promesa.** El bot se comprometió a algo que todavía no puede cumplir.

## Consecuencias

**Se gana:**
- La mayoría de los Intents no tienen ciclo de vida que administrar. **Nada que limpiar, y por lo tanto nada que olvidar limpiar.**
- Es imposible que un Intent derivado contradiga la realidad.
- La migración desde flags no requiere migración de datos: el derivador arranca vacío y produce el estado correcto en el primer turno.

**Se pierde:**
- Cada turno recalcula. El costo es despreciable frente al de mantener sincronizado un flag.

**Corolario obligatorio — el revival.** Un Intent declarado que se abandona **debe poder revivir**. Si el cliente abandona el pedido y después agrega otro plato, el abandono se limpia solo. Sin esa regla, `abandonado = true` es una lápida: el cliente arma un pedido nuevo y el bot nunca lo ayuda a cerrarlo. **Es el bug silencioso más probable de esta arquitectura, y no se detecta en QA manual porque requiere una secuencia de tres turnos.**

## Alternativas descartadas

**Persistir todos los Intents, por uniformidad.** Un solo mecanismo, más simple de razonar. Se descarta porque uniforma **hacia abajo**: todos los Intents heredarían los problemas de los pocos que realmente necesitan persistencia (limpieza, TTL, drift), en vez de que los pocos hereden la pureza de la mayoría.
