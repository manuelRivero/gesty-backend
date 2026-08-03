# ADR-0001 — La familia Intent no rutea

**Estado:** Aceptado · **Fecha:** 2026-07-11 · **Invariante 1**

## Contexto

El sistema rutea cada turno a un agente (híbrido, checkout, reservas, onboarding) según flags de sesión. Esos mismos flags cargan hoy tres responsabilidades simultáneas: **quién habla**, **qué quedó a medias** y **qué pregunta hay que rehacer**.

Esa fusión produjo bugs críticos en producción. El caso canónico: una reserva **pausada** conserva su flag de sesión, y como el router lo lee como ownership, **bloquea el ruteo hacia checkout**. El cliente queda en un limbo donde una intención abandonada hace veinte turnos captura mensajes que no le corresponden.

La causa raíz no es un error de implementación: es que **un objetivo abierto y un flujo activo tienen ciclos de vida incompatibles**, y se los representó con el mismo campo.

## Decisión

**El routing pertenece exclusivamente a Ownership. Ningún Intent (Goal, Opportunity o Alert) puede influir en qué agente procesa un turno.**

Un Intent abierto debe poder coexistir con cualquier cosa que esté pasando en la conversación. Esa capacidad es la única razón por la que la capa existe.

**Criterio de clasificación operativo:**

> Si un campo **debe limpiarse** para que el sistema no se rompa → es **Ownership**.
> Si puede quedar abierto indefinidamente sin consecuencias → es **Intent**.

Un campo que hace las dos cosas hereda lo peor de ambas: bloquea como Ownership y persiste como Intent.

## Consecuencias

**Se gana:**
- Un objetivo puede quedar abierto para siempre sin efectos colaterales. Es el comportamiento esperado, no una fuga.
- El routing sigue siendo determinista, auditable y legible como una única cadena de prioridad.
- Un flujo abandonado deja de secuestrar turnos ajenos.

**Se pierde:**
- La elegancia aparente de *"si hay un objetivo de checkout abierto, que hable el checkout"*. Suena a auto-organización; es una trampa.

**Queda prohibido:**
- Leer un Intent para decidir quién habla.
- Que una Tool cambie el Ownership.
- Que el LLM rutee.

## Alternativas descartadas

**Que los Intents ruteen (unificar ambas capas).** Elimina una capa aparentemente redundante y menos código. Se descarta porque los Intents pueden quedar abiertos indefinidamente por diseño: un objetivo que nadie va a completar capturaría turnos eternamente, y **se perdería la capacidad de tener algo pendiente sin bloquear** — que es literalmente lo único que los Intents aportan. El sistema quedaría igual que antes del refactor, con una capa de indirección más y menos determinismo.

**Routing por LLM.** Un router probabilístico convierte cada turno en un tiro de dados sobre la seguridad transaccional. No es negociable.
