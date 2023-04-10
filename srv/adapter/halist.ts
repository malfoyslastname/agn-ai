import needle, { NeedleResponse } from 'needle'
import { decryptText } from '../db/util'
import { sanitise, trimResponseV2 } from '../api/chat/common'
import { ModelAdapter } from './type'
import { AppLog } from '../logger'
import { Encoder, getEncoder } from '../../common/tokenize'

export const handleHalist: ModelAdapter = async function* ({
  char,
  members,
  user,
  parts,
  lines,
  guest,
  log,
  settings,
  gen,
}) {
  if (!user.halistApiKey) {
    yield { error: 'Halist API not set' }
    return
  }

  const apiKey = `Basic ${guest ? user.halistApiKey : decryptText(user.halistApiKey)}`
  const cookieSession = `Basic ${guest ? user.halistCookies : decryptText(user.halistCookies)}`
  const headers = {
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9',
    'content-type': 'application/json',
    origin: 'https://halist.ai/api/v1/chat',
    Authorization: `Bearer ${apiKey}`,
    Cookie: `session=${cookieSession}`,
  }
  const encoder = getEncoder('openai', 'gpt-4')
  const gaslightTokens = encoder(parts.gaslight)
  const contextSize = Math.min(gen.maxContextLength || settings.maxContextLength || 4000, 7750)
  const reservedInferenceTokens = gen.maxTokens || settings.maxTokens || 80
  const tokenBudget = contextSize - gaslightTokens - reservedInferenceTokens
  log.info(
    { contextSize, gaslightTokens, reservedInferenceTokens, tokenBudget },
    'Halist: working with these token values (prompt budget = context - gaslight - reserved)'
  )

  if (!lines) {
    yield { error: 'Halist: no chat lines sent by client' }
    return
  }

  const promptString = buildPromptString({
    encoder,
    lines,
    log,
    tokenBudget,
  })

  try {
    const payload = {
      context: [],
      query: promptString,
    }
    log.info({ payload }, 'Halist: sending payload to embedbase')
    const chatResponse = await needle(
      'post',
      'https://halist.ai/api/v1/chat',
      JSON.stringify(payload),
      {
        headers,
        json: true,
      }
    )
    assertOk(chatResponse, 'Halist API call failed')
    // Response is just straight text

    const parsed = sanitise(chatResponse.body)
    const trimmed = trimResponseV2(parsed, char, members, [])
    yield trimmed || parsed
  } catch (err: any) {
    log.error({ err: `Halist adapter error: ${err.message}` })
    yield { error: err.message }
  }
}

function assertOk(response: NeedleResponse, message: string) {
  if ((response.statusCode || 0) >= 400) {
    throw new Error(`${message} with status code ${response.statusCode}`)
  }
}

function buildPromptString({
  log,
  lines,
  encoder,
  tokenBudget,
}: {
  log: AppLog
  lines: string[]
  encoder: Encoder
  tokenBudget: number
}) {
  let tokens = tokenBudget
  const prompt = []

  for (const line of lines) {
    const length = encoder(line + `\n`)
    if (tokens < length) break
    tokens -= length
    prompt.push(line)
  }

  log.info({ unusedTokens: tokens }, 'Halist: Finished building prompt')
  return prompt.join('\n')
}
