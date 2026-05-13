import type { BusinessUserRole } from "./auth";

declare global {
  namespace Express {
    interface Request {
      user?: {
        userId: string;
        /** Vacío solo para `SUPER_ADMIN` (sin tenant en el token). */
        businessId: string | null;
        role: BusinessUserRole;
      };
    }
  }
}

export {};
