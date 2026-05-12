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

// Handlers de intención (NLP)
import { OrderFoodHandler } from './orderFoodHandler';
import { RemoveItemHandler } from './removeItemHandler';
import { ProductQueryHandler } from './productQueryHandler';
import { RecommendationRequestHandler } from './recommendationRequestHandler';
import { FeaturedPageHandler } from './featuredPageHandler';
import { ProductAttributeQuestionHandler } from './productAttributeQuestionHandler';
import { SmallTalkHandler } from './smallTalkHandler';
import { EditAddressHandler } from './editAddressHandler';
import { BusinessHoursHandler } from './businessHoursHandler';
import { ReservationHandler } from './reservationHandler';
import { ViewReservationHandler } from './viewReservationHandler';
import { ViewQrHandler } from './viewQrHandler';

import { ModifyQuantityHandler } from './modifyQuantityHandler';
import { ProvideNameHandler } from './provideNameHandler';
import { SupportHandler } from './supportHandler';

// Fallback
import { FallbackHandler } from './fallbackHandler';
import { ViewCartForEditionHandler } from './viewCartForEditionHandler';
import { ViewCartHandler } from './viewCartHandler';
import { ViewMenuHandler } from './viewMenuHandler';
import { SelectCartItemForEditionHandler } from './selectCartItemForEdition';
import { SelectDecreaseItemQuantityHandler } from './selectDecreaseItemQuantityHandler';
import { DecreaseItemHandler } from './decreaseItemHandler';
import { SelectIncreaseItemQuantityHandler } from './selectIncreaseItemQuantityHandler';
import { IncreaseItemHandler } from './increaseItemHandler';
import { OnboardingStartHandler } from './onboardingStartHandler';

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
  new ViewCartHandler(),
  new ViewMenuHandler(),
  new SelectCartItemForEditionHandler(),
  new DecreaseItemHandler(),
  new SelectDecreaseItemQuantityHandler(),
  new IncreaseItemHandler(),
  new SelectIncreaseItemQuantityHandler(),
  new OnboardingStartHandler(),
  // === INTENCIONES (NLP) ===
  new OrderFoodHandler(),
  new SmallTalkHandler(),
  new EditAddressHandler(),
  new BusinessHoursHandler(),
  new ViewReservationHandler(),
  new ViewQrHandler(),
  new ReservationHandler(),
  new RemoveItemHandler(),
  new ProductQueryHandler(),
  new RecommendationRequestHandler(),
  new ProductAttributeQuestionHandler(),
  new ModifyQuantityHandler(),
  new ProvideNameHandler(),
  new SupportHandler(),

  // === FALLBACK (siempre último) ===
  new FallbackHandler()
];