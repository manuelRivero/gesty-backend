# Agent Factory — cómo se construye un agente en este repo

**Estado:** normativo. Destilado de los cuatro agentes en producción: **híbrido** (`reactAgent`), **checkout** (`checkoutAgent`), **reservas** (`reservationAgent`) y **onboarding** (`onboardingAgent`).
**Última revisión:** 2026-08-15 (lecciones de onboarding: tipable fulfilled en el nodo, handoff post-liberación, formato WA, prompt delegate vs finish).

**Para quién es cada parte:**

- **Programador que quiere un agente nuevo:** llená el [formulario](#1-formulario) y pasáselo a un asistente de código junto con este archivo. No necesitás leer el resto.
- **Asistente de código que va a implementarlo:** leé todo. La §2 es la anatomía, la §3 son leyes que no se negocian, la §4 es la receta y la §6 son los errores que este repo ya cometió y registró.

**Fuentes de verdad que este archivo resume (si hay contradicción, gana el código y después ellas):**
`ARQUITECTURA.md` · `docs/adr/` (0001–0013) · `docs/arquitectura/TAXONOMIA.md` · `docs/arquitectura/VIOLACIONES.md` · `docs/arquitectura/PENDING-TIPABLES-AUTONOMIA.md` · `.cursor/rules/hybrid-pending-autonomy.mdc`

---

## 0. Antes de empezar: ¿necesitás un agente?

Un **agente de sesión** se justifica cuando el flujo cumple **las tres**:

1. **Toma turnos completos** durante varios mensajes (tiene Ownership), no responde una sola pregunta.
2. **Recolecta datos en lenguaje natural** que no se pueden capturar con botones (tipables).
3. **Tiene un estado incompleto** que se puede derivar de Facts y decir "qué falta".

Si no cumple las tres, casi seguro necesitás otra cosa:

| Si… | Usá |
|---|---|
| Es una pregunta puntual respondible con datos | Una **tool** nueva en el híbrido (`tools/index.ts`) |
| Es una acción de un botón | Un **handler de payload** |
| Es un dato que falta pero no bloquea el turno | Un **Goal** derivado + prompt del híbrido |
| Es un mensaje que hay que interceptar siempre (ej. pedir humano) | Un **gate** pre-Ownership (`nodes/gates/`) |
| Es un tipo de mensaje especial (imagen, ubicación) | `messageTypeGuard` + nodo dedicado |

**Regla de dedo:** un agente nuevo cuesta ~6 archivos y una rama de routing. Una tool cuesta 30 líneas. Empezá por la tool.

**Excepción: agente por identidad, no por sesión.** Si el motivo de separar el agente es *quién habla* (otro actor, otras tools, otro blast radius) y no *recolectar un borrador*, no uses flag de sesión ni `nextXStep`. Ownership = gate de identidad **antes** de la cadena de clientes; el Constraint vive en las tools (`withGate`). Precedente: `owner_assistant` (`PLAN-ACCION-OWNER-ASSISTANT.md`). Meterle un `*_agent_active` sin condición de liberación es exactamente ADR-0001.

---

## 1. Formulario

Copiá este bloque, completalo y entregalo junto con este archivo. Todo lo que no completes, el asistente lo va a inventar — y probablemente mal.

```yaml
# ── IDENTIDAD ────────────────────────────────────────────────────────────
nombre: # snake_case. Ej: catering_quote
proposito: # una frase. "Cotizar eventos de catering para grupos grandes"
por_que_no_alcanza_el_hibrido: # obligatorio. Si no sabés responder, no hagas el agente.

# ── OWNERSHIP (quién habla) ──────────────────────────────────────────────
flag_sesion: # metadata boolean. Ej: catering_active
como_se_abre: # payload de CTA | tool del híbrido | gate de Facts | gate de negocio. Debe ser EXPLÍCITO.
como_se_cierra: # lista. Ej: éxito (cotización enviada), tool finish_*, sesión stale
prioridad_vs_otras_sesiones: # ¿antes o después de checkout/reserva/onboarding? ¿por qué?
que_pasa_si_queda_abierta: # si no sabés, el flag es un bug esperando (ADR-0001)

# ── FACTS (los datos que recolecta) ──────────────────────────────────────
# Uno por dato. El "orden" define el paso derivado.
# Si un Fact abre Ownership, DEBE tener tool_que_lo_escribe + withGate (§3.10 / §3.16).
facts:
  - nombre:        # ej: fecha_evento
    donde_vive:    # tabla.columna o metadata.clave. NO inventar tabla nueva sin decirlo
    obligatorio:   # true/false — si false, documentá cómo se omite (finish/intent)
    como_se_captura: # tipable (prosa) | botón/lista | ambos
    tool_que_lo_escribe: # ej: save_event_date — OBLIGATORIO si el Fact rutea o bloquea
    orden:         # 1, 2, 3... define nextXStep
    omisible_si:   # opcional. Ej: "intent RESERVATION | VIEW_MENU → finish(not_needed)"

# ── CONFIRMACIONES TIPABLES (sí/no, elegir opción en prosa) ───────────────
# Cada pregunta que el bot hace y espera respuesta en texto libre (además de botón).
# Si no listás ninguna y hay botones Confirmar/Editar, igual hace falta el tipable (§3.11).
pendings_tipables:
  - pending_action: # ej: confirm_address
    paso:           # ej: confirm
    bot_question:   # la pregunta que vio el cliente
    schema:         # ej: { confirmed: boolean }
    valor_fulfilled_aplica_en: # nodo | tool-señal→nodo — NUNCA "solo el prompt"

# ── UI CERRADA (lo que va con botones) ───────────────────────────────────
pasos_con_botones: # ej: [confirmacion]. Vacío es válido: todo prosa.
payloads: # ej: CATERING_CONFIRM, CATERING_CANCEL

# ── BORDES DUROS (Constraints, ADR-0002) ─────────────────────────────────
# "Si el modelo decidiera ignorar la regla, ¿el efecto ocurriría igual?"
# Si la respuesta es SÍ, no es un borde: es una frase en un prompt.
constraints:
  - regla:        # ej: no crear la cotización sin fecha ni cantidad de personas
    tool_que_lo_aplica: # ej: create_quote
    fact_que_evalua:    # ej: fecha_evento != null && personas != null

# ── SALIDAS ──────────────────────────────────────────────────────────────
delegate_to_main: # true/false — consulta lateral, la sesión sigue viva
handback:         # true/false — abandona la sesión, el híbrido sigue el turno
finish/abandon:   # true/false — cierre permanente. ¿borra Facts o los conserva?
# Tras finish/éxito: ¿a quién se entrega el turno? (§3.14)
handoff_despues_de_cerrar:
  por_default: # welcome_menu | hybrid | ninguno
  por_intent:  # ej: RESERVATION → reservation_agent; VIEW_MENU → hybrid
  # PROHIBIDO re-invocar el híbrido con el tipable crudo del usuario si ese
  # mensaje era la respuesta a TU pregunta (ej. "Manu", "sí") — sangra dominio.

# ── EFECTOS IRREVERSIBLES ────────────────────────────────────────────────
crea_orden_cobra_o_notifica: # true/false
si_true_quien_confirma:      # confirmación explícita del cliente + draft completo

# ── OPERACIÓN ────────────────────────────────────────────────────────────
feature_flag: # ej: CATERING_AGENT_ENABLED
que_pasa_con_sesiones_viejas: # al desactivar el flag
```

**Mínimo viable para arrancar:** `nombre`, `proposito`, `flag_sesion`, `como_se_abre`, `como_se_cierra`, `facts` (con `tool_que_lo_escribe`), `constraints`, `pendings_tipables` (si hay confirmación por botón, el tipable es obligatorio). Lo demás se puede iterar.

---

## 2. Anatomía — los 6 archivos

Todo agente de sesión de este repo tiene exactamente esta forma. No hay excepciones entre los cuatro existentes.

```
src/agents/<nombre>Agent.ts          # el ReAct: prompt + tools + contexto + señales
src/tools/<nombre>.ts                # tools propias (writes + señales)
src/graph/nodes/<nombre>/index.ts    # el nodo: payloads, UI, señales, efectos
src/services/<nombre>/next<Nombre>Step.ts  # derivador de paso (función pura)
src/prompts/botPersonality.ts        # build<Nombre>AgentSystemPrompt (archivo compartido)
src/graph/nodes/context/index.ts     # rama de routing (archivo compartido)
```

Más el cableado: `graph/routers.ts` (`NODE` + `contextRoute`), `graph/mainGraph.ts` (nodo + edges), `graph/state.ts` (tipo de `contextRoute`), `config/env.ts` (feature flag), `services/productQuery/types.ts` (claves de metadata tipadas).

### 2.1 La división de trabajo — la decisión más importante

| Capa | Hace | NO hace |
|---|---|---|
| **Agente (LLM)** | Interpreta prosa tipable de recolección, decide qué preguntar, llama tools, redacta | Persistir, cobrar, decidir routing, ser el único camino de un "sí/no" a confirmación |
| **Tools** | Único lugar donde ocurren efectos (ADR-0004). Aplican Constraints **antes** de ejecutar (ADR-0002) | Redactar el mensaje al cliente |
| **Nodo** | Payloads de botón; **aplicar** `extractPendingTurnResponse` cuando status=`fulfilled` (§3.11); adjuntar UI según estado; efectos irreversibles; delegación / handoff | Interpretar texto libre con regex / diccionarios de frases |
| **Derivador** | Decir qué paso falta, a partir de Facts | Persistir el paso (ADR-0005/0006) |

**El error que este repo cometió cuatro veces:** poner en el nodo o en el prompt algo que era de la tool, o al revés. Ver §6.

**Corolario tipable (2026-08-15):** el nodo **sí** puede cerrar un pending cuando el clasificador LLM dice `fulfilled`. Eso no es "interpretar con regex": es el mismo borde que el payload del botón, con otra entrada. Dejarlo "solo al ReAct" es un bug de producto (el cliente escribe "sí" y el bot vuelve a preguntar).

### 2.2 `agents/<nombre>Agent.ts`

Cinco bloques, siempre en este orden:

1. **Cache de agentes por personalidad** — `Map<string, ReactAgent>` con key `<nombre>:<personalityId>`, más `reset<Nombre>AgentCacheForTesting()`.
2. **`build<Nombre>ContextMessage(ctx)`** — arma el bloque `[ESTADO DEL <NOMBRE>]` (§3.2) + bloque de PASO PENDIENTE (§3.3) + el mensaje del usuario, en ese orden.
3. **`extractSignals(messages)`** — recorre los `ToolMessage` (los que tienen `tool_call_id`), parsea el JSON del `content` y levanta `signal: '...'`. Ignora todo lo que no sea JSON.
4. **`extractFinalText(result)`** — último mensaje, string o array de parts. **Copiado literal** en los cuatro agentes.
5. **`run<Nombre>Agent(ctx)`** — resuelve personalidad, arma historial (`buildAgentHistoryMessages`), invoca con `configurable: { businessId, customerId, customerPhone, conversationId, conversationStartedAt }` y `recursionLimit` (8–10), y **obliga** el formato WhatsApp con `ensureBotUserMessageFormat` (§3.12) — no con un `startsWith('🤖')` que deja pasar prosa incompleta.

El `configurable` es el contrato con las tools: `getReactContext(config)` (`tools/_context.ts`) lo valida y tira si falta algo. **Nunca** le pases datos de negocio al agente por closure.

### 2.3 `tools/<nombre>.ts`

Dos tipos de tool, no mezclar:

**Tool de write** — persiste un Fact y aplica el Constraint:

```ts
func: async ({ value }, _runManager, config) => {
  const { businessId, customerPhone } = getReactContext(config);
  const facts = await loadLiveFacts({ businessId, customerPhone });
  if (nextStep(facts) !== 'este_paso') {
    return toJson({ error: 'prerequisite_required', missing: nextStep(facts) });
  }
  await persist(value);
  return toJson({ success: true, value });
}
```

El error es **estructurado y para el modelo** (`*_required`), no una excepción y no silencio: el agente tiene que poder reintentar el paso correcto.

Así se ve hoy en los agentes existentes. En un agente **nuevo** ese gate va declarado como envoltorio y no escrito adentro del `func`: ver §3.10.

**Tool de señal** — no hace efecto, solo le dice al nodo qué hacer:

```ts
func: async ({ reason }, _runManager, config) => {
  getReactContext(config); // valida contexto aunque no lo use
  return toJson({ signal: 'handback_to_main', reason });
}
```

Regla: **si el efecto es irreversible (crear orden, cobrar, notificar), la tool señala y el nodo ejecuta.** Precedente: V-18 — elegir método de pago disparaba el cobro; hoy `resolve_order_confirmation` solo señala.

### 2.4 `graph/nodes/<nombre>/index.ts`

Orden **obligatorio** de las secciones (agentes nuevos — incluye tipable fulfilled):

```
1. Payloads determinísticos           → return temprano, sin invocar al LLM
2. Tipos de mensaje especiales        → location, image, etc.
3. Tipable fulfilled (paso pendiente) → extractPendingTurnResponse; si fulfilled,
                                        aplicar el mismo camino que el botón (§3.11)
                                        ANTES del ReAct. Loguear status/source.
4. Liberación por Fact opcional       → si el paso es omisible y el intent clasificado
                                        pide otro dominio (menú/reserva/…), finish +
                                        handoff (§3.14 / §3.17). Sin "¿te parece?".
5. Activar el flag de sesión          → si no estaba
6. Invocar el agente                  → try/catch con fallback
7. Señal: delegate_to_main            → híbrido inline + resume por nextXStep, sesión viva
8. Señal: handback / finish           → limpiar sesión + handoff al destino correcto (§3.14)
9. Señales de dominio                 → efectos irreversibles acá
10. UI por estado                     → botones según paso derivado, NO según señal
11. Fallback                          → texto del agente (ya formateado) tal cual
```

Siempre devuelve `{ handlerResult, dataCollectionDelegated: true }`. Ese flag hace que `routeAfterHandlerOrSubflow` vaya directo a `SEND`, salteando los post-gates legacy.

**Ack al avanzar de paso:** si el nodo concatena "dato guardado" + pregunta del siguiente Fact, el ack **no** puede ser una pregunta abierta de otro dominio ("¿en qué te ayudo?"). Un ack corto + resume del paso derivado (§3.13).

### 2.5 `services/<nombre>/next<Nombre>Step.ts`

Función **pura**, sin BD ni metadata. Recibe Facts ya cargados, devuelve el paso. Referencia: `services/checkout/nextCheckoutStep.ts`.

```ts
export type XStep = 'paso_a' | 'paso_b' | 'done';
export const nextXStep = (facts: XFacts, config: XConfig): XStep => { … };
```

Es la **única** fuente de verdad del paso: la usan el ledger del prompt, el resume tras delegación, la UI del nodo y los gates de las tools. Si hay dos órdenes distintos en el código, ya tenés el bug de V-29.

### 2.6 Piezas compartidas que **no** hay que reescribir

| Pieza | Archivo | Para qué |
|---|---|---|
| `buildAgentHistoryMessages` | `agents/conversationHistory.ts` | Memoria de turnos previos |
| `extractPendingTurnResponse` | `services/ai/extractPendingTurnResponse.ts` | Clasificar la respuesta a una pregunta pendiente |
| `formatPendingExtractionBlock` | idem | Renderizar el bloque para el prompt |
| `delegateToMainWithDetection` | `graph/nodes/session/delegateToMain.ts` | Delegar al híbrido con detección real |
| `buildResumeFollowUp` | `graph/nodes/session/buildResumeFollowUp.ts` | Re-preguntar lo suspendido tras delegar |
| `buildDiscardedReentryMessage` | `graph/nodes/session/discardedSignalMessage.ts` | El híbrido intentó re-entrar a una sesión tomada |
| `withOrphanPayloadAsText` | `graph/nodes/session/orphanPayload.ts` | Botón viejo tocado dentro de la sesión |
| `getReactContext` | `tools/_context.ts` | Contrato de contexto de las tools |
| `formatBotUserMessage` / `ensureBotUserMessageFormat` | `services/productQuery/utils.ts` | Formato de salida WhatsApp (§3.12) |
| `resolvePersonalityForBusiness` | `services/botPersonality.service.ts` | Personalidad por negocio |
| `withGate` | `tools/_withGate.ts` | Gate declarado de prerequisito (§3.10) |

---

## 3. Las leyes

Cada una tiene una violación registrada detrás. No son preferencias de estilo.

### 3.1 Ley del borde: el gate va en la tool, no en el prompt

> **Test:** *"Si el modelo decidiera ignorar esta regla, ¿el efecto ocurriría igual?"* Si la respuesta es **sí**, no tenés un Constraint: tenés una frase.

ADR-0002. Violación canónica: V-01 (borrar ítems sin confirmación — el prompt lo pedía, nada lo obligaba).

### 3.2 Ley del ledger: el agente lee estado, no adivina

Todo agente inyecta un bloque `[ESTADO DEL X]` con Facts + paso + acción esperada:

```
[ESTADO DEL CHECKOUT]
- Nombre del cliente: no informado
- Tipo de entrega: TAKE_AWAY (opciones habilitadas: DELIVERY, TAKE_AWAY)
- Paso actual: name
- Goal: OBTENER_NOMBRE
- Acción esperada: pedir nombre en prosa; save_customer_name cuando lo provea
```

Las tres últimas líneas se derivan de `nextXStep`. Sin ellas el modelo salta pasos (era el hueco P1.1 del checkout).

**Los Facts se releen frescos post-tool-call.** El objeto del grafo queda stale: en checkout eso es `loadLiveCheckoutFacts`; en onboarding, releer metadata con `findOrCreateConversationState` (sin eso los botones aparecían un turno tarde — V-24).

### 3.3 Ley del tipable: lo interpreta el LLM — y el **borde aplica el resultado**

`.cursor/rules/hybrid-pending-autonomy.mdc`. **Prohibido** `tryHandle*Hybrid`, regex sobre el mensaje del usuario, diccionarios de frases o "lo resuelvo sin LLM porque es un número".

Cuando hay una pregunta pendiente y llega texto libre:

1. El nodo (o el builder de contexto) llama `extractPendingTurnResponse` — clasificador LLM acotado → `fulfilled` / `reprompt` / `delegate` / `off_pending`.
2. El bloque va al prompt del ReAct (ledger).
3. **Obligatorio en agentes nuevos (§3.11):** si `status === 'fulfilled'`, el **nodo aplica el mismo efecto que el botón** en ese turno, **antes** de invocar al ReAct (o sin invocarlo). No alcanza con "el prompt le dice al modelo que llame la tool".

**Sí es determinístico y válido:** payloads de botón; aplicar el resultado `fulfilled` del clasificador; validar el **argumento** que el modelo pasó a la tool contra catálogo/BD; gates de sesión/horario; fórmulas de sugerencia.

> Nota de historia (V-20): un fix de "detectar cambio de tema" con regex fue revertido explícitamente. Un bot con clientes de distintas nacionalidades no puede depender de listas de palabras en español.

> Nota de producto (onboarding 2026-08-15): el cliente escribió "Si" a "¿es correcta la dirección?" y el bot volvió a preguntar con botones porque el fulfilled era solo advisory al ReAct. El botón sí funcionaba. Asimetría inaceptable: **tipable y botón comparten el mismo camino de efecto**.

### 3.4 Ley del copy: la prosa del agente no se castiga

**Prohibido** reemplazar el texto del LLM porque "no llamó una tool reconocida". Pedir un dato en prosa es el comportamiento correcto de un tipable, no una falla.

El único fallback admitido es **texto vacío**, y debe derivar del paso (`nextXStep`), nunca de un orden paralelo.

Violación: V-29 (checkout). Y su variante en capa prompt: decirle al modelo que su texto se descarta cuando el código no hace eso — mentira que el modelo obedece y el código no puede corregir.

### 3.5 Ley de la UI: los botones salen del estado, no de la señal

Si el paso derivado es `payment`, los botones de pago se adjuntan **aunque** el LLM no haya llamado `present_payment_options`. La garantía estructural no puede depender de la memoria del modelo.

Violaciones: V-24 (onboarding), V-25 (checkout).

Corolario: **un solo mensaje**, no texto + followUp con la misma pregunta. Texto del LLM como *body* del interactivo. Violación: V-19 (dos mensajes contradictorios en el mismo turno).

### 3.6 Ley del Ownership: una sesión, una condición de salida

ADR-0001. Un flag de sesión sin condición de liberación es un bug crítico: el cliente queda atrapado.

Salidas canónicas (nombres estables entre agentes):

| Señal | Sesión | Facts | Cuándo |
|---|---|---|---|
| `delegate_to_main` | sigue viva | intactos | consulta lateral (horarios, precios) |
| `handback_to_main` / `handback_reservation` | se limpia | **se conservan** | el cliente quiere hacer otra cosa |
| `finish_onboarding` / `abandon_reservation` | se limpia | se borran/marcan | abandono definitivo |

Tras delegar, **anexar** (no reemplazar) el resume de lo pendiente: el cliente no tiene que adivinar que la sesión sigue (H-03).

Además: sesión **stale**. El checkout limpia solo si el flag está activo y el carrito está vacío (`clearCheckoutSessionIfStale`). Todo agente necesita su equivalente.

### 3.7 Ley del "qué sigue": no lo improvisa el agente de dominio

Tras completar su objetivo, el agente de sesión **no** inventa la respuesta general en prosa libre del ReAct de dominio. El **nodo** hace handoff (§3.14): welcome determinístico, otro agente de sesión, o híbrido con mensaje neutro — nunca el tipable crudo que cerraba el Fact.

Violación clásica: V-23 (onboarding mostraba un menú de bienvenida a alguien que tenía el carrito lleno). Variante 2026-08: invocar el híbrido con `"Manu"` tras `save_customer_name` → "ya guardé que sos 1 persona".

### 3.8 Ley del estado derivado: FSM como función, nunca como fila

ADR-0005/0006. No persistas `current_step`. Derivalo de Facts en cada turno. Un paso persistido necesita un reconciliador, y los reconciliadores están prohibidos (ADR-0012, V-06/V-08).

Excepción legítima: staging temporal (`temp_address`) es un **Fact**, no un paso. Si además rutea, ya fusionaste Ownership con Fact — V-09.

### 3.9 Ley de la observabilidad: loguear señales junto a cada corrección

Todo evento de corrección/fallback loguea, en el mismo JSON, el paso derivado **y** las señales/tools del turno. Sin eso no se puede distinguir "el agente hizo bien y el borde está mal" de "el agente se salteó la tool".

Formato: `console.log(JSON.stringify({ event: '[<nombre>-agent] <evento>', conversationId, ... }))`.

### 3.10 Ley del guardrail declarado — **aplica a agentes nuevos**

> Los agentes viejos pueden tener el gate escrito a mano dentro del `func`. Un agente **nuevo** usa `withGate` (`tools/_withGate.ts`).

El problema con el gate escrito a mano no es que falle: es que **es invisible**. No se puede listar qué tools tienen borde y cuáles no, no se puede testear el gate sin ejecutar el efecto, y cuando alguien agrega la tool número doce simplemente se olvida — que es exactamente el modo de falla de V-01.

**La forma correcta para un agente nuevo:** el gate es un envoltorio declarativo sobre la tool, no una línea adentro.

```ts
export const saveEventDate = withGate({
  assert: async (ctx) => {
    const facts = await loadLiveCateringFacts(ctx);
    const step = nextCateringStep(facts);
    if (step !== 'fecha_evento') {
      return { error: `${step}_required`, missing: step };
    }
    return null;
  },
})(
  new DynamicStructuredTool({ name: 'save_event_date', /* … */ }),
);
```

Lo que compra: el prerequisito es **dato inspeccionable**, no control de flujo; la relectura fresca de Facts pasa a ser parte del contrato en vez de algo que cada autor recuerda; el error estructurado tiene una sola forma en todo el agente; y el test del gate no necesita mockear la persistencia, porque el envoltorio corta antes.

**Convención de error, obligatoria para agentes nuevos:** `{ error: '<fact>_required', missing: '<paso>' }`. Nada de `{ saved: false, error }` en una tool y `{ error }` en la de al lado — el modelo tiene que poder reconocer "me faltó un prerequisito" sin aprenderse la forma de cada tool.

Esto no reemplaza a §3.1, la implementa. Y no aplica a la **validación de argumentos** (que la fecha sea parseable, que el party size entre en la capacidad): eso es lógica propia de la tool y vive adentro, como hoy.

#### Estado de los cuatro agentes actuales

El grado de cumplimiento del borde declarado (`withGate`) varía:

| Agente | Gate de prerequisito | Relectura fresca de Facts | Forma del error | Veredicto |
|---|---|---|---|---|
| **checkout** | Sí, derivado de `nextCheckoutStep` (`tools/checkout.ts`) | Sí, `loadLiveCheckoutFacts` | `fulfillment_required` / `address_required` / `name_required` | Lo más cerca del patrón. Es el gate correcto, escrito a mano dentro de cada `func` |
| **híbrido** | Parcial y ad-hoc: `party_size_required`, `variation_required`, `quantity_required` en `tools/index.ts` | Por tool, no por contrato | Convención `*_required` respetada | El borde existe y la forma del error es la buena, pero cada gate se inventa solo — no hay derivador de paso detrás |
| **reservas** | **No hay gate de prerequisito.** Solo validación de argumento (`invalid_date`, `past_date`, `party_size_too_large`) | No (lee snapshot stale — R-B) | Inconsistente: `{ saved: false, error }` en unas, `{ error }` en otras | El más lejos. No existe `nextReservationStep`, así que no hay contra qué gatear (R-E/R-G) |
| **onboarding** | Sí (`withGate` + `nextOnboardingStep`) | Sí, `loadLiveOnboardingFacts` | `*_required` | Alineado al patrón post OWNERSHIP-ENTRY; tipable confirm en el nodo (§3.11) |

**Qué hacer con ellos:** checkout/híbrido migrar a `withGate` es cosmético. Reservas: `PLAN-ACCION-RESERVAS-AUTONOMIA.md` (falta derivador). Onboarding ya usa `withGate` en writes.

**Precedente externo:** OpenAI Agents SDK expone esto como primitiva de framework (*tool guardrails*: corren antes y después de cada function tool, pueden bloquear la llamada, reemplazar el output o cortar el run). Rasa CALM llega al mismo lugar por otro camino, sacando la lógica de negocio del prompt hacia un ejecutor determinístico. Nosotros llegamos a la misma conclusión escribiendo V-01; la diferencia es que ellos la tienen como pieza del framework y nosotros como disciplina.

### 3.11 Ley del tipable fulfilled en el nodo — **aplica a agentes nuevos**

> Si hay botones Confirmar/Editar (u otra UI cerrada) **y** el cliente puede responder en prosa, el camino tipable y el camino botón deben terminar en **la misma función de efecto**.

Patrón obligatorio:

```ts
// En el nodo, ANTES de runXAgent — cuando nextXStep(facts) === 'confirm_...'
const extraction = await extractPendingTurnResponse({ ... });
if (extraction.status === 'fulfilled' && extraction.value) {
  return applySamePathAsButtonPayload(extraction.value); // p.ej. resolveStaged...
}
// reprompt / delegate → sigue al ReAct (o delegate_to_main)
```

- El clasificador LLM **sí** interpreta ("sí", "dale", "esa no es").
- El nodo **aplica**; no espera a que el ReAct recuerde llamar `resolve_*`.
- Log: `[x-agent] <pending>_tipable_extraction` con `status`, `confidence`, `source`.
- Tests: fulfilled → efecto; **cero** tests de regex de "sí"/"no".

Si solo inyectás el bloque al prompt y rezás, vas a reeditar el bug del onboarding en el próximo agente.

### 3.12 Ley del formato WhatsApp

Todo texto plano al cliente sale con el formato canónico (`🤖` + `*Título* emoji` + cuerpo).

- Usar `ensureBotUserMessageFormat(raw, title, emoji, fallback)` — **no** `raw.startsWith('🤖') ? raw : format(...)`. Un `🤖` suelto sin título parseable debe reenvolverse.
- Cuerpos de mensajes **interactivos** (header WA propio): prosa en el body, sin duplicar el header `🤖` encima del header del botón.
- Prompt: incluir `${BOT_WHATSAPP_OUTPUT_FORMAT_PROMPT}`; el código es el borde, el prompt no alcanza.

### 3.13 Ley del ack coherente al cambiar de paso

Cuando el nodo concatena "Fact guardado" + pregunta del siguiente paso:

- El ack es **afirmación corta** ("Listo, ya la anoté."), nunca una pregunta de otro dominio ("¿en qué te ayudo ahora?").
- El resume deriva de `nextXStep` / `buildResumeFollowUp`, con copy del producto (no jerga interna: "perfil", "sistema").
- Un solo mensaje; no ack que cierra conversacionalmente y en el renglón siguiente reabre otra pregunta contradictoria.

### 3.14 Ley del handoff post-liberación

Tras `finish_*` / éxito de perfil / abandono:

1. **No** re-invocar el híbrido pasando como `userMessage` el tipable que respondía a *tu* pregunta ("Manu", "sí"). Ese mensaje no es un pedido de comida: el híbrido inventa party size, carrito vacío, etc.
2. Handoff **por destino**: si el intent del mensaje de liberación es de otro agente (ej. `RESERVATION`), activar esa sesión e invocar ese agente en el mismo turno. Si no, welcome determinístico (`buildSmallTalkMenu`) o híbrido con mensaje neutro / body fijo.
3. Documentar `handoff_despues_de_cerrar` en el formulario (§1).

### 3.15 Ley del prompt: `delegate` vs `finish` sin contradicción

En `REGLAS DURAS` del prompt del agente:

- **delegate_to_main:** pregunta lateral y el cliente **sigue** en el flujo de datos.
- **finish / abandon:** el cliente quiere **hacer otra cosa ahora** (menú, reserva, omitir Fact opcional) o se niega al dato.

**Prohibido** una regla que diga "si menciona reservas → delegate" y otra que diga "si quiere reservar → finish". El modelo elige la primera y atrapa al cliente.

También prohibido pedir confirmación intermedia ("¿te parece si omitimos la dirección?") cuando el producto ya define que ese intent libera: `finish` en el mismo turno.

### 3.16 Ley Fact→Ownership→tool

Si un Fact participa del predicado de Ownership o del `nextXStep` que bloquea avance:

1. Tiene `tool_que_lo_escribe` (o señal→nodo con una sola función de persistencia).
2. Esa tool lleva `withGate` contra el paso derivado.
3. El predicado de routing **no** mira un Fact que el agente no puede cerrar.

Meter `!customer.name` en el router sin `save_customer_name` en el toolset es Ownership inválido (ADR-0001).

### 3.17 Ley de Facts opcionales

Si un Fact es omisible (`obligatorio: false`):

- Documentar `omisible_si` (intents / outcomes de finish).
- El nodo puede liberar con el **clasificador de intent** (no regex) cuando el paso actual es el omisible — mismo espíritu que §3.11.
- Tras liberar: refusal/ledger para no reabrir por Facts en el turno siguiente + handoff (§3.14).

---

## 4. Receta

### Paso 1 — Contrato (antes de escribir código)

Del formulario, derivá y escribí en el PR:

- Lista de Facts en orden → firma de `nextXStep` (cada uno con `tool_que_lo_escribe` si rutea).
- Tabla Constraint → tool que lo aplica → Fact que evalúa.
- Tabla `pendings_tipables` → cada uno con aplicación en el **nodo** (§3.11).
- Diagrama de salidas de sesión + `handoff_despues_de_cerrar` (§3.14).

Si algún Constraint no tiene tool, **no empieces**: ese es el borde que falta.
Si hay botones Confirmar/Editar sin tipable fulfilled en el nodo, **no empieces**: vas a reeditar el bug del "sí".

### Paso 2 — Derivador + test

`services/<nombre>/next<Nombre>Step.ts` y su test. Función pura: es el archivo más barato de escribir y el que más errores previene.

### Paso 3 — Tools

Writes con gate + señales. Test por tool: **el gate**, no la prosa del usuario.

### Paso 4 — Prompt

`build<Nombre>AgentSystemPrompt` en `prompts/botPersonality.ts`. Secciones estándar:

```
REGLAS DURAS
TOOLS DISPONIBLES        (una línea por tool, qué devuelve, cuándo llamarla)
PASO PENDIENTE           (cómo actuar ante fulfilled/reprompt/delegate/off_pending)
ORDEN DE RECOLECCIÓN     (paso 0 = leer el ledger; después uno por Fact)
DELEGACIÓN Y HANDBACK    (cuándo ceder el control)
MANEJO DE SITUACIONES
```

Cerrar con `${BOT_WHATSAPP_OUTPUT_FORMAT_PROMPT}` y envolver con `withPersonality`.

Prohibido en el prompt: reglas transaccionales sin tool que las obligue (V-05); afirmaciones falsas sobre lo que hace el sistema (§3.4).

### Paso 5 — Agente

Los cinco bloques de §2.2. `extractFinalText` se copia literal.

### Paso 6 — Nodo

Las secciones de §2.4, en orden (incluye tipable fulfilled **antes** del ReAct, y handoff post-finish).
Test: "sí" en pending confirm → mismo efecto que el payload; sin invocar al agente.

### Paso 7 — Cableado

`config/env.ts` (flag) → `services/productQuery/types.ts` (metadata tipada) → `graph/state.ts` (`contextRoute`) → `graph/routers.ts` (`NODE` + case) → `graph/mainGraph.ts` (`addNode` + el `for` de `routeAfterHandlerOrSubflow`) → `graph/nodes/context/index.ts` (rama de Ownership, con su lugar en la cadena de prioridad).

La prioridad importa: en `context/index.ts` las ramas se evalúan en orden y la primera gana. Documentá por qué tu agente va donde va.

### Paso 8 — Tests

- Derivador: un caso por paso.
- Tools: gate rechaza sin prerequisito, no persiste.
- Nodo: payloads, UI por estado, delegación, texto sin tool sale intacto.
- **Anti-tests:** ningún test de regex de frases del usuario.

---

## 5. Checklist de PR

```
CONTRATO
[ ] Cada Constraint tiene una tool que lo aplica (no solo una línea de prompt)
[ ] El gate va declarado (withGate), no escrito a mano dentro del func — §3.10
[ ] Todos los errores de prerequisito usan { error: '<fact>_required', missing }
[ ] Efectos irreversibles: la tool señala, el nodo ejecuta
[ ] El flag de sesión tiene condición de salida documentada + limpieza de sesión stale

ESTADO
[ ] nextXStep es puro y es la única fuente de verdad del paso
[ ] No se persiste el paso actual (solo Facts)
[ ] Los Facts se releen frescos después de los tool-calls

AUTONOMÍA
[ ] No hay tryHandle*Hybrid ni regex sobre el mensaje del usuario
[ ] Los tipables pasan por extractPendingTurnResponse
[ ] Cada pending con botones tiene short-circuit fulfilled en el NODO (§3.11) — mismo efecto que el payload
[ ] No se reemplaza el copy del agente por ausencia de señal de tool
[ ] El prompt no afirma mecanismos que el código no tiene
[ ] Prompt: delegate vs finish sin reglas contradictorias (§3.15)

UI / FORMATO
[ ] Botones según paso derivado, no solo según señal
[ ] Un solo mensaje por turno (texto como body del interactivo)
[ ] Texto plano pasa por ensureBotUserMessageFormat (§3.12)
[ ] Ack al cambiar de paso es coherente (§3.13) — no "¿en qué te ayudo?" + siguiente Fact

SESIÓN / HANDOFF
[ ] delegate / handback / finish implementadas y distinguidas
[ ] Resume tras delegar deriva del paso real
[ ] Tras finish/éxito: handoff por destino (§3.14); no híbrido con el tipable crudo
[ ] Facts opcionales: liberación documentada + refusal (§3.17)
[ ] Todo Fact de Ownership tiene tool + withGate (§3.16)

OBSERVABILIDAD
[ ] Cada corrección/fallback loguea paso + señales del turno

TESTS
[ ] Derivador, gates de tools, nodo
[ ] Cero tests de regex de frases del usuario
```

---

## 6. Antipatrones con nombre

Cada uno se cometió acá, en producción, y está registrado en `docs/arquitectura/VIOLACIONES.md`.

| Antipatrón | Qué pasó | Registro |
|---|---|---|
| **Regla solo en prompt** | El prompt pedía confirmar antes de borrar; la tool borraba igual | V-01 |
| **Doble mensaje contradictorio** | Texto del LLM ("confirmada") + followUp con botones ("¿es correcta?") | V-19 |
| **Botones dependientes de la memoria del modelo** | Sin `present_*`, el mensaje salía sin botones | V-24, V-25 |
| **Policy de copy castigando tipables** | "Sin tool reconocida → reemplazo el texto" mataba el pedido de nombre en prosa | V-29 |
| **FSM paralela en el fallback** | El copy enlatado tenía su propio orden de pasos, distinto de `nextCheckoutStep` | V-29 (D2/D4) |
| **Agente de dominio componiendo la respuesta general** | Onboarding mostraba menú de bienvenida al guardar la dirección | V-23 |
| **Ownership fusionado con Fact** | `awaiting_address` / `onboarding_step` rutean y además son datos | V-09 |
| **Reconciliador de estado** | Pending del checkout persistido que había que reconciliar | V-06, V-08 |
| **Efecto disparado por el paso intermedio** | Elegir método de pago creaba la orden y cobraba | V-18 |
| **Intent muerto** | Handler registrado para un intent que nadie emite | V-27 |
| **Wizard legacy sobreviviendo como "compatibilidad"** | Keyword matching (`text.includes('confirmar')`) vivo en producción | V-14 |
| **Regex para interpretar significado** | Detección de "cambio de tema" por lista de palabras en español | V-20 (revertido) |
| **Write que pisa Facts vecinos** | Una tool de escritura reemplazaba la clave completa del borrador (merge shallow del primer nivel) en vez de leer y mergear — borraba en silencio lo que otras tools ya habían guardado | V-35 |
| **El agente lee el snapshot pre-payload** | El nodo "refrescaba" un objeto local tras persistir un payload, pero `normalizeMetadata` devuelve un objeto nuevo — no mutaba nada, y el context message seguía leyendo el estado previo al turno | R-B (`PLAN-ACCION-RESERVAS-AUTONOMIA.md`) |
| **Acción por producto sobre un carrito con líneas** | Las variaciones hicieron que un producto ocupe dos líneas, pero los botones (`CONFIRM_REMOVE:<productId>`) y `remove_cart_item(productId)` seguían resolviendo por producto: `findFirst` borraba una arbitraria. Peor: las filas mostraban `2x Pizza` sin la variación, así que el cliente veía **dos opciones idénticas**. La display sí distinguía las líneas y las acciones no | Variaciones 2026-08-30 (Tarea 4.5) |
| **Nodo alimentado por una señal que ya no se calcula** | `nameCollection` guardaba el nombre que la detección NLP extrajera espontáneamente. Cuando NLP-agent-first reemplazó al clasificador, `state.detection` pasó a ser un stub con `customerName: null` fijo: el nodo siguió corriendo en cada turno sin poder hacer nada. Un nodo no muere cuando se borra su llamador, sino cuando se vacía su entrada — y eso no lo detecta ningún compilador | Goal Engine 2026-08-30 (F.2) |
| **Parser de idioma disfrazado de tool** | `resolve_date(text, currentDate)` recibía el mensaje del cliente y lo resolvía con una lista de expresiones en español. Pasaba el filtro de "transforma un argumento, no intercepta el mensaje" solo en apariencia: el argumento **era** el mensaje. Cubría un idioma, agregaba un round-trip al ReAct, y ante lo que no entendía devolvía una fecha equivocada en vez de `null` | Reservas 2026-08-30 |
| **Dos relojes para el mismo "hoy"** | El ledger le decía al modelo qué día es hoy con un `new Date()` y el gate decidía qué es "fecha pasada" con otro. Un solo origen (`services/reservations/clock.ts`) es además el único punto donde después se aplica la zona horaria del negocio | Reservas 2026-08-30 |
| **Tipable fulfilled solo advisory al ReAct** | Cliente escribe "sí" a confirmar dirección; el bot re-pregunta con botones. El botón sí cerraba. | Onboarding 2026-08-15 → §3.11 |
| **Handoff con el tipable crudo** | Tras `save_customer_name("Manu")` se invocó el híbrido con "Manu" → party size / carrito vacío | Onboarding 2026-08-15 → §3.14 |
| **Ack contradictorio al avanzar paso** | "¿En qué te ayudo?" + "sigamos con tu nombre" en el mismo mensaje | Onboarding 2026-08-15 → §3.13 |
| **Prompt delegate vs finish contradictorio** | "si menciona reservas → delegate" y "si quiere reservar → finish"; el modelo atrapa al cliente | Onboarding 2026-08-15 → §3.15 |
| **Formato WA no enforced** | `startsWith('🤖')` deja pasar prosa sin *Título* | Onboarding 2026-08-15 → §3.12 |
| **Fact en Ownership sin tool de cierre** | Router mira `!name` sin `save_customer_name` en el agente | §3.16 / OWNERSHIP-ENTRY |

---

## 7. Estado de la factory — qué hay y qué falta

Respuesta honesta a "¿tenemos lo necesario?": **sí para escribir un agente correcto siguiendo esta guía; no para generarlo sin escribir código.**

**Lo que ya está resuelto y es reusable tal cual:** contexto de tools (`getReactContext`), historial, extractor de paso pendiente, delegación al híbrido con detección, mensajes de señal descartada, payload huérfano, formato de salida, personalidad por negocio. Un agente nuevo hoy reusa ~9 piezas y escribe ~6 archivos.

**Lo que hoy se copia a mano entre agentes (candidatos a extraer):**

| Duplicado | Dónde se repite | Posible extracción |
|---|---|---|
| `extractFinalText` | los 4 agentes, idéntico | `agents/_shared/extractFinalText.ts` |
| Cache de agentes por personalidad | los 4, idéntico salvo la key | `agents/_shared/agentCache.ts` |
| `extractSignals` | los 4, misma forma distinto enum | helper genérico tipado por union de señales |
| Bloque `[ESTADO DEL X]` | los 4, formato a ojo | `buildLedgerBlock(lines, step, goal, expectedAction)` |
| Esqueleto del nodo (9 secciones) | 3 nodos de sesión | `createSessionNode({...})` |
| Gate de prerequisito dentro del `func` | checkout (bien), híbrido (ad-hoc); reservas y onboarding no lo tienen | `tools/_withGate.ts` — §3.10 |

**Lo que está acoplado a un dominio y habría que generalizar:**

- `pendingActionRegistry.ts` vive en `services/checkout/` pero `extractPendingTurnResponse` lo importa para resolver `off_pending` — un agente nuevo con pendings propios no puede registrarlos ahí sin ensuciar checkout. Reservas (`confirm_reservation`, P1.2) esquivó el problema pasando `schema`/`valueHints`/`actionDescription` directo a `extractPendingTurnResponse` sin tocar el registry — funciona porque no necesita `off_pending` cross-field, pero confirma que el registry es checkout-specific, no genérico.
- `buildResumeFollowUp` es un `switch` sobre `kind: 'checkout' | 'reservation' | 'onboarding'`: agregar un agente obliga a tocar un archivo compartido en vez de registrar el resume del lado del agente.
- `SessionKind` en `discardedSignalMessage.ts`: mismo problema, union cerrada.

**Lo que no existe:** scaffolding (`npm run new:agent`), test harness de agente de sesión, y un lint/rule que falle el PR ante `tryHandle*Hybrid` o regex sobre el mensaje del usuario (hoy es una rule de Cursor, no un check de CI).

**Recomendación:** construí el próximo agente siguiendo esta guía a mano. Si al terminar volviste a copiar los cinco duplicados de la tabla, ese es el momento de extraerlos — con tres casos reales ya sabés cuál es la abstracción correcta, y con dos todavía no.
