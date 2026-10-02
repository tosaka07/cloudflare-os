import { useState, useEffect } from 'react'
import { Dialog, Button, Input, Select, Collapsible, useKumoToastManager } from '@cloudflare/kumo'
import { AiChatAuthorInfo, AiModelProvider, AiGatewayInfo, RedactedAiModelConfig, SUGGESTED_MODELS,
  GATEWAY_CUSTOM_PRESETS, GatewayCustomApi, GatewayCustomReasoningEffort,
  isValidGatewayCustomPathPrefix, isValidGatewayCustomSlug } from '@gadgets/workshop-shared/api'
import { RpcStub } from 'capnweb'
import { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { ExtraHeadersEditor } from './features/ai-models/ExtraHeadersEditor'
import { StoredSecretInput } from './features/ai-models/StoredSecretInput'
import {
  headerRowsFromRecord, headerRowsToRecord, validateHeaderRows, type HeaderRow,
} from './features/ai-models/extraHeaders'

/**
 * Whether the modal adds a model from scratch, edits a stored one, or adds a model based on a
 * stored one, with the stored model's withheld secrets carried over.
 */
export type ModelModalMode =
  | { type: 'add' }
  | { type: 'edit' | 'clone', source: { profile: AiChatAuthorInfo, config: RedactedAiModelConfig } }

interface AddModelModalProps {
  visible: boolean
  onCancel: () => void
  onSuccess: () => void
  authenticatedApi: RpcStub<AuthenticatedApi>
  aiConfig: AiGatewayInfo | null
  mode?: ModelModalMode
}

type SelectionType =
  | { type: 'suggested', provider: AiModelProvider, modelId: string, displayName: string }
  | { type: 'custom', provider: AiModelProvider }

const PROVIDER_LABELS: Record<AiModelProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  cloudflare: 'Cloudflare Workers AI',
  ollama: 'Ollama',
  'gateway-custom': 'Custom Provider',
}

// Placeholder hinting at the shape of each provider's API token.
const API_TOKEN_PLACEHOLDERS: Record<AiModelProvider, string> = {
  anthropic: 'sk-ant-...',
  openai: 'sk-...',
  google: 'AIza...',
  cloudflare: 'Cloudflare API token',
  ollama: '(optional)',
  // Never shown: a Custom Provider is offered only in gateway mode, which hides the token field.
  'gateway-custom': '(stored on the AI Gateway)',
}

// Providers whose client can send no API key at all, so a proxy that extra headers authenticate
// can supply its own (AI Gateway only injects a stored key into requests that carry none). Google's
// SDK always sends a key, and the Workers AI endpoint can't be redirected to a proxy.
const TOKEN_OPTIONAL_WITH_HEADERS: ReadonlySet<AiModelProvider> = new Set(['anthropic', 'openai'])

const isTokenRequired = (provider: AiModelProvider, headerRows: readonly HeaderRow[]) =>
  provider !== 'ollama' &&
  !(TOKEN_OPTIONAL_WITH_HEADERS.has(provider) && headerRowsToRecord(headerRows) !== undefined)

// Example used in the custom-model placeholders for providers that have no suggested models
// (Ollama serves whatever the user has pulled locally).
const FALLBACK_EXAMPLE_MODEL = { modelId: 'gemma4:31b', name: 'Gemma 4 31B' }

// Chosen in the endpoint picker to type an endpoint the presets don't cover.
const PRESET_MANUAL = '__manual__'

// The slug and the path both land in the gateway route, where the backend holds them to the
// same rule, so the wording matches what it would reject.
const SLUG_ERROR = 'Use only letters, digits and hyphens, starting with a letter or digit'
const PATH_ERROR = 'Start each segment with a letter or digit, e.g. /openai/v1'
const PRICE_ERROR = 'Enter dollars per million tokens, e.g. 1.25'

const WIRE_FORMATS: { value: GatewayCustomApi, label: string }[] = [
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'openai-completions', label: 'OpenAI Chat Completions' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
]

const REASONING_EFFORTS: GatewayCustomReasoningEffort[] =
  ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

// Pick an example model to show in the custom-model placeholders for the given provider.
function exampleModel(provider: AiModelProvider): { modelId: string, name: string } {
  const first = Object.entries(SUGGESTED_MODELS[provider])[0]
  return first ? { modelId: first[0], name: first[1].name } : FALLBACK_EXAMPLE_MODEL
}

