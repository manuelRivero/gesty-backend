import { Router } from "express";
import {
  getBusinessInfo,
  getFeaturedMenuItems,
  getMenuItemById,
  getStorefrontFulfillment,
  getStorefrontHours,
  getStorefrontMenu,
  getStorefrontMenuCategories,
  getStorefrontMenuItems,
  getStorefrontPaymentMethods
} from "../controllers/publicMenu.controller";
import {
  createStorefrontOrder,
  getStorefrontOrder,
  quoteStorefrontDelivery
} from "../controllers/publicOrders.controller";
import { reverseGeocodeStorefront } from "../controllers/publicGeocoding.controller";
import {
  getPublicVapidKey,
  registerStorefrontPushSubscription,
  unregisterStorefrontPushSubscription
} from "../controllers/publicPush.controller";
import { getPaymentProviderLogo } from "../controllers/publicPaymentProviders.controller";
import { getPublicBillingPlansHandler } from "../controllers/publicBilling.controller";
import {
  createIpRateLimit,
  createKeyedRateLimit
} from "../middleware/publicRateLimit.middleware";

const router = Router();

const reverseGeocodeRateLimit = createIpRateLimit({
  windowMs: 60_000,
  max: 30,
  code: "RATE_LIMITED",
  message: "Demasiadas solicitudes de geocode; reintentá en un momento"
});

const pushSubscribeIpRateLimit = createIpRateLimit({
  windowMs: 60_000,
  max: 20,
  code: "RATE_LIMITED",
  message: "Demasiadas suscripciones push; reintentá en un momento"
});

const pushSubscribeOrderRateLimit = createKeyedRateLimit({
  windowMs: 60_000,
  max: 10,
  keyFn: (req) => `order:${String(req.params.orderId ?? "unknown")}`,
  code: "RATE_LIMITED",
  message: "Demasiadas suscripciones push para este pedido; reintentá en un momento"
});

router.get("/billing/plans", getPublicBillingPlansHandler);

router.get("/push/vapid-public-key", getPublicVapidKey);

// Storefront por slug (UUID sigue resolviendo por compat).
// Rutas más específicas primero.
router.get("/businesses/:slug/menu/categories", getStorefrontMenuCategories);
router.get("/businesses/:slug/menu/items", getStorefrontMenuItems);
router.get("/businesses/:slug/menu", getStorefrontMenu);
router.post("/businesses/:slug/delivery-quote", quoteStorefrontDelivery);
router.post(
  "/businesses/:slug/reverse-geocode",
  reverseGeocodeRateLimit,
  reverseGeocodeStorefront
);
router.post("/businesses/:slug/orders", createStorefrontOrder);
router.post(
  "/businesses/:slug/orders/:orderId/push-subscription",
  pushSubscribeIpRateLimit,
  pushSubscribeOrderRateLimit,
  registerStorefrontPushSubscription
);
router.delete(
  "/businesses/:slug/orders/:orderId/push-subscription",
  unregisterStorefrontPushSubscription
);
router.get("/businesses/:slug/orders/:orderId", getStorefrontOrder);
router.get("/businesses/:slug/hours", getStorefrontHours);
router.get("/businesses/:slug/fulfillment", getStorefrontFulfillment);
router.get("/businesses/:slug/payment-methods", getStorefrontPaymentMethods);
router.get("/businesses/:slug/featured-items", getFeaturedMenuItems);
router.get("/businesses/:slug/menu-items/:itemId", getMenuItemById);
router.get("/businesses/:slug", getBusinessInfo);

router.get(
  "/payment-providers/:provider/logo.png",
  getPaymentProviderLogo
);

export default router;
