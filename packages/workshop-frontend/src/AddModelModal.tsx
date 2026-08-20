import { useState, useEffect } from 'react'
import { Dialog, Button, Input, Select, SensitiveInput, Collapsible, useKumoToastManager } from '@cloudflare/kumo'
import { AiChatAuthorInfo, AiModelConfig, AiModelProvider, AiGatewayInfo, SUGGESTED_MODELS,
  GATEWAY_CUSTOM_PRESETS, GatewayCustomApi, GatewayCustomReasoningEffort,
  isValidGatewayCustomPathPrefix, isValidGatewayCustomSlug } from '@gadgets/workshop-shared/api'
import { RpcStub } from 'capnweb'
import { AuthenticatedApi } from '@gadgets/workshop-shared/api'

interface AddModelModalProps {
  visible: boolean
  onCancel: () => void
  onSuccess: () => void
  authenticatedApi: RpcStub<AuthenticatedApi>
  aiConfig: AiGatewayInfo | null
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

// Example used in the custom-model placeholders for providers that have no suggested models
// (Ollama serves whatever the user has pulled locally).
const FALLBACK_EXAMPLE_MODEL = { modelId: 'gemma4:31b', name: 'Gemma 4 31B' }

// Chosen in the endpoint picker to type an endpoint the presets don't cover.
const PRESET_MANUAL = '__manual__'

// The slug and the path both land in the gateway route, where the backend holds them to the
// same rule, so the wording matches what it would reject.
const SLUG_ERROR = 'Use only letters, digits and hyphens, starting with a letter or digit'
const PATH_ERROR = 'Start each segment with a letter or digit, e.g. /openai/v1'

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

export default function AddModelModal({ visible, onCancel, onSuccess, authenticatedApi, aiConfig }: AddModelModalProps) {
  const toasts = useKumoToastManager()

  const [loading, setLoading] = useState(false)
  const [selection, setSelection] = useState<SelectionType | null>(null)
  const [selectValue, setSelectValue] = useState<string | undefined>(undefined)

  // Form fields (used for custom models)
  const [modelId, setModelId] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [apiToken, setApiToken] = useState('')
  const [accountId, setAccountId] = useState('')
  const [apiUrl, setApiUrl] = useState('')
  // Custom Provider route. `preset` only seeds the two fields below it; what gets saved is
  // always the path and format, so a preset can change without stranding saved models.
  const [preset, setPreset] = useState<string>(PRESET_MANUAL)
  const [slug, setSlug] = useState('')
  const [pathPrefix, setPathPrefix] = useState('')
  const [wireFormat, setWireFormat] = useState<GatewayCustomApi>('openai-responses')
  const [contextWindow, setContextWindow] = useState('')
  const [outputLimit, setOutputLimit] = useState('')
  const [maxTokensField, setMaxTokensField] = useState('')
  const [reasoningEffort, setReasoningEffort] = useState('')

  // Validation errors
  const [errors, setErrors] = useState<Record<string, string>>({})

  // Advanced settings collapsible state
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const gatewayMode = aiConfig?.enabled === true
  const enabledProviders: Set<string> | null = gatewayMode
    ? new Set(aiConfig.enabledProviders)
    : null

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
      setContextWindow('')
      setOutputLimit('')
      setMaxTokensField('')
      setReasoningEffort('')
      setErrors({})
      setAdvancedOpen(false)
    }
  }, [visible])

  const handleModelSelect = (value: string) => {
    setSelectValue(value)
    setErrors({})
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
    setContextWindow('')
    setOutputLimit('')
    setMaxTokensField('')
    setReasoningEffort('')
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
    }

    if (showCredentials && selection && !isOllama && !apiToken.trim()) {
      newErrors.apiToken = 'Please enter your API token'
    }

    if (showCredentials && isCloudflare && !accountId.trim()) {
      newErrors.accountId = 'Please enter your Cloudflare account ID'
    }

    if (showCredentials && isOllama && !apiUrl.trim()) {
      newErrors.apiUrl = 'Please enter the Ollama API URL'
    }

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
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
        id: finalModelId,
        name: finalDisplayName,
      }

      const config: AiModelConfig = {
        provider: selection!.provider,
        model: finalModelId,
        apiToken: gatewayMode ? '' : apiToken.trim(),
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
          },
        }),
      }

      await authenticatedApi.addModel(profile, config)
      toasts.add({ title: 'AI model added successfully', variant: 'success' })
      onSuccess()
    } catch (error: any) {
      console.error('Failed to add model:', error)
      toasts.add({ title: 'Failed to add model', variant: 'error' })
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
      <Dialog className="p-6" size="lg">
        <Dialog.Title className="text-lg font-semibold mb-4">
          Add AI Model
        </Dialog.Title>

        {/* Scrolls on its own so the title and the footer buttons stay put: a Custom Provider
            route asks for enough fields to outgrow the dialog. */}
        <div className="space-y-4 max-h-[60vh] overflow-y-auto px-1 -mx-1">
          {/* Model / Provider selection */}
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
            <SensitiveInput
              label="API Token"
              placeholder={API_TOKEN_PLACEHOLDERS[selection.provider]}
              description={
                isOllama
                  ? 'Optional for local Ollama access'
                  : isCloudflare
                  ? 'An API token with Workers AI Read + Edit permissions (in the dashboard: Workers AI > Use REST API > Create a Workers AI API Token)'
                  : `Your ${PROVIDER_LABELS[selection.provider]} API token for billing`
              }
              value={apiToken}
              onValueChange={(v) => { setApiToken(v); setErrors(prev => ({ ...prev, apiToken: '' })) }}
              error={errors.apiToken}
              variant={errors.apiToken ? 'error' : 'default'}
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

          {/* Advanced Settings for non-Ollama, non-Cloudflare providers */}
          {showCredentials && selection && !isOllama && !isCloudflare && (
            <Collapsible.Root
              open={advancedOpen}
              onOpenChange={setAdvancedOpen}
            >
              <Collapsible.DefaultTrigger>Advanced Settings</Collapsible.DefaultTrigger>
              <Collapsible.DefaultPanel>
                <Input
                  label="API URL"
                  placeholder="https://..."
                  description="Override the default API endpoint (useful for proxies like Cloudflare AI Gateway)"
                  value={apiUrl}
                  onChange={(e) => setApiUrl(e.target.value)}
                />
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
            Add Model
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
