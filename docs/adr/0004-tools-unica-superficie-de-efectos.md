# ADR-0004 — Las Tools son la única superficie de efectos externos

**Estado:** Aceptado · **Fecha:** 2026-07-11 · **Invariante 4**

## Contexto

En un sistema donde un modelo probabilístico participa del control de flujo, la pregunta *"¿por dónde puede este sistema modificar el mundo?"* debe tener una respuesta corta, enumerable y auditable. Si los efectos pueden originarse en varias capas —un agente que escribe directo, un derivador que dispara una acción, un worker que muta estado— esa pregunta deja de tener respuesta, y con ella desaparece la capacidad de razonar sobre la seguridad del sistema.

## Decisión

**Todo efecto externo pasa por una Tool. Sin excepciones y sin atajos.**

Ninguna otra capa modifica el mundo. En particular, **un Intent nunca ejecuta**: motiva, y nada más.

Cada Tool es responsable de:
1. **Aplicar sus Constraints antes de ejecutar** — es el borde, y el borde es donde se veta.
2. Ejecutar de forma determinista.
3. **Ser idempotente cuando el efecto es irreversible.** Cobrar dos veces es peor que no cobrar.
4. Devolver el resultado real, no el esperado.
5. Producir el cambio en los Facts del que después se re-derivan los Intents.

**Una Tool asume siempre que su llamador es poco confiable.** No es paranoia: es la descripción literal de su llamador. El modelo puede invocarla con argumentos inventados, en el orden equivocado, sin los pasos previos.

## Consecuencias

**Se gana:**
- La superficie de ataque del sistema es enumerable: es la lista de Tools.
- **Ownership se vuelve un mecanismo de contención real:** un agente que no tiene la Tool de cobro **no puede cobrar mal** — no porque se comporte bien, sino porque la capacidad no está a su alcance. Es la forma más fuerte de seguridad disponible en un sistema con LLMs: no la que confía en el buen comportamiento, sino la que hace inalcanzable el mal comportamiento.

**Se pierde:**
- Conveniencia. Escribir directo a la base desde un handler es más rápido. Está prohibido igual.

**Queda prohibido:**
- Que una Tool **cierre un Intent directamente.** Cambia Facts; los Intents se re-derivan solos. Una Tool que cierra un Intent a mano está creando la segunda fuente de verdad que esta arquitectura existe para evitar.
- Que una Tool cambie el Ownership.
- Tools con efectos ocultos: si el nombre dice una cosa y hace dos, el modelo —y el humano que debuggea— razonan sobre una ficción.
- Que un derivador de Intents produzca efectos. Eso los volvería no idempotentes y destruiría la propiedad que hace gratis la derivación.

## Alternativas descartadas

**Permitir escrituras directas en flujos "confiables"** (workers, handlers determinísticos). Se descarta porque la confianza es transitiva y decae: el handler confiable de hoy es llamado mañana desde un camino que nadie revisó. Además rompe la enumerabilidad, que es toda la propiedad que buscamos.
