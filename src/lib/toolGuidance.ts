import type { MCPToolDescriptor } from './mcpTypes';

interface JSONSchemaLike {
  description?: string;
  title?: string;
  properties?: Record<string, JSONSchemaLike>;
  required?: string[];
  items?: JSONSchemaLike | JSONSchemaLike[];
  anyOf?: JSONSchemaLike[];
  oneOf?: JSONSchemaLike[];
  allOf?: JSONSchemaLike[];
  [key: string]: unknown;
}

interface ExtractedHint {
  name: string;
  description: string;
  required: boolean;
}

export function buildToolGuidance(
  tool: MCPToolDescriptor | undefined,
  providedArgs: Record<string, unknown> | undefined,
): string | null {
  if (!tool || typeof tool !== 'object') {
    return null;
  }

  const schema = sanitizeSchema(tool.inputSchema);
  if (!schema) {
    return null;
  }

  const hints = extractHints(schema);
  if (hints.length === 0) {
    return null;
  }

  const prioritized = prioritizeHints(hints, providedArgs);
  if (prioritized.length === 0) {
    return null;
  }

  const intro = selectIntro(prioritized, providedArgs);
  const suggestions = prioritized
    .slice(0, 2)
    .map((hint) => formatHint(hint, providedArgs));
  if (suggestions.length === 0) {
    return null;
  }
  const suggestionText = suggestions.join(' ');
  return intro ? `${intro} ${suggestionText}` : suggestionText;
}

function sanitizeSchema(schema: unknown): JSONSchemaLike | null {
  if (!schema || typeof schema !== 'object') {
    return null;
  }
  return schema as JSONSchemaLike;
}

function extractHints(schema: JSONSchemaLike, parentRequired: string[] = []): ExtractedHint[] {
  const properties = schema.properties;
  if (!properties || typeof properties !== 'object') {
    return [];
  }

  const requiredList = Array.isArray(schema.required) ? schema.required : parentRequired;
  const hints: ExtractedHint[] = [];

  for (const [name, propSchema] of Object.entries(properties)) {
    if (!propSchema || typeof propSchema !== 'object') {
      continue;
    }
    const description = resolveDescription(propSchema, name);
    const required = requiredList.includes(name);
    hints.push({ name, description, required });
  }

  return hints;
}

function resolveDescription(schema: JSONSchemaLike, fallbackName: string): string {
  if (typeof schema.description === 'string' && schema.description.trim()) {
    const normalized = normalizeDescription(schema.description, fallbackName);
    if (normalized) {
      return normalized;
    }
  }
  if (typeof schema.title === 'string' && schema.title.trim()) {
    const normalized = normalizeDescription(schema.title, fallbackName);
    if (normalized) {
      return normalized;
    }
  }

  const composite = schema.anyOf ?? schema.oneOf ?? schema.allOf;
  if (Array.isArray(composite)) {
    for (const option of composite) {
      const optionDescription = resolveDescription(option, fallbackName);
      if (optionDescription) {
        return optionDescription;
      }
    }
  }

  if (schema.items && typeof schema.items === 'object') {
    return resolveDescription(schema.items as JSONSchemaLike, fallbackName);
  }

  return defaultDescription(fallbackName);
}

function normalizeDescription(description: string, fallbackName: string): string | null {
  const simplified = simplifyDescription(description);
  if (!simplified) {
    return null;
  }
  if (looksTechnical(simplified)) {
    return null;
  }
  const friendlyName = toFriendlyName(fallbackName);
  if (simplified.toLowerCase() === friendlyName.toLowerCase()) {
    return null;
  }
  return simplified;
}

function prioritizeHints(hints: ExtractedHint[], providedArgs: Record<string, unknown> | undefined): ExtractedHint[] {
  if (!providedArgs || typeof providedArgs !== 'object') {
    return hints.sort(compareHints);
  }

  const missing = hints.filter((hint) => !(hint.name in providedArgs));
  if (missing.length > 0) {
    return missing
      .sort(compareHints)
      .concat(hints.filter((hint) => missing.every((item) => item.name !== hint.name)).sort(compareHints));
  }

  return hints.sort(compareHints);
}

