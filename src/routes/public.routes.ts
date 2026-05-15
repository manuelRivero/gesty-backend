import { Router } from "express";
import {
  getBusinessInfo,
  getFeaturedMenuItems,
  getMenuItemById
} from "../controllers/publicMenu.controller";

const router = Router();

router.get("/businesses/:businessId", getBusinessInfo);
router.get("/businesses/:businessId/featured-items", getFeaturedMenuItems);
router.get("/businesses/:businessId/menu-items/:itemId", getMenuItemById);

export default router;
