-- Rubro gastronómico de cada local, para armar el home/vitrina global de
-- Shopping (marketplace de restaurantes) con filtro por categoría.
-- Lista fija validada en la app (ver src/constants/businessCategory.ts),
-- guardada como texto simple (sin enum de Postgres) para no requerir un
-- ALTER TYPE si la lista de categorías crece.
-- NULL = sin categoría asignada todavía (locales existentes).
-- Ejecutar manualmente en Postgres (este repo no migra al arrancar).

ALTER TABLE business
  ADD COLUMN IF NOT EXISTS category TEXT;
