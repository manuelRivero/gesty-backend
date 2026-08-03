# ADR-0013 — Toda migración sigue el ciclo shadow → dual-write → shadow-read → flip → cleanup

**Estado:** Aceptado · **Fecha:** 2026-07-11

## Contexto

El sistema está en producción con clientes reales. La migración toca el camino crítico de cada conversación: continuidad, checkout, cobro. **Una regresión no se manifiesta como un error 500: se manifiesta como un pedido perdido, y probablemente nos enteramos por el dueño del restaurante.**

Además, la mayoría de los flags que se van a migrar **no tienen especificación escrita**. Su comportamiento real es el que emergió de años de parches. **Nadie sabe con certeza qué hacen en todos los casos** — y esa es precisamente la razón por la que hay que migrarlos.

## Decisión

**Ningún flag se migra sin pasar por los cinco pasos, en orden, un flag por PR.**

```
1. SHADOW        Derivador nuevo corriendo, logueando. Nada leído, nada cambiado.
                 → mide la línea base. Riesgo: cero.

2. DUAL-WRITE    Se escribe el flag viejo Y el Intent nuevo. Se lee solo el viejo.
                 → comportamiento idéntico. Riesgo: cero.

3. SHADOW-READ   Se leen ambos, se comparan, se loguea la divergencia.
                 Se responde con el viejo.
                 → corre sobre tráfico real hasta divergencia ≈ 0 (mínimo 3 días).

4. FLIP          Se lee el nuevo, detrás de un flag por campo. Canary 10 → 50 → 100%.
                 → rollback = apagar un booleano.

5. CLEANUP       Se borra el flag viejo, su escritura y sus limpiezas dispersas.
```

**El paso 3 es el que la gente saltea, y es el único que importa.** Es lo único que confirma, con tráfico real, que el derivador se comporta igual que el flag que reemplaza — **incluyendo los casos que nadie documentó**, que son la mayoría.

## Consecuencias

**Se gana:**
- Rollback en un booleano, en cualquier momento, sin migración de datos que revertir.
- La divergencia se descubre **en logs**, no en una queja de un cliente.
- Los derivados no requieren migración de datos: arrancan vacíos y producen el estado correcto en el primer turno.

**Se pierde:**
- Velocidad. Cada flag cuesta días, no horas.

**Queda prohibido:**
- **Migrar varios flags en un PR.** El impulso de agrupar "porque son parecidos" produce el rollback que después no sabés atribuir.
- Saltear el shadow-read "porque el cambio es obvio".
- Migrar un flag transaccional antes de que el engine lleve semanas estable en producción.

**Puerta de salida — la primera fase puede matar el proyecto, y eso es un éxito.** La fase shadow mide la pérdida de continuidad real. **Si el número sale bajo, el problema era otro y hay que parar.** Una semana de trabajo que evita un refactor de meses es el mejor retorno posible, y hace falta disciplina para cruzar esa puerta en las dos direcciones.

## Alternativas descartadas

**Big bang detrás de un feature flag global.** Un solo switch, todo el modelo nuevo. Se descarta porque un rollback global no dice **cuál** de los quince cambios rompió, y en un sistema con clientes reales el diagnóstico post-rollback es la parte cara.

**Migrar sin shadow-read, confiando en los tests.** Se descarta porque los tests cubren el comportamiento **especificado**, y estos flags no tienen especificación: **tienen historia.** Solo el tráfico real la contiene.
