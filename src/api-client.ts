// ─── Backend API Client ───────────────────────────────────────────────────
//
// This module handles communication between the widget (frontend)
// and the Python/FastAPI backend that connects to the LLM + data layer.
//
// USAGE (from main.ts):
//   import { askBackend, checkHealth, ApiConfig } from './api-client'
//
//   const config: ApiConfig = { baseUrl: 'https://your-backend.com' }
//   const response = await askBackend(config, question, context)
//
// The widget sends:
//   - The user's question (string)
//   - The current SAC context (measures, dimensions, filters from binding)
//
// The backend returns:
//   - An answer (LLM-generated explanation)
//   - Optional supporting data (for display in the widget)
//   - Confidence level and sources
// ──────────────────────────────────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

/** Configuration for the backend connection */
export type ApiConfig = {
  baseUrl: string           // e.g. 'https://your-backend.com' or 'http://localhost:8000'
  apiKey?: string           // optional auth token
  timeoutMs?: number        // request timeout (default: 30000)
}

/** What the widget sends to the backend */
export type AskRequest = {
  question: string
  conversationId?: string
  context?: {
    measures: string[]
    measureLabels: string[]
    dimensions: string[]
    dimensionLabels: string[]
    filters: {
      dimension: string
      dimensionLabel: string
      members: string[]
    }[]
    rowCount: number
    confidence: string
  }
}

/** What the backend returns */
export type AskResponse = {
  answer: string
  data?: {
    rows: Record<string, unknown>[]
    columns: { id: string; label: string }[]
  }
  sources?: string[]
  confidence: 'high' | 'medium' | 'low'
  conversationId: string
  error?: string
}

/** Health check response */
export type HealthResponse = {
  status: 'ok' | 'error'
  version?: string
  error?: string
}


// ═══════════════════════════════════════════════════════════════════════════
// API FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Send a user question + SAC context to the backend LLM service.
 *
 * Flow:
 *   Widget → POST /api/ask → Backend → queries data + calls LLM → returns answer
 */
export async function askBackend(
  config: ApiConfig,
  question: string,
  context?: AskRequest['context'],
  conversationId?: string,
): Promise<AskResponse> {
  const url = `${config.baseUrl}/api/ask`
  const timeout = config.timeoutMs ?? 30000

  const body: AskRequest = {
    question,
    conversationId,
    context,
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (config.apiKey) {
    headers['Authorization'] = `Bearer ${config.apiKey}`
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error')
      return {
        answer: '',
        confidence: 'low',
        conversationId: conversationId ?? '',
        error: `Backend error (${response.status}): ${errorText}`,
      }
    }

    return await response.json() as AskResponse
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      return {
        answer: '',
        confidence: 'low',
        conversationId: conversationId ?? '',
        error: `Request timed out after ${timeout}ms`,
      }
    }
    return {
      answer: '',
      confidence: 'low',
      conversationId: conversationId ?? '',
      error: `Network error: ${String(e)}`,
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Check if the backend is reachable.
 */
export async function checkHealth(config: ApiConfig): Promise<HealthResponse> {
  const url = `${config.baseUrl}/api/health`

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: config.apiKey ? { 'Authorization': `Bearer ${config.apiKey}` } : {},
    })

    if (!response.ok) {
      return { status: 'error', error: `HTTP ${response.status}` }
    }

    return await response.json() as HealthResponse
  } catch (e) {
    return { status: 'error', error: String(e) }
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// HELPER: Convert widget state context to API request context
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Transform the widget's internal ReportContext into the shape the API expects.
 * Call this before sending to askBackend().
 *
 * Usage:
 *   const apiContext = toApiContext(this.state.context)
 *   const response = await askBackend(config, question, apiContext)
 */
export function toApiContext(widgetContext: {
  measures: string[]
  measureLabels: string[]
  dimensions: string[]
  dimensionLabels: string[]
  filters: { dimension: string; dimensionLabel: string; members: string[]; memberLabels: string[] }[]
  rowCount: number
  confidence: string
} | null): AskRequest['context'] | undefined {
  if (!widgetContext) return undefined

  return {
    measures: widgetContext.measures,
    measureLabels: widgetContext.measureLabels,
    dimensions: widgetContext.dimensions,
    dimensionLabels: widgetContext.dimensionLabels,
    filters: widgetContext.filters.map(f => ({
      dimension: f.dimension,
      dimensionLabel: f.dimensionLabel,
      members: f.members,
    })),
    rowCount: widgetContext.rowCount,
    confidence: widgetContext.confidence,
  }
}
