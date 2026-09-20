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
import { createStorefrontOrder, getStorefrontOrder } from "../controllers/publicOrders.controller";
import { getPaymentProviderLogo } from "../controllers/publicPaymentProviders.controller";
import { getPublicBillingPlansHandler } from "../controllers/publicBilling.controller";

const router = Router();

router.get("/billing/plans", getPublicBillingPlansHandler);

// Storefront por slug (UUID sigue resolviendo por compat).
// Rutas más específicas primero.
router.get("/businesses/:slug/menu/categories", getStorefrontMenuCategories);
router.get("/businesses/:slug/menu/items", getStorefrontMenuItems);
router.get("/businesses/:slug/menu", getStorefrontMenu);
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
