import type { customer, customer_address } from '@prisma/client';
import { prisma } from '../lib/prisma';

export const findOrCreateCustomer = async (
  businessId: string,
  phoneNumber: string,
  name?: string
): Promise<customer> => {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { currency_code: true }
  });

  return prisma.customer.upsert({
    where: {
      business_id_phone_number: {
        business_id: businessId,
        phone_number: phoneNumber
      }
    },
    update: {
      name: name ?? undefined
    },
    create: {
      business_id: businessId,
      phone_number: phoneNumber,
      name: name ?? undefined,
      preferred_currency: business?.currency_code ?? undefined
    }
  });
};

export const updateCustomerName = async (
  customerId: string,
  name: string
): Promise<customer> => {
  return prisma.customer.update({
    where: { id: customerId },
    data: { name }
  });
};

export const findCustomerById = async (customerId: string): Promise<customer | null> => {
  return prisma.customer.findUnique({
    where: { id: customerId }
  });
};

export const findDefaultCustomerAddress = async (
  customerId: string
): Promise<customer_address | null> => {
  return prisma.customer_address.findFirst({
    where: {
      customer_id: customerId,
      is_default: true,
    },
  });
};
