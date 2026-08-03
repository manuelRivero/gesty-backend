# Arquitectura de responsabilidades — v1.0

**Sistema:** agente conversacional multiagente para restaurantes sobre WhatsApp.
**Estado:** **CONGELADO.** Modelo conceptual cerrado. El trabajo pasó de descubrimiento a consolidación.
**Naturaleza:** normativo, no descriptivo. Fuente de verdad arquitectónica.
**Pregunta que responde:** *¿dónde vive cada responsabilidad del sistema, y por qué?*

| | |
|---|---|
| **Taxonomía oficial** | [`docs/arquitectura/TAXONOMIA.md`](docs/arquitectura/TAXONOMIA.md) |
| **Decisiones (ADRs)** | [`docs/adr/`](docs/adr/) |
| **Roadmap de migración** | [`docs/arquitectura/ROADMAP-MIGRACION.md`](docs/arquitectura/ROADMAP-MIGRACION.md) |
| **Violaciones actuales** | [`docs/arquitectura/VIOLACIONES.md`](docs/arquitectura/VIOLACIONES.md) |

---

## Cómo leer y mantener este documento

Dos partes con vidas útiles distintas, y la separación es deliberada:

- **Núcleo normativo (§1–§13)** — definiciones, invariantes, criterios, anti-patrones. **Debe seguir siendo válido aunque cambien el lenguaje, el framework, el proveedor de LLM o la base de datos.** No contiene nombres de archivos, funciones ni tablas. Si una sección del núcleo deja de ser cierta porque cambió una tecnología, la sección estaba mal escrita.
- **Apéndice del sistema actual (§14)** — cómo se materializa hoy. **Envejece a propósito.** Cuando se contradiga con el código, gana el código y el apéndice se actualiza.

**Regla de mantenimiento:** el núcleo se modifica **solo por ADR aceptado**, nunca para acomodar una implementación. Si una implementación no encaja, la implementación está mal — o hay un hueco real en el modelo, y eso se discute en un ADR, no se parchea en el código.

**Congelamiento del modelo.** Las 9 categorías de §2 son la taxonomía oficial. **No se introducen categorías nuevas salvo evidencia fuerte, en producción, de que un concepto real no encaja naturalmente en ninguna.** Esa evidencia se presenta como ADR. El sesgo por defecto es **rechazar** la categoría nueva: casi siempre, lo que parece un concepto sin hogar es un concepto mal nombrado que esconde dos cosas adentro.

---

## 1. El problema que esta arquitectura resuelve

Un sistema conversacional transaccional enfrenta dos presiones que tiran en direcciones opuestas.

**La presión transaccional** exige determinismo: no se cobra sin método de pago, no se envía a domicilio sin dirección, no se confirma una orden vacía. Estas reglas no admiten interpretación. Un sistema que las delega al juicio de un modelo probabilístico es un sistema que eventualmente cobra mal.

**La presión conversacional** exige flexibilidad: el cliente cambia de tema, pregunta cosas laterales, se distrae, vuelve. Un empleado humano tolera todo eso sin perder el hilo — responde la pregunta intermedia y retoma el pedido cuando es natural, sin volverse insistente. Un sistema que modela la conversación como una secuencia rígida rompe en el primer desvío.

**El error clásico es resolver ambas presiones con el mismo mecanismo.** Cuando el estado estructurado —diseñado para el determinismo— se usa también para sostener la continuidad, aparece una espiral predecible: cada caso de continuidad agrega un flag, cada flag agrega una limpieza, cada limpieza agrega un reconciliador. El sistema no se vuelve incorrecto: se vuelve **irrazonable**.

Esta arquitectura separa las dos presiones en capas con dueños distintos. **La continuidad conversacional y el determinismo transaccional dejan de competir por el mismo espacio de representación.**

---

## 2. Las nueve categorías

```
   ┌──────────────────────────────────────────────────────────────┐
   │  OWNERSHIP    ¿quién habla?          → dueño: el sistema     │
   │               Determinista. Exclusivo. Termina.              │
   ├──────────────────────────────────────────────────────────────┤
   │  FACTS        ¿qué es verdad?        → dueño: el sistema     │
   │               Verificable. Fuente única. No opina.           │
   ├──────────────────────────────────────────────────────────────┤
   │  ── FAMILIA INTENT ── derivada de Facts. No rutea. No autoriza.│
   │                                                              │
   │  GOALS        ¿qué falta hacer?      → obligatorio           │
   │  OPPORTUNITIES ¿qué convendría ofrecer? → opcional           │
   │  ALERTS       ¿qué debemos avisar?   → deber de informar     │
   ├──────────────────────────────────────────────────────────────┤
   │  LEDGER       ¿qué ya intentamos?    → dueño: el sistema     │
   │               Memoria del comportamiento, no del negocio.    │
   ├──────────────────────────────────────────────────────────────┤
   │  CONSTRAINTS  ¿qué se permite?       → dueño: el negocio     │
   │               Vetan. Viven en el borde de las Tools.         │
   ├──────────────────────────────────────────────────────────────┤
   │  TOOLS        ¿qué se ejecuta?       → dueño: el código      │
   │               Única superficie hacia el mundo exterior.      │
   ├──────────────────────────────────────────────────────────────┤
   │  LLM EXPRESSION LAYER  ¿cómo se dice? → dueño: el modelo     │
   │               Tres verbos. Ninguno transaccional.            │
   └──────────────────────────────────────────────────────────────┘
```

**Goals, Opportunities y Alerts forman la familia Intent** (ADR-0008): comparten estructura, derivación, presupuesto y ciclo de vida. Se distinguen por **presión** y por **quién toma la iniciativa**. No son tres mecanismos: son tres modos de uno.

---

## 3. Las cuatro invariantes

Son la constitución del sistema. **Un cambio que viole una invariante no es un cambio: es un cambio de arquitectura, y requiere un ADR que modifique este documento primero.**

### Invariante 1 — La familia Intent no rutea *(ADR-0001)*

El routing pertenece exclusivamente a **Ownership**.

Un objetivo abierto jamás decide quién procesa un turno. La razón profunda: si un Intent rutea, *tener algo pendiente* se vuelve indistinguible de *estar en un flujo*. Y un Intent pendiente puede quedar abierto indefinidamente — mientras que un flujo activo **debe** terminar. Confundirlos produce un sistema donde una intención vieja secuestra turnos ajenos, y donde no hay forma de tener algo pendiente sin bloquear.

> **Un Intent abierto debe poder coexistir con cualquier otra cosa que esté pasando. Ese es todo el punto de que exista.**

### Invariante 2 — La familia Intent no autoriza *(ADR-0002)*

La autorización pertenece exclusivamente a **Constraints** y **Tools**.

Que el sistema *quiera* cerrar un pedido no lo habilita a cerrarlo. Un Intent es una motivación; una autorización es un permiso. Que el modelo esté convencido de que puede cobrar es irrelevante para la pregunta de si puede cobrar.

**Corolario operativo:** el Constraint se verifica **en el borde de la Tool**, no en el prompt. Un permiso que solo existe como instrucción en lenguaje natural no es un permiso: es una sugerencia con buena reputación.

### Invariante 3 — La familia Intent no contiene datos del negocio *(ADR-0003)*

Los datos pertenecen exclusivamente a **Facts**.

Un Intent **referencia** ("el pedido en curso"); nunca **copia** ("total: 2500"). Toda copia es una segunda fuente de verdad, y toda segunda fuente de verdad diverge — no por mal código, sino por el paso del tiempo.

**Única excepción legítima:** el material que *no es un Fact* — el texto literal de lo que el cliente dijo al ser interrumpido. Es historia conversacional; no existe en ninguna otra parte.

### Invariante 4 — La familia Intent no ejecuta efectos externos *(ADR-0004)*

Las **Tools** son la única superficie autorizada para modificar el mundo.

Un Intent abierto puede hacer que el agente *quiera* actuar. Solo una Tool ejecutada, con sus Constraints satisfechos, hace que algo pase. **No existe el Intent que se auto-cumple.**

---

## 4. FACTS

### Qué son
**Lo que el sistema sabe que es verdad, verificable sin interpretación.** El estado del negocio y del mundo. Un Fact no opina, no motiva, no recuerda intenciones. Simplemente *es*.

### Propiedades
| Propiedad | Significado |
|---|---|
| **Verificable** | Se comprueba consultando la fuente. No requiere inferencia. |
| **Fuente única** | Existe en exactamente un lugar. Si aparece en dos, uno es una copia y va a divergir. |
| **Sin opinión** | No dice qué hacer. "El carrito tiene 2 ítems" no dice si hay que cerrarlo. |
| **Autoritativo** | Ante discrepancia con cualquier otra capa, el Fact gana. Siempre. |
| **Temporal** | Cambia. Toda decisión basada en un Fact se recalcula cuando el Fact cambia. |

### Qué puede vivir acá
Contenido y estado del pedido · datos del cliente · catálogo, precios, disponibilidad · horarios y cobertura · estado transaccional (pago acreditado, orden confirmada) · contexto materialmente verdadero de la conversación (último producto mostrado, personas que van a comer).

### Qué NO puede vivir acá
- ❌ **Intenciones.** "El cliente quiere cerrar" es una inferencia. El Fact es "hay un pedido con ítems sin confirmar".
- ❌ **Historial del comportamiento del bot.** "Ya le preguntamos 3 veces" es **Ledger**.
- ❌ **Control de flujo.** "Estamos esperando que responda X" es **Ownership** o **Intent**, según qué signifique.
- ❌ **Nada regenerable.** **Un valor derivado y persistido es un bug con fecha de activación diferida.**

### Criterio de identificación
> **¿Podría un auditor externo, mirando solo los datos, verificar esto como verdadero o falso sin conocer la conversación?**

### Preguntas de code review
1. ¿Este dato existe en otro lugar del sistema? *(Si sí: una de las dos copias debe morir.)*
2. ¿Se puede derivar de otros Facts? *(Si sí: derivalo, no lo guardes.)*
3. ¿Describe el mundo, o lo que el bot pretende hacer con el mundo? *(Lo segundo no es un Fact.)*
4. Si lo borro y lo recalculo, ¿obtengo lo mismo? *(Si no: era una fuente independiente y no lo sabías.)*

---

## 5. La familia INTENT: Goals, Opportunities, Alerts

### 5.1 Qué comparten *(ADR-0008)*

Las tres son **intenciones abiertas del sistema que sobreviven al turno en que nacieron**. Comparten:

- **Derivación desde Facts.** Preferentemente derivadas, excepcionalmente declaradas (ADR-0005).
- **Estructura.** Abiertas o cerradas; sin pasos, sin transiciones, sin jerarquía.
- **Presupuesto de insistencia**, contabilizado en el **Ledger**.
- **Prohibiciones.** No rutean, no autorizan, no contienen datos, no ejecutan.
- **Un solo Intent activo por turno** (ADR-0009).

**Son la capa de continuidad conversacional. Es su única función.** Si un Intent hace cualquier otra cosa, está mal ubicado.

### 5.2 El diagnóstico que las hace necesarias

Un sistema puede tener todo el estado del mundo y aun así perder el hilo. Si al modelo se le informa *"carrito: 2 ítems"*, se le entrega un **número inerte**: describe el mundo pero no comunica ninguna intención sobre él. Es tan neutro como *"horario: 12–15h"*. El modelo no retoma el pedido porque **nadie lo puso en su función objetivo**.

> **La pérdida de continuidad no es un problema de memoria. Es un problema de representación.**
> El estado describe el mundo. Nada representa la intención abierta *sobre* el mundo.

### 5.3 Las tres, diferenciadas

|  | **GOAL** | **OPPORTUNITY** | **ALERT** |
|---|---|---|---|
| **Qué es** | Intención **obligatoria** | Intención **opcional** | **Deber de informar** |
| **Iniciativa** | Del **cliente** (empezó algo) | Del **negocio** (quiere ofrecer) | Del **sistema** (debe avisar) |
| **El sistema…** | la **persigue** | la **propone** | la **emite** |
| **Si nunca se cumple** | 🔴 El cliente quería algo y no lo obtuvo | 🟢 No pasa nada | 🔴 El cliente se perjudica |
| **Presión típica** | bloqueante / reanudable | ambiental | bloqueante, **una vez** |
| **Se cierra por** | cambio en un **Fact** | **decay** o un Fact | **emisión** (registrada en Ledger) |
| **Presupuesto** | 3 → **enmudece, no muere** | 1 → **se abandona** | 1 → **se cierra** |
| **¿La puede silenciar el cliente?** | Sí (abandono explícito) | Sí | **No, si es crítica** |
| **Ejemplos** | cerrar el pedido, obtener la dirección, definir el pago | sugerir postre, ofrecer una promo, sugerir cargar dirección | el local cierra en 20 min, el pago falló, un ítem del pedido se quedó sin stock |

**Las tres diferencias que realmente importan:**

**1. Quién toma la iniciativa.** Un Goal nace de algo que **el cliente empezó** — por eso el sistema tiene derecho a insistir: el cliente lo quería. Una Opportunity nace de algo que **el negocio quiere** — por eso el sistema *no* tiene derecho a insistir: nadie la pidió. Una Alert nace de algo que **el sistema debe decir** — por eso ni siquiera el cliente puede silenciarla si es crítica.

