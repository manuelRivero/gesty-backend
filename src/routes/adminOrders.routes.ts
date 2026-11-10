import { Router } from "express";
import {
  getOrderById,
  getOrders,
  patchOrderDeliveryAssignment,
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
  getOccupiedTables,
  getTableTabById_,
  getTableTabOrders,
  getTableTabs,
  patchReassignTableTab,
  postAssignTableToTab,
  postCancelTableTabItem,
  postCloseTableTab,
  postCreateTableTabRound,
  postOpenTableTab,
  postTransferTable
} from "../controllers/adminTableTab.controller";
import {
  getKitchenTickets,
  patchKitchenTicketItemStatus
} from "../controllers/kitchenTicketItem.controller";
import {
  getPreparationStations,
  postAssignMenuItemStation,
  postPreparationStation
} from "../controllers/preparationStation.controller";
import {
  getTableTabBalanceHandler,
  postRecordTabPayment
} from "../controllers/tabPayment.controller";
import { postCreateBillableCharge } from "../controllers/billableCharge.controller";
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
  patchWhatsappConversationAssignment,
  postWhatsappConversationTake,
  postWhatsappConversationSupportAck,
  getWhatsappConversationNotes,
  postWhatsappConversationNote,
  deleteWhatsappConversationNote,
  postWhatsappConversationViewing
} from "../controllers/adminWhatsappInbox.controller";
import {
  getCannedReplies,
  postCannedReply,
  patchCannedReply,
  deleteCannedReplyHandler
} from "../controllers/adminCannedReplies.controller";
import {
  getAdminBusiness,
  patchAdminBusiness
} from "../controllers/adminBusiness.controller";
import {
  deleteBusinessImageHandler,
  uploadBusinessImageHandler
} from "../controllers/adminBusinessImage.controller";
import { getAdminAiQuota } from "../controllers/adminAiQuota.controller";
import {
  getAdminBillingPlans,
  getAdminBillingSubscriptionHandler,
  postAdminBillingCheckout,
  postAdminBillingPortal,
  postAdminBillingSubscriptionCancel,
  postAdminBillingSubscriptionChangePlan,
  postAdminBillingSubscriptionReactivate,
} from "../controllers/adminBilling.controller";
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
import {
  deleteAdminDraftOrderItemHandler,
  getAdminDraftOrderHandler,
  patchAdminDraftOrderFulfillmentHandler,
  patchAdminDraftOrderItemHandler,
  postAdminDraftOrderRequestConfirmationHandler,
  postAdminDraftOrderItemHandler
} from "../controllers/adminDraftOrder.controller";
import {
  getArcaHealthHandler,
  getCuitLookupHandler,
  getFiscalConfigurationHandler,
  getInvoicingAddonHandler,
  getInvoicingUsageHandler,
  getIssuerConnectivityHandler,
  getOrderInvoicePdfHandler,
  getOrderInvoicesHandler,
  listInvoicesHandler,
  postEmitOrderInvoiceHandler,
  postProvisionEmisorHandler,
  putFiscalConfigurationHandler,
  putInvoicingAddonHandler
} from "../controllers/adminInvoicing.controller";

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
router.patch(
  "/orders/:id/delivery-assignment",
  requireRoles("OWNER", "ADMIN"),
  patchOrderDeliveryAssignment
);
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
router.post(
  "/business/image",
  requireRoles("OWNER", "ADMIN"),
  menuItemImageUploadMiddleware,
  uploadBusinessImageHandler
);
router.delete(
  "/business/image",
  requireRoles("OWNER", "ADMIN"),
  deleteBusinessImageHandler
);
router.get("/ai-quota", requireRoles("OWNER", "ADMIN"), getAdminAiQuota);
router.get(
  "/billing/plans",
  requireRoles("OWNER", "ADMIN"),
  getAdminBillingPlans
);
router.get(
  "/billing/subscription",
  requireRoles("OWNER", "ADMIN"),
  getAdminBillingSubscriptionHandler
);
router.post(
  "/billing/checkout",
  requireRoles("OWNER", "ADMIN"),
  postAdminBillingCheckout
);
router.post(
  "/billing/portal",
  requireRoles("OWNER", "ADMIN"),
  postAdminBillingPortal
);
router.post(
  "/billing/subscription/cancel",
  requireRoles("OWNER", "ADMIN"),
  postAdminBillingSubscriptionCancel
);
router.post(
  "/billing/subscription/reactivate",
  requireRoles("OWNER", "ADMIN"),
  postAdminBillingSubscriptionReactivate
);
router.post(
  "/billing/subscription/change-plan",
  requireRoles("OWNER", "ADMIN"),
  postAdminBillingSubscriptionChangePlan
);
router.get("/config", requireRoles("OWNER", "ADMIN"), getAdminBusinessConfig);
router.get(
  "/config/bot-personalities",
  requireRoles("OWNER", "ADMIN"),
  getAdminBotPersonalities
);
router.post("/config", requireRoles("OWNER", "ADMIN"), createAdminBusinessConfig);
router.patch("/config", requireRoles("OWNER", "ADMIN"), patchAdminBusinessConfig);
router.delete("/config", requireRoles("OWNER", "ADMIN"), removeAdminBusinessConfig);
router.get("/whatsapp/messages", requireRoles("OWNER", "ADMIN"), getWhatsappMessages);
router.get(
  "/whatsapp/conversations",
  requireRoles("OWNER", "ADMIN"),
  getWhatsappConversations
);
router.get(
  "/whatsapp/conversations/:conversationId/bot",
  requireRoles("OWNER", "ADMIN"),
  getWhatsappConversationBotStatus
);
router.patch(
  "/whatsapp/conversations/:conversationId/bot",
  requireRoles("OWNER", "ADMIN"),
  patchWhatsappConversationBotStatus
);
router.post(
  "/whatsapp/conversations/:conversationId/messages",
  requireRoles("OWNER", "ADMIN"),
  postAdminWhatsappReply
);
router.patch(
  "/whatsapp/conversations/:conversationId/assignment",
  requireRoles("OWNER", "ADMIN"),
  patchWhatsappConversationAssignment
);
router.post(
  "/whatsapp/conversations/:conversationId/take",
  requireRoles("OWNER", "ADMIN"),
  postWhatsappConversationTake
);
router.post(
  "/whatsapp/conversations/:conversationId/support-ack",
  requireRoles("OWNER", "ADMIN"),
  postWhatsappConversationSupportAck
);
router.get(
  "/whatsapp/conversations/:conversationId/notes",
  requireRoles("OWNER", "ADMIN"),
  getWhatsappConversationNotes
);
router.post(
  "/whatsapp/conversations/:conversationId/notes",
  requireRoles("OWNER", "ADMIN"),
  postWhatsappConversationNote
);
router.delete(
  "/whatsapp/conversations/:conversationId/notes/:noteId",
  requireRoles("OWNER", "ADMIN"),
  deleteWhatsappConversationNote
);
router.post(
  "/whatsapp/conversations/:conversationId/viewing",
  requireRoles("OWNER", "ADMIN"),
  postWhatsappConversationViewing
);
router.get(
  "/whatsapp/conversations/:conversationId/draft-order",
  requireRoles("OWNER", "ADMIN"),
  getAdminDraftOrderHandler
);
router.post(
  "/whatsapp/conversations/:conversationId/draft-order/items",
  requireRoles("OWNER", "ADMIN"),
  postAdminDraftOrderItemHandler
);
router.patch(
  "/whatsapp/conversations/:conversationId/draft-order/items/:itemId",
  requireRoles("OWNER", "ADMIN"),
  patchAdminDraftOrderItemHandler
);
router.delete(
  "/whatsapp/conversations/:conversationId/draft-order/items/:itemId",
  requireRoles("OWNER", "ADMIN"),
  deleteAdminDraftOrderItemHandler
);
router.patch(
  "/whatsapp/conversations/:conversationId/draft-order/fulfillment",
  requireRoles("OWNER", "ADMIN"),
  patchAdminDraftOrderFulfillmentHandler
);
router.post(
  "/whatsapp/conversations/:conversationId/draft-order/request-confirmation",
  requireRoles("OWNER", "ADMIN"),
  postAdminDraftOrderRequestConfirmationHandler
);
router.get(
  "/whatsapp/canned-replies",
  requireRoles("OWNER", "ADMIN"),
  getCannedReplies
);
router.post(
  "/whatsapp/canned-replies",
  requireRoles("OWNER", "ADMIN"),
  postCannedReply
);
router.patch(
  "/whatsapp/canned-replies/:id",
  requireRoles("OWNER", "ADMIN"),
  patchCannedReply
);
router.delete(
  "/whatsapp/canned-replies/:id",
  requireRoles("OWNER", "ADMIN"),
  deleteCannedReplyHandler
);
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
// Lectura abierta a MOZO también: el panel de `/pos` necesita el menú para
// armar una ronda (`POST /table-tabs/:id/rounds`). El CRUD del menú sigue
// exclusivo de OWNER/ADMIN.
router.get("/menu-items", requireRoles("OWNER", "ADMIN", "MOZO"), getMenuItems);
router.get("/menu-items/:id", requireRoles("OWNER", "ADMIN", "MOZO"), getMenuItemById);
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