function compareHints(a: ExtractedHint, b: ExtractedHint): number {
  if (a.required && !b.required) {
    return -1;
  }
  if (!a.required && b.required) {
    return 1;
  }
  return a.name.localeCompare(b.name);
}

function formatHint(hint: ExtractedHint, providedArgs: Record<string, unknown> | undefined): string {
  return "";
  // const friendlyName = toFriendlyName(hint.name);
  // const alreadyProvided = Boolean(providedArgs && hint.name in providedArgs);
  // const leadIn = hint.required && !alreadyProvided ? 'Be sure to tell me about' : alreadyProvided ? 'If you want, you can add more about' : 'You can also mention';
  // const detail = hint.description || defaultDescription(hint.name);
  // const conversationalDetail = makeConversational(detail, friendlyName);
  // return conversationalDetail
  //   ? `${leadIn} ${friendlyName} so I can ${conversationalDetail}.`
  //   : `${leadIn} ${friendlyName}.`;
}

function defaultDescription(fieldName: string): string {
  const friendly = toFriendlyName(fieldName);
  return `know what you want for ${friendly}`;
}

function simplifyDescription(description: string): string {
  const trimmed = description.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!trimmed) {
    return '';
  }
  const firstSentence = trimmed.split(/[.;]/)[0] ?? '';
  let normalized = firstSentence.trim();
  if (!normalized) {
    return '';
  }
  normalized = normalized.charAt(0).toLowerCase() + normalized.slice(1);
  if (/^safe length/i.test(normalized)) {
    normalized = normalized.replace(/^safe length/i, 'keep it between');
  }
  if (/^safe range/i.test(normalized)) {
    normalized = normalized.replace(/^safe range/i, 'pick a number between');
  }
  if (/^page size/i.test(normalized)) {
    normalized = 'choose how many results you want';
  }
  return normalized;
}

function looksTechnical(text: string): boolean {
  const technicalPatterns = /(matchType|regex|enum|\bapi\b|>=|<=|==|\bSQL\b|JSON|schema|fuzzy)/i;
  const containsHex = /[A-F0-9]{8,}/i;
  return technicalPatterns.test(text) || containsHex.test(text) || text.includes('http');
}

function makeConversational(detail: string, friendlyName: string): string {
  const lower = detail.toLowerCase();
  if (lower.startsWith('text filter') || lower.includes('filter')) {
    return `focus on the ${friendlyName} you care about`;
  }
  if (lower.includes('page size') || lower.includes('page-size')) {
    return 'control how many results you get at once';
  }
  if (lower.includes('number of rows to skip') || lower.includes('offset')) {
    return 'skip the results you already saw';
  }
  if (lower.startsWith('keep it between')) {
    return detail;
  }
  if (lower.includes('know what you want')) {
    return detail;
  }
  return detail;
}

function toFriendlyName(value: string): string {
  return value.replace(/[_-]+/g, ' ').trim();
}

const INTRO_VARIANTS: string[] = [
  // 'Sounds promising—let’s make the response even sharper.',
  // 'Great start! We can elevate the answer by adding a bit more detail.',
  // 'Nice momentum here. A touch more context will really help.',
  // 'Love where this is going. Let’s tighten things up just a little.',
  // 'Almost there—just a couple of details will make it shine.',
];

function selectIntro(
  hints: ExtractedHint[],
  providedArgs: Record<string, unknown> | undefined,
): string {
  if (!INTRO_VARIANTS.length) {
    return '';
  }
  const seedSource = JSON.stringify({
    hints: hints.map((item) => item.name),
    provided: providedArgs ?? null,
  });
  let hash = 0;
  for (let index = 0; index < seedSource.length; index += 1) {
    hash = (hash * 31 + seedSource.charCodeAt(index)) >>> 0;
  }
  return INTRO_VARIANTS[hash % INTRO_VARIANTS.length];
}
