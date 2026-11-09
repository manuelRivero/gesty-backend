# Despliegue — food-service-agent (Docker Hub + DonWeb VPS + Nginx Proxy Manager)

Build con código **ofuscado**, imagen publicada en **Docker Hub** y desplegada en un
VPS de DonWeb **sin subir el código fuente**. El reverse proxy y TLS los gestiona
**Nginx Proxy Manager** (NPM) ya instalado en el servidor.

## Resumen de la aplicación

| Aspecto | Valor |
|---------|-------|
| Framework | Express 5 + TypeScript |
| Puerto interno | `5001` |
| Comando de arranque | `node dist/index.js` |
| WebSockets | Sí (Socket.IO en el mismo servidor HTTP) |
| Migraciones al arrancar | **No** — el esquema Prisma (`prisma/schema.prisma`, `prisma/migrations/`) lo gestiona **este repositorio**, única fuente de verdad; aplicar las migraciones manualmente antes de desplegar (ver §7) |
| Imagen Docker Hub | `manuelrivero/food-service-agent:latest` |
| Ruta en VPS | `/opt/apps/food-service-agent` |

## Variables de entorno

Todas las variables que usa la app (más las de despliegue). En Node.js puro casi todas
son **runtime**: cambiás `.env` en el VPS y `docker compose up -d` sin rebuild.

| Variable | Cuándo | Dónde |
|----------|--------|-------|
| `DOCKER_IMAGE` | Deploy | `.env` del VPS (docker-compose) |
| `DOMAIN` | Referencia NPM | `.env` del VPS (la app no la lee) |
| `PORT` | Runtime | `.env` del VPS |
| `NODE_ENV` | Runtime | `docker-compose.prod.yml` (`production`) |
| `PUBLIC_URL` | Runtime | `.env` del VPS |
| `CORS_ORIGIN` | Runtime | `.env` del VPS |
| `DATABASE_URL` | Runtime | `.env` del VPS |
| `OPENAI_API_KEY` | Runtime | `.env` del VPS |
| `DRY_RUN_WHATSAPP_SEND` | Runtime | `.env` del VPS |
| `HYBRID_CTA_TARGET_INTENTS` | Runtime | `.env` del VPS |
| `WHATSAPP_ACCESS_TOKEN` | Runtime | `.env` del VPS |
| `PHONE_NUMBER_ID` | Runtime | `.env` del VPS |
| `WABA_ID` | Runtime | `.env` del VPS |
| `WHATSAPP_VERIFY_TOKEN` | Runtime | `.env` del VPS |
| `WHATSAPP_TEST_TO` | Runtime | `.env` del VPS (solo dev) |
| `JWT_ACCESS_SECRET` | Runtime | `.env` del VPS |
| `JWT_REFRESH_SECRET` | Runtime | `.env` del VPS |
| `JWT_ACCESS_EXPIRES` | Runtime | `.env` del VPS |
| `JWT_REFRESH_EXPIRES` | Runtime | `.env` del VPS |
| `JWT_REFRESH_EXPIRES_MS` | Runtime | `.env` del VPS |
| `AUTH_ACCESS_COOKIE_NAME` | Runtime | `.env` del VPS |
| `AUTH_REFRESH_COOKIE_NAME` | Runtime | `.env` del VPS |
| `AUTH_ACCESS_COOKIE_MAX_AGE` | Runtime | `.env` del VPS |
| `AUTH_REFRESH_COOKIE_MAX_AGE` | Runtime | `.env` del VPS |
| `AUTH_COOKIE_SAMESITE` | Runtime | `.env` del VPS |
| `AUTH_COOKIE_SECURE` | Runtime | `.env` del VPS |
| `AUTH_COOKIE_DOMAIN` | Runtime | `.env` del VPS |
| `PAYMENT_PROVIDER_ENCRYPTION_KEY` | Runtime | `.env` del VPS |
| `MERCADO_PAGO_WEBHOOK_BASE_URL` | Runtime | `.env` del VPS |
| `R2_ACCOUNT_ID` | Runtime | `.env` del VPS (imágenes de menú) |
| `R2_BUCKET` | Runtime | `.env` del VPS |
| `R2_ACCESS_KEY_ID` | Runtime | `.env` del VPS |
| `R2_SECRET_ACCESS_KEY` | Runtime | `.env` del VPS |
| `R2_PUBLIC_URL` | Runtime | `.env` del VPS (CDN / custom domain) |