// Lectura abierta a MOZO también: `/pos` necesita el catálogo de mesas
// (nombre/capacidad/entorno) para dibujar la grilla — ver `app/(dashboard)/pos`
// en gesty-admin. El CRUD del plano (crear/editar/borrar mesa) sigue exclusivo
// de OWNER/ADMIN, igual que siempre.
router.get("/tables", requireRoles("OWNER", "ADMIN", "MOZO"), getTables);
router.get("/tables/:id", requireRoles("OWNER", "ADMIN", "MOZO"), getTableById);
router.post("/tables", requireRoles("OWNER", "ADMIN"), postTable);
router.patch("/tables/:id", requireRoles("OWNER", "ADMIN"), patchTable);
router.delete("/tables/:id", requireRoles("OWNER", "ADMIN"), removeTable);

// Operación de salón sobre mesas y comandas (Fases 2/4, POS_TECHNICAL_DESIGN.md
// §4.A/§4.B/§4.C/§4.F). Matriz confirmada tras auditar cómo lo resuelven POS
// reales (Fudo separa explícitamente el permiso "Cerrar ventas" de "Cobrar
// mesa" — cerrar/cobrar/facturar quedan en el nivel de supervisor/caja, nunca
// en el mozo que toma el pedido):
//   - Lectura (ver mesas/cuentas y su consumo): MOZO + ADMIN/OWNER — el
//     encargado necesita poder revisar la cuenta ANTES de decidir cerrarla.
//   - Operación de mesa (abrir, asignar/transferir mesa, crear ronda,
//     reasignar mozo): MOZO exclusivo — es el trabajo del mozo, no del dueño.
//   - Cerrar cuenta, cobrar, facturar: ADMIN/OWNER exclusivo — el mozo nunca
//     maneja caja ni decide que una cuenta está saldada.
const TABLE_TAB_READ_ROLES = ["MOZO", "ADMIN", "OWNER"] as const;
const TABLE_TAB_OPERATE_ROLES = ["MOZO"] as const;
const TAB_PAYMENT_AND_BILLING_ROLES = ["OWNER", "ADMIN"] as const;