**2. Qué pasa si nunca se cumple.** Es el test más rápido para clasificar. Si un Goal muere sin cumplirse, un cliente que quería algo no lo obtuvo — eso es una falla. Si una Opportunity muere sin cumplirse, **no pasa absolutamente nada** — es lo esperable la mayoría de las veces. Si una Alert muere sin emitirse, el cliente se perjudica y posiblemente el negocio incumple.

**3. Cómo se cierran.** Goal y Opportunity se cierran cuando el mundo cambia. **La Alert se cierra al emitirse** — su propósito era decir algo, y decirlo lo cumple. Esa es la única semántica de cierre por emisión del sistema, y es la excepción que confirma la regla: **el cierre lo sigue registrando el sistema en el Ledger** (se emitió, quedó constancia), **no el modelo declarando "listo"** (ADR-0010). La Invariante se mantiene intacta.

**Excepción — Alerts que exigen resolución.** Una Alert crítica que requiere acción del cliente ("tu pago fue rechazado") **no se cierra al emitirse**: se cierra cuando cambia el Fact. Emitirla no basta; resolverla sí. En la práctica esas Alerts se comportan como Goals bloqueantes, y está bien que así sea.

### 5.4 Derivados vs Declarados *(ADR-0005)*

**No es taxonomía: determina si el Intent se persiste, y por lo tanto si puede corromperse.**

**Derivados** — proyección pura de Facts. Se recalculan cada turno. **No se persisten.** Si el Fact desaparece, el Intent desaparece. **Son estructuralmente incapaces de quedar huérfanos, desincronizados o zombis.** No necesitan limpieza, ni TTL, ni reconciliación.

*Un Intent derivado no se "crea" ni se "cierra": se deriva, o no se deriva.* Esa es toda su mecánica.

**Declarados** — nacen en la conversación y **no son derivables de ningún Fact**. Hay que persistirlos, y por lo tanto pueden corromperse, envejecer, revivir cuando no corresponde. Requieren TTL, limpieza y auditoría.

> **Regla:** un Intent se declara **solo si se demuestra que no se puede derivar.** La carga de la prueba está del lado de quien quiere persistir. **Cada declarado es deuda administrada; cada derivado es gratis.**

**Los tres casos que genuinamente exigen declaración —y son casi los únicos:**

1. **El abandono explícito.** El cliente dijo "dejalo". Los Facts no cambiaron —el pedido sigue ahí— pero la intención del sistema debe cambiar. **Es el único bit que separa un asistente de un acosador.** *(Vive en el Ledger, §7.)*
2. **La tarea interrumpida.** Lo que el cliente estaba diciendo cuando el sistema lo cortó con una pregunta. Historia conversacional; no existe en ninguna tabla.
3. **La promesa.** El bot se comprometió a algo que no puede cumplir todavía. No hay Fact que lo represente.

### 5.5 Qué NO puede vivir en un Intent

- ❌ Datos del negocio *(Inv. 3)* · ❌ Autoridad para ejecutar *(Inv. 2)* · ❌ Poder de routing *(Inv. 1)* · ❌ Efectos *(Inv. 4)*
- ❌ **Jerarquía.** No hay sub-goals. El conjunto es **plano**.
- ❌ **Dependencias entre Intents.** Si A depende de B, la relación se expresa en el **Fact** que B produce y que el derivador de A observa. **La dependencia vive en el mundo, no entre las intenciones.**
- ❌ **Transiciones.** Un Intent no pasa de un estado a otro. Existe o no existe.
- ❌ **Prioridad almacenada.** La urgencia se computa por turno. Persistida, envejece.

> **Estas prohibiciones son el corazón del diseño.** Sin ellas, la familia Intent degenera en un motor de workflows dentro del prompt — la máquina de estados de la que se venía huyendo, pero ahora **no determinista**. Si alguien propone sub-goals o dependencias, la respuesta correcta es: *eso que querés modelar es un flujo, y los flujos ya tienen dónde vivir.*

### 5.6 Continuidad y control de presión *(ADR-0009)*

Los Intents hacen posible la continuidad **y también el acoso**. Son la misma capacidad vista desde dos lados.

Un sistema que recuerda todos sus objetivos y los menciona todos en cada respuesta es **peor** que uno que olvida. El olvido, al menos, es discreto.

Tres mecanismos obligatorios de contención:

1. **Un solo Intent activo por turno.** El resto es contexto: el agente sabe que existen, tiene **prohibido mencionarlos**.
2. **Presupuesto de insistencia**, con decay. *(En el Ledger.)*
3. **Primacía de la consulta actual.** El Intent **nunca** desplaza lo que el cliente acaba de preguntar. Se responde primero; se retoma después, y solo si el turno cierra bien.

**Orden de saliencia (determinista, nunca lo decide el modelo):**

```
Alert crítica  →  Goal bloqueante  →  Goal reanudable  →  Opportunity
```

**El matiz que separa un asistente de una máquina:** un **Goal** que agota su presupuesto **enmudece pero no muere**. El pedido sigue existiendo, el sistema sigue sabiendo que existe, deja de empujarlo. Si el cliente vuelve, la continuidad está intacta. Una **Opportunity**, en cambio, **sí se abandona**: nadie la pidió.

*Un mozo no te repite cuatro veces si querés cerrar la cuenta. Pero tampoco tira tu mesa a la basura.*

### 5.7 Relación con Ownership

**Ejes ortogonales.** Confundirlos es la fuente de bugs más costosa de esta clase de sistemas.

Un Intent **existe** con total independencia de quién lo puede plantear. Puede estar abierto mientras habla un agente que no es su dueño — eso es, literalmente, la definición de tener algo pendiente.

- *"Hay un pedido sin cerrar"* → **Intent**. Abierto durante toda la conversación, mientras pasan reservas, consultas y silencios.
- *"El agente de checkout procesa este turno"* → **Ownership**. Exclusivo, de este turno, y termina.

### 5.8 Preguntas de code review

1. ¿Describe algo que el sistema quiere que pase y todavía no pasó?
2. ¿Se puede **derivar** de Facts? *(Si sí: derivalo. Persistir es deuda voluntaria.)*
3. ¿Contiene datos que también viven en un Fact? *(Violación Inv. 3.)*
4. ¿Alguien lo lee para decidir **quién habla**? *(Violación Inv. 1 — es Ownership disfrazado.)*
5. ¿Alguien lo lee para decidir si se **permite** una acción? *(Violación Inv. 2 — es un Constraint disfrazado.)*
6. ¿Tiene sub-goals, dependencias o transiciones? *(Es una FSM mal ubicada.)*
7. ¿Puede quedar abierto para siempre sin romper nada? *(Si hay que limpiarlo, es Ownership.)*
8. **Goal, Opportunity o Alert:** si nunca se cumple, ¿qué se rompe? *(Nada → Opportunity. El cliente no obtuvo lo que quería → Goal. El cliente se perjudica → Alert.)*

