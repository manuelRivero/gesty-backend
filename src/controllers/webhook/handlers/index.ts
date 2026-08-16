// src/controllers/webhook/handlers/index.ts

// Handlers de botones (payloadId)
import { SelectProductHandler } from './selectProductHandler';
import { SelectOrderProductHandler } from './selectOrderProductHandler';
import { OrderSearchPageHandler } from './orderSearchPageHandler';
import { CategoryPageHandler } from './categoryPageHandler';
import { CategoryListPageHandler } from './categoryListPageHandler';
import { MenuByTagHandler } from './menuByTagHandler';
import { CategoryHandler } from './categoryHandler';
import { AddItemHandler } from './addItemHandler';
import { ShowComplementSuggestionsHandler } from './showComplementSuggestionsHandler';
import { CheckoutHandler } from './checkoutHandler';
import { CancelOrderHandler } from './cancelOrderHandler';
import { EndConversationHandler } from './endConversationHandler';
import { AskQuestionHandler } from './askQuestionHandler';
import { ViewMenuReturnHandler } from './viewMenuReturnHandler';
import { ViewCategoriesHandler } from './viewCategoriesHandler';
import { ConfirmRemoveActionHandler } from './confirmRemoveActionHandler';
import { CancelRemoveActionHandler } from './cancelRemoveActionHandler';

import { FeaturedPageHandler } from './featuredPageHandler';
import { EditAddressHandler } from './editAddressHandler';
import { BusinessHoursHandler } from './businessHoursHandler';
import { ReservationHandler } from './reservationHandler';
import { ViewReservationHandler } from './viewReservationHandler';
import { ViewQrHandler } from './viewQrHandler';
import { SupportHandler } from './supportHandler';

// Fallback
import { FallbackHandler } from './fallbackHandler';
import { ViewCartForEditionHandler } from './viewCartForEditionHandler';
import { ItemNoteHandler } from './itemNoteHandler';
import { ViewCartHandler } from './viewCartHandler';
import { ViewMenuHandler } from './viewMenuHandler';
import { SelectCartItemForEditionHandler } from './selectCartItemForEdition';
import { SelectDecreaseItemQuantityHandler } from './selectDecreaseItemQuantityHandler';
import { DecreaseItemHandler } from './decreaseItemHandler';
import { SelectIncreaseItemQuantityHandler } from './selectIncreaseItemQuantityHandler';
import { IncreaseItemHandler } from './increaseItemHandler';
import { SelectDeliveryHandler, SelectTakeAwayHandler } from './selectFulfillmentHandler';
import { PayOnlineHandler } from './payOnlineHandler';
import { PayCashHandler, PayTransferHandler } from './payCashHandler';

export const handlers = [
  // === BOTONES (payloadId) - orden: más específicos primero ===
  new SelectProductHandler(),
  new SelectOrderProductHandler(),
  new OrderSearchPageHandler(),
  new FeaturedPageHandler(),
  new CategoryPageHandler(),
  new CategoryListPageHandler(),
  new MenuByTagHandler(),
  new CategoryHandler(),
  new AddItemHandler(),
  new ShowComplementSuggestionsHandler(),
  new CheckoutHandler(),
  new CancelOrderHandler(),
  new EndConversationHandler(),
  new AskQuestionHandler(),
  new ViewMenuReturnHandler(),
  new ViewCategoriesHandler(),
  new CancelRemoveActionHandler(),
  new ConfirmRemoveActionHandler(),
  new ViewCartForEditionHandler(),
  new ItemNoteHandler(),
  new ViewCartHandler(),
  new ViewMenuHandler(),
  new SelectCartItemForEditionHandler(),
  new DecreaseItemHandler(),
  new SelectDecreaseItemQuantityHandler(),
  new IncreaseItemHandler(),
  new SelectIncreaseItemQuantityHandler(),
  SelectDeliveryHandler,
  SelectTakeAwayHandler,
  new PayOnlineHandler(),
  new PayCashHandler(),
  new PayTransferHandler(),
  // === BOTONES de sesión / negocio (payloadId, no prosa) ===
  new EditAddressHandler(),
  new BusinessHoursHandler(),
  new ViewReservationHandler(),
  new ViewQrHandler(),
  new ReservationHandler(),
  new SupportHandler(),

  // === FALLBACK (siempre último) ===
  new FallbackHandler()
];