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
import { getPaymentProviderLogo } from "../controllers/publicPaymentProviders.controller";
import { getPublicBillingPlansHandler } from "../controllers/publicBilling.controller";
import { createIpRateLimit } from "../middleware/publicRateLimit.middleware";

const router = Router();

const reverseGeocodeRateLimit = createIpRateLimit({
  windowMs: 60_000,
  max: 30,
  code: "RATE_LIMITED",
  message: "Demasiadas solicitudes de geocode; reintentá en un momento"
});

router.get("/billing/plans", getPublicBillingPlansHandler);

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
