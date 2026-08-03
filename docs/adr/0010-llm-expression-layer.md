# ADR-0010 — El LLM tiene tres verbos, y ninguno es transaccional

**Estado:** Aceptado · **Fecha:** 2026-07-11

## Contexto

En un sistema agéntico la pregunta *"¿qué puede hacer el modelo?"* tiende a responderse por omisión: puede hacer todo lo que no le prohibimos explícitamente. Eso invierte el default correcto para un sistema que maneja dinero.

Y la prohibición por prompt no es una prohibición: es una sugerencia con buena reputación (ADR-0002).

## Decisión

**El LLM vive en una sola capa —Expression— y tiene exactamente tres capacidades:**

1. **Expresar** — traducir un Intent habilitado a lenguaje natural apropiado.
2. **Priorizar conversacionalmente** — elegir qué es relevante decir ahora, **dentro del permiso que el sistema le otorgó**.
3. **Elegir el momento** — juzgar si es natural retomar algo en este turno.

**Ninguno de los tres es transaccional.** Todo lo demás pertenece al sistema.

| El LLM… | ¿Puede? |
|---|---|
| Leer Facts, Intents, Constraints | ✅ |
| Decidir **cómo** expresar el Intent habilitado | ✅ Es su trabajo |
| Decidir si **este turno** es natural para retomarlo | ✅ Dentro del permiso |
| Plantear un Intent que el sistema no habilitó | ⚠️ Se registra como divergencia y se audita |
| **Crear** un Intent | ⚠️ Solo instanciando tipos del catálogo cerrado, vía Tool tipada *(ADR-0011)* |
| **Cerrar** un Goal o una Alert crítica | ❌ **Nunca.** Lo cierra un Fact. |
| Cambiar presión o prioridad | ❌ Es política del negocio |
| **Rutear** | ❌ Es Ownership *(ADR-0001)* |
| **Autorizar** un efecto | ❌ Es Constraint + Tool *(ADR-0002, ADR-0004)* |

**El default se invierte: el modelo no puede hacer nada que no esté en la lista.**

## Consecuencias

**Se gana:**
- La pregunta *"¿qué pasa si el modelo se equivoca?"* tiene una respuesta acotada y enumerable: **dice algo raro**. No cobra mal, no rutea mal, no borra nada.
- El sistema sobrevive a un cambio de modelo sin re-auditar su seguridad.

**Se pierde:**
- Autonomía del agente. Es deliberado: **la autonomía que se le quita es exactamente la que no queremos que tenga.**

**Por qué el verbo 3 (elegir el momento) sí se le delega.** Es la única decisión que **no se puede tomar antes de generar la respuesta**: depende de si el texto producido deja o no una pregunta abierta (ADR-0009). Delegarla es correcto porque el sistema ya acotó el espacio: **el modelo elige el momento dentro del permiso, nunca el permiso.** Y el uso del permiso se mide.

**El límite, en una frase:**
> **El LLM decide qué decir. El código decide qué pasa.**
> Si ese límite se borronea, toda la arquitectura es decorativa.

## Alternativas descartadas

**Que el LLM administre los Intents** (crearlos, cerrarlos, priorizarlos). Es el diseño "agéntico" de moda. Se descarta porque los Intents controlan qué persigue el sistema, y un modelo probabilístico administrando su propia función objetivo produce un sistema cuyo comportamiento no se puede predecir ni auditar. **Además es innecesario: los Intents se derivan de Facts, y los Facts ya los tiene el sistema.**

**Que el LLM valide Constraints antes de actuar.** Se descarta por ADR-0002: una validación que el modelo puede saltearse no es una validación.
