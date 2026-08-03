# Architecture Decision Records

Registro de las decisiones arquitectónicas fundamentales del sistema.

**Un ADR no se edita ni se borra: se supersede.** Si una decisión cambia, se escribe un ADR nuevo que la reemplace y se marca la vieja como `Superseded by ADR-XXXX`. El historial de por qué el sistema es como es tiene tanto valor como el sistema.

**El modelo conceptual está congelado.** Modificar el núcleo de [`ARQUITECTURA.md`](../../ARQUITECTURA.md) —incluida la introducción de una categoría nueva— **requiere un ADR aceptado**. El sesgo por defecto es rechazar: casi siempre, lo que parece un concepto sin hogar es un concepto mal nombrado que esconde dos cosas adentro.

---

## Índice

### Las cuatro invariantes
| ADR | Decisión | Estado |
|---|---|---|
| [0001](0001-intents-no-rutean.md) | La familia Intent no rutea; el routing es exclusivo de Ownership | Aceptado |
| [0002](0002-constraints-en-el-borde-de-las-tools.md) | Los Constraints viven en el borde de las Tools, nunca en prompts | Aceptado |
| [0003](0003-intents-no-contienen-datos-de-negocio.md) | Los Intents referencian Facts, nunca los copian | Aceptado |
| [0004](0004-tools-unica-superficie-de-efectos.md) | Las Tools son la única superficie de efectos externos | Aceptado |

### Diseño de la capa Intent
| ADR | Decisión | Estado |
|---|---|---|
| [0005](0005-derivacion-sobre-persistencia.md) | Preferir derivación sobre persistencia; declarar solo lo inderivable | Aceptado |
| [0006](0006-fsm-como-funcion-nunca-como-fila.md) | La máquina de estados vive en una función, nunca en una fila | Aceptado |
| [0008](0008-familia-intent-goal-opportunity-alert.md) | Goals, Opportunities y Alerts son una familia con ciclo de vida compartido | Aceptado |
| [0009](0009-un-solo-intent-activo-por-turno.md) | Un solo Intent puede plantearse activamente por turno | Aceptado |
| [0011](0011-catalogo-cerrado-de-intents.md) | El catálogo de tipos de Intent es cerrado | Aceptado |

### Memoria y fronteras
| ADR | Decisión | Estado |
|---|---|---|
| [0007](0007-ledger-como-categoria-separada.md) | El Ledger es una categoría separada de Facts e Intents | Aceptado |
| [0010](0010-llm-expression-layer.md) | El LLM tiene tres verbos y ninguno es transaccional | Aceptado |
| [0012](0012-prohibicion-de-reconciliadores.md) | Los reconciliadores están prohibidos; se elimina la duplicación, no se administra | Aceptado |

### Proceso
| ADR | Decisión | Estado |
|---|---|---|
| [0013](0013-migracion-sin-downtime.md) | Toda migración usa shadow → dual-write → shadow-read → flip → cleanup | Aceptado |

---

## Formato

Cada ADR responde cuatro preguntas y ninguna más:

- **Contexto** — qué problema real forzó la decisión.
- **Decisión** — qué se decidió, en imperativo.
- **Consecuencias** — qué se gana, qué se pierde, qué queda prohibido.
- **Alternativas descartadas** — qué más se consideró y por qué no.

Si un ADR no puede nombrar una alternativa que fue genuinamente considerada, probablemente no documenta una decisión: documenta una preferencia.