// Parse an optional token-limit field: undefined when blank, null when invalid.
function parseTokenLimit(text: string): number | undefined | null {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  if (!/^\d+$/.test(trimmed)) return null
  const value = Number(trimmed)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

// A stored number as the text its field shows: absent reads as an untouched field.
function tokenText(value: number | undefined): string {
  return value === undefined ? '' : String(value)
}

// Same, for the dollars-per-million-tokens price fields.
const priceText = tokenText

// Encode a selection into a string value for the Select component.
function encodeSelection(provider: AiModelProvider, modelId?: string): string {
  return modelId ? `${provider}:${modelId}` : `other-${provider}`
}

// Decode a Select value back into a SelectionType.
function decodeSelection(value: string): SelectionType {
  if (value.startsWith('other-')) {
    return { type: 'custom', provider: value.substring(6) as AiModelProvider }
  }
  const colonIndex = value.indexOf(':')
  const provider = value.substring(0, colonIndex) as AiModelProvider
  const modelId = value.substring(colonIndex + 1)
  const displayName = SUGGESTED_MODELS[provider][modelId].name
  return { type: 'suggested', provider, modelId, displayName }
}

// Build the flat list of options for the Select dropdown.
function buildOptions(gatewayMode: boolean, enabledProviders: Set<string> | null) {
  const options: { value: string; label: string; provider: string }[] = []
  const providerOrder = Object.keys(SUGGESTED_MODELS) as AiModelProvider[]

  for (const provider of providerOrder) {
    if (enabledProviders && !enabledProviders.has(provider)) continue
    // A Custom Provider is registered on a gateway, which also holds the vendor's key, so it has
    // nothing to offer a deployment that isn't in gateway mode.
    if (!gatewayMode && provider === 'gateway-custom') continue

    // In gateway mode, suggested models are already built-in, so don't list them.
    if (!gatewayMode) {
      for (const [modelId, model] of Object.entries(SUGGESTED_MODELS[provider])) {
        if (model.hidden) continue
        options.push({
          value: encodeSelection(provider, modelId),
          label: model.name,
          provider,
        })
      }
    }

    options.push({
      value: encodeSelection(provider),
      label: `Other ${PROVIDER_LABELS[provider] || provider}...`,
      provider,
    })
  }

  return options
}

export default function AddModelModal({ visible, onCancel, onSuccess, authenticatedApi, aiConfig, mode = { type: 'add' } }: AddModelModalProps) {
  const toasts = useKumoToastManager()

  // Edit and clone modes take their initial state from the source model, so the caller remounts
  // the modal (with a `key`) to switch source.
  const source = mode.type === 'add' ? null : mode.source
  const editing = mode.type === 'edit'

  const [loading, setLoading] = useState(false)
  const [selection, setSelection] = useState<SelectionType | null>(
    source && { type: 'custom', provider: source.config.provider })
  const [selectValue, setSelectValue] = useState<string | undefined>(undefined)

  // The stored Custom Provider route, which seeds this modal's route fields when editing one.
  const route = source?.config.gatewayCustom

  // Form fields (used for custom models). A null secret keeps the source's withheld value.
  const [modelId, setModelId] = useState(editing ? source!.config.model : '')
  const [displayName, setDisplayName] = useState(editing ? source!.profile.name : '')
  const [apiToken, setApiToken] = useState<string | null>(source ? source.config.apiToken : '')
  const [accountId, setAccountId] = useState(source?.config.accountId ?? '')
  const [apiUrl, setApiUrl] = useState(source?.config.apiUrl ?? '')
  const [headerRows, setHeaderRows] = useState<HeaderRow[]>(() => headerRowsFromRecord(source?.config.extraHeaders))
  // Custom Provider route. `preset` only seeds the two fields below it; what gets saved is
  // always the path and format, so a preset can change without stranding saved models.
  const [preset, setPreset] = useState<string>(PRESET_MANUAL)
  const [slug, setSlug] = useState(route?.slug ?? '')
  const [pathPrefix, setPathPrefix] = useState(route?.pathPrefix ?? '')
  const [wireFormat, setWireFormat] = useState<GatewayCustomApi>(route?.api ?? 'openai-responses')
  // Token limits are specific to a model, so a clone doesn't inherit them. A Custom Provider
  // carries its own on the route, which is where the backend reads them.
  const [contextWindow, setContextWindow] = useState(
      editing ? tokenText(source!.config.contextWindow ?? route?.contextWindow) : '')
  const [outputLimit, setOutputLimit] = useState(
      editing ? tokenText(source!.config.outputLimit ?? route?.outputLimit) : '')
  const [maxTokensField, setMaxTokensField] = useState<string>(route?.maxTokensField ?? '')
  const [reasoningEffort, setReasoningEffort] = useState<string>(route?.reasoningEffort ?? '')
  // Prices in dollars per million tokens. Optional as a pair: entering neither leaves the cost
  // indicator at zero, which is the honest reading of a model nobody has priced.
  const [inputPrice, setInputPrice] = useState(priceText(route?.cost?.input))
  const [outputPrice, setOutputPrice] = useState(priceText(route?.cost?.output))
  const [cachedInputPrice, setCachedInputPrice] = useState(priceText(route?.cost?.cacheRead))

  // Validation errors
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [headerErrors, setHeaderErrors] = useState<Record<number, string>>({})

  // Advanced settings collapsible state
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const gatewayMode = aiConfig?.enabled === true
  const enabledProviders: Set<string> | null = gatewayMode
    ? new Set(aiConfig.enabledProviders)
    : null

  // The server keeps withheld secrets only for the endpoint they were configured for. Once the URL
  // changes, withheld values are shown (and sent) as blank, and header values must be re-entered.
  const storedSecretsUsable = source !== null && apiUrl.trim() === (source.config.apiUrl ?? '')
  const effectiveApiToken = apiToken === null && !storedSecretsUsable ? '' : apiToken

  // Reset all state when dialog closes
  useEffect(() => {
    if (!visible) {
      setSelection(null)
      setSelectValue(undefined)
      setModelId('')
      setDisplayName('')
      setApiToken('')
      setAccountId('')
      setApiUrl('')
      setPreset(PRESET_MANUAL)
      setSlug('')
      setPathPrefix('')
      setWireFormat('openai-responses')
      setMaxTokensField('')
      setReasoningEffort('')
      setInputPrice('')
      setOutputPrice('')
      setCachedInputPrice('')
      setHeaderRows([])
      setContextWindow('')
      setOutputLimit('')
      setErrors({})
      setHeaderErrors({})
      setAdvancedOpen(false)
    }
  }, [visible])

  const handleModelSelect = (value: string) => {
    setSelectValue(value)
    setErrors({})
    setHeaderErrors({})
    const sel = decodeSelection(value)
    setSelection(sel)

    if (sel.type === 'custom') {
      setModelId('')
      setDisplayName('')
    } else {
      setModelId(sel.modelId)
      setDisplayName(sel.displayName)
    }
    setApiToken('')
    setAccountId('')
    setApiUrl(sel.provider === 'ollama' ? 'http://localhost:11434' : '')
    setPreset(PRESET_MANUAL)
    setSlug('')
    setPathPrefix('')
    setWireFormat('openai-responses')
    setMaxTokensField('')
    setReasoningEffort('')
    setInputPrice('')
    setOutputPrice('')
    setCachedInputPrice('')
    setHeaderRows([])
    setContextWindow('')
    setOutputLimit('')
  }

  // Seed the path and format from a known vendor endpoint. Both stay editable afterwards.
  const handlePresetSelect = (value: string) => {
    setPreset(value)
    setErrors(prev => ({ ...prev, pathPrefix: '', modelId: '' }))
    const entry = GATEWAY_CUSTOM_PRESETS[value]
    if (!entry) return
    setPathPrefix(entry.pathPrefix)
    setWireFormat(entry.api)
    setMaxTokensField(entry.maxTokensField ?? '')
  }

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {}

    if (!selection) {
      newErrors.selection = gatewayMode ? 'Please select a provider' : 'Please select a model'
    }

    if (selection?.type === 'custom') {
      if (!modelId.trim()) newErrors.modelId = 'Please enter the model ID'
      if (!displayName.trim()) newErrors.displayName = 'Please enter a display name'
    }

    const isOllama = selection?.provider === 'ollama'
    const isCloudflare = selection?.provider === 'cloudflare'
    const showCredentials = !gatewayMode

    // Asked for in every mode, unlike the credential fields: these address the endpoint rather
    // than authenticate to it, and the key stays with the gateway either way.
    if (selection?.provider === 'gateway-custom') {
      if (!slug.trim()) newErrors.slug = 'Please enter the Custom Provider slug'
      else if (!isValidGatewayCustomSlug(slug.trim())) newErrors.slug = SLUG_ERROR

      if (!isValidGatewayCustomPathPrefix(pathPrefix.trim())) newErrors.pathPrefix = PATH_ERROR

      const window = Number(contextWindow.trim())
      if (!contextWindow.trim() || !Number.isInteger(window) || window <= 0) {
        newErrors.contextWindow = 'Please enter the context window in tokens'
      }
      if (outputLimit.trim()) {
        const limit = Number(outputLimit.trim())
        if (!Number.isInteger(limit) || limit <= 0 || limit >= window) {
          newErrors.outputLimit = 'Must be a positive number below the context window'
        }
      }

      // Priced or unpriced, never half-priced: one rate alone would bill a turn's prompt without
      // its response, or the reverse, and read as a real total.
      const price = (raw: string) => raw.trim() ? Number(raw.trim()) : undefined
      const badPrice = (raw: string) => {
        const value = price(raw)
        return value !== undefined && (!Number.isFinite(value) || value < 0)
      }
      if (badPrice(inputPrice)) newErrors.inputPrice = PRICE_ERROR
      if (badPrice(outputPrice)) newErrors.outputPrice = PRICE_ERROR
      if (badPrice(cachedInputPrice)) newErrors.cachedInputPrice = PRICE_ERROR
      if (Boolean(inputPrice.trim()) !== Boolean(outputPrice.trim())) {
        const missing = inputPrice.trim() ? 'outputPrice' : 'inputPrice'
        newErrors[missing] = 'Enter both prices, or neither'
      }
      if (cachedInputPrice.trim() && !inputPrice.trim()) {
        newErrors.inputPrice = 'Needed to price the rest of the prompt'
      }
    }

    if (showCredentials && selection && isTokenRequired(selection.provider, headerRows) && effectiveApiToken?.trim() === '') {
      newErrors.apiToken = apiToken === null
        ? 'Please re-enter your API token, since the API URL changed'
        : 'Please enter your API token'
    }

    if (showCredentials && isCloudflare && !accountId.trim()) {
      newErrors.accountId = 'Please enter your Cloudflare account ID'
    }

    if (showCredentials && isOllama && !apiUrl.trim()) {
      newErrors.apiUrl = 'Please enter the Ollama API URL'
    }

    if (parseTokenLimit(contextWindow) === null) {
      newErrors.contextWindow = 'Please enter a positive whole number of tokens'
    }
    if (parseTokenLimit(outputLimit) === null) {
      newErrors.outputLimit = 'Please enter a positive whole number of tokens'
    }

    const newHeaderErrors = showCredentials ? validateHeaderRows(headerRows) : {}
    if (showCredentials && !storedSecretsUsable) {
      for (const row of headerRows) {
        if (row.value === null && !newHeaderErrors[row.id]) {
          newHeaderErrors[row.id] = "Please re-enter this header's value, since the API URL changed"
        }
      }
    }
    // These fields live in the collapsible, so reveal their errors if it was closed.
    if (Object.keys(newHeaderErrors).length > 0 || newErrors.contextWindow || newErrors.outputLimit) {
      setAdvancedOpen(true)
    }

    setErrors(newErrors)
    setHeaderErrors(newHeaderErrors)
    return Object.keys(newErrors).length === 0 && Object.keys(newHeaderErrors).length === 0
  }

  const handleSubmit = async () => {
    if (!validate()) return

    setLoading(true)
    try {
      const isSuggested = selection!.type === 'suggested'
      const finalModelId = isSuggested ? selection!.modelId : modelId.trim()
      const finalDisplayName = isSuggested ? selection!.displayName : displayName.trim()

      const profile: AiChatAuthorInfo = {
        type: 'agent',
        // A model's ID is its identity to chats and settings, so editing never changes it.
        id: editing ? source!.profile.id : finalModelId,
        name: finalDisplayName,
      }

      const extraHeaders = gatewayMode ? undefined : headerRowsToRecord(headerRows)
      const isGatewayCustom = selection!.provider === 'gateway-custom'
      const contextWindowTokens = parseTokenLimit(contextWindow)
      const outputLimitTokens = parseTokenLimit(outputLimit)
      const config: RedactedAiModelConfig = {
        provider: selection!.provider,
        model: finalModelId,
        apiToken: gatewayMode ? '' : effectiveApiToken?.trim() ?? null,
        ...(!gatewayMode && accountId.trim() && { accountId: accountId.trim() }),
        ...(!gatewayMode && apiUrl.trim() && { apiUrl: apiUrl.trim() }),
        ...(selection!.provider === 'gateway-custom' && {
          gatewayCustom: {
            slug: slug.trim(),
            pathPrefix: pathPrefix.trim(),
            api: wireFormat,
            contextWindow: Number(contextWindow.trim()),
            ...(outputLimit.trim() && { outputLimit: Number(outputLimit.trim()) }),
            ...(maxTokensField && {
              maxTokensField: maxTokensField as 'max_tokens' | 'max_completion_tokens',
            }),
            ...(reasoningEffort && {
              reasoningEffort: reasoningEffort as GatewayCustomReasoningEffort,
            }),
            // Validated as a pair above, so an input price implies an output one.
            ...(inputPrice.trim() && {
              cost: {
                input: Number(inputPrice.trim()),
                output: Number(outputPrice.trim()),
                ...(cachedInputPrice.trim() && { cacheRead: Number(cachedInputPrice.trim()) }),
              },
            }),
          },
        }),
        ...(extraHeaders && { extraHeaders }),
        // A Custom Provider carries its limits on its route instead, so they aren't repeated here.
        ...(!isGatewayCustom && contextWindowTokens && { contextWindow: contextWindowTokens }),
        ...(!isGatewayCustom && outputLimitTokens && { outputLimit: outputLimitTokens }),
      }

      if (editing) {
        await authenticatedApi.updateModel(profile, config)
      } else {
        await authenticatedApi.addModel(profile, config, source?.profile.id)
      }
      toasts.add({ title: editing ? 'AI model updated successfully' : 'AI model added successfully', variant: 'success' })
      onSuccess()
    } catch (error: any) {
      console.error('Failed to save model:', error)
      toasts.add({
        title: editing ? 'Failed to update model' : 'Failed to add model',
        description: error?.message,
        variant: 'error',
      })
    } finally {
      setLoading(false)
    }
  }

  const options = buildOptions(gatewayMode, enabledProviders)
  const showCustomFields = selection?.type === 'custom'
  const example = selection ? exampleModel(selection.provider) : null
  const isOllama = selection?.provider === 'ollama'
  const isCloudflare = selection?.provider === 'cloudflare'
  const isGatewayCustom = selection?.provider === 'gateway-custom'
  const presetEntry = GATEWAY_CUSTOM_PRESETS[preset]
  const modelExample = isGatewayCustom
    ? (presetEntry?.exampleModel ?? 'model-id')
    : example?.modelId
  const showCredentials = !gatewayMode
  const tokenRequired = selection !== null && isTokenRequired(selection.provider, headerRows)
  const title = { add: 'Add AI Model', edit: 'Edit AI Model', clone: 'Clone AI Model' }[mode.type]

  // Group options by provider for rendering with visual separators.
  const groupedOptions: { provider: string; items: typeof options }[] = []
  for (const opt of options) {
    const last = groupedOptions[groupedOptions.length - 1]
    if (last && last.provider === opt.provider) {
      last.items.push(opt)
    } else {
      groupedOptions.push({ provider: opt.provider, items: [opt] })
    }
  }

  return (
    <Dialog.Root open={visible} onOpenChange={(open) => { if (!open) onCancel() }}>
      <Dialog className="responsive-dialog overflow-y-auto p-6" size="lg">
        <Dialog.Title className="text-lg font-semibold mb-4">
          {title}
        </Dialog.Title>

        {/* Scrolls on its own so the title and the footer buttons stay put: a Custom Provider
            route asks for enough fields to outgrow the dialog. */}
        <div className="space-y-4 max-h-[60vh] overflow-y-auto px-1 -mx-1">
          {/* Model / Provider selection */}
          {source ? (
            <Input
              label="Provider"
              value={PROVIDER_LABELS[source.config.provider] || source.config.provider}
              disabled
            />
          ) : (
          <Select
            label={gatewayMode ? 'Select Provider' : 'Select Model'}
            className="w-full text-sm"
            placeholder={gatewayMode ? 'Choose a provider...' : 'Choose an AI model...'}
            value={selectValue}
            onValueChange={(v) => handleModelSelect(v as string)}
            error={errors.selection}
            renderValue={(v) => {
              const opt = options.find(o => o.value === v)
              return opt?.label ?? String(v)
            }}
          >
            {groupedOptions.map((group, groupIndex) => (
              <div key={group.provider}>
                {groupIndex > 0 && (
                  <div className="h-px bg-kumo-line my-1 mx-2" />
                )}
                <div className="px-3 py-1.5 text-xs font-medium text-kumo-subtle select-none">
                  {PROVIDER_LABELS[group.provider as AiModelProvider] || group.provider}
                </div>
                {group.items.map(opt => (
                  <Select.Option key={opt.value} value={opt.value}>
                    {opt.label}
                  </Select.Option>
                ))}
              </div>
            ))}
          </Select>
          )}

          {/* Custom model fields */}
          {showCustomFields && (
            <>
              <Input
                label="Model ID"
                placeholder={`e.g., ${modelExample}`}
                description={isGatewayCustom
                  ? `The model id the endpoint expects (e.g., '${modelExample}')`
                  : `The model identifier as specified by the provider (e.g., '${modelExample}')`}
                value={modelId}
                disabled={editing}
                onChange={(e) => { setModelId(e.target.value); setErrors(prev => ({ ...prev, modelId: '' })) }}
                error={errors.modelId}
                variant={errors.modelId ? 'error' : 'default'}
              />

              <Input
                label="Display Name"
                placeholder={`e.g., ${example!.name}`}
                description="Human-readable name shown in the UI"
                value={displayName}
                onChange={(e) => { setDisplayName(e.target.value); setErrors(prev => ({ ...prev, displayName: '' })) }}
                error={errors.displayName}
                variant={errors.displayName ? 'error' : 'default'}
              />
            </>
          )}

          {/* The Custom Provider route. Shown in gateway mode too, unlike the credential fields
              below: these say which registered provider to address and how to speak to it. The
              vendor's key is not among them -- the gateway holds it. */}
          {isGatewayCustom && (
            <>
              <Select
                label="Endpoint"
                className="w-full text-sm"
                value={preset}
                onValueChange={(v) => handlePresetSelect(v as string)}
                renderValue={(v) => v === PRESET_MANUAL
                  ? 'Other endpoint…'
                  : (GATEWAY_CUSTOM_PRESETS[v as string]?.label ?? String(v))}
                description="Fills in the path and wire format below. Both stay editable."
              >
                {Object.entries(GATEWAY_CUSTOM_PRESETS).map(([key, entry]) => (
                  <Select.Option key={key} value={key}>{entry.label}</Select.Option>
                ))}
                <Select.Option value={PRESET_MANUAL}>Other endpoint…</Select.Option>
              </Select>

              <Input
                label="Custom Provider Slug"
                placeholder="e.g., azure-sandbox"
                description={presetEntry
                  ? `The slug you registered in AI Gateway, whose base URL is ${presetEntry.baseUrlHint}`
                  : 'The slug you registered under AI Gateway > Custom Providers'}
                value={slug}
                onChange={(e) => { setSlug(e.target.value); setErrors(prev => ({ ...prev, slug: '' })) }}
                error={errors.slug}
                variant={errors.slug ? 'error' : 'default'}
              />

              <Input
                label="Path"
                placeholder="/openai/v1"
                description="Appended to the provider's base URL, before the endpoint itself. Leave empty if the API sits at the root."
                value={pathPrefix}
                onChange={(e) => { setPathPrefix(e.target.value); setErrors(prev => ({ ...prev, pathPrefix: '' })) }}
                error={errors.pathPrefix}
                variant={errors.pathPrefix ? 'error' : 'default'}
              />

              <Select
                label="Wire Format"
                className="w-full text-sm"
                value={wireFormat}
                onValueChange={(v) => setWireFormat(v as GatewayCustomApi)}
                renderValue={(v) => WIRE_FORMATS.find(f => f.value === v)?.label ?? String(v)}
                description="Which request shape the endpoint speaks"
              >
                {WIRE_FORMATS.map(f => (
                  <Select.Option key={f.value} value={f.value}>{f.label}</Select.Option>
                ))}
              </Select>

              <Input
                label="Context Window"
                placeholder="e.g., 400000"
                description="Total tokens one request may occupy. Used to budget context compaction, so an inaccurate value either compacts too early or overflows the model."
                value={contextWindow}
                onChange={(e) => { setContextWindow(e.target.value); setErrors(prev => ({ ...prev, contextWindow: '' })) }}
                error={errors.contextWindow}
                variant={errors.contextWindow ? 'error' : 'default'}
              />

              <Collapsible.Root open={advancedOpen} onOpenChange={setAdvancedOpen}>
                <Collapsible.DefaultTrigger>Advanced Settings</Collapsible.DefaultTrigger>
                <Collapsible.DefaultPanel>
                  <div className="space-y-4">
                    <Input
                      label="Output Limit"
                      placeholder="(none)"
                      description="Tokens reserved out of the context window for the response"
                      value={outputLimit}
                      onChange={(e) => { setOutputLimit(e.target.value); setErrors(prev => ({ ...prev, outputLimit: '' })) }}
                      error={errors.outputLimit}
                      variant={errors.outputLimit ? 'error' : 'default'}
                    />

                    <Select
                      label="Token Cap Field"
                      className="w-full text-sm"
                      value={maxTokensField}
                      onValueChange={(v) => setMaxTokensField(v as string)}
                      renderValue={(v) => v ? String(v) : 'Default for the format'}
                      description="Vendors disagree: Azure's newer models reject max_tokens, DeepSeek honours only that one. Ignored by Anthropic Messages."
                    >
                      <Select.Option value="">Default for the format</Select.Option>
                      <Select.Option value="max_completion_tokens">max_completion_tokens</Select.Option>
                      <Select.Option value="max_tokens">max_tokens</Select.Option>
                    </Select>

                    <Select
                      label="Reasoning Effort"
                      className="w-full text-sm"
                      value={reasoningEffort}
                      onValueChange={(v) => setReasoningEffort(v as string)}
                      renderValue={(v) => v ? String(v) : 'Vendor default'}
                      description="Sent on every request. Leave at the default unless the model reasons — most models reject the setting. Which values work depends on the model."
                    >
                      <Select.Option value="">Vendor default</Select.Option>
                      {REASONING_EFFORTS.map(e => (
                        <Select.Option key={e} value={e}>{e}</Select.Option>
                      ))}
                    </Select>

                    <Input
                      label="Input Price"
                      placeholder="(unpriced)"
                      description="Dollars per million prompt tokens, as the vendor publishes them. Leave both prices blank to leave this model's cost unreported."
                      value={inputPrice}
                      onChange={(e) => { setInputPrice(e.target.value); setErrors(prev => ({ ...prev, inputPrice: '' })) }}
                      error={errors.inputPrice}
                      variant={errors.inputPrice ? 'error' : 'default'}
                    />

                    <Input
                      label="Output Price"
                      placeholder="(unpriced)"
                      description="Dollars per million completion tokens, reasoning included."
                      value={outputPrice}
                      onChange={(e) => { setOutputPrice(e.target.value); setErrors(prev => ({ ...prev, outputPrice: '' })) }}
                      error={errors.outputPrice}
                      variant={errors.outputPrice ? 'error' : 'default'}
                    />

                    <Input
                      label="Cached Input Price"
                      placeholder="(same as input)"
                      description="Dollars per million prompt tokens served from the vendor's cache. Azure OpenAI discounts these to a tenth of input; blank charges them at the full input rate rather than guessing."
                      value={cachedInputPrice}
                      onChange={(e) => { setCachedInputPrice(e.target.value); setErrors(prev => ({ ...prev, cachedInputPrice: '' })) }}
                      error={errors.cachedInputPrice}
                      variant={errors.cachedInputPrice ? 'error' : 'default'}
                    />
                  </div>
                </Collapsible.DefaultPanel>
              </Collapsible.Root>
            </>
          )}

          {/* Cloudflare account ID (the Workers AI REST endpoint is account-scoped) */}
          {showCredentials && isCloudflare && (
            <Input
              label="Cloudflare Account ID"
              placeholder="e.g., 0123456789abcdef0123456789abcdef"
              description="The Cloudflare account to bill for Workers AI usage"
              value={accountId}
              onChange={(e) => { setAccountId(e.target.value); setErrors(prev => ({ ...prev, accountId: '' })) }}
              error={errors.accountId}
              variant={errors.accountId ? 'error' : 'default'}
            />
          )}

          {/* API Token */}
          {showCredentials && selection && (
            <StoredSecretInput
              label="API Token"
              stored={storedSecretsUsable && source!.config.apiToken === null}
              placeholder={tokenRequired ? API_TOKEN_PLACEHOLDERS[selection.provider] : '(optional)'}
              description={
                isOllama
                  ? 'Optional for local Ollama access'
                  : isCloudflare
                  ? 'An API token with Workers AI Read + Edit permissions (in the dashboard: Workers AI > Use REST API > Create a Workers AI API Token)'
                  : TOKEN_OPTIONAL_WITH_HEADERS.has(selection.provider)
                  ? `Your ${PROVIDER_LABELS[selection.provider]} API token for billing. Leave blank if the extra headers under Advanced Settings authenticate you to a proxy that supplies its own key.`
                  : `Your ${PROVIDER_LABELS[selection.provider]} API token for billing`
              }
              value={effectiveApiToken}
              onValueChange={(v) => { setApiToken(v); setErrors(prev => ({ ...prev, apiToken: '' })) }}
              error={errors.apiToken}
            />
          )}

          {/* Ollama API URL (always visible for Ollama) */}
          {showCredentials && isOllama && (
            <Input
              label="API URL"
              placeholder="http://localhost:11434"
              description="URL of your Ollama server"
              value={apiUrl}
              onChange={(e) => { setApiUrl(e.target.value); setErrors(prev => ({ ...prev, apiUrl: '' })) }}
              error={errors.apiUrl}
              variant={errors.apiUrl ? 'error' : 'default'}
            />
          )}

          {selection && (
            <Collapsible.Root
              open={advancedOpen}
              onOpenChange={setAdvancedOpen}
            >
              <Collapsible.DefaultTrigger>Advanced Settings</Collapsible.DefaultTrigger>
              <Collapsible.DefaultPanel>
                <div className="space-y-4">
                  {/* Ollama shows its API URL above; Workers AI's endpoint is derived from the account ID. */}
                  {showCredentials && !isOllama && !isCloudflare && (
                    <Input
                      label="API URL"
                      placeholder="https://..."
                      description="Override the default API endpoint (useful for proxies like Cloudflare AI Gateway)"
                      value={apiUrl}
                      onChange={(e) => setApiUrl(e.target.value)}
                    />
                  )}
                  {showCredentials && (
                    <ExtraHeadersEditor
                      rows={headerRows}
                      storedValuesUsable={storedSecretsUsable}
                      errors={headerErrors}
                      onRowsChange={(rows) => {
                        setHeaderRows(rows)
                        setHeaderErrors({})
                        // Adding a header can make the token optional.
                        setErrors(prev => ({ ...prev, apiToken: '' }))
                      }}
                    />
                  )}
                  <Input
                    label="Context Window"
                    inputMode="numeric"
                    placeholder="(default)"
                    description="The maximum tokens one request may total. Leave blank to use the model's built-in default."
                    value={contextWindow}
                    onChange={(e) => { setContextWindow(e.target.value); setErrors(prev => ({ ...prev, contextWindow: '' })) }}
                    error={errors.contextWindow}
                    variant={errors.contextWindow ? 'error' : 'default'}
                  />
                  <Input
                    label="Output Limit"
                    inputMode="numeric"
                    placeholder="(default)"
                    description="The maximum tokens in one response, also reserved out of the context window. Leave blank to use the model's built-in default."
                    value={outputLimit}
                    onChange={(e) => { setOutputLimit(e.target.value); setErrors(prev => ({ ...prev, outputLimit: '' })) }}
                    error={errors.outputLimit}
                    variant={errors.outputLimit ? 'error' : 'default'}
                  />
                </div>
              </Collapsible.DefaultPanel>
            </Collapsible.Root>
          )}
        </div>

        {/* Footer */}
        <div className="mt-6 flex justify-end gap-2">
          <Dialog.Close render={(props) => (
            <Button variant="secondary" {...props} disabled={loading}>
              Cancel
            </Button>
          )} />
          <Button
            variant="primary"
            onClick={handleSubmit}
            loading={loading}
            disabled={!selection}
          >
            {editing ? 'Save Changes' : 'Add Model'}
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
