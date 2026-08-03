# ADR-0009 — Un solo Intent activo por turno

**Estado:** Aceptado · **Fecha:** 2026-07-11

## Contexto

Los Intents resuelven la pérdida de continuidad. Pero la misma capacidad que hace que el sistema **recuerde** hace que el sistema **insista**. Son la misma cosa vista desde dos lados.

Un sistema que recuerda todos sus objetivos abiertos y los menciona todos en cada respuesta es **peor** que uno que olvida. El olvido, al menos, es discreto. Un cliente que en cada mensaje recibe un recordatorio del pedido, una oferta de postre, un pedido de dirección y una pregunta sobre cuántos son, se va.

**Este riesgo es especialmente peligroso porque es invisible en las métricas técnicas.** El sistema estaría funcionando perfecto: recuerda todo, no pierde nada, retoma siempre, todas las métricas de continuidad en verde. Solo aparece en retención, abandono y quejas.

## Decisión

**El sistema elige, deterministamente, a lo sumo UN Intent con permiso de plantearse activamente en cada turno.** El resto se inyecta como contexto: el agente sabe que existen y **tiene prohibido mencionarlos**.

Tres mecanismos de contención, obligatorios:

1. **Un solo Intent activo por turno.**
2. **Presupuesto de insistencia con decay**, registrado en el Ledger.
3. **Primacía de la consulta actual.** El Intent **nunca** desplaza lo que el cliente acaba de preguntar. Se responde primero; se retoma después, y solo si el turno cierra bien.

**El permiso lo calcula el sistema, no el modelo:**

```
permiso = intent abierto
        ∧ presión ≠ silenciosa (presupuesto disponible)
        ∧ cooldown vencido
        ∧ el turno "cierra" (la respuesta no deja una pregunta abierta)
```

La última condición **no puede evaluarse antes de generar la respuesta**. Por eso se delega al modelo *dentro del permiso otorgado*: **el sistema decide si el Intent puede aparecer; el modelo decide si este turno concreto es el momento** (ADR-0010, verbo 3). El uso del permiso se mide, y una divergencia sostenida indica que hay que endurecer el mecanismo.

## Consecuencias

**Se gana:**
- Continuidad sin acoso. El sistema recuerda todo y **menciona poco**.
- La distinción que separa un asistente de una máquina: **un Goal que agota su presupuesto enmudece pero no muere.** El pedido sigue existiendo, el sistema sigue sabiendo que existe, deja de empujarlo. Si el cliente vuelve, la continuidad está intacta. Una Opportunity, en cambio, **sí se abandona**: nadie la pidió.

*Un mozo no te repite cuatro veces si querés cerrar la cuenta. Pero tampoco tira tu mesa a la basura.*

**Se pierde:**
- Oportunidades de conversión a corto plazo. Es deliberado.

**Métrica de guardia, con rollback automático:**
> **Intents planteados por turno ≤ 1.0.** Si sube, el sistema se está volviendo insistente y hay que apagarlo.

## Alternativas descartadas

**Dejar que el LLM decida cuántos objetivos mencionar.** Se descarta porque el modelo, instruido para ser útil, tiende a mencionar todo lo que sabe. El control de presión es una política de negocio, no un juicio conversacional.

**Sin límite, confiando en el buen criterio del prompt.** Es lo que hace el sistema hoy con las sugerencias comerciales, y es exactamente por eso que existen contadores anti-repetición ad-hoc dispersos por el código: **el problema ya se manifestó y ya se parchó tres veces.**
