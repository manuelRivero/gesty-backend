# ADR-0012 — Los reconciliadores están prohibidos

**Estado:** Aceptado · **Fecha:** 2026-07-11

## Contexto

El sistema tiene hoy al menos un reconciliador: una función que compara el flag de "paso pendiente del checkout" contra el estado real del pedido, y limpia el flag cuando descubre que el dato ya fue provisto por otro camino.

**La función es correcta y arregla un bug real.** Sin ella, el bot vuelve a preguntar algo que el cliente ya respondió. Quien la escribió resolvió un problema de producción, y lo resolvió bien.

**Ese es exactamente el problema.**

## Decisión

**Un reconciliador es un síntoma, nunca una solución. Su existencia es evidencia de que hay dos fuentes de verdad donde debería haber una.**

**Está prohibido escribir un reconciliador.** Cuando aparezca la necesidad, la respuesta correcta no es escribirlo: es **eliminar la fuente duplicada**. Hecho eso, el reconciliador desaparece solo, porque ya no hay nada que reconciliar.

## Consecuencias

**Se gana:**
- No se cristaliza la duplicación. **Un reconciliador le da a la duplicación un guardián oficial, tests y una razón de ser documentada: lo que era un bug pasa a ser una feature con mantenimiento.** Y el próximo caso de divergencia agrega una rama al reconciliador, no una pregunta sobre por qué existe.
- La deuda se paga cuando duele, no cuando ya se volvió infraestructura.

**Se pierde:**
- Velocidad para apagar el incendio. Eliminar la duplicación cuesta más que reconciliarla.

**Excepción operativa, con fecha:** ante un incidente en producción, escribir el reconciliador para detener el sangrado es aceptable **si en el mismo PR se abre el ticket para eliminar la fuente duplicada, y el reconciliador se marca como deuda con fecha de eliminación.** Un reconciliador sin ticket es una violación de este ADR.

**Métrica de salud arquitectónica:**
> **Reconciliadores en el código. Meta: cero.**
> Cada uno es un ticket de deuda con nombre y apellido. Contarlos es una de las tres métricas de salud del sistema.

## Alternativas descartadas

**Aceptar los reconciliadores como patrón legítimo en sistemas distribuidos.** En sistemas genuinamente distribuidos —donde dos fuentes de verdad son físicamente inevitables— la reconciliación es correcta y necesaria. **Este no es ese caso:** las duplicaciones acá son voluntarias, viven en la misma base de datos, en la misma transacción, y existen por conveniencia. Importar la solución de un problema que no tenemos es lo que produce complejidad accidental.
