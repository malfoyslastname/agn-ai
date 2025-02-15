import { ImageAdapterResponse, ImageGenerateRequest } from './types'
import { AppLog } from '../logger'
import { handleNovelImage } from './novel'
import { store } from '../db'
import { config } from '../config'
import { v4 } from 'uuid'
import { saveFile } from '../api/upload'
import { handleSDImage } from './stable-diffusion'
import { sendGuest, sendMany } from '../api/ws'
import { handleHordeImage } from './horde'

export async function generateImage(
  { user, chatId, messageId, ...opts }: ImageGenerateRequest,
  log: AppLog,
  guestId?: string
) {
  const broadcastIds: string[] = []

  if (!guestId) {
    broadcastIds.push(user._id)
    const members = await store.chats.getActiveMembers(chatId)
    broadcastIds.push(...members, user._id)
  }

  let image: ImageAdapterResponse | undefined
  let output: string = ''
  let error: any

  let parsed = opts.prompt.replace(/\{\{prompt\}\}/g, ' ')
  let prompt = parsed

  if (user.images?.template) {
    prompt = user.images.template.replace(/\{\{prompt\}\}/g, parsed)
    if (!prompt.includes(parsed)) {
      prompt = prompt + ' ' + parsed
    }
  }

  prompt = prompt.trim()

  log.debug({ prompt, type: user.images?.type }, 'Image prompt')

  try {
    switch (user.images?.type || 'horde') {
      case 'novel':
        image = await handleNovelImage({ user, prompt }, log, guestId)
        break

      case 'sd':
        image = await handleSDImage({ user, prompt }, log, guestId)
        break

      case 'horde':
      default:
        image = await handleHordeImage({ user, prompt }, log, guestId)
        break
    }
  } catch (ex: any) {
    error = ex.message || ex
  }

  /**
   * If the server is configured to save images: we will store the image, generate a message, then publish the message
   * Otherwise: We will broadcast the image content
   */
  if (image) {
    if (!opts.ephemeral && config.storage.saveImages) {
      const name = `${v4()}.${image.ext}`
      output = await saveFile(name, image.content)

      if (!guestId) {
        const msg = await createImageMessage({
          chatId,
          userId: user._id,
          filename: output,
          memberIds: broadcastIds,
          messageId,
        })

        if (msg) return
      }
    } else {
      output = await saveFile(`temp-${v4()}.${image.ext}`, image.content, 300)
    }
  }

  const message = image
    ? { type: 'image-generated', chatId, image: output }
    : { type: 'image-failed', chatId, error: error || 'Invalid image settings (No handler found)' }

  if (broadcastIds.length) {
    sendMany(broadcastIds, message)
  } else if (guestId) {
    sendGuest(guestId, message)
  }

  return { output }
}

async function createImageMessage(opts: {
  chatId: string
  userId: string
  filename: string
  messageId?: string
  memberIds: string[]
}) {
  const chat = await store.chats.getChat(opts.chatId)
  if (!chat) return

  const char = await store.characters.getCharacter(opts.userId, chat.characterId)
  if (!char) return

  if (opts.messageId) {
    const msg = await store.msgs.editMessage(opts.messageId, opts.filename, 'image')
    sendMany(opts.memberIds, {
      type: 'message-retry',
      chatId: opts.chatId,
      messageId: opts.messageId,
      message: opts.filename,
      adapter: 'image',
    })
    return msg
  } else {
    const msg = await store.msgs.createChatMessage({
      chatId: opts.chatId,
      message: opts.filename,
      characterId: char._id,
      adapter: 'image',
    })

    sendMany(opts.memberIds, { type: 'message-created', msg, chatId: opts.chatId })
    return msg
  }
}
