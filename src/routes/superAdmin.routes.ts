import { Router } from "express";
import {
  getSuperAdminBusinessById,
  getSuperAdminBusinessesList
} from "../controllers/superAdminBusinesses.controller";
import { authenticateJwt, requireRoles } from "../middleware/auth.middleware";

const router = Router();

router.use(authenticateJwt);
router.use(requireRoles("SUPER_ADMIN"));

router.get("/businesses", getSuperAdminBusinessesList);
router.get("/businesses/:id", getSuperAdminBusinessById);

export default router;