---

## 6. CONSTRAINTS

### Qué son
**Una regla del negocio que no puede violarse, sin importar lo que el cliente quiera, lo que el agente crea, o lo que el modelo decida.** No se negocia. No tiene excepciones conversacionales.

### Propiedades
| Propiedad | Significado |
|---|---|
| **Vetante** | No motiva ni sugiere: **impide**. |
| **Verificable** | Se evalúa contra Facts. Respuesta binaria. |
| **Indiferente a la intención** | Que el cliente insista o que el modelo esté convencido es irrelevante. |
| **En el borde** | Se aplica donde el efecto ocurre, no donde el efecto se decide. |
| **Silenciosa** | No necesita explicarse para funcionar. La explicación es cortesía; el veto es la función. |

### Por qué NO deben vivir en prompts *(ADR-0002)*

**Una regla escrita en un prompt no es una regla. Es una sugerencia con buena reputación.**

1. **Un prompt es probabilístico.** Una instrucción se cumple *casi* siempre. Para una regla de tono, "casi siempre" es excelente. Para una regla de cobro, es un incidente esperando su turno. **La diferencia entre 99% y 100% no es de grado: es de naturaleza.**
2. **Los prompts se erosionan.** Crecen. Las reglas críticas quedan sepultadas entre instrucciones de estilo, compitiendo por atención con reglas sobre emojis. **Un Constraint enterrado en la línea 180 de un prompt ya está roto — solo que todavía no lo sabés.**
3. **No son auditables.** Ante un incidente, *"¿estaba activa la regla?"* no tiene respuesta cuando la regla es una oración en prosa.
4. **No sobreviven al cambio de modelo.** Cambiar de proveedor o de versión **re-tira los dados sobre todas las reglas escritas en prosa, a la vez, sin aviso.** Cada regla crítica en un prompt es **una regresión latente en el próximo upgrade**.

### Por qué SÍ en el borde de las Tools
Porque **es el único lugar por donde el efecto puede ocurrir** — el punto de estrangulamiento natural del sistema. Cualquier otra ubicación es un lugar donde la regla *puede* consultarse pero también *puede* saltearse, porque no está en el camino obligatorio hacia el efecto.

> **La prueba definitiva: si el modelo decidiera ignorar la regla, ¿el efecto ocurriría igual?**
> Si la respuesta es sí, **la regla no existe.** Existe la intención de la regla.

**El prompt conserva un rol legítimo:** explicarle al cliente por qué algo no se puede, con buen tono. Pero eso es *comunicación del veto*, no *el veto*. **Confundir el cartel con la cerradura es el error.**

### Constraint y Goal son capas complementarias, no alternativas
| Regla | Constraint (borde de la Tool) | Goal (superficie conversacional) |
|---|---|---|
| No eliminar sin confirmar | La Tool exige evidencia de confirmación | `CONFIRMAR_ELIMINACIÓN` hace que la conversación sea fluida |
| No cobrar sin método de pago | La Tool rechaza sin el Fact | `DEFINIR_METODO_DE_PAGO` lo pide con naturalidad |
| No delivery sin dirección en cobertura | La Tool exige el Fact válido | `OBTENER_DIRECCION` lo gestiona en la charla |

**El Constraint garantiza que no se puede. El Goal garantiza que la conversación al respecto es agradable.** Sin el Constraint: sistema inseguro con buenos modales. Sin el Goal: sistema seguro y brusco. **Se necesitan los dos y no se sustituyen.**

### Preguntas de code review
1. ¿Existe **únicamente** como texto en un prompt? *(Entonces no existe.)*
2. Si el modelo la ignorara, ¿el efecto ocurriría igual?
3. ¿Está en el borde de la Tool, o antes de decidir llamarla? *(Antes = evitable.)*
4. ¿Hay más de un camino hacia este efecto? *(Entonces hay un camino sin protección.)*
5. ¿Queda registro auditable de que se evaluó?

---

## 7. LEDGER

### Qué es
**La memoria del sistema sobre su propio comportamiento.** No recuerda el negocio (Facts). No recuerda intenciones (Intents). Recuerda **lo que el sistema ya hizo o intentó**.

### La distinción central: memoria transaccional vs conversacional *(ADR-0007)*

|  | **Memoria transaccional** (Facts) | **Memoria conversacional** (Ledger) |
|---|---|---|
| Qué recuerda | Lo que le pasó **al mundo** | Lo que hizo **el sistema** |
| Ejemplo | "El pedido tiene 2 ítems" | "Ya le ofrecí postre 2 veces" |
| Autoridad | **Es la verdad** | Es historia del bot |
| Ante discrepancia | Gana | Se descarta |
| Si se pierde | 🔴 Se corrompe el negocio | 🟡 El bot se vuelve repetitivo |
| Auditoría | Financiera / legal | De calidad conversacional |

### Qué pertenece
Presupuestos de insistencia (`surface_count`) · rechazos (`refusal_count`) · **abandono explícito** · cooldowns · expiraciones · trazabilidad (qué Intent se planteó en cada turno y por qué el sistema lo eligió).

### Qué NO pertenece
- ❌ Datos del negocio · ❌ Estado transaccional · ❌ Control de flujo *(si el Ledger decide quién habla, se convirtió en Ownership)*.
- ❌ **Cualquier cosa que, al perderse, corrompa el negocio.**

> **El test del Ledger: debe poder borrarse entero sin consecuencias financieras.** Si borrarlo rompe algo más que el tono del bot, algo que no pertenecía se coló adentro.

### Por qué el Ledger hace posible que los Intents sean puros
Es su función arquitectónica más profunda, y no es obvia.

Un Intent derivado se recalcula desde cero en cada turno: no recuerda nada, y **esa amnesia es su virtud** — no puede corromperse. Pero un sistema que no recuerda cuántas veces preguntó algo **pregunta lo mismo para siempre**.

El Ledger resuelve la tensión: **guarda el conteo por fuera del Intent, indexado de forma estable.** El Intent se recalcula limpio; el conteo sobrevive. Se obtienen las dos propiedades a la vez —pureza de derivación y memoria de comportamiento— que de otro modo serían incompatibles.

