import needle from 'needle'
import { sanitise, trimResponseV2 } from '../api/chat/common'
import { ModelAdapter, AdapterProps } from './type'
import { decryptText } from '../db/util'
import { defaultPresets } from '../../common/presets'
import { BOT_REPLACE, SELF_REPLACE } from '../../common/prompt'
import { getEncoder } from '../../common/tokenize'
import { OPENAI_MODELS } from '../../common/adapters'
import { AppSchema } from '../db/schema'

const baseUrl = `https://api.anthropic.com/v1/complete`

// There's no tokenizer for Claude, we use OpenAI's as an estimation
const encoder = getEncoder('openai', OPENAI_MODELS.Turbo)

export const handleClaude: ModelAdapter = async function* (opts) {
  const { char, members, user, settings, log, guest, gen, sender, isThirdParty } = opts
  const base = getBaseUrl(user, isThirdParty)
  if (!user.claudeApiKey && !base.changed) {
    yield { error: `Claude request failed: Claude API key not set. Check your settings.` }
    return
  }
  const claudeModel = settings.claudeModel ?? defaultPresets.claude.claudeModel
  const username = sender.handle || 'You'

  const stops = new Set([
    `\n\n${char.name}:`,
    `\n\n${username}:`,
    `\n\nSystem:`,
    ...members.map((member) => `\n\n${member.handle}:`),
  ])

  const requestBody = {
    model: claudeModel,
    temperature: Math.min(1, Math.max(0, gen.temp ?? defaultPresets.claude.temp)),
    max_tokens_to_sample: gen.maxTokens ?? defaultPresets.claude.maxTokens,
    prompt: createClaudePrompt(opts),
    stop_sequences: Array.from(stops),
  }

  const headers: any = {
    'Content-Type': 'application/json',
  }

  if (!base.changed) {
    headers['x-api-key'] = !!guest ? user.claudeApiKey : decryptText(user.claudeApiKey!)
  }

  log.debug(requestBody, 'Claude payload')

  const resp = await needle('post', base.url, JSON.stringify(requestBody), {
    json: true,
    headers,
  }).catch((err) => ({ error: err }))

  if ('error' in resp) {
    log.error({ error: resp.error }, 'Claude request failed to send')
    yield { error: `Claude request failed: ${resp.error?.message || resp.error}` }
    return
  }

  if (resp.statusCode && resp.statusCode >= 400) {
    log.error({ body: resp.body }, `Claude request failed (${resp.statusCode})`)
    yield { error: `Claude request failed: ${resp.statusMessage}` }
    return
  }

  try {
    const completion = resp.body.completion
    if (!completion) {
      log.error({ body: resp.body }, 'OpenAI request failed: Empty response')
      yield { error: `OpenAI request failed: Received empty response. Try again.` }
      return
    } else {
      const sanitised = sanitise(completion)
      const trimmed = trimResponseV2(sanitised, char, members, ['END_OF_DIALOG'])
      yield trimmed || sanitised
      return
    }
  } catch (ex: any) {
    log.error({ err: ex }, 'Claude failed to parse')
    yield { error: `Claude request failed: ${ex.message}` }
    return
  }
}

function getBaseUrl(user: AppSchema.User, isThirdParty?: boolean) {
  if (isThirdParty && user.thirdPartyFormat === 'claude' && user.koboldUrl) {
    return { url: user.koboldUrl, changed: true }
  }

  return { url: baseUrl, changed: false }
}

function createClaudePrompt(opts: AdapterProps): string {
  const { char, sender, parts, gen } = opts
  const username = sender.handle || 'You'
  const lines = opts.lines ?? []

  const maxContextLength = gen.maxContextLength || defaultPresets.claude.maxContextLength
  const maxResponseTokens = gen.maxTokens ?? defaultPresets.claude.maxTokens

  const gaslightCost = encoder('System: ' + parts.gaslight)
  const ujb = gen.ultimeJailbreak?.replace(BOT_REPLACE, char.name)?.replace(SELF_REPLACE, username)
  const ujbCost = ujb ? encoder('System: ' + gen.ultimeJailbreak) : 0

  const maxBudget =
    maxContextLength - maxResponseTokens - gaslightCost - ujbCost - encoder(char.name + ':')

  let tokens = 0
  const history: string[] = []

  for (const line of lines.slice().reverse()) {
    const cost = encoder(line)
    if (cost + tokens >= maxBudget) break

    tokens += cost
    history.push(line)
  }

  const messages = [`System: ${parts.gaslight}`, ...history.reverse()]

  if (ujb) {
    messages.push(`System: ${ujb}`)
  }

  // <https://console.anthropic.com/docs/prompt-design#what-is-a-prompt>
  return '\n\n' + messages.join('\n\n') + '\n\n' + char.name + ':'
}
