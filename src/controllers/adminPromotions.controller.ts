/**
 * Endpoints admin de promociones
 * (PLAN-ACCION-PROMOCIONES-PERSISTENCIA.md).
 *
 *   POST   /api/admin/promotions/interpret        texto|audio → StructuredOffer + candidatos
 *   POST   /api/admin/promotions/resolve-entities re-buscar candidatos del menú
 *   POST   /api/admin/promotions                  persiste (rechaza incompletas, D6)
 *   GET    /api/admin/promotions                  listado paginado
 *   GET    /api/admin/promotions/:id              detalle
 *   PATCH  /api/admin/promotions/:id              edición / cambio de estado
 *   DELETE /api/admin/promotions/:id              archiva (D5)
 *
 * El buffer de audio vive solo en memoria (multer) y no se persiste.
 */

import type { Request, Response } from 'express';
import { z } from 'zod';
import type { business as Business } from '@prisma/client';
import { prisma } from '../lib/prisma';
import {
  detectAudioMimeFromBuffer,
  MAX_PROMOTION_AUDIO_BYTES,
} from '../middleware/audioUpload.middleware';
import {
  AudioTranscriptionError,
  transcribeAudio,
} from '../services/ai/audioTranscription.service';
import { getEffectiveAiTokenLimit } from '../services/ai/aiLimits';
import { incrementUsage } from '../services/ai/aiUsage.service';
import { evaluateBusinessBillingAccess } from '../services/billing/evaluateBusinessBillingAccess.service';
import { interpretPromotionText } from '../services/promotions/promotionInterpreter.service';
import { resolveProductEntities } from '../services/promotions/resolveProductEntities';
import { buildEntityCards } from '../services/promotions/buildPromotionDisplay';
import {
  archivePromotion,
  createPromotion,
  getPromotionById,
  listPromotions,
  PromotionForeignProductError,
  PromotionInvalidOfferError,
  PromotionNotFoundError,
  updatePromotion,
} from '../services/promotions/adminPromotions.service';
import {
  PromotionAmbiguousBenefitError,
  PromotionIncompleteError,
  PromotionNotEvaluableError,
  PromotionInvalidTransitionError,
} from '../services/promotions/promotionStatus';

const textBodySchema = z.object({
  type: z.literal('text'),
  text: z.string().min(1).max(4000),
  /** D8: buscar candidatos del menú en el mismo turno. */
  resolveProducts: z.boolean().optional(),
});

const productLinkSchema = z.object({
  path: z.string().min(1),
  role: z.enum(['condition', 'benefit']),
  menuItemId: z.string().uuid(),
  sourceText: z.string().min(1),
  quantity: z.number().int().positive().nullable().optional(),
});

const createPromotionSchema = z.object({
  offer: z.unknown(),
  productLinks: z.array(productLinkSchema).default([]),
  status: z.enum(['draft', 'active']).optional(),
  sourceType: z.enum(['text', 'audio']).optional(),
  sourceText: z.string().max(4000).nullable().optional(),
  name: z.string().min(1).max(120).optional(),
});

const updatePromotionSchema = z.object({
  offer: z.unknown().optional(),
  productLinks: z.array(productLinkSchema).optional(),
  status: z.enum(['draft', 'active', 'paused', 'archived']).optional(),
  name: z.string().min(1).max(120).optional(),
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
  status: z.enum(['draft', 'active', 'paused', 'archived']).optional(),
  q: z.string().max(120).optional(),
  includeArchived: z.coerce.boolean().optional(),
});

const idParamSchema = z.object({ id: z.string().uuid() });

const resolveEntitiesSchema = z.object({
  entities: z
    .array(
      z.object({
        text: z.string().min(1).max(120),
        type: z.enum(['product', 'category', 'other']).default('product'),
        path: z.string().min(1),
      })
    )
    .min(1)
    .max(20),
});

async function loadBusiness(businessId: string): Promise<Business | null> {
  return prisma.business.findUnique({ where: { id: businessId } });
}

async function canUseAiForBusiness(business: Business): Promise<boolean> {
  if (business.ai_blocked) return false;
  const trialAccess = await evaluateBusinessBillingAccess(business);
  if (!trialAccess.ok) return false;
  const effectiveLimit = getEffectiveAiTokenLimit(trialAccess.business);
  if (trialAccess.business.ai_monthly_tokens_used >= effectiveLimit) return false;
  return true;
}