**Sin Ledger, cada Intent tendría que persistirse solo para llevar su contador, y toda la familia perdería su propiedad más valiosa.**

---

## 8. TOOLS

### Responsabilidades
**Única superficie por la que el sistema modifica el mundo.** Todo efecto externo pasa por acá. Sin excepciones y sin atajos.

Cada Tool debe: **aplicar sus Constraints antes de ejecutar** · ejecutar de forma determinista · **ser idempotente cuando el efecto es irreversible** (cobrar dos veces es peor que no cobrar) · devolver el resultado real, no el esperado · producir el cambio en los Facts del que después se derivarán los Intents.

### Qué nunca deberían hacer
- ❌ **Confiar en que el llamador validó.** El modelo puede llamarla con argumentos inventados, en el orden equivocado, sin los pasos previos. **La Tool asume siempre que su llamador es poco confiable.** No es paranoia: es la descripción literal de su llamador.
- ❌ **Interpretar intención.** Ejecuta o rechaza. No adivina qué "quiso decir".
- ❌ **Cambiar el Ownership.**
- ❌ **Cerrar Intents directamente.** Cambia Facts; los Intents se re-derivan solos. **Una Tool que cierra un Intent a mano está creando la segunda fuente de verdad que esta arquitectura existe para evitar.**
- ❌ **Tener efectos ocultos.** Si el nombre dice una cosa y hace dos, el modelo —y el humano que debuggea— razonan sobre una ficción.

### Relaciones
| Con… | Relación |
|---|---|
| **Constraints** | Viven **en su borde**. Son su sistema inmune, no una etapa previa. |
| **Intents** | Los Intents **motivan** llamarla. Nunca la autorizan ni la reemplazan. La Tool cambia Facts, y ese cambio cierra el Intent — **indirectamente, siempre indirectamente**. |
| **Ownership** | Determina **qué Tools están disponibles** este turno. Es el mecanismo de aislamiento entre agentes. |
| **Facts** | Son la **única forma legítima de cambiarlos**. |

---

## 9. OWNERSHIP

### Qué es
**Responde a una sola pregunta: ¿quién procesa este turno?** Exclusivo (un dueño por turno), determinista (nunca lo decide un modelo), transitorio (**termina**).

### Por qué es diferente de la familia Intent *(ADR-0001)*
Se confunden porque suelen coincidir. **La coincidencia es circunstancial, y tratarla como identidad produce los bugs más caros del sistema.**

|  | **Ownership** | **Intent** |
|---|---|---|
| Pregunta | ¿quién habla? | ¿qué falta? |
| Exclusividad | Uno por turno | Muchos simultáneos |
| Duración | Este turno | Indefinida |
| **Debe terminar** | **Sí** | **No** |
| Lo decide | El sistema, determinista | Se deriva de Facts |
| Si queda huérfano | 🔴 **Bloquea el sistema** | 🟢 **Es lo normal** |

**La fila decisiva es "debe terminar".** Un Ownership abandonado es un bug crítico: bloquea turnos ajenos. Un Intent abandonado es el comportamiento esperado: es exactamente lo que significa tener algo pendiente.

> **Regla de clasificación:** si un campo **debe limpiarse** para que el sistema no se rompa → es **Ownership**. Si puede quedar abierto indefinidamente sin consecuencias → es **Intent**. Un campo que hace las dos cosas hereda lo peor de ambas: bloquea como Ownership y persiste como Intent.

### Cómo decidir quién habla
Determinista (nunca un modelo — **un router probabilístico convierte cada turno en un tiro de dados sobre la seguridad transaccional**) · explícito (prioridad legible, no una cascada sedimentada) · basado **solo** en Ownership · total (siempre hay exactamente un dueño; "ninguno aplica" también es una ruta).

### Ownership como contención de blast radius
Ownership no es solo routing: determina **qué Tools están al alcance**. Un agente conversacional que no tiene la Tool de cobro **no puede cobrar mal** — no porque se comporte bien, sino porque la capacidad no existe en su alcance.

> **Esa es la forma más fuerte de seguridad disponible en un sistema con LLMs: no la que confía en el buen comportamiento, sino la que hace inalcanzable el mal comportamiento.**

---

## 10. LLM EXPRESSION LAYER

### Qué es
**La capa donde vive el modelo, y la única donde vive.** El LLM lee Facts, Intents, Constraints y Ownership. **No los administra.**

### Los tres verbos *(ADR-0010)*
El modelo tiene exactamente tres capacidades, y **ninguna es transaccional**:

1. **Expresar** — traducir un Intent habilitado a lenguaje natural apropiado.
2. **Priorizar conversacionalmente** — elegir qué es relevante decir ahora, **dentro del permiso que el sistema le otorgó**.
3. **Elegir el momento** — juzgar si es natural retomar algo en este turno.

### La matriz de permisos
| El LLM… | ¿Puede? |
|---|---|
| Leer los Intents abiertos | ✅ Se los inyecta el sistema |
| Decidir **cómo** expresar el Intent habilitado | ✅ Es su trabajo |
| Decidir si **este turno concreto** es natural para retomarlo | ✅ Dentro del permiso otorgado |
| Plantear un Intent que el sistema **no** habilitó | ⚠️ Se registra como divergencia y se audita |
| **Crear** un Intent | ⚠️ Solo instanciando tipos de un **catálogo cerrado**, vía Tool tipada |
| **Cerrar** un Goal o una Alert crítica | ❌ **Nunca.** Lo cierra un Fact. |
| **Cambiar** presión o prioridad | ❌ Es política del negocio |
| **Inventar** un tipo de Intent | ❌ El catálogo es cerrado *(ADR-0011)* |
| **Rutear** | ❌ Es Ownership |
| **Autorizar** un efecto | ❌ Es Constraint + Tool |

**El catálogo cerrado es la defensa contra la alucinación** (ADR-0011). Si el modelo pudiera inventar Intents con semántica nueva, el sistema tendría un lenguaje de scripting no versionado creciendo dentro de su base de datos. **El modelo puede instanciar tipos existentes; nunca definirlos.**

### El límite, en una frase
> **El LLM decide qué decir. El código decide qué pasa.**
> Si ese límite se borronea, todo lo demás de este documento es decorativo.

---

## 11. Tabla maestra de clasificación

