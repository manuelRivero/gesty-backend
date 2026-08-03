# ADR-0008 — Goals, Opportunities y Alerts son una familia

**Estado:** Aceptado · **Fecha:** 2026-07-11

## Contexto

El sistema necesita representar tres cosas que superficialmente parecen distintas:

- *"Falta cerrar el pedido"* — algo que el cliente empezó y quedó a medias.
- *"Convendría ofrecerle un postre"* — algo que el negocio quiere, y el cliente no pidió.
- *"El local cierra en 20 minutos"* — algo que el sistema debe avisar, aunque nadie pregunte.

Las tres son intenciones abiertas que sobreviven al turno. Comparten derivación desde Facts, presupuesto de insistencia y todas las prohibiciones. Pero **tratarlas idénticamente produce un bot insoportable**, y **tratarlas como tres mecanismos separados triplica la maquinaria sin justificación.**

## Decisión

**Goals, Opportunities y Alerts son una sola familia —Intent— con ciclo de vida compartido. Se distinguen por dos ejes: quién toma la iniciativa, y qué pasa si nunca se cumplen.**

|  | **GOAL** | **OPPORTUNITY** | **ALERT** |
|---|---|---|---|
| **Iniciativa** | del **cliente** | del **negocio** | del **sistema** |
| **El sistema…** | la **persigue** | la **propone** | la **emite** |
| **Si nunca se cumple** | 🔴 el cliente quería algo y no lo obtuvo | 🟢 no pasa nada | 🔴 el cliente se perjudica |
| **Presión típica** | bloqueante / reanudable | ambiental | bloqueante, una vez |
| **Se cierra por** | cambio en un Fact | decay o Fact | **emisión** |
| **Presupuesto** | 3 → **enmudece, no muere** | 1 → **se abandona** | 1 → se cierra |
| **¿La silencia el cliente?** | sí (abandono) | sí | **no, si es crítica** |

**Comparten:** derivación desde Facts (ADR-0005), estructura plana sin transiciones, presupuesto en el Ledger (ADR-0007), las cuatro invariantes, y la regla de un solo Intent activo por turno (ADR-0009).

**Orden de saliencia, determinista:**
`Alert crítica → Goal bloqueante → Goal reanudable → Opportunity`

## Consecuencias

**Se gana:**
- **Un solo mecanismo**, tres modos de uso. Un derivador, un presupuesto, un renderer, un ciclo de vida.
- La legitimidad de insistir queda codificada en el modelo, no en el criterio de quien escribe el prompt: **insistir con un Goal es servicio** (el cliente lo empezó); **insistir con una Opportunity es venta agresiva** (nadie la pidió).

**La diferencia de cierre de las Alerts, y por qué no viola la Invariante 4.** Una Alert se cierra **al emitirse**: su propósito era decir algo, y decirlo lo cumple. **El cierre lo sigue registrando el sistema en el Ledger** (se emitió, quedó constancia), **no el modelo declarando "listo"**. La invariante se mantiene: el LLM nunca cierra nada.

**Excepción — Alerts que exigen resolución.** Una Alert crítica que requiere acción del cliente ("tu pago fue rechazado") **no se cierra al emitirse**: se cierra cuando cambia el Fact. Emitirla no basta; resolverla sí. En la práctica se comportan como Goals bloqueantes, y está bien que así sea.

**Queda prohibido:**
- Darle a una Opportunity presupuesto > 1. **El mecanismo es idéntico al de un Goal y por eso la confusión es fácil de cometer — pero la legitimidad es opuesta.**
- Que el cliente pueda silenciar una Alert crítica.

## Alternativas descartadas

**Tres categorías peer, con derivador y persistencia propios.** Más expresivo. Se descarta porque triplica la maquinaria sin ninguna diferencia real de ciclo de vida: las tres se derivan igual, se presupuestan igual, se rankean juntas y comparten todas las prohibiciones. Sería complejidad accidental pura.

**Una sola categoría (todo es Goal), con un campo de "importancia".** Se descarta porque el campo terminaría cargando la distinción de iniciativa —que es lo que determina el derecho a insistir— sin nombrarla. **El bot que insiste con el postre como si fuera el pedido nace exactamente de esa fusión.**