router.get("/table-tabs", requireRoles(...TABLE_TAB_READ_ROLES), getTableTabs);
router.get("/table-tabs/occupied-tables", requireRoles(...TABLE_TAB_READ_ROLES), getOccupiedTables);
router.get("/table-tabs/:id", requireRoles(...TABLE_TAB_READ_ROLES), getTableTabById_);
router.get("/table-tabs/:id/orders", requireRoles(...TABLE_TAB_READ_ROLES), getTableTabOrders);
router.post("/table-tabs", requireRoles(...TABLE_TAB_OPERATE_ROLES), postOpenTableTab);
router.post("/table-tabs/:id/tables", requireRoles(...TABLE_TAB_OPERATE_ROLES), postAssignTableToTab);
router.post("/table-tabs/:id/transfer", requireRoles(...TABLE_TAB_OPERATE_ROLES), postTransferTable);
router.post("/table-tabs/:id/rounds", requireRoles(...TABLE_TAB_OPERATE_ROLES), postCreateTableTabRound);
router.patch("/table-tabs/:id/assignee", requireRoles(...TABLE_TAB_OPERATE_ROLES), patchReassignTableTab);

// Cierre de cuenta: exclusivo de ADMIN/OWNER (encargado/caja), NO el mozo —
// ver matriz arriba. El mozo sirve, no cierra ni verifica caja.
router.post("/table-tabs/:id/close", requireRoles(...TAB_PAYMENT_AND_BILLING_ROLES), postCloseTableTab);

