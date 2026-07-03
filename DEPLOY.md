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
| Migraciones al arrancar | **No** — el esquema Prisma lo gestiona `food-service-backend`; aplicar migraciones allí antes de desplegar |
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
| `AGENT_MODE` | Runtime | `.env` del VPS |
| `DRY_RUN_WHATSAPP_SEND` | Runtime | `.env` del VPS |
| `HYBRID_CTA_ENABLED` | Runtime | `.env` del VPS |
| `HYBRID_CTA_TARGET_INTENTS` | Runtime | `.env` del VPS |
| `HYBRID_CTA_ENABLED_BUSINESS_IDS` | Runtime | `.env` del VPS |
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

Plantilla comentada: [`.env.example`](.env.example).

## 0. Pre-requisitos

- VPS DonWeb con Docker y Docker Compose.
- **Nginx Proxy Manager** corriendo en Docker (red externa `proxy-network`).
- Dominio con registro **A** apuntando a la IP del VPS (ej. `api.tu-dominio.com` → `138.36.238.15`).
- No modificar registros de correo (MX, `mail.*`, TXT SPF/DKIM) si el dominio ya tiene hosting compartido.
- Base de datos Postgres accesible (`DATABASE_URL`) con esquema ya migrado desde `food-service-backend`.
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
scp -P 5698 docker-compose.prod.yml root@138.36.238.15:/opt/apps/food-service-agent/
scp -P 5698 .env.example root@138.36.238.15:/opt/apps/food-service-agent/
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

Esta imagen **no** incluye el CLI de Prisma ni ejecuta migraciones al arrancar.

El esquema se sincroniza desde `food-service-backend`:

```bash
# En el repo food-service-backend (no en el VPS de esta app)
npx prisma migrate deploy
```

Aplicar migraciones **antes** de desplegar una versión que dependa de cambios de esquema.

## Notas

- **Ruta de build local**: `~/PROYECTOS/food-service-agent` (no buildar desde `/mnt/...` con Docker snap).
- **Ofuscación**: solo `dist/` (código propio). `node_modules` y Prisma client no se ofuscan. Ver `scripts/obfuscate.mjs`.
- **Socket.IO**: NPM debe tener WebSockets habilitado; el cliente admin usa el mismo origen que `CORS_ORIGIN`.
- **docker-compose.yml** (con nginx + certbot propio) queda para despliegues sin NPM; en DonWeb usar `docker-compose.prod.yml`.
