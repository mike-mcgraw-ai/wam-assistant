/**
 * Public snapshot stand-in. The household rules are part of WAM Home, which is
 * private; this keeps the public hub runnable with a plain list (every sentence
 * is one item, nothing is routed).
 */
import { parseListSpeech } from './listVoice.js'

export function routeHouseholdSpeech(text) {
  return { listOps: parseListSpeech(text), routines: [], tasks: [] }
}
