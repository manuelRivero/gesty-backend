/**
 * Sanitizador HTML para el cuerpo de anuncios.
 * Sólo permite una allowlist de tags y atributos inofensivos.
 * No depende de librerías externas para no agregar superficie de ataque de terceros.
 */

const ALLOWED_TAGS = new Set([
  "p", "br", "strong", "b", "em", "i", "u", "s",
  "ul", "ol", "li",
  "h1", "h2", "h3", "h4",
  "blockquote",
  "a",
  "img",
  "hr",
  "pre", "code",
  "span", "div",
]);

/** Atributos permitidos globalmente (en cualquier tag). */
const ALLOWED_ATTRS_GLOBAL = new Set(["class", "id"]);

/** Atributos permitidos sólo en tags específicos. */
const ALLOWED_ATTRS_BY_TAG: Record<string, Set<string>> = {
  a: new Set(["href", "title", "target", "rel"]),
  img: new Set(["src", "alt", "title", "width", "height"]),
};

/** Protocolos seguros para href/src. */
const SAFE_PROTOCOLS = /^(https?:\/\/|mailto:|\/\/|\/)/i;

function sanitizeAttrValue(tag: string, attr: string, value: string): string | null {
  const lowerAttr = attr.toLowerCase();
  const tagAttrs = ALLOWED_ATTRS_BY_TAG[tag];
  const allowed =
    ALLOWED_ATTRS_GLOBAL.has(lowerAttr) ||
    (tagAttrs !== undefined && tagAttrs.has(lowerAttr));

  if (!allowed) return null;

  // Validar protocolos en URLs
  if (lowerAttr === "href" || lowerAttr === "src") {
    const clean = value.trim().replace(/[\u0000-\u001F]/g, "");
    if (!SAFE_PROTOCOLS.test(clean)) return null;
    return clean;
  }

  // Bloquear event handlers y expresiones JS en style/class
  if (/javascript|expression|vbscript/i.test(value)) return null;

  return value;
}

/**
 * Elimina tags no permitidos y atributos peligrosos.
 * No parsea un DOM real: procesa el string con regex. Suficiente para
 * contenido de texto enriquecido simple (TipTap / Quill).
 */
export function sanitizeAnnouncementHtml(raw: string): string {
  if (!raw) return "";

  // Eliminar comentarios HTML
  let html = raw.replace(/<!--[\s\S]*?-->/g, "");

  // Eliminar CDATA, procesing instructions
  html = html.replace(/<!\[CDATA\[[\s\S]*?\]\]>/gi, "");
  html = html.replace(/<\?[\s\S]*?\?>/g, "");

  // Procesar todos los tags
  html = html.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)(\s[^>]*)?\s*\/?>/g, (match, tagName, attrsStr) => {
    const tag = tagName.toLowerCase();

    // Tag no permitido: eliminar
    if (!ALLOWED_TAGS.has(tag)) return "";

    // Closing tag sin atributos
    if (match.startsWith("</")) return `</${tag}>`;

    // Self-closing void tags
    const isVoid = tag === "br" || tag === "hr" || tag === "img";

    // Procesar atributos
    const safeAttrs: string[] = [];
    if (attrsStr) {
      const attrPattern = /([a-zA-Z][a-zA-Z0-9\-:]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*)))?/g;
      let m: RegExpExecArray | null;
      while ((m = attrPattern.exec(attrsStr)) !== null) {
        const attrName = m[1].toLowerCase();
        const attrVal = m[2] ?? m[3] ?? m[4] ?? "";
        const safe = sanitizeAttrValue(tag, attrName, attrVal);
        if (safe !== null) {
          safeAttrs.push(`${attrName}="${safe.replace(/"/g, "&quot;")}"`);
        }
      }
    }

    // Forzar target=_blank + rel en links externos
    if (tag === "a") {
      const hasTarget = safeAttrs.some((a) => a.startsWith("target="));
      if (!hasTarget) safeAttrs.push('target="_blank"');
      const hasRel = safeAttrs.some((a) => a.startsWith("rel="));
      if (!hasRel) safeAttrs.push('rel="noopener noreferrer"');
    }

    const attrsOutput = safeAttrs.length > 0 ? " " + safeAttrs.join(" ") : "";
    return isVoid ? `<${tag}${attrsOutput} />` : `<${tag}${attrsOutput}>`;
  });

  return html.trim();
}
