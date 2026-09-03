import { Router } from "express";
import {
  getSuperAdminBusinessById,
  getSuperAdminBusinessesList,
  postSuperAdminBusiness
} from "../controllers/superAdminBusinesses.controller";
import {
  getSuperAdminBusinessBilling,
  getSuperAdminTrialDefaults,
  patchSuperAdminBusinessBilling,
  postSuperAdminCancelBilling,
  postSuperAdminGrantTrial,
  postSuperAdminSyncStripe,
} from "../controllers/superAdminBilling.controller";
import {
  createAnnouncementHandler,
  deleteAnnouncementHandler,
  deleteAnnouncementMediaHandler,
  getAnnouncementHandler,
  listAnnouncementsHandler,
  updateAnnouncementHandler,
  uploadAnnouncementMediaHandler,
} from "../controllers/superAdminAnnouncements.controller";
import { announcementMediaUploadMiddleware } from "../middleware/announcementMediaUpload.middleware";
import { authenticateJwt, requireRoles } from "../middleware/auth.middleware";

const router = Router();

router.use(authenticateJwt);
router.use(requireRoles("SUPER_ADMIN"));

router.get("/businesses", getSuperAdminBusinessesList);
router.post("/businesses", postSuperAdminBusiness);
router.get("/billing/trial-defaults", getSuperAdminTrialDefaults);
router.get("/businesses/:id/billing", getSuperAdminBusinessBilling);
router.patch("/businesses/:id/billing", patchSuperAdminBusinessBilling);
router.post("/businesses/:id/billing/grant-trial", postSuperAdminGrantTrial);
router.post("/businesses/:id/billing/sync-stripe", postSuperAdminSyncStripe);
router.post("/businesses/:id/billing/cancel", postSuperAdminCancelBilling);
router.get("/businesses/:id", getSuperAdminBusinessById);

// Announcements CRUD
router.get("/announcements", listAnnouncementsHandler);
router.get("/announcements/:id", getAnnouncementHandler);
router.post("/announcements", createAnnouncementHandler);
router.patch("/announcements/:id", updateAnnouncementHandler);
router.delete("/announcements/:id", deleteAnnouncementHandler);

// Announcement media
router.post("/announcements/:id/media", announcementMediaUploadMiddleware, uploadAnnouncementMediaHandler);
router.delete("/announcements/:id/media", deleteAnnouncementMediaHandler);

export default router;
