// ─── Talk to Your Data — Model-First Data Binding ────────────────────────
//
// CONTEXT STRATEGY:
//   The widget gets its OWN model connection via Builder Panel data binding.
//   No SAC scripts. No linked analysis wiring required.
//   Customer setup: drop widget → assign model → pick dimensions/measures.
//
// HOW IT WORKS:
//   1. Customer assigns a model to the widget in the SAC Builder Panel.
//   2. Customer drags dimensions + measures into the widget's feeds.
//   3. SAC automatically queries the model, filtered by story/page filters.
//   4. When filters change (input controls, page filters), SAC re-queries
//      and pushes updated rows → onCustomWidgetAfterUpdate fires.
//   5. Widget reads binding, extracts current filtered data, displays context.
//
// WHAT'S AVAILABLE:
//   ✅ All rows matching current story/page/input-control filters
//   ✅ Dimension members in the filtered result
//   ✅ Measure values in the filtered result
//   ✅ Feed metadata (dimension/measure labels from model)
//   ✅ Auto-reacts to filter changes (no user click required)
//   ⚠️ Model ID (may appear in metadata depending on SAC version)
//   ❌ Which chart the user is looking at (widget has its own data)
//   ❌ Time scope as a structured object (appears as dimension if assigned)
//
// OPTIONAL ENHANCEMENT:
//   If linked analysis is ALSO configured (source chart → this widget),
//   the binding will reflect the clicked selection instead of full data.
//   This works as a bonus — not a requirement.
// ──────────────────────────────────────────────────────────────────────────

import { askBackend, checkHealth, toApiContext, type ApiConfig, type AskResponse } from './api-client'


// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1: TYPES
// ═══════════════════════════════════════════════════════════════════════════

type ContextFilter = {
  dimension: string
  dimensionLabel: string
  members: string[]
  memberLabels: string[]
}

type ReportContext = {
  measures: string[]
  measureLabels: string[]
  dimensions: string[]
  dimensionLabels: string[]
  filters: ContextFilter[]
  rowCount: number
  confidence: 'high' | 'medium' | 'low'
  missing: string[]
  capturedAt: string
}

type WidgetProps = {
  title: string
  showDiagnostics: boolean
  assistantMode: 'diagnostic' | 'guided' | 'chat'
}

type ChatMessage = {
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
}

// ── Data binding types ─────────────────────────────────────────────────────
type BindingColumn = {
  id: string
  label?: string
  type?: string
}

type WidgetDataBinding = {
  data?: Array<Record<string, unknown>>
  metadata?: {
    feeds?: {
      dimensions?: BindingColumn[]
      measures?: BindingColumn[]
    }
    mainStructureItem?: BindingColumn
  }
  state?: string
  error?: unknown
}

type DataBindingHost = HTMLElement & {
  getDataBinding?: (name: string) => WidgetDataBinding | undefined
}

type AssistantState = {
  props: WidgetProps
  context: ReportContext | null
  bindingConfigured: boolean
  messages: ChatMessage[]
  apiConfig: ApiConfig
  conversationId: string | undefined
  loading: boolean
}


// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2: DEFAULTS
// ═══════════════════════════════════════════════════════════════════════════

const TAG = 'com-myorg-talk-to-data'
const BINDING_NAME = 'mainBinding'

const DEFAULT_PROPS: WidgetProps = {
  title: 'Talk to Your Data',
  showDiagnostics: true,
  assistantMode: 'diagnostic',
}

const DEFAULT_API_CONFIG: ApiConfig = {
  baseUrl: 'http://localhost:8000',
  timeoutMs: 30000,
}

const DEFAULT_STATE: AssistantState = {
  props: DEFAULT_PROPS,
  context: null,
  bindingConfigured: false,
  messages: [],
  apiConfig: DEFAULT_API_CONFIG,
  conversationId: undefined,
  loading: false,
}


// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3: HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function mergeProps(current: WidgetProps, changed: Record<string, unknown>): WidgetProps {
  return {
    title: typeof changed['title'] === 'string' ? changed['title'] : current.title,
    showDiagnostics: typeof changed['showDiagnostics'] === 'boolean' ? changed['showDiagnostics'] : current.showDiagnostics,
    assistantMode: (changed['assistantMode'] === 'guided' || changed['assistantMode'] === 'chat')
      ? changed['assistantMode'] as 'guided' | 'chat'
      : current.assistantMode,
  }
}