Plantilla comentada: [`.env.example`](.env.example).

## 0. Pre-requisitos

- VPS DonWeb con Docker y Docker Compose.
- **Nginx Proxy Manager** corriendo en Docker (red externa `proxy-network`).
- Dominio con registro **A** apuntando a la IP del VPS (ej. `api.tu-dominio.com` → `138.36.238.15`).
- No modificar registros de correo (MX, `mail.*`, TXT SPF/DKIM) si el dominio ya tiene hosting compartido.
- Base de datos Postgres accesible (`DATABASE_URL`) con el esquema de `prisma/schema.prisma` **de este repositorio** ya migrado (Neon u Postgres local; ver §7-§8).
- Cuenta Docker Hub: `manuelrivero`.

## 1. Build y push de la imagen (máquina local o CI)

> **Importante (Docker snap + disco en `/mnt/`)**: si el repo está en una partición
> montada (ej. `/mnt/EE7CE2787CE23B4B/PROYECTOS/...`), Docker snap **no puede leer**
> el `Dockerfile` desde ahí (`open Dockerfile: no such file or directory`).
> Copiá o sincronizá el proyecto a **`~/PROYECTOS/food-service-agent`** y ejecutá
> el build desde esa ruta.

```bash
# Sincronizar desde el disco montado (excluye artefactos locales)
mkdir -p ~/PROYECTOS
rsync -a --delete --exclude node_modules --exclude dist \
  /mnt/EE7CE2787CE23B4B/PROYECTOS/food-service-agent/ \
  ~/PROYECTOS/food-service-agent/

cd ~/PROYECTOS/food-service-agent

# Login en Docker Hub
docker login -u manuelrivero
# Si falla por permisos del socket: sudo docker login -u manuelrivero

# Build (multi-stage: compila TS, ofusca dist/, Prisma client)
docker build -t manuelrivero/food-service-agent:latest .
# Si falla por permisos del socket: sudo docker build ...

# Publicar
docker push manuelrivero/food-service-agent:latest
# Si falla por permisos del socket: sudo docker push ...
```

El [Dockerfile](Dockerfile) ya está configurado:

- Etapa `builder`: `npm run build:obf` (TypeScript + ofuscación).
- Etapa `prod-deps`: dependencias de producción + cliente Prisma generado.
- Etapa `runner`: usuario `node`, puerto `5001`, healthcheck en `/health`.
- CMD: `node dist/index.js`

Verificación local opcional:

```bash
docker run --rm -p 5001:5001 --env-file .env manuelrivero/food-service-agent:latest
curl -fsS http://localhost:5001/health
```

## 2. Preparar el VPS

Conectarse por SSH:

```bash
ssh -p 5698 root@138.36.238.15
```

Verificar la red de NPM:

```bash
docker network ls | grep proxy
# Debe existir: proxy-network
docker ps --format '{{.Names}}' | grep -i nginx
# Ejemplo: nginx-proxy-manager
```

Crear directorio de despliegue (solo infra, **sin código fuente**):

```bash
mkdir -p /opt/apps/food-service-agent
cd /opt/apps/food-service-agent
```

Copiar desde tu máquina local **solo estos archivos**:

```bash
scp -P 5698 docker-compose.prod.yml root@201.32.132.31:/opt/apps/food-service-agent/
scp -P 5698 .env.example root@201.32.132.31:/opt/apps/food-service-agent/
```

En el VPS, crear `.env` con secretos reales:

