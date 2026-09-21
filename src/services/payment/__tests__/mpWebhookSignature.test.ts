import crypto from "crypto";
import { describe, expect, it } from "vitest";
import type { Request } from "express";
import { verifyMpWebhookSignature } from "../mercadoPago.service";

function sign(secret: string, message: string): string {
  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

function fakeReq(params: {
  dataIdBody?: string;
  dataIdQuery?: string;
  requestId?: string;
  ts: string;
  v1: string;
}): Request {
  return {
    headers: {
      "x-signature": `ts=${params.ts},v1=${params.v1}`,
      ...(params.requestId ? { "x-request-id": params.requestId } : {})
    },
    query: params.dataIdQuery ? { "data.id": params.dataIdQuery } : {},
    body: params.dataIdBody ? { data: { id: params.dataIdBody } } : {}
  } as unknown as Request;
}

describe("verifyMpWebhookSignature", () => {
  const secret = "test-secret";
  const ts = "1704908010";
  const requestId = "req-abc";
  const dataId = "179096755117";

  it("acepta manifest oficial con ; final y data.id de query", () => {
    const message = `id:${dataId};request-id:${requestId};ts:${ts};`;
    const v1 = sign(secret, message);
    expect(
      verifyMpWebhookSignature(
        fakeReq({ dataIdQuery: dataId, requestId, ts, v1 }),
        secret
      )
    ).toBe(true);
  });

  it("acepta data.id solo en body (fallback)", () => {
    const message = `id:${dataId};request-id:${requestId};ts:${ts};`;
    const v1 = sign(secret, message);
    expect(
      verifyMpWebhookSignature(
        fakeReq({ dataIdBody: dataId, requestId, ts, v1 }),
        secret
      )
    ).toBe(true);
  });

  it("lowercases data.id alfanumérico", () => {
    const raw = "ORD01ABC";
    const message = `id:${raw.toLowerCase()};request-id:${requestId};ts:${ts};`;
    const v1 = sign(secret, message);
    expect(
      verifyMpWebhookSignature(
        fakeReq({ dataIdQuery: raw, requestId, ts, v1 }),
        secret
      )
    ).toBe(true);
  });

  it("omite request-id si no viene header", () => {
    const message = `id:${dataId};ts:${ts};`;
    const v1 = sign(secret, message);
    expect(
      verifyMpWebhookSignature(
        fakeReq({ dataIdQuery: dataId, ts, v1 }),
        secret
      )
    ).toBe(true);
  });

  it("rechaza manifest viejo sin ; final", () => {
    const legacy = `id:${dataId};request-id:${requestId};ts:${ts}`;
    const v1 = sign(secret, legacy);
    expect(
      verifyMpWebhookSignature(
        fakeReq({ dataIdQuery: dataId, requestId, ts, v1 }),
        secret
      )
    ).toBe(false);
  });

  it("rechaza secret incorrecto", () => {
    const message = `id:${dataId};request-id:${requestId};ts:${ts};`;
    const v1 = sign(secret, message);
    expect(
      verifyMpWebhookSignature(
        fakeReq({ dataIdQuery: dataId, requestId, ts, v1 }),
        "other-secret"
      )
    ).toBe(false);
  });
});