function esc(s: string | null | undefined): string {
  if (s == null) return ''
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Extract context from the widget's own data binding.
// This works for both:
//   - Direct model binding (widget has its own model, reflects story filters)
//   - Linked analysis (if configured, binding reflects clicked selection)
function extractContextFromBinding(binding: WidgetDataBinding): ReportContext {
  const now = new Date().toISOString()
  const rows = binding.data ?? []
  const meta = binding.metadata

  const dimCols: BindingColumn[] = meta?.feeds?.dimensions ?? []
  const measureCols: BindingColumn[] = meta?.feeds?.measures
    ?? (meta?.mainStructureItem ? [meta.mainStructureItem] : [])

  // Build dimension context — unique members per dimension in the result
  const filters: ContextFilter[] = []

  if (dimCols.length > 0) {
    dimCols.forEach((col, i) => {
      const alias = `dimensions_${i}`
      const members = [...new Set(rows.map(r => String(r[alias] ?? '')).filter(Boolean))]
      if (members.length > 0) {
        filters.push({
          dimension: col.id,
          dimensionLabel: col.label ?? col.id,
          members,
          memberLabels: members,
        })
      }
    })
  } else if (rows.length > 0) {
    const dimKeys = Object.keys(rows[0]).filter(k => /^dimensions_\d+$/.test(k)).sort()
    dimKeys.forEach(alias => {
      const members = [...new Set(rows.map(r => String(r[alias] ?? '')).filter(Boolean))]
      if (members.length > 0) {
        filters.push({
          dimension: alias,
          dimensionLabel: alias,
          members,
          memberLabels: members,
        })
      }
    })
  }

  // Resolve measures
  let measures: string[] = measureCols.map(c => c.id)
  let measureLabels: string[] = measureCols.map(c => c.label ?? c.id)

  if (measures.length === 0 && rows.length > 0) {
    const mKeys = Object.keys(rows[0]).filter(k => /^measures_\d+$/.test(k)).sort()
    measures = mKeys
    measureLabels = mKeys
  }

  // Determine confidence based on richness of metadata
  let confidence: 'high' | 'medium' | 'low' = 'low'
  if (dimCols.length > 0 && measureCols.length > 0 && rows.length > 0) {
    confidence = 'high'
  } else if (rows.length > 0) {
    confidence = 'medium'
  }

  const missing: string[] = []
  if (dimCols.length === 0 && filters.length === 0) missing.push('dimensions')
  if (measureCols.length === 0 && measures.length === 0) missing.push('measures')

  return {
    measures,
    measureLabels,
    dimensions: dimCols.map(c => c.id),
    dimensionLabels: dimCols.map(c => c.label ?? c.id),
    filters,
    rowCount: rows.length,
    confidence,
    missing,
    capturedAt: now,
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// SECTION 4: STYLES
// ═══════════════════════════════════════════════════════════════════════════

const STYLES = `
  :host {
    display: flex;
    flex-direction: column;
    height: 100%;
    box-sizing: border-box;
    font-family: '72', '72full', Arial, Helvetica, sans-serif;
    font-size: 13px;
    color: #32363a;
    background: #fff;
    overflow: hidden;
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    background: #0a6ed1;
    color: #fff;
    flex-shrink: 0;
  }
  .header-title { font-size: 14px; font-weight: 600; }
  .header-badge {
    font-size: 10px;
    background: rgba(255,255,255,0.25);
    padding: 2px 6px;
    border-radius: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .chat-area {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    flex: 1;
    gap: 8px;
    color: #6a7d8b;
    text-align: center;
    padding: 20px;
  }
  .empty-state .icon { font-size: 2rem; }
  .empty-state p { margin: 0; font-size: 12px; line-height: 1.5; }
  .setup-steps {
    text-align: left;
    font-size: 11px;
    line-height: 1.8;
    color: #6a7d8b;
    margin-top: 8px;
  }
  .setup-steps li { margin: 2px 0; }

  .msg {
    display: flex;
    flex-direction: column;
    max-width: 82%;
  }
  .msg-user    { align-self: flex-end;   align-items: flex-end; }
  .msg-assistant { align-self: flex-start; align-items: flex-start; }
  .msg-system  { align-self: center; align-items: center; max-width: 100%; }

  .bubble {
    padding: 8px 12px;
    border-radius: 14px;
    font-size: 13px;
    line-height: 1.5;
    word-break: break-word;
  }
  .bubble-user {
    background: #0a6ed1;
    color: #fff;
    border-bottom-right-radius: 3px;
  }
  .bubble-assistant {
    background: #f5f6f7;
    color: #32363a;
    border: 1px solid #e5e5e5;
    border-bottom-left-radius: 3px;
  }
  .bubble-system {
    background: #fef9ec;
    color: #6a5d00;
    font-size: 11px;
    border: 1px solid #fde8b0;
    border-radius: 8px;
    padding: 4px 12px;
    text-align: center;
  }
  .msg-time {
    font-size: 10px;
    color: #aaa;
    margin-top: 3px;
    padding: 0 4px;
  }

  .ctx-line { margin: 2px 0; font-size: 12px; }
  .ctx-label { color: #6a7d8b; }
  .ctx-value { color: #32363a; }
  .ctx-filter-tag {
    display: inline-block;
    background: #e8f1fb;
    color: #0a6ed1;
    border-radius: 10px;
    padding: 1px 7px;
    font-size: 11px;
    margin: 1px 2px;
  }
  .ctx-confidence {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 8px;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
  }
  .ctx-confidence-high   { background: #e6f4ea; color: #1e7e34; }
  .ctx-confidence-medium { background: #fef9ec; color: #7a6400; }
  .ctx-confidence-low    { background: #fde8e8; color: #a00; }

  .input-area {
    display: flex;
    gap: 6px;
    padding: 8px 10px;
    border-top: 1px solid #e5e5e5;
    align-items: flex-end;
    flex-shrink: 0;
    background: #fff;
  }
  .input-wrap {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .input-actions { display: flex; gap: 4px; }
  textarea.chat-input {
    width: 100%;
    box-sizing: border-box;
    resize: none;
    border: 1px solid #c9d0d8;
    border-radius: 6px;
    padding: 7px 9px;
    font-family: inherit;
    font-size: 13px;
    line-height: 1.4;
    min-height: 36px;
    max-height: 100px;
    overflow-y: auto;
    outline: none;
  }
  textarea.chat-input:focus { border-color: #0a6ed1; }

  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    font-size: 12px;
    font-family: inherit;
    border-radius: 6px;
    cursor: pointer;
    border: none;
    font-weight: 600;
    white-space: nowrap;
  }
  .btn-send {
    padding: 0 14px;
    height: 36px;
    background: #0a6ed1;
    color: #fff;
    flex-shrink: 0;
    align-self: flex-end;
  }
  .btn-send:hover { background: #085cb1; }
  .btn-context {
    padding: 3px 8px;
    height: 24px;
    background: transparent;
    color: #0a6ed1;
    border: 1px solid #c9d0d8;
    font-size: 11px;
    border-radius: 12px;
  }
  .btn-context:hover { border-color: #0a6ed1; background: #e8f1fb; }
  .btn-clear {
    padding: 3px 8px;
    height: 24px;
    background: transparent;
    color: #6a7d8b;
    border: 1px solid #c9d0d8;
    font-size: 11px;
    border-radius: 12px;
  }
  .btn-clear:hover { border-color: #9aa; background: #f5f6f7; }
`


// ═══════════════════════════════════════════════════════════════════════════
// SECTION 5: RENDER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

function formatTime(iso?: string): string {
  const d = iso ? new Date(iso) : new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function confidenceBadge(level: string): string {
  return `<span class="ctx-confidence ctx-confidence-${esc(level)}">${esc(level)}</span>`
}

function contextToAssistantContent(ctx: ReportContext): string {
  const lines: string[] = []

  lines.push(`<div class="ctx-line"><span class="ctx-label">Confidence: </span>${confidenceBadge(ctx.confidence)}</div>`)
  lines.push(`<div class="ctx-line"><span class="ctx-label">Rows: </span><span class="ctx-value">${ctx.rowCount}</span></div>`)

  const measures = ctx.measureLabels?.length ? ctx.measureLabels : ctx.measures
  if (measures?.length) {
    lines.push(`<div class="ctx-line"><span class="ctx-label">Measures: </span><span class="ctx-value">${measures.map(esc).join(', ')}</span></div>`)
  }

  if (ctx.filters?.length) {
    lines.push(`<div class="ctx-line"><span class="ctx-label">Dimensions in scope:</span></div>`)
    for (const f of ctx.filters) {
      const dim = f.dimensionLabel || f.dimension
      const count = f.members.length
      // Show up to 5 members, summarize the rest
      const shown = f.members.slice(0, 5)
      const memberTags = shown.map(m => `<span class="ctx-filter-tag">${esc(m)}</span>`).join('')
      const overflow = count > 5 ? `<span class="ctx-filter-tag">+${count - 5} more</span>` : ''
      lines.push(`<div class="ctx-line" style="padding-left:8px">${esc(dim)} (${count}): ${memberTags}${overflow}</div>`)
    }
  }

  if (ctx.missing?.length) {
    lines.push(`<div class="ctx-line" style="margin-top:4px"><span class="ctx-label">Not configured: </span><em style="color:#aaa">${ctx.missing.map(esc).join(', ')}</em></div>`)
  }

  return lines.join('')
}

function renderMessages(messages: ChatMessage[], state: AssistantState): string {
  if (messages.length === 0) {
    if (!state.bindingConfigured) {
      return `
        <div class="empty-state">
          <div class="icon">⚙️</div>
          <strong>Setup Required</strong>
          <p>Assign a data model to this widget in the Builder Panel.</p>
          <ol class="setup-steps">
            <li>Select this widget on the canvas</li>
            <li>Open <strong>Builder Panel</strong> → <strong>Data Binding</strong></li>
            <li>Assign a <strong>model</strong></li>
            <li>Drag <strong>dimensions</strong> into the dimensions feed</li>
            <li>Drag <strong>measures</strong> into the measures feed</li>
            <li>Done — widget auto-reacts to story filters</li>
          </ol>
          <p style="font-size:11px;color:#aaa;margin-top:8px">
            No scripting or linked analysis configuration needed.
          </p>
        </div>
      `
    }
    return `
      <div class="empty-state">
        <div class="icon">💬</div>
        <strong>Talk to Your Data</strong>
        <p>Model is connected. Waiting for data from current filters.</p>
        <p style="font-size:11px;color:#aaa">
          Change a story filter or input control to see context update.
        </p>
      </div>
    `
  }
  return messages.map(msg => {
    if (msg.role === 'system') {
      return `
        <div class="msg msg-system">
          <div class="bubble bubble-system">${msg.content}</div>
        </div>
      `
    }
    if (msg.role === 'user') {
      return `
        <div class="msg msg-user">
          <div class="bubble bubble-user">${esc(msg.content)}</div>
          <span class="msg-time">${formatTime(msg.timestamp)}</span>
        </div>
      `
    }
    return `
      <div class="msg msg-assistant">
        <div class="bubble bubble-assistant">${msg.content}</div>
        <span class="msg-time">${formatTime(msg.timestamp)}</span>
      </div>
    `
  }).join('')
}


// ═══════════════════════════════════════════════════════════════════════════
// SECTION 6: WEB COMPONENT CLASS
// ═══════════════════════════════════════════════════════════════════════════

class TalkToDataWidget extends HTMLElement {
  private readonly root: ShadowRoot
  private state: AssistantState = { ...DEFAULT_STATE, props: { ...DEFAULT_PROPS } }

  constructor() {
    super()
    this.root = this.attachShadow({ mode: 'open' })
    this.render()
  }

  // ── SAC lifecycle ──────────────────────────────────────────────────────

  onCustomWidgetBeforeUpdate(changedProperties: Record<string, unknown>): void {
    try {
      if (!changedProperties) return
      this.state = {
        ...this.state,
        props: mergeProps(this.state.props, changedProperties),
      }
    } catch (e) {
      console.error('[TalkToData] onCustomWidgetBeforeUpdate error:', e)
    }
  }

  // Called by SAC whenever:
  //   - Properties change
  //   - Data binding data changes (model query result updated)
  //   - Story/page filters change (triggers model re-query → new binding data)
  //   - Linked analysis selection changes (if configured — bonus, not required)
  onCustomWidgetAfterUpdate(_changedProperties: Record<string, unknown>): void {
    try {
      this.tryReadBinding()
      this.render()
    } catch (e) {
      console.error('[TalkToData] onCustomWidgetAfterUpdate error:', e)
    }
  }

  onCustomWidgetResize(_width: number, _height: number): void {
    // CSS flexbox handles layout
  }

  onCustomWidgetDestroy(): void {
    // nothing to clean up
  }

  // ── Data binding reader ────────────────────────────────────────────────

  private tryReadBinding(): void {
    const host = this as unknown as DataBindingHost
    const binding = host.getDataBinding?.(BINDING_NAME)

    // Detect whether binding is configured at all
    if (!binding) {
      this.state = { ...this.state, bindingConfigured: false }
      return
    }

    // Binding exists but may be loading or empty
    this.state = { ...this.state, bindingConfigured: true }

    if (binding.state === 'loading') return
    if (binding.error) {
      const now = new Date().toISOString()
      const errMsg = String(binding.error)
      if (!this.state.messages.some(m => m.content.includes('Binding error'))) {
        this.state = {
          ...this.state,
          messages: [...this.state.messages, {
            role: 'system',
            content: `❌ Binding error: ${esc(errMsg)}`,
            timestamp: now,
          }],
        }
      }
      return
    }

    if (!binding.data?.length) return

    const ctx = extractContextFromBinding(binding)

    // Only update messages if context actually changed
    const prevContext = this.state.context
    if (prevContext && prevContext.capturedAt === ctx.capturedAt) return
    if (prevContext
      && prevContext.rowCount === ctx.rowCount
      && prevContext.filters.length === ctx.filters.length
      && prevContext.measures.length === ctx.measures.length
      && JSON.stringify(prevContext.filters) === JSON.stringify(ctx.filters)) {
      // Same data — skip duplicate messages
      this.state = { ...this.state, context: ctx }
      return
    }

    const now = new Date().toISOString()
    const newMessages: ChatMessage[] = [...this.state.messages]

    if (this.state.props.showDiagnostics) {
      const keys = Object.keys(binding.data[0] ?? {}).join(', ')
      newMessages.push({
        role: 'system',
        content: `🔍 Binding: ${esc(keys)} — ${binding.data.length} row(s)`,
        timestamp: now,
      })
    }

    newMessages.push({
      role: 'system',
      content: `📊 Data updated — ${ctx.rowCount} rows, ${ctx.filters.length} dimension(s), ${ctx.measures.length} measure(s)`,
      timestamp: now,
    })
    newMessages.push({
      role: 'assistant',
      content: contextToAssistantContent(ctx),
      timestamp: now,
    })

    this.state = { ...this.state, context: ctx, messages: newMessages }
  }

  // ── Rendering ─────────────────────────────────────────────────────────

  private render(): void {
    const { props } = this.state
    const messages = this.state.messages ?? []

    this.root.innerHTML = `
      <style>${STYLES}</style>

      <div class="header">
        <span class="header-title">${esc(props.title)}</span>
        <span class="header-badge">${esc(props.assistantMode)}</span>
      </div>

      <div class="chat-area" id="chat-area">
        ${renderMessages(messages, this.state)}
      </div>

      <div class="input-area">
        <div class="input-wrap">
          <div class="input-actions">
            <button class="btn btn-context" id="btn-refresh">↺ Refresh</button>
            ${messages.length > 0 ? '<button class="btn btn-clear" id="btn-clear">Clear</button>' : ''}
          </div>
          <textarea class="chat-input" id="chat-input" rows="1" placeholder="Ask a question about your data…"></textarea>
        </div>
        <button class="btn btn-send" id="btn-send">Send</button>
      </div>
    `

    const chatArea = this.root.getElementById('chat-area')
    if (chatArea) chatArea.scrollTop = chatArea.scrollHeight

    this.root.getElementById('btn-refresh')?.addEventListener('click', () => {
      this.tryReadBinding()
      this.render()
    })

    this.root.getElementById('btn-clear')?.addEventListener('click', () => {
      this.state = { ...this.state, context: null, messages: [] }
      this.render()
    })

    const input = this.root.getElementById('chat-input') as HTMLTextAreaElement | null
    const sendBtn = this.root.getElementById('btn-send') as HTMLButtonElement | null

    const sendMessage = () => {
      const text = input?.value.trim()
      if (!text || this.state.loading) return
      this.addMessage({ role: 'user', content: text, timestamp: new Date().toISOString() })
      if (input) input.value = ''
      this.askApi(text)
    }

    sendBtn?.addEventListener('click', sendMessage)
    input?.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        sendMessage()
      }
    })
  }

  private addMessage(msg: ChatMessage): void {
    this.state = { ...this.state, messages: [...(this.state.messages ?? []), msg] }
    this.render()
  }

  private async askApi(question: string): Promise<void> {
    this.state = { ...this.state, loading: true }
    this.render()

    const apiContext = toApiContext(this.state.context)
    const response: AskResponse = await askBackend(
      this.state.apiConfig,
      question,
      apiContext,
      this.state.conversationId,
    )

    if (response.conversationId) {
      this.state = { ...this.state, conversationId: response.conversationId }
    }

    const now = new Date().toISOString()

    if (response.error) {
      this.addMessage({ role: 'system', content: `⚠️ ${response.error}`, timestamp: now })
    } else {
      this.addMessage({ role: 'assistant', content: response.answer, timestamp: now })
    }

    this.state = { ...this.state, loading: false }
    this.render()
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// SECTION 7: REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════

if (!customElements.get(TAG)) {
  customElements.define(TAG, TalkToDataWidget)
}
