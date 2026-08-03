# ADR-0002 — Los Constraints viven en el borde de las Tools

**Estado:** Aceptado · **Fecha:** 2026-07-11 · **Invariante 2**

## Contexto

Varias reglas transaccionales del sistema existen **únicamente como texto en prompts**: *"si el carrito está vacío, no inicies el checkout"*, *"confirmá antes de eliminar un ítem"*, *"no gestiones el pago vos"*. El prompt principal supera las 200 líneas y esas reglas conviven con instrucciones sobre emojis y tono.

Hay al menos un caso donde la regla **solo** vive ahí: la Tool de eliminación de ítems borra directo, sin exigir evidencia de confirmación. El prompt le pide al modelo que confirme; nada lo obliga.

## Decisión

**Toda regla que deba cumplirse sin excepción se aplica en el borde de la Tool, donde el efecto ocurre. El prompt puede explicarla, nunca aplicarla.**

**La prueba definitiva, aplicable en cualquier code review:**

> **Si el modelo decidiera ignorar la regla, ¿el efecto ocurriría igual?**
> Si la respuesta es sí, **la regla no existe.** Existe la intención de la regla.

## Consecuencias

**Se gana:**
- Las reglas críticas dejan de ser probabilísticas. La diferencia entre 99% y 100% no es de grado: es de naturaleza.
- Se vuelven auditables: ante un incidente, la pregunta *"¿estaba activa la regla?"* tiene respuesta.
- **Sobreviven al cambio de modelo.** Cambiar de proveedor o de versión re-tira los dados sobre todas las reglas escritas en prosa, a la vez, sin aviso y sin test que lo detecte. Un Constraint en código es indiferente al modelo.

**Se pierde:**
- Agregar una regla deja de ser editar una línea de prompt. Cuesta más. Ese costo es el precio de que la regla exista de verdad.

**Queda prohibido:**
- Que una regla transaccional exista únicamente en un prompt.
- Aplicar el Constraint *antes* de decidir llamar la Tool en vez de *dentro* de ella: si hay más de un camino hacia el efecto, hay un camino sin protección.

**Relación con la capa Intent — no son alternativas, son complementarias:**

| | Constraint | Goal |
|---|---|---|
| Garantiza | que **no se puede** | que la **conversación es fluida** |
| Si falta | sistema inseguro con buenos modales | sistema seguro y brusco |

Se necesitan los dos y no se sustituyen. El Goal `CONFIRMAR_ELIMINACIÓN` es la superficie conversacional del Constraint, no su reemplazo.

## Alternativas descartadas

**Reglas en el prompt, con evals de regresión.** Más barato y más flexible. Se descarta porque los evals cubren los casos que se te ocurren, y las violaciones ocurren en los que no. Además no resuelve la erosión: nadie mide qué instrucción se degradó cuando el prompt pasó de 80 a 250 líneas.

**Validación en la capa del agente, antes de llamar la Tool.** Se descarta porque no está en el camino obligatorio hacia el efecto: es evitable. **Solo el borde de la Tool tiene la propiedad de que no hay camino alternativo.** *El cartel que dice "no pasar" no es la cerradura.*