```bash
cp .env.example .env
nano .env   # completar DATABASE_URL, JWT, OpenAI, WhatsApp, etc.
```

Ajustar al menos:

- `PUBLIC_URL` y `MERCADO_PAGO_WEBHOOK_BASE_URL` → `https://api.tu-dominio.com`
- `CORS_ORIGIN` → URL del frontend admin (Vercel, etc.)
- `AUTH_COOKIE_DOMAIN` → `.tu-dominio.com` si frontend y API comparten dominio raíz

Login en Docker Hub en el VPS y levantar:

```bash
docker login -u manuelrivero
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f app
```

## 3. Configurar Nginx Proxy Manager

En la UI de NPM (`http://IP-VPS:81` o tu dominio de administración):

1. **Hosts → Proxy Hosts → Add Proxy Host**
2. **Domain Names**: `api.tu-dominio.com` (el valor de `DOMAIN` en `.env`)
3. **Scheme**: `http`
4. **Forward Hostname / IP**: `food-service-agent` (nombre del contenedor)
5. **Forward Port**: `5001`
6. **Websockets Support**: **ON** (requerido para Socket.IO del panel admin)
7. **SSL**: Request a new SSL Certificate (Let's Encrypt), Force SSL, HTTP/2

El contenedor `food-service-agent` debe estar en la misma red Docker que NPM
(`proxy-network`), definida como `external` en `docker-compose.prod.yml`.

Si NPM no resuelve el hostname del contenedor, usar la IP interna del contenedor:

```bash
docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' food-service-agent
```

## 4. DNS (DonWeb)

En el panel DNS del dominio:

| Tipo | Nombre | Valor |
|------|--------|-------|
| A | `api` | `138.36.238.15` |

No tocar registros MX ni TXT de correo existentes.

## 5. Verificación

```bash
# Desde el VPS
curl -fsS http://food-service-agent:5001/health
# Desde fuera (tras NPM + SSL)
curl -fsS https://api.tu-dominio.com/health
```

Respuesta esperada:

```json
{"status":"healthy","mode":"hybrid","timestamp":"..."}
```

Configurar integraciones externas:

- **Meta WhatsApp**: webhook `https://api.tu-dominio.com/api/whatsapp/webhook`
  (token de verificación = `WHATSAPP_VERIFY_TOKEN`)
- **Mercado Pago**: `MERCADO_PAGO_WEBHOOK_BASE_URL=https://api.tu-dominio.com`

## 6. Actualizaciones

En local/CI (siempre desde `~/PROYECTOS/food-service-agent`):

```bash
rsync -a --delete --exclude node_modules --exclude dist \
  /mnt/EE7CE2787CE23B4B/PROYECTOS/food-service-agent/ \
  ~/PROYECTOS/food-service-agent/

cd ~/PROYECTOS/food-service-agent
docker build -t manuelrivero/food-service-agent:latest .
docker push manuelrivero/food-service-agent:latest
```

En el VPS:

```bash
cd /opt/apps/food-service-agent
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

Cambiar solo variables de entorno (sin nueva imagen):

```bash
nano .env
docker compose -f docker-compose.prod.yml up -d
```

## 7. Migraciones de base de datos

Esta imagen **no** incluye el CLI de Prisma ni ejecuta migraciones al arrancar. El Postgres
de producción vive en el VPS (`food-postgres`, ver §8) y solo escucha en `127.0.0.1:5433`
dentro del servidor — se accede desde tu máquina local vía túnel SSH.

**Regla de oro: nunca corras `npx prisma` (ni ningún proceso Node pesado) directamente en
el VPS.** El servidor tiene recursos muy limitados (~1 GB RAM, sin swap) y descargar/ejecutar
el CLI de Prisma ahí puede agotar la memoria y colgar el sistema completo (ya pasó). Todo el
cálculo de diffs se hace desde tu máquina local, contra el VPS a través del túnel.

### 7.1 Flujo por defecto: sincronizar esquema desde Neon (dev) hacia el VPS (prod)

1. **Abrí un túnel SSH hacia el Postgres del VPS** (dejalo corriendo en una terminal aparte):

   ```bash
   ssh -p5735 -L 5433:127.0.0.1:5433 root@201.32.132.31
   ```

2. **Backup de seguridad de producción** (en otra terminal local, usando el túnel):

   ```bash
   PGPASSWORD='<password_vps>' pg_dump -h localhost -p 5433 -U <usuario_vps> -d <db_vps> \
     > /tmp/backup_prod_$(date +%Y%m%d_%H%M).sql
   ```

   Requiere `postgresql-client` en la **misma versión mayor que el servidor** (el VPS corre
   Postgres 17): `sudo apt-get install -y postgresql-client-17` si `pg_dump --version` no
   coincide.

3. **Generar el diff de esquema** (VPS prod → Neon dev). El CLI de Prisma del proyecto (v7)
   eliminó `--from-url`/`--to-url`; usar temporalmente `prisma@5` solo para este comando:

   ```bash
   npx prisma@5 migrate diff \
     --from-url 'postgresql://<usuario_vps>:<password_vps>@localhost:5433/<db_vps>' \
     --to-url 'postgresql://<usuario_neon>:<password_neon>@<host_neon>/<db_neon>?sslmode=require&channel_binding=require' \
     --script > /tmp/diff_prod_to_dev.sql
   ```

   Usar el host de Neon **sin** `-pooler` (conexión directa) para evitar problemas con el
   introspection de Prisma.

4. **Revisar el script a mano antes de aplicar nada.** Buscar específicamente
   `DROP COLUMN`, `DROP TABLE` o `ALTER ... TYPE` — si aparecen, puede significar que el VPS
   tiene columnas/tablas que Neon no tiene (señal de que apuntaste al proyecto/branch de Neon
   equivocado, o de que prod tiene cambios que dev no tiene). Un diff sano para "promover dev
   a prod" solo debería traer `CREATE TYPE`, `ADD COLUMN`, `CREATE TABLE`, `CREATE INDEX` y
   `ADD CONSTRAINT` (foreign keys), más algún `ALTER COLUMN ... SET DEFAULT` o
   `DROP NOT NULL` no destructivo.

5. **Aplicar el script contra el VPS** (mismo túnel):

   ```bash
   PGPASSWORD='<password_vps>' psql -h localhost -p 5433 -U <usuario_vps> -d <db_vps> \
     -f /tmp/diff_prod_to_dev.sql
   ```

6. **Reiniciar la app y verificar logs:**

   ```bash
   ssh -p5735 root@201.32.132.31 \
     "docker restart food-service-agent && docker logs --tail 50 food-service-agent"
   ```

### 7.2 (Histórico, eliminado) Migrar desde `food-service-backend`

Método anterior, **ya no aplica**: dependía de un repo separado (`food-service-backend`)
gestionando el esquema y de scripts SQL sueltos (p. ej. `prisma/sql/*.sql`) aplicados
manualmente, lo cual generó desfases entre el schema de Prisma y la base real (columnas
esperadas por el cliente que no existían en la BD) — ese fue precisamente el motivo de la
decisión arquitectónica de dejar de depender de ese repo. Este repositorio (`gesty-backend`,
antes `food-service-agent`) es ahora la **única fuente de verdad** de `prisma/schema.prisma`
y de `prisma/migrations/`; el script `prisma:sync` que copiaba el schema desde
`food-service-backend` fue eliminado de `package.json`. No correr `prisma migrate deploy` en
ningún otro repo para esta base de datos.

Si encontrás un script suelto en `prisma/sql/` sin migración formal asociada, preferí el
flujo de §7.1 (diff contra Neon) o una migración manual nueva en `prisma/migrations/` de este
repo en vez de aplicar el script a ciegas.

## 8. Migrar Neon → Postgres en el VPS

Pasos **manuales** en el VPS (SSH). Los archivos de ayuda están en el repo:

- [`docker-compose.postgres.yml`](docker-compose.postgres.yml) — Postgres con PostGIS + pgvector
- [`.env.postgres.example`](.env.postgres.example) — usuario/clave/db

Requisitos: red Docker `proxy-network` ya creada (la usa la app con NPM).

### 8.1 Connection string de Neon

1. [console.neon.tech](https://console.neon.tech) → proyecto → **Connect**.
2. **Desactivar Connection pooling** (host **sin** `-pooler`).
3. Neon está en **Postgres 17**. La imagen por defecto del compose es `datosonline/postgis-pgvector:17-3.5`.

### 8.2 Levantar Postgres en el VPS

Desde tu máquina (con el repo) o pegando los archivos en el VPS:

```bash
ssh user@TU_VPS
sudo mkdir -p /opt/apps/postgres/backups
# Copiá docker-compose.postgres.yml → /opt/apps/postgres/docker-compose.yml
# Copiá .env.postgres.example → /opt/apps/postgres/.env y editá POSTGRES_PASSWORD

cd /opt/apps/postgres
nano .env   # POSTGRES_IMAGE, POSTGRES_PASSWORD, etc.
docker compose up -d
docker compose ps
docker compose exec postgres psql -U food -d food_service -c \
  "CREATE EXTENSION IF NOT EXISTS postgis; CREATE EXTENSION IF NOT EXISTS vector;"
```

### 8.3 Probar Neon desde el VPS

Reemplazá `NEON_URL` por la connection string **sin pooler**:

```bash
docker run --rm postgres:17 \
  psql "NEON_URL" -c 'select 1'
```

Si falla por cuota o auth, no sigas.

### 8.4 Dump desde Neon

```bash
mkdir -p /opt/apps/postgres/backups

docker run --rm \
  -v /opt/apps/postgres/backups:/backups \
  postgres:17 \
  pg_dump -Fc -v \
  -d "NEON_URL" \
  -f /backups/neon.dump

ls -lh /opt/apps/postgres/backups/neon.dump
```

### 8.5 Restore en el Postgres local

La app y Postgres comparten `proxy-network`; el hostname es `food-postgres`:

```bash
# Ajustá USER/PASSWORD/DB a tu /opt/apps/postgres/.env
docker run --rm \
  --network proxy-network \
  -v /opt/apps/postgres/backups:/backups \
  postgres:17 \
  pg_restore -v --no-owner --no-acl \
  -d "postgresql://food:TU_PASSWORD@food-postgres:5432/food_service" \
  /backups/neon.dump
```

Avisos de roles inexistentes con `--no-owner` suelen ser normales. Si falla por `postgis` / `vector`, la imagen no tiene las extensiones.

Verificar datos:

```bash
cd /opt/apps/postgres
docker compose exec postgres psql -U food -d food_service -c '\dt'
docker compose exec postgres psql -U food -d food_service -c 'select count(*) from business;'
```

### 8.6 Cutover de la app

En `/opt/apps/food-service-agent/.env`:

```env
DATABASE_URL=postgresql://food:TU_PASSWORD@food-postgres:5432/food_service
```

(Sin `sslmode=require` hacia el Postgres del mismo Docker network.)

```bash
cd /opt/apps/food-service-agent
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml logs -f --tail=100
curl -fsS https://TU_DOMINIO/health
```

Cuando todo ande: guardá `neon.dump` un tiempo; no borres Neon el mismo día.

## Notas

- **Ruta de build local**: `~/PROYECTOS/food-service-agent` (no buildar desde `/mnt/...` con Docker snap).
- **Ofuscación**: solo `dist/` (código propio). `node_modules` y Prisma client no se ofuscan. Ver `scripts/obfuscate.mjs`.
- **Socket.IO**: NPM debe tener WebSockets habilitado; el cliente admin usa el mismo origen que `CORS_ORIGIN`.
- **docker-compose.yml** (con nginx + certbot propio) queda para despliegues sin NPM; en DonWeb usar `docker-compose.prod.yml`.
