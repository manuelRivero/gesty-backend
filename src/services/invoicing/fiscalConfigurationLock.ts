import { withBillingLock } from "../billing/billingLock";

const FISCAL_CONFIGURATION_LOCK_NAMESPACE = "gesty:invoicing:emisor-provisioning";

export function withFiscalConfigurationLock<T>(
  businessId: string,
  operation: () => Promise<T>
): Promise<T> {
  return withBillingLock(FISCAL_CONFIGURATION_LOCK_NAMESPACE, businessId, operation);
}
