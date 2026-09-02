import { Router } from "express";
import {
  getOrderById,
  getOrders,
  patchOrderDeliveryStatus,
  patchOrderPaymentStatus
} from "../controllers/adminOrders.controller";
import {
  getReservationById,
  getReservations
} from "../controllers/adminReservations.controller";
import {
  getOrderPaymentProofs,
  postOrderPaymentProofReview
} from "../controllers/adminPaymentProof.controller";
import {
  getDeliveryZoneById,
  getDeliveryZones,
  patchDeliveryZone,
  postDeliveryZone,
  removeDeliveryZone
} from "../controllers/adminDeliveryZones.controller";
import {
  getDeliveryZoneCalibrationStatusHandler,
  postDeliveryZoneCalibrationHandler
} from "../controllers/adminDeliveryZoneCalibration.controller";
import {
  getTableById,
  getTables,
  patchTable,
  postTable,
  removeTable
} from "../controllers/adminTables.controller";
import {
  getEnvironmentById,
  getEnvironments,
  patchEnvironment,
  postEnvironment,
  removeEnvironment
} from "../controllers/adminEnvironments.controller";
import {
  getBusinessHourById,
  getBusinessHours,
  patchBusinessHour,
  postBusinessHour,
  removeBusinessHour
} from "../controllers/adminBusinessHours.controller";
import {
  getReservationSlotById,
  getReservationSlots,
  patchReservationSlot,
  postReservationSlot,
  removeReservationSlot
} from "../controllers/adminReservationSlots.controller";
import {
  getMenuCategoriesOptions,
  getMenuCategoryTagsOptions,
  getMenuItemById,
  getMenuItems,
  patchMenuItem,
  postMenuItem,
  removeMenuItem,
  generateMenuItemEnrichmentHandler,
  getMenuItemAiMetadataHandler,
  saveMenuItemAiMetadataHandler
} from "../controllers/adminMenuItems.controller";
import {
  deleteMenuItemImageHandler,
  uploadMenuItemImageHandler
} from "../controllers/adminMenuItemImage.controller";
import { menuItemImageUploadMiddleware } from "../middleware/upload.middleware";
import { getDashboardSummary } from "../controllers/adminDashboard.controller";
import {
  getClientRankingHandler,
  getOrderVolumeHandler,
  getTopDishesHandler,
} from "../controllers/adminAnalytics.controller";
import {
  createAdminBusinessConfig,
  getAdminBusinessConfig,
  patchAdminBusinessConfig,
  removeAdminBusinessConfig
} from "../controllers/adminBusinessConfig.controller";
import { getAdminBotPersonalities } from "../controllers/adminBotPersonality.controller";
import { getWhatsappMessages, getWhatsappConversations } from "../controllers/adminWhatsappMessages.controller";
import {
  getWhatsappConversationBotStatus,
  patchWhatsappConversationBotStatus
} from "../controllers/adminWhatsappBotControl.controller";
import { postAdminWhatsappReply } from "../controllers/adminWhatsappReply.controller";
import {
  getAdminBusiness,
  patchAdminBusiness
} from "../controllers/adminBusiness.controller";
import {
  getPaymentProviderById,
  getPaymentProviders,
  patchPaymentProvider,
  postPaymentProvider,
  removePaymentProvider
} from "../controllers/adminPaymentProviders.controller";
import {
  getPaymentMethodConfigs,
  getPaymentMethodConfigById,
  postPaymentMethodConfig,
  patchPaymentMethodConfig,
  removePaymentMethodConfig,
} from "../controllers/adminPaymentMethodConfig.controller";
import {
  listAnnouncementsForBusinessHandler,
  getUnreadCountHandler,
  getAnnouncementForBusinessHandler,
  markAnnouncementReadHandler,
  getReadersForBusinessHandler,
} from "../controllers/adminAnnouncements.controller";
import { authenticateJwt, requireRoles } from "../middleware/auth.middleware";
import {
  createPromotionHandler,
  deletePromotionHandler,
  getPromotionByIdHandler,
  interpretPromotionHandler,
  listPromotionsHandler,
  patchPromotionHandler,
  resolvePromotionEntitiesHandler
} from "../controllers/adminPromotions.controller";
import { promotionAudioUploadMiddleware } from "../middleware/audioUpload.middleware";
import {
  getBusinessUserById,
  getBusinessUsers,
  patchBusinessUser,
  postBusinessUser,
  removeBusinessUser
} from "../controllers/adminBusinessUsers.controller";

const router = Router();

router.use(authenticateJwt);

/**
 * Interpreta una promoción en lenguaje natural (texto JSON o audio multipart).
 * No persiste — solo pipeline STT + interpreter V1.
 */
router.post(
  "/promotions/interpret",
  requireRoles("OWNER", "ADMIN"),
  (req, res, next) => {
    const ct = String(req.headers["content-type"] ?? "").toLowerCase();
    if (ct.includes("multipart/form-data")) {
      return promotionAudioUploadMiddleware(req, res, next);
    }
    next();
  },
  interpretPromotionHandler
);
router.post(
  "/promotions/resolve-entities",
  requireRoles("OWNER", "ADMIN"),
  resolvePromotionEntitiesHandler
);
router.get("/promotions", requireRoles("OWNER", "ADMIN"), listPromotionsHandler);
router.post("/promotions", requireRoles("OWNER", "ADMIN"), createPromotionHandler);
router.get("/promotions/:id", requireRoles("OWNER", "ADMIN"), getPromotionByIdHandler);
router.patch("/promotions/:id", requireRoles("OWNER", "ADMIN"), patchPromotionHandler);
router.delete("/promotions/:id", requireRoles("OWNER", "ADMIN"), deletePromotionHandler);

router.get("/orders", getOrders);
router.get("/orders/:id", getOrderById);
router.patch("/orders/:id/status", patchOrderDeliveryStatus);
router.patch("/orders/:id/payment-status", patchOrderPaymentStatus);
router.get(
  "/orders/:id/payment-proofs",
  requireRoles("OWNER", "ADMIN"),
  getOrderPaymentProofs
);
router.post(
  "/orders/:id/payment-proofs/:proofId/review",
  requireRoles("OWNER", "ADMIN"),
  postOrderPaymentProofReview
);
router.get("/dashboard/summary", getDashboardSummary);
router.get("/analytics/order-volume", getOrderVolumeHandler);
router.get("/analytics/client-ranking", getClientRankingHandler);
router.get("/analytics/top-dishes", getTopDishesHandler);
router.get("/business", requireRoles("OWNER", "ADMIN"), getAdminBusiness);
router.patch("/business", requireRoles("OWNER", "ADMIN"), patchAdminBusiness);
router.get("/config", requireRoles("OWNER", "ADMIN"), getAdminBusinessConfig);
router.get(
  "/config/bot-personalities",
  requireRoles("OWNER", "ADMIN"),
  getAdminBotPersonalities
);
router.post("/config", requireRoles("OWNER", "ADMIN"), createAdminBusinessConfig);
router.patch("/config", requireRoles("OWNER", "ADMIN"), patchAdminBusinessConfig);
router.delete("/config", requireRoles("OWNER", "ADMIN"), removeAdminBusinessConfig);
router.get("/whatsapp/messages", getWhatsappMessages);
router.get("/whatsapp/conversations", getWhatsappConversations);
router.get(
  "/whatsapp/conversations/:conversationId/bot",
  getWhatsappConversationBotStatus
);
router.patch(
  "/whatsapp/conversations/:conversationId/bot",
  patchWhatsappConversationBotStatus
);
router.post("/whatsapp/conversations/:conversationId/messages", postAdminWhatsappReply);
router.get(
  "/menu-categories/options",
  requireRoles("OWNER", "ADMIN"),
  getMenuCategoriesOptions
);
router.get(
  "/menu-category-tags/options",
  requireRoles("OWNER", "ADMIN"),
  getMenuCategoryTagsOptions
);
router.get("/menu-items", requireRoles("OWNER", "ADMIN"), getMenuItems);
router.get("/menu-items/:id", requireRoles("OWNER", "ADMIN"), getMenuItemById);
router.post("/menu-items", requireRoles("OWNER", "ADMIN"), postMenuItem);
router.patch("/menu-items/:id", requireRoles("OWNER", "ADMIN"), patchMenuItem);
router.delete("/menu-items/:id", requireRoles("OWNER", "ADMIN"), removeMenuItem);
router.post(
  "/menu-items/:id/image",
  requireRoles("OWNER", "ADMIN"),
  menuItemImageUploadMiddleware,
  uploadMenuItemImageHandler
);
router.delete(
  "/menu-items/:id/image",
  requireRoles("OWNER", "ADMIN"),
  deleteMenuItemImageHandler
);
router.post(
  "/menu-items/:id/generate-enrichment",
  requireRoles("OWNER", "ADMIN"),
  generateMenuItemEnrichmentHandler
);
router.get(
  "/menu-items/:id/ai-metadata",
  requireRoles("OWNER", "ADMIN"),
  getMenuItemAiMetadataHandler
);
router.put(
  "/menu-items/:id/ai-metadata",
  requireRoles("OWNER", "ADMIN"),
  saveMenuItemAiMetadataHandler
);
router.get("/delivery-zones", requireRoles("OWNER", "ADMIN"), getDeliveryZones);
router.get(
  "/delivery-zones/calibration/status",
  requireRoles("OWNER", "ADMIN"),
  getDeliveryZoneCalibrationStatusHandler
);
router.post(
  "/delivery-zones/calibration",
  requireRoles("OWNER", "ADMIN"),
  postDeliveryZoneCalibrationHandler
);
router.get(
  "/delivery-zones/:id",
  requireRoles("OWNER", "ADMIN"),
  getDeliveryZoneById
);
router.post("/delivery-zones", requireRoles("OWNER", "ADMIN"), postDeliveryZone);
router.patch(
  "/delivery-zones/:id",
  requireRoles("OWNER", "ADMIN"),
  patchDeliveryZone
);
router.delete(
  "/delivery-zones/:id",
  requireRoles("OWNER", "ADMIN"),
  removeDeliveryZone
);

