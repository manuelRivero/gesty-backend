# Plan de acción — Páginas back_url pago bot (MP)

| | |
|--|--|
| **Estado** | disponible (PAY-07) |
| **Fecha** | 2026-09-20 |
| **Repo** | `gesty-backend` |
| **Objetivo** | Tras Checkout Pro del bot WA, redirigir a páginas HTML en la API con estado del pago, datos del local y CTA “Volver al chat”. |
| **FEATURES.md** | `PAY-07` |
| **Depende de** | PAY-02 |

---

## Decisiones

| # | Resolución |
|---|------------|
| Alcance | Solo bot WA. Storefront sigue en `/shopping/...` (PAY-06). |
| Rutas | `GET /payment/success\|failure\|pending` |
| Defaults preference | `{MERCADO_PAGO_WEBHOOK_BASE_URL}/payment/…?business_id={uuid}` |
| Lookup | `business_id` + `external_reference` (draft) / `preference_id` (query MP) |
| CTA | `https://wa.me/{digits}` desde `business.whatsapp_phone_number` |
| UI | Template HTML único minimalista; sin branding por color/logo |

---

## Checklist

- [x] `business_id` en back_urls default de `createMpPreference`
- [x] `paymentReturnPage.service` + controller HTML
- [x] Rutas en `src/index.ts`
- [x] Tests + FEATURES PAY-07
