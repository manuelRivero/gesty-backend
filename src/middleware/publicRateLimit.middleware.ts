import type { NextFunction, Request, Response } from "express";

type Bucket = {
  count: number;
  resetAt: number;
};

function clientIp(req: Request): string {
  return (
    (typeof req.headers["x-forwarded-for"] === "string"
      ? req.headers["x-forwarded-for"].split(",")[0]?.trim()
      : null) ||
    req.ip ||
    req.socket.remoteAddress ||
    "unknown"
  );
}

/**
 * Rate limit in-memory por clave (IP y/o orderId).
 * No es multi-instancia; en varios replicas cada uno tiene su ventana.
 */
export function createKeyedRateLimit(opts: {
  windowMs: number;
  max: number;
  /** Clave del bucket. Default: IP. */
  keyFn?: (req: Request) => string;
  code?: string;
  message?: string;
}) {
  const buckets = new Map<string, Bucket>();
  const code = opts.code ?? "RATE_LIMITED";
  const message = opts.message ?? "Demasiadas solicitudes; reintentá en un momento";
  const keyFn = opts.keyFn ?? ((req: Request) => `ip:${clientIp(req)}`);

  const sweepEvery = Math.max(opts.windowMs, 60_000);
  let lastSweep = Date.now();

  return function keyedRateLimit(
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

    const key = keyFn(req);
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(key, bucket);
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

/**
 * Rate limit in-memory por IP (suficiente para abuso desde storefront).
 */
export function createIpRateLimit(opts: {
  windowMs: number;
  max: number;
  code?: string;
  message?: string;
}) {
  return createKeyedRateLimit({
    ...opts,
    keyFn: (req) => `ip:${clientIp(req)}`
  });
}
