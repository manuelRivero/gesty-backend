# Despliegue — food-service-agent (Docker + Donweb Cloud Server)

Build con código **ofuscado**, publicado en un **registry privado** y desplegado
en un VPS de Donweb con **Nginx + HTTPS (Let's Encrypt)**.

## 0. Pre-requisitos
- Dominio apuntando (registro A) a la IP del Cloud Server de Donweb.
- En el VPS: Docker + plugin Compose instalados.
- **Rotar secretos** antes de producción (la OpenAI key, JWT y la clave de
  cifrado de pagos estuvieron en texto plano en el `.env` del repo).

## 1. Build + ofuscación local (verificación)
```bash
npm ci
npm run build:obf   # compila a dist/ (sin sourcemaps) y lo ofusca
```

## 2. Build de la imagen y push al registry
Ejemplo con GitHub Container Registry (GHCR). Reemplazá `tu-usuario`.
```bash
echo $GHCR_TOKEN | docker login ghcr.io -u tu-usuario --password-stdin

docker build -t ghcr.io/tu-usuario/food-service-agent:latest .
docker push ghcr.io/tu-usuario/food-service-agent:latest
```
> El `.dockerignore` evita que la fuente `.ts`, tests, `.env` y docs entren al
> contexto. En la imagen final solo queda `dist/` ya ofuscado + deps de prod.

## 3. Preparar el servidor
Copiá al VPS solo los archivos de infra (NO el código fuente):
```
docker-compose.yml
.env                      # creado a partir de .env.example, con secretos reales
nginx/conf.d/food-service-agent.conf
```
Editá `nginx/conf.d/food-service-agent.conf` y reemplazá `tu-dominio.com`.

Login al registry en el server y pull:
```bash
echo $GHCR_TOKEN | docker login ghcr.io -u tu-usuario --password-stdin
export IMAGE=ghcr.io/tu-usuario/food-service-agent:latest
docker compose pull
```

## 4. Emitir el certificado TLS (bootstrap)
Como Nginx no arranca sin certificado, primero se obtiene con un server HTTP-only.

1. Levantar solo la app y Nginx (Nginx servirá el challenge en el bloque `:80`):
```bash
mkdir -p nginx/certbot/www nginx/certbot/conf
docker compose up -d app nginx
```
2. Emitir el certificado:
```bash
docker compose run --rm certbot certonly \
  --webroot -w /var/www/certbot \
  -d tu-dominio.com \
  --email tu-email@dominio.com --agree-tos --no-eff-email
```
3. Recargar Nginx (ya con el bloque `:443` válido) y levantar todo:
```bash
docker compose up -d
docker compose exec nginx nginx -s reload
```
> Si Nginx falla al iniciar por falta de certificado, comentá temporalmente el
> bloque `server { listen 443 ... }` para el bootstrap y descomentalo después.

La renovación es automática (servicio `certbot` cada 12h).

## 5. Verificación
```bash
curl -fsS https://tu-dominio.com/health
docker compose logs -f app
```
Configurar en Meta el webhook de WhatsApp apuntando a
`https://tu-dominio.com/api/whatsapp/webhook` y, en Mercado Pago,
`MERCADO_PAGO_WEBHOOK_BASE_URL=https://tu-dominio.com`.

## 6. Actualizaciones
```bash
# Local/CI
docker build -t ghcr.io/tu-usuario/food-service-agent:latest . && docker push ...
# Server
docker compose pull && docker compose up -d
```

## Notas sobre la ofuscación
- Solo se ofusca `dist/` (nuestro código). `node_modules` y el cliente Prisma no
  se tocan.
- El build de prod desactiva `sourceMap`/`declaration` para no enviar mapas que
  reviertan la ofuscación.
- Nivel **moderado** (renombrado + stringArray base64), sin control-flow
  flattening ni self-defending, para no degradar performance ni romper runtime.
  Ajustable en `scripts/obfuscate.mjs`.
