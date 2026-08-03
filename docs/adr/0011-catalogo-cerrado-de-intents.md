# ADR-0011 — El catálogo de tipos de Intent es cerrado

**Estado:** Aceptado · **Fecha:** 2026-07-11

## Contexto

Si el modelo puede crear objetivos, la pregunta inmediata es: **¿puede crear tipos nuevos de objetivo, o solo instancias de tipos existentes?**

La respuesta permisiva es tentadora: un agente que puede decir *"recordá que el cliente quiere consultar por el vino la próxima vez"* parece más inteligente y más útil.

Pero un Intent no es una nota: **es algo que el sistema va a perseguir.** Y perseguir tiene consecuencias — el sistema va a plantearlo, insistir con él, gastarle presupuesto, y potencialmente empujarlo al cliente.

## Decisión

**El catálogo de tipos de Intent es cerrado. El modelo puede instanciar tipos existentes; nunca definirlos.**

Agregar un tipo nuevo al catálogo es un cambio de código, revisado, versionado y testeado. **Nunca ocurre en runtime.**

La condición de satisfacción de un Intent —qué Fact lo cierra— es **un nombre que apunta a un predicado en código**, no una expresión almacenada. Guardar un predicado serializado convertiría la base de datos en código no versionado, no testeable y con superficie de inyección.

## Consecuencias

**Se gana:**
- **Es imposible que el sistema persiga un objetivo alucinado.** El modelo puede equivocarse al instanciar; no puede inventar semántica.
- El conjunto de comportamientos posibles del sistema es enumerable y auditable.
- **Los Intents no degeneran en un lenguaje de scripting creciendo dentro de la base de datos** — que es exactamente lo que pasaría si la semántica fuera dato.

**Se pierde:**
- Flexibilidad. El sistema no puede recordar cosas arbitrarias que el cliente pida. **Ese límite es el precio de que lo que recuerda sea confiable.**

**Los Intents declarados por el usuario** ("recordame preguntarte por el vino") son legítimos, pero nacen con la **menor confianza del sistema**: presión ambiental, presupuesto 1, y auditoría de cada creación. Son la superficie natural de alucinación y se tratan como tal.

**Queda prohibido:**
- Crear tipos de Intent en runtime.
- Almacenar predicados de satisfacción como datos.
- Que un Intent creado por el modelo tenga presión bloqueante.

## Alternativas descartadas

**Catálogo abierto con validación posterior.** El modelo propone tipos, un humano los revisa. Se descarta porque la revisión llega tarde: el sistema ya persiguió el objetivo con el cliente. **En un sistema conversacional, la validación asíncrona de algo que ya se dijo no es validación: es arqueología.**

**Predicados de satisfacción como expresiones almacenadas.** Máxima flexibilidad, permite Intents nuevos sin deploy. Se descarta por las razones habituales del código-como-dato: no versionable, no testeable, superficie de inyección, y debuggeable solo en producción.