function isMultipart(req: Request): boolean {
  const ct = String(req.headers['content-type'] ?? '').toLowerCase();
  return ct.includes('multipart/form-data');
}

/**
 * Interpreta una promoción desde texto JSON o audio multipart.
 */
export async function interpretPromotionHandler(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: 'No autenticado' });
  }

  const startedAt = Date.now();
  const business = await loadBusiness(businessId);
  if (!business) {
    return res.status(404).json({ error: 'Negocio no encontrado' });
  }

  const canUse = await canUseAiForBusiness(business).catch((error) => {
    console.error(
      JSON.stringify({
        event: '[admin-promotions-interpret] usage_gate_failed',
        businessId,
        error: String(error),
      })
    );
    return false;
  });
  if (!canUse) {
    return res.status(402).json({
      error: 'Sin cuota de IA disponible para interpretar promociones',
    });
  }

  let inputType: 'text' | 'audio';
  let normalizedText: string;
  let resolveProducts = true;
  let transcription: { text: string; language?: string; duration?: number } | null = null;

  if (isMultipart(req)) {
    const typeField = String(req.body?.type ?? 'audio').toLowerCase();
    if (typeField !== 'audio') {
      return res.status(400).json({
        error: 'Para multipart usá type=audio y el campo file audio',
      });
    }

    const file = req.file;
    if (!file?.buffer?.length) {
      return res.status(400).json({ error: 'Falta el archivo de audio' });
    }
    if (file.buffer.length > MAX_PROMOTION_AUDIO_BYTES) {
      return res.status(400).json({ error: 'El audio supera el tamaño máximo de 10 MB' });
    }

    const detectedMime = detectAudioMimeFromBuffer(file.buffer);
    if (!detectedMime) {
      return res.status(400).json({
        error: 'El archivo no parece un audio válido (magic bytes)',
      });
    }

    inputType = 'audio';
    resolveProducts = String(req.body?.resolveProducts ?? 'true') !== 'false';
    try {
      const stt = await transcribeAudio({
        audioBuffer: file.buffer,
        mimeType: detectedMime,
        language: 'es',
      });
      if (stt.usageTokens && stt.usageTokens > 0) {
        await incrementUsage(businessId, stt.usageTokens).catch((error) => {
          console.error(
            JSON.stringify({
              event: '[admin-promotions-interpret] stt_increment_failed',
              businessId,
              error: String(error),
            })
          );
        });
      }
      transcription = {
        text: stt.text,
        language: stt.language,
        ...(stt.duration !== undefined ? { duration: stt.duration } : {}),
      };
      normalizedText = stt.text;
    } catch (error) {
      const code =
        error instanceof AudioTranscriptionError ? error.code : 'PROVIDER_FAILED';
      console.error(
        JSON.stringify({
          event: '[admin-promotions-interpret] transcription_failed',
          businessId,
          code,
          error: String(error),
          latencyMs: Date.now() - startedAt,
        })
      );
      if (code === 'EMPTY_TRANSCRIPT') {
        return res.status(422).json({ error: 'No se pudo obtener texto del audio' });
      }
      return res.status(502).json({ error: 'Falló la transcripción del audio' });
    }
  } else {
    const parsed = textBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Body inválido',
        details: parsed.error.flatten(),
      });
    }
    inputType = 'text';
    normalizedText = parsed.data.text.trim();
    resolveProducts = parsed.data.resolveProducts ?? true;
  }

  const interpretation = await interpretPromotionText({
    text: normalizedText,
    businessId,
    resolveProducts,
  });

  console.log(
    JSON.stringify({
      event: '[admin-promotions-interpret] done',
      businessId,
      inputType,
      transcriptionText: transcription?.text ?? null,
      normalizedText,
      interpretationStatus: interpretation.status,
      latencyMs: Date.now() - startedAt,
    })
  );

  if (interpretation.status === 'error') {
    return res.status(502).json({
      input:
        inputType === 'text'
          ? { type: 'text' as const, text: normalizedText }
          : { type: 'audio' as const },
      transcription,
      interpretation: { status: 'error' as const },
    });
  }

  return res.json({
    input:
      inputType === 'text'
        ? { type: 'text' as const, text: normalizedText }
        : { type: 'audio' as const },
    transcription,
    interpretation,
  });
}