router.get("/environments", requireRoles("OWNER", "ADMIN"), getEnvironments);
router.get("/environments/:id", requireRoles("OWNER", "ADMIN"), getEnvironmentById);
router.post("/environments", requireRoles("OWNER", "ADMIN"), postEnvironment);
router.patch("/environments/:id", requireRoles("OWNER", "ADMIN"), patchEnvironment);
router.delete("/environments/:id", requireRoles("OWNER", "ADMIN"), removeEnvironment);

router.get("/tables", requireRoles("OWNER", "ADMIN"), getTables);
router.get("/tables/:id", requireRoles("OWNER", "ADMIN"), getTableById);
router.post("/tables", requireRoles("OWNER", "ADMIN"), postTable);
router.patch("/tables/:id", requireRoles("OWNER", "ADMIN"), patchTable);
router.delete("/tables/:id", requireRoles("OWNER", "ADMIN"), removeTable);
router.get("/business-hours", requireRoles("OWNER", "ADMIN"), getBusinessHours);
router.get(
  "/business-hours/:id",
  requireRoles("OWNER", "ADMIN"),
  getBusinessHourById
);
router.post("/business-hours", requireRoles("OWNER", "ADMIN"), postBusinessHour);
router.patch(
  "/business-hours/:id",
  requireRoles("OWNER", "ADMIN"),
  patchBusinessHour
);
router.delete(
  "/business-hours/:id",
  requireRoles("OWNER", "ADMIN"),
  removeBusinessHour
);

router.get(
  "/reservation-slots",
  requireRoles("OWNER", "ADMIN"),
  getReservationSlots
);
router.get(
  "/reservation-slots/:id",
  requireRoles("OWNER", "ADMIN"),
  getReservationSlotById
);
router.post(
  "/reservation-slots",
  requireRoles("OWNER", "ADMIN"),
  postReservationSlot
);
router.patch(
  "/reservation-slots/:id",
  requireRoles("OWNER", "ADMIN"),
  patchReservationSlot
);
router.delete(
  "/reservation-slots/:id",
  requireRoles("OWNER", "ADMIN"),
  removeReservationSlot
);

router.get(
  "/payment-providers",
  requireRoles("OWNER", "ADMIN"),
  getPaymentProviders
);
router.get(
  "/payment-providers/:id",
  requireRoles("OWNER", "ADMIN"),
  getPaymentProviderById
);
router.post(
  "/payment-providers",
  requireRoles("OWNER", "ADMIN"),
  postPaymentProvider
);
router.patch(
  "/payment-providers/:id",
  requireRoles("OWNER", "ADMIN"),
  patchPaymentProvider
);
router.delete(
  "/payment-providers/:id",
  requireRoles("OWNER", "ADMIN"),
  removePaymentProvider
);

router.get("/reservations", getReservations);
router.get("/reservations/:id", getReservationById);

router.get(
  "/payment-method-configs",
  requireRoles("OWNER", "ADMIN"),
  getPaymentMethodConfigs
);
router.get(
  "/payment-method-configs/:id",
  requireRoles("OWNER", "ADMIN"),
  getPaymentMethodConfigById
);
router.post(
  "/payment-method-configs",
  requireRoles("OWNER", "ADMIN"),
  postPaymentMethodConfig
);
router.patch(
  "/payment-method-configs/:id",
  requireRoles("OWNER", "ADMIN"),
  patchPaymentMethodConfig
);
router.delete(
  "/payment-method-configs/:id",
  requireRoles("OWNER", "ADMIN"),
  removePaymentMethodConfig
);

router.get("/business-users", requireRoles("OWNER", "ADMIN"), getBusinessUsers);
router.get(
  "/business-users/:id",
  requireRoles("OWNER", "ADMIN"),
  getBusinessUserById
);
router.post("/business-users", requireRoles("OWNER", "ADMIN"), postBusinessUser);
router.patch(
  "/business-users/:id",
  requireRoles("OWNER", "ADMIN"),
  patchBusinessUser
);
router.delete(
  "/business-users/:id",
  requireRoles("OWNER", "ADMIN"),
  removeBusinessUser
);

// Announcements inbox (business)
router.get("/announcements", listAnnouncementsForBusinessHandler);
router.get("/announcements/unread-count", getUnreadCountHandler);
router.get("/announcements/:id", getAnnouncementForBusinessHandler);
router.post("/announcements/:id/read", markAnnouncementReadHandler);
router.get("/announcements/:id/readers", getReadersForBusinessHandler);

export default router;