| Concepto del dominio | Facts | Goals | Opport. | Alerts | Ownership | Constraints | Tools | Ledger |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Contenido y total del pedido | ✅ | | | | | | | |
| "Falta cerrar el pedido" | | ✅ | | | | | | |
| "El cliente dijo que lo deje" | | | | | | | | ✅ |
| "Ya le ofrecí cerrar 3 veces" | | | | | | | | ✅ |
| Dirección del cliente | ✅ | | | | | | | |
| "Falta la dirección" | | ✅ | | | | | | |
| "No hay delivery sin dirección" | | | | | | ✅ | | |
| Capturar la dirección | | | | | | | ✅ | |
| "Rechazó la dirección 2 veces" | | | | | | | | ✅ |
| "Convendría que cargue la dirección" | | | ✅ | | | | | |
| Método de pago elegido | ✅ | | | | | | | |
| "Falta elegir el pago" | | ✅ | | | | | | |
| "No se cobra sin método de pago" | | | | | | ✅ | | |
| Cobrar | | | | | | | ✅ | |
| **"El pago fue rechazado"** | | | | ✅ | | | | |
| Orden confirmada | ✅ | | | | | | | |
| "No se confirma una orden vacía" | | | | | | ✅ | | |
| El agente de checkout tiene el turno | | | | | ✅ | | | |
| El agente de reservas tiene el turno | | | | | ✅ | | | |
| El agente de onboarding tiene el turno | | | | | ✅ | | | |
| El orden de los pasos del checkout | | | | | | ✅ | | |
| "No se elimina sin confirmar" | | | | | | ✅ | | |
| "Falta confirmar la eliminación" | | ✅ | | | | | | |
| Eliminar un ítem | | | | | | | ✅ | |
| Horarios del negocio | ✅ | | | | | | | |
| **"El local cierra en 20 minutos"** | | | | ✅ | | | | |
| "No se opera fuera de horario" | | | | | | ✅ | | |
| Catálogo, precios, disponibilidad | ✅ | | | | | | | |
| **"Un ítem del pedido se quedó sin stock"** | | | | ✅ | | | | |
| **"Sugerir postre / bebida"** | | | ✅ | | | | | |
| **"Ofrecer la promo del día"** | | | ✅ | | | | | |
| Qué decía el cliente al ser interrumpido | | ✅ | | | | | | |
| Cuándo expira una oferta | | | | | | | | ✅ |
| Última vez que se planteó un Intent | | | | | | | | ✅ |
| Personas que van a comer | ✅ | | | | | | | |
| Reserva creada | ✅ | | | | | | | |
| "Falta completar la reserva" | | ✅ | | | | | | |
| **"La reserva es en 1 hora"** | | | | ✅ | | | | |

**Cómo se usa esta tabla:** una fila **nunca** tiene dos marcas. Si un concepto real las necesita, **el concepto está mal nombrado y esconde dos cosas adentro.** Su valor en code review no es clasificar lo que ya está bien — es **detectar los conceptos que se resisten a ser clasificados**, que son siempre los que están rompiendo el sistema.

**El patrón que ordena la tabla entera:**

> **El valor es Fact. Su ausencia obligatoria es Goal. Su ausencia opcional es Opportunity. Lo que debemos avisar es Alert. La regla es Constraint. La acción es Tool. Quién habla es Ownership. Cuántas veces lo dijimos es Ledger. Cómo se dice es el LLM.**

Nueve preguntas distintas sobre el mismo dato, nueve dueños. Si hay que recordar una sola cosa del documento, es esa frase.

---

## 12. Anti-patrones

Todos son reales, todos parecen buenas ideas al introducirse, y todos aparecen por la misma razón: **resolver un problema de continuidad con un mecanismo de control de flujo.**

### 12.1 El pending action infinito
**Qué es.** Una bandera que dice "estamos esperando que el usuario responda X".
**Por qué aparece.** El bot preguntó algo y necesita interpretar la respuesta del próximo turno. Necesidad legítima.
**Por qué parece buena idea.** Es directo, explícito, funciona a la primera.
**Por qué se convierte en deuda.** Porque *el usuario no responde*. Cambia de tema, se va, vuelve tres días después. El pending sobrevive a todo eso. Alguien agrega una limpieza. Después otra, en otro lugar. Después un TTL. Después un reconciliador, porque el usuario **sí** respondió pero por otro camino.
**Síntoma diagnóstico:** *el mismo pending se limpia en cinco lugares distintos del código.* Cuando eso pasa, no tenés un flag: tenés un Intent que nadie modeló, y estás implementando su ciclo de vida a mano, disperso, sin dueño.
**Alternativa.** El pending son **dos cosas fusionadas**:
- *"Falta el dato X"* → **Goal derivado.** Si el dato apareció por cualquier camino, el Goal desaparece solo. **No hay nada que limpiar, y por lo tanto nada que olvidar limpiar.**
- *"La última pregunta que hice fue X"* → **Ledger.** Se sobrescribe naturalmente.

### 12.2 Intents que rutean
**Qué es.** El objetivo abierto determina qué agente procesa el turno.
**Por qué parece buena idea.** Es tentadoramente elegante: *"si hay un objetivo de checkout abierto, que hable el checkout"*. Suena a auto-organización. Elimina una capa aparentemente redundante.
**Por qué se convierte en deuda.** Porque los Intents **pueden quedar abiertos para siempre — esa es su naturaleza y su valor.** Un objetivo que nadie va a completar captura turnos eternamente. El cliente pregunta por el horario y le contesta el agente de checkout, porque hace veinte turnos empezó un pedido. Y **se pierde la capacidad de tener algo pendiente sin bloquear**, que es *literalmente* la única razón por la que los Intents existen.
**Alternativa.** Ownership rutea. Los Intents informan. **Un Goal de checkout abierto mientras habla el agente conversacional es el caso normal y deseable**, no una anomalía.

### 12.3 Constraints dentro del prompt
**Qué es.** *"No cobres sin método de pago"* como una oración en las instrucciones.
**Por qué parece buena idea.** El modelo obedece. Casi siempre. Y en una demo, "casi siempre" es indistinguible de "siempre".
**Por qué se convierte en deuda.** El prompt crece; la regla crítica queda sepultada entre instrucciones de tono. Y llega el upgrade de modelo: **cambiar de versión re-tira los dados sobre todas las reglas en prosa, a la vez, sin aviso y sin test que lo detecte.** El sistema no falla en el deploy: falla la semana siguiente, en un caso raro, con dinero real.
**Alternativa.** El Constraint vive en el borde de la Tool. El prompt *explica* la regla; **la regla se aplica donde el modelo no puede alcanzarla.** *El cartel que dice "no pasar" no es la cerradura.*

### 12.4 La FSM persistida
**Qué es.** Guardar el paso actual de un flujo: *"el checkout está en el paso 'dirección'"*.
**Por qué parece buena idea.** Porque **es cierto que el flujo es una máquina de estados**. No hay cobro sin método de pago. **El error no es reconocer la FSM: es dónde ponerla.**
**Por qué se convierte en deuda.** Un paso persistido es una **segunda fuente de verdad** que puede divergir del estado real. El usuario da la dirección por otro camino y el paso guardado sigue diciendo "dirección". Ahora hacen falta reconciliadores, limpiezas, TTLs — cada uno con su propio bug.
**Alternativa:**
> **La máquina de estados puede vivir en una función. Nunca en una fila.**

