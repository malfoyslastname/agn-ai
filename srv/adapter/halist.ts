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
  const apiKey = `${guest ? user.halistApiKey : decryptText(user.halistApiKey)}`
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
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

  const ctxAndQuery = buildPromptCtxAndQuery({
    encoder,
    lines,
    log,
    tokenBudget,
    gaslight: parts.gaslight,
    charname: char.name,
  })

  try {
    const chatResponse = await needle(
      'post',
      'https://halist.ai/api/v1/chat',
      JSON.stringify({ ...ctxAndQuery, title: '' }),
      { headers, json: true }
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

type CtxMsg = {
  committed: number
  content: string
  conversationId: number
  from: 'AI' | 'You'
  id: number
}

const mkCtxMsg = (from: 'AI' | 'You', content: string) => ({
  committed: 1,
  content,
  conversationId: 1,
  from,
  id: 1,
})

function buildPromptCtxAndQuery({
  log,
  lines,
  encoder,
  tokenBudget,
  gaslight,
  charname,
}: {
  log: AppLog
  lines: string[]
  encoder: Encoder
  tokenBudget: number
  gaslight: string
  charname: string
}): { query: string; context: CtxMsg[] } {
  let budget = tokenBudget - encoder(gaslight)
  const ctx: CtxMsg[] = []

  for (const line of [...lines].reverse().slice(1)) {
    budget -= encoder(line + `\n`)
    if (budget <= 0) break
    const isBot = line.startsWith(charname)
    const msgContent = line.split(':')[1] ?? line
    ctx.push(mkCtxMsg(isBot ? 'AI' : 'You', msgContent))
  }
  ctx.push(mkCtxMsg('AI', gaslight))
  ctx.reverse()
  const queryLine = lines[lines.length - 1]
  const query = queryLine?.split(':')?.[1] ?? queryLine

  log.info({ unusedTokens: budget }, 'Halist: Finished building prompt')
  return { context: ctx, query }
}