/**
 * Re-busca candidatos del menú. Se usa cuando el admin corrige a mano el nombre
 * de un producto y quiere volver a ver opciones sin reinterpretar todo.
 */
export async function resolvePromotionEntitiesHandler(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) return res.status(401).json({ error: 'No autenticado' });

  const parsed = resolveEntitiesSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Body inválido', details: parsed.error.flatten() });
  }

  const entities = parsed.data.entities.map((entity) => ({
    type: entity.type,
    text: entity.text,
    path: entity.path,
  }));

  const resolved = await resolveProductEntities({ businessId, entities });

  return res.json({
    entityCards: buildEntityCards(
      entities,
      resolved.map((item) => ({
        path: item.entity.path,
        candidates: item.candidates,
        resolved: item.resolved,
      }))
    ),
  });
}

/** Traduce los errores de dominio a HTTP sin filtrar internals. */
function handlePromotionError(res: Response, error: unknown): Response {
  if (error instanceof PromotionIncompleteError) {
    return res.status(409).json({
      error: 'La promoción está incompleta',
      code: error.code,
      missing: error.missing,
    });
  }
  if (error instanceof PromotionNotEvaluableError) {
    return res.status(409).json({
      error: 'La promoción no se puede aplicar automáticamente todavía',
      code: error.code,
      missing: error.missing,
    });
  }
  if (error instanceof PromotionAmbiguousBenefitError) {
    return res.status(409).json({
      error: 'El beneficio de la promoción es ambiguo',
      code: error.code,
      missing: error.missing,
    });
  }
  if (error instanceof PromotionInvalidTransitionError) {
    return res.status(409).json({
      error: `No se puede pasar de ${error.from} a ${error.to}`,
      code: error.code,
    });
  }
  if (error instanceof PromotionForeignProductError) {
    return res.status(400).json({
      error: 'Algún platillo no pertenece a este negocio',
      code: error.code,
      menuItemIds: error.menuItemIds,
    });
  }
  if (error instanceof PromotionInvalidOfferError) {
    return res.status(400).json({
      error: 'La oferta no es válida',
      code: error.code,
      details: error.details,
    });
  }
  if (error instanceof PromotionNotFoundError) {
    return res.status(404).json({ error: 'Promoción no encontrada', code: error.code });
  }
  throw error;
}

export async function createPromotionHandler(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) return res.status(401).json({ error: 'No autenticado' });

  const parsed = createPromotionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Body inválido', details: parsed.error.flatten() });
  }

  try {
    const promotion = await createPromotion({
      businessId,
      userId: req.user?.userId ?? null,
      offer: parsed.data.offer,
      productLinks: parsed.data.productLinks,
      status: parsed.data.status,
      sourceType: parsed.data.sourceType,
      sourceText: parsed.data.sourceText ?? null,
      name: parsed.data.name,
    });
    return res.status(201).json(promotion);
  } catch (error) {
    return handlePromotionError(res, error);
  }
}

export async function listPromotionsHandler(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) return res.status(401).json({ error: 'No autenticado' });

  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Query inválida', details: parsed.error.flatten() });
  }

  const result = await listPromotions({ businessId, ...parsed.data });
  return res.json(result);
}

export async function getPromotionByIdHandler(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) return res.status(401).json({ error: 'No autenticado' });

  const parsedParams = idParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: 'id inválido' });
  }

  try {
    return res.json(await getPromotionById({ businessId, id: parsedParams.data.id }));
  } catch (error) {
    return handlePromotionError(res, error);
  }
}

export async function patchPromotionHandler(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) return res.status(401).json({ error: 'No autenticado' });

  const parsedParams = idParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: 'id inválido' });
  }

  const parsed = updatePromotionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Body inválido', details: parsed.error.flatten() });
  }

  try {
    const promotion = await updatePromotion({
      businessId,
      id: parsedParams.data.id,
      ...parsed.data,
    });
    return res.json(promotion);
  } catch (error) {
    return handlePromotionError(res, error);
  }
}

export async function deletePromotionHandler(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) return res.status(401).json({ error: 'No autenticado' });

  const parsedParams = idParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: 'id inválido' });
  }

  try {
    await archivePromotion({ businessId, id: parsedParams.data.id });
    return res.status(204).send();
  } catch (error) {
    return handlePromotionError(res, error);
  }
}