Una función pura que, dados los Facts, devuelve el próximo paso: sin estado propio, recalculada cada turno, **estructuralmente incapaz de desincronizarse.** No hay nada que reconciliar porque no hay dos cosas que puedan diferir.

**Prueba de fuego:** si borrás todo el estado de flujo y el sistema se comporta igual —porque todo se rederiva— tenés una proyección, no una FSM persistida. **Lo único que legítimamente sobrevive a ese borrado es lo que no se puede derivar: el abandono explícito y los contadores de insistencia.**

### 12.5 Duplicación de fuentes de verdad
**Qué es.** El mismo dato en dos lugares.
**Por qué parece buena idea.** Funciona. Y durante meses las copias coinciden.
**Por qué se convierte en deuda.** Porque divergen. **No por mal código: por el paso del tiempo.** Un camino de actualización que nadie recordó, un rollback parcial, un worker a destiempo. Y cuando divergen, nadie sabe cuál creer — **y ambas tienen defensores en el código.**
**Alternativa.** Fuente única. Las demás capas referencian, nunca copian *(Inv. 3)*. **Un valor derivado y persistido es un bug con fecha de activación diferida.**

### 12.6 El reconciliador
**Qué es.** Una función que compara dos representaciones del mismo hecho y decide cuál vale.
**Por qué parece buena idea.** **Arregla el bug.** De verdad. Inmediatamente. Y quien lo escribe es visto —correctamente— como el que salvó el día.
**Por qué se convierte en deuda.** Porque **cristaliza la duplicación en vez de eliminarla.** Ahora la duplicación tiene un guardián oficial, tests y una razón de ser documentada. Lo que era un bug pasó a ser una feature con mantenimiento. El próximo caso de divergencia agrega una rama al reconciliador, no una pregunta sobre por qué existe.
**Alternativa.** **Un reconciliador es un síntoma, nunca una solución.** Su existencia prueba que hay dos fuentes de verdad donde debería haber una. La respuesta no es mejorarlo: es **eliminar la fuente duplicada** — y el reconciliador desaparece solo.
> **Regla:** cada reconciliador es un ticket de deuda con nombre y apellido. **Contarlos es una métrica de salud arquitectónica. La meta es cero.** *(ADR-0012)*

### 12.7 El Intent que ejecuta
**Qué es.** Un objetivo que, al derivarse, dispara un efecto.
**Por qué se convierte en deuda.** Viola la Invariante 4 y destruye la propiedad más valiosa de la capa: **los Intents dejan de ser idempotentes.** Ya no se pueden recalcular libremente, porque recalcular ahora *hace cosas*. Se pierde la derivación gratis, y con ella toda la arquitectura.
**Alternativa.** El Intent **motiva**. El agente **decide**. La Tool **ejecuta**. La separación es lo que permite que derivar sea gratis, seguro y repetible.

### 12.8 El Intent que no se calla
**Qué es.** El sistema recuerda todos sus objetivos y los menciona en cada respuesta.
**Por qué parece buena idea.** Técnicamente el sistema funciona **perfecto**: recuerda todo, retoma siempre. Todas las métricas de continuidad en verde.
**Por qué se convierte en deuda.** Porque el cliente lo odia. **Un asistente que recuerda todo y lo menciona todo es peor que uno que olvida** — el que olvida, al menos, es discreto. Y es especialmente peligroso porque **es invisible en las métricas técnicas**: solo aparece en retención, abandono y quejas.
**Alternativa.** Un Intent activo por turno, presupuesto, decay, primacía de la consulta actual. Los Goals **enmudecen pero no mueren**; las Opportunities **se abandonan**.
> **Continuidad sin control de presión es acoso.** Es el riesgo que esta arquitectura introduce, y el que nadie ve venir porque el sistema, técnicamente, está funcionando bien.

### 12.9 La Opportunity con derecho a insistir
**Qué es.** Tratar una sugerencia comercial con el mismo presupuesto de insistencia que un objetivo del cliente.
**Por qué aparece.** Comparten el mismo mecanismo (son la misma familia), así que es un descuido de una línea: alguien le pone presupuesto 3 a una Opportunity.
**Por qué se convierte en deuda.** **Un Goal se persigue porque el cliente empezó algo. Una Opportunity la quiere el negocio, no el cliente.** Insistir con un Goal es servicio; insistir con una Opportunity es venta agresiva. El mecanismo es idéntico y por eso la confusión es fácil — pero la legitimidad es opuesta.
**Alternativa.** Opportunity: presupuesto **1**, se abandona sin ruido. Es la única categoría de la familia que **muere del todo**, y debe ser así.

---

## 13. Checklist de code review

**Regla de oro: si una pieza responde "sí" a preguntas de dos secciones distintas, está mal modelada y esconde dos cosas adentro.**

### ¿Esto es realmente un Intent?
- [ ] ¿Describe algo que el sistema quiere que pase y todavía no pasó?
- [ ] ¿Puede quedar abierto indefinidamente sin romper nada? *(Si hay que limpiarlo → Ownership.)*
- [ ] ¿Se puede **derivar** de Facts? *(Si sí → derivalo. Persistir es deuda voluntaria.)*
- [ ] ¿Está libre de datos del negocio? *(Inv. 3.)*
- [ ] ¿Sin sub-goals, dependencias ni transiciones? *(Si no → FSM mal ubicada.)*

### ¿Es Goal, Opportunity o Alert?
- [ ] Si nunca se cumple, **¿qué se rompe?** → Nada = **Opportunity** · El cliente no obtuvo lo que quería = **Goal** · El cliente se perjudica = **Alert**
- [ ] ¿Quién tomó la iniciativa? → El cliente = **Goal** · El negocio = **Opportunity** · El sistema = **Alert**
- [ ] ¿Tiene presupuesto > 1 y es una sugerencia comercial? *(Violación §12.9.)*

### ¿Esto debería ser un Fact?
- [ ] ¿Un auditor externo podría verificarlo mirando solo los datos, sin conocer la conversación?
- [ ] ¿Es la fuente única, o hay otra copia?
- [ ] ¿Es regenerable desde otros Facts? *(Si sí → no lo guardes.)*