// Anulación de ítem desde el salón (Fase 4, POS_TECHNICAL_DESIGN.md §4.C): el
// mozo puede anular sin fricción si el ítem sigue `pending` (sin costo
// hundido); si ya está `preparing`/`ready`, la regla ya aprobada exige
// ADMIN/OWNER + motivo. Por eso el endpoint admite ambos sets — el servicio
// (`cancelOrderItem`) decide el permiso exacto según el estado real del ítem.
router.post(
  "/table-tabs/:id/cancel-item",
  requireRoles("MOZO", "ADMIN", "OWNER"),
  postCancelTableTabItem
);

router.get(
  "/table-tabs/:id/balance",
  requireRoles(...TAB_PAYMENT_AND_BILLING_ROLES),
  getTableTabBalanceHandler
);
router.post(
  "/table-tabs/:id/payments",
  requireRoles(...TAB_PAYMENT_AND_BILLING_ROLES),
  postRecordTabPayment
);
router.post(
  "/table-tabs/:id/billable-charges",
  requireRoles(...TAB_PAYMENT_AND_BILLING_ROLES),
  postCreateBillableCharge
);

// Comandas y estaciones (Fase 4, POS_TECHNICAL_DESIGN.md §4.C). El snapshot
// REST (`GET /kitchen-tickets`, usado por el KDS al montar/reconectar/polling,
// Fase 5, §4.C) y la transición de estado quedan exclusivos de MOZO — no es
// parte de la decisión de hoy (cierre/cobro/facturación), sin cambios.
router.get("/kitchen-tickets", requireRoles(...TABLE_TAB_OPERATE_ROLES), getKitchenTickets);
router.patch(
  "/kitchen-tickets/items/:id/status",
  requireRoles(...TABLE_TAB_OPERATE_ROLES),
  patchKitchenTicketItemStatus
);
router.get("/kitchen-stations", requireRoles("OWNER", "ADMIN"), getPreparationStations);
router.post("/kitchen-stations", requireRoles("OWNER", "ADMIN"), postPreparationStation);
router.post(
  "/kitchen-stations/:id/menu-items",
  requireRoles("OWNER", "ADMIN"),
  postAssignMenuItemStation
);

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

router.get("/reservations", requireRoles("OWNER", "ADMIN"), getReservations);
router.get(
  "/reservations/:id",
  requireRoles("OWNER", "ADMIN"),
  getReservationById
);

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

// Facturación electrónica (add-on opcional, ver FASE 7 del encargo de invoicing)
router.get("/invoicing/arca-health", requireRoles("OWNER", "ADMIN"), getArcaHealthHandler);
router.get("/invoicing/fiscal-configuration", requireRoles("OWNER", "ADMIN"), getFiscalConfigurationHandler);
router.put("/invoicing/fiscal-configuration", requireRoles("OWNER", "ADMIN"), putFiscalConfigurationHandler);
router.get("/invoicing/fiscal-configuration/issuer-connectivity", requireRoles("OWNER", "ADMIN"), getIssuerConnectivityHandler);
router.get("/invoicing/fiscal-configuration/cuit-lookup/:cuit", requireRoles("OWNER", "ADMIN"), getCuitLookupHandler);
router.get("/invoicing/addon", requireRoles("OWNER", "ADMIN"), getInvoicingAddonHandler);
router.put("/invoicing/addon", requireRoles("OWNER", "ADMIN"), putInvoicingAddonHandler);
router.get("/invoicing/usage", requireRoles("OWNER", "ADMIN"), getInvoicingUsageHandler);
router.get("/invoicing/invoices", requireRoles("OWNER", "ADMIN"), listInvoicesHandler);
router.get("/invoicing/orders/:orderId/invoices", requireRoles("OWNER", "ADMIN"), getOrderInvoicesHandler);
router.get("/invoicing/orders/:orderId/invoices/:invoiceId/pdf", requireRoles("OWNER", "ADMIN"), getOrderInvoicePdfHandler);
router.post("/invoicing/orders/:orderId/emit", requireRoles("OWNER", "ADMIN"), postEmitOrderInvoiceHandler);
router.post("/invoicing/fiscal-configuration/provision-emisor", requireRoles("OWNER", "ADMIN"), postProvisionEmisorHandler);

// Announcements inbox (business)
router.get("/announcements", listAnnouncementsForBusinessHandler);
router.get("/announcements/unread-count", getUnreadCountHandler);
router.get("/announcements/:id", getAnnouncementForBusinessHandler);
router.post("/announcements/:id/read", markAnnouncementReadHandler);
router.get("/announcements/:id/readers", getReadersForBusinessHandler);

export default router;
