# ADR-0003 — Los Intents referencian Facts, nunca los copian

**Estado:** Aceptado · **Fecha:** 2026-07-11 · **Invariante 3**

## Contexto

El estado de conversación acumuló copias de datos que ya viven en las tablas del negocio. La motivación siempre fue razonable: evitar un query, tenerlo a mano para el prompt, o simple sedimentación (alguien lo copió una vez y nadie lo sacó).

El problema no aparece al escribir el código: aparece meses después. Las copias divergen —no por mal código, sino por el paso del tiempo: un camino de actualización que nadie recordó, un rollback parcial, un worker que corre a destiempo. Y cuando divergen, **nadie sabe cuál creer, y ambas tienen defensores en el código.**

## Decisión

**Un Intent referencia Facts por identidad. Nunca los copia.**

`"el pedido en curso"` ✅ · `"el pedido con total 2500 y 3 ítems"` ❌

Los Facts tienen **fuente única**. Todas las demás capas los leen en el momento de usarlos.

**Única excepción legítima:** el material que **no es un Fact** — el texto literal de lo que el cliente dijo cuando fue interrumpido. Eso es historia conversacional: no existe en ninguna tabla del negocio y no puede derivarse de ninguna.

## Consecuencias

**Se gana:**
- Es imposible que un Intent contradiga la realidad del negocio.
- Los Intents derivados se vuelven proyecciones puras: recalculables, idempotentes, gratis.
- Desaparece la clase entera de bugs "el bot dijo un total que no era".

**Se pierde:**
- Cada uso de un Fact requiere leerlo. En la práctica el costo es despreciable y el sistema ya paga esos queries.

**Queda prohibido:**
- Persistir cualquier valor derivable de otros Facts. **Un valor derivado y persistido es un bug con fecha de activación diferida.**
- Escribir un reconciliador para mantener sincronizadas dos copias *(ver ADR-0012)*.

## Alternativas descartadas

**Copiar con invalidación por evento.** Cachear el dato y refrescarlo cuando cambia. Se descarta porque exige enumerar exhaustivamente todos los caminos de mutación — y el caso que rompe es siempre el que nadie enumeró. La invalidación de caché es notoriamente uno de los problemas difíciles; introducirlo voluntariamente en la capa de continuidad no se justifica por el ahorro de un query.

**Snapshot inmutable del Fact al crear el Intent.** Tiene semántica clara ("esto era verdad cuando nació el objetivo"), pero produce Intents que hablan de un mundo que ya no existe. Para continuidad conversacional eso es exactamente lo que no queremos: el objetivo debe hablar del pedido **de ahora**.