### ¿Esto es una Constraint disfrazada?
- [ ] ¿Debe cumplirse aunque el cliente insista y el modelo se equivoque?
- [ ] Si el modelo la ignorara, ¿el efecto ocurriría igual? *(Si sí → **la regla no existe**.)*
- [ ] ¿Vive únicamente como texto en un prompt?
- [ ] ¿Se aplica en el borde de la Tool, o antes de decidir llamarla?

### ¿Esto está intentando hacer routing?
- [ ] ¿Alguien lee este dato para decidir **quién habla**? *(Entonces es Ownership, se llame como se llame.)*
- [ ] Si queda huérfano, ¿bloquea turnos? *(Entonces es Ownership y necesita un final.)*

### ¿Esto está duplicando una fuente de verdad?
- [ ] ¿Este dato existe en otro lugar?
- [ ] ¿Estoy escribiendo un **reconciliador**? *(Si sí → **pará**. Eliminá la duplicación en vez de administrarla.)*
- [ ] Si lo borro y lo recalculo, ¿obtengo lo mismo?

### ¿Esto pertenece al Ledger?
- [ ] ¿Recuerda lo que **hizo el sistema**, no lo que le pasó al negocio?
- [ ] Si se borra entero, ¿lo único que se rompe es el tono del bot?

---

## 14. Apéndice — materialización actual

> ⚠️ **Esta sección envejece a propósito.** Cuando se contradiga con el código, **gana el código** y esta sección se actualiza. El núcleo (§1–§13) **nunca** se modifica para acomodar una implementación.
>
> *Última revisión: 2026-08-03. Detalle vivo: [`ROADMAP-MIGRACION.md`](docs/arquitectura/ROADMAP-MIGRACION.md) · [`VIOLACIONES.md`](docs/arquitectura/VIOLACIONES.md).*

### Qué ya está implementado con el modelo nombrado

Fases **−1, 0, 1 y 1b** del roadmap: cerradas. Hay Goals derivados explícitos, Ledger mínimo, Tools de abandono/handback y arbitraje de saliencia. **No** hay todavía engine genérico de Opportunities/Alerts ni migración completa de flags (Fases 2–3).

| Pieza | Qué es en el modelo | Dónde |
|---|---|---|
| `deriveOrderCompletionGoal` | **Goal `COMPLETAR_PEDIDO`** (derivado) | `src/services/orderCompletionGoal.service.ts` |
| `deriveReservationCompletionGoal` | **Goal `COMPLETAR_RESERVA`** (derivado) | `src/services/reservationCompletionGoal.service.ts` |
| `nextCheckoutStep` + `checkoutGoalForStep` | **Derivador / exposición de Goals de checkout** (`DEFINIR_ENTREGA`, `OBTENER_DIRECCION`, …) | `src/services/checkout/nextCheckoutStep.ts`, `checkoutGoal.service.ts` |
| `nextReservationDraftQuestion` | **Derivador de orden** del borrador de reserva (Constraint del flujo, no prioridad de Intents) | `src/graph/nodes/session/buildResumeFollowUp.ts` |
| `intentLedger` + `patchIntentLedgerEntry` | **Ledger** (abandonment, surfaceCount, lastSurfacedAt) por tipo de Intent | `conversation_state.metadata` · `src/services/intentLedger.repository.ts` |
| `abandon_pending_order` / `abandon_pending_reservation` | **Tools de Ledger** — silencian sin borrar Facts | `src/tools/index.ts` |
| `handback_reservation` | **Salida temporal de Ownership** que conserva el Fact (`reservation_draft`) | `src/tools/reservation.ts` |
| Arbitraje pedido vs reserva en `reactAgent` | **ADR-0009** — un Intent activo por turno (`suppressedBySaliency`) | `src/agents/reactAgent.ts` |
| Confirmación en `remove_cart_item` | **Constraint en el borde de la Tool** (V-01) | `src/tools/index.ts` |
| `escalationGateNode` | **Constraint / gate** pre-Ownership (V-02) | `src/graph/nodes/gates/escalation.ts` |
| `checkout_active`, `reservation_agent_active`, `onboarding_agent_active` | **Ownership** | metadata de sesión + router en `context/index.ts` |

### Piezas legacy que todavía mapean al modelo (sin consolidar)

Siguen siendo evidencia de que el modelo emergió solo — y también la deuda que la Fase 2 debe migrar o eliminar.

| Pieza actual | Qué es en el modelo | Nota |
|---|---|---|
| `peopleCountResume` | **Goal declarado** (tarea interrumpida) | Limpieza dispersa en ~7 lugares (V-11). |
| `name_refusal_count`, `address_refusal_count` | **Ledger** | Presupuesto a mano, fuera de `intentLedger` (V-10). |
| `nextActionHintsShown`, `lastCtaShownAt` | **Ledger** | Cooldowns / anti-repetición aún no unificados. |
| `lastOffer` | **Opportunity declarada** | TTL que nadie lee (V-12). |
| `awaiting_address` | **Ownership + Goal + Opportunity fusionados** | V-09 — no migrar a ciegas. |
| `buildResumeFollowUp()` | **Renderer de Intents** (parcial) | Sigue derivando re-preguntas; convive con la inyección de Goals en `[ESTADO DEL CLIENTE]`. |
| Wizard legacy de reservas | **Ownership / FSM mal ubicada** | V-14. |

### Qué todavía no existe como arquitectura general

- Engine genérico de Intents (hoy: dos Goals + exposición de checkout/reserva).
- Opportunities y Alerts del catálogo (`SUGERIR_COMPLEMENTO`, `NEGOCIO_POR_CERRAR`, etc.) — Fase 3.
- Ledger en tabla propia — sigue en metadata (Bloque E).
- “Todo efecto pasa por Tools” y “LLM solo expression layer” son **norma**; el ReAct actual aún muta estado vía Tools y handlers/workers legacy escriben directo.

### Métrica de salud arquitectónica

Tres números, medibles, sin ambigüedad. Valores orientativos a 2026-08-03 — la fuente viva es [`VIOLACIONES.md`](docs/arquitectura/VIOLACIONES.md):

| Métrica | Hoy (aprox.) | Meta |
|---|:-:|:-:|
| Reconciliadores en el código | **0** (pending de checkout eliminado) | **0** |
| Flags en el estado de conversación | **~34–36** | **≤ 9** |
| Reglas transaccionales solo en prompts | **≥ 1** (V-05 abierta) | **0** |

---

## 15. En una frase

> **El valor es Fact. Su ausencia obligatoria es Goal. Su ausencia opcional es Opportunity. Lo que debemos avisar es Alert. La regla es Constraint. La acción es Tool. Quién habla es Ownership. Cuántas veces lo dijimos es Ledger.**
>
> **El LLM decide qué decir. El código decide qué pasa.**
