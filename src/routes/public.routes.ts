import { Router } from "express";
import {
  getBusinessInfo,
  getFeaturedMenuItems,
  getMenuItemById
} from "../controllers/publicMenu.controller";
import { getPaymentProviderLogo } from "../controllers/publicPaymentProviders.controller";
import { getPublicBillingPlansHandler } from "../controllers/publicBilling.controller";

const router = Router();

router.get("/billing/plans", getPublicBillingPlansHandler);

router.get("/businesses/:businessId", getBusinessInfo);
router.get("/businesses/:businessId/featured-items", getFeaturedMenuItems);
router.get("/businesses/:businessId/menu-items/:itemId", getMenuItemById);
router.get(
  "/payment-providers/:provider/logo.png",
  getPaymentProviderLogo
);

export default router;
