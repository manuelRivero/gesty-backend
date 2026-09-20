import type { NextFunction, Request, Response } from "express";

type Bucket = {
  count: number;
  resetAt: number;
};

/**
 * Rate limit in-memory por IP (suficiente para abuso desde storefront).
 * No es multi-instancia; en varios replicas cada uno tiene su ventana.
 */
export function createIpRateLimit(opts: {
  windowMs: number;
  max: number;
  code?: string;
  message?: string;
}) {
  const buckets = new Map<string, Bucket>();
  const code = opts.code ?? "RATE_LIMITED";
  const message = opts.message ?? "Demasiadas solicitudes; reintentá en un momento";

  // Limpieza ocasional para no crecer sin bound.
  const sweepEvery = Math.max(opts.windowMs, 60_000);
  let lastSweep = Date.now();

  return function ipRateLimit(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    const now = Date.now();
    if (now - lastSweep > sweepEvery) {
      lastSweep = now;
      for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(key);
      }
    }

    const ip =
      (typeof req.headers["x-forwarded-for"] === "string"
        ? req.headers["x-forwarded-for"].split(",")[0]?.trim()
        : null) ||
      req.ip ||
      req.socket.remoteAddress ||
      "unknown";

    let bucket = buckets.get(ip);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(ip, bucket);
    }

    bucket.count += 1;
    const remaining = Math.max(0, opts.max - bucket.count);
    res.setHeader("X-RateLimit-Limit", String(opts.max));
    res.setHeader("X-RateLimit-Remaining", String(remaining));
    res.setHeader(
      "X-RateLimit-Reset",
      String(Math.ceil(bucket.resetAt / 1000))
    );

    if (bucket.count > opts.max) {
      res.status(429).json({ error: message, code });
      return;
    }

    next();
  };
}
