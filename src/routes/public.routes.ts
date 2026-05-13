import { Router } from "express";
import {
  getBusinessInfo,
  getFeaturedMenuItems
} from "../controllers/publicMenu.controller";

const router = Router();

router.get("/businesses/:businessId", getBusinessInfo);
router.get("/businesses/:businessId/featured-items", getFeaturedMenuItems);

export default router;
