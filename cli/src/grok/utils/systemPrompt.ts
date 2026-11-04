import { SKILL_LOOKUP_INSTRUCTION } from '@/modules/common/skillLookupInstruction'
import { withSessionSummaryInstruction } from '@/modules/common/sessionSummaryInstruction'

export const GROK_TITLE_INSTRUCTION =
    `Use the tool "hapi_change_title" once the initial request is clear to set a concise session title, and call it again in later turns whenever the user switches to a new task or topic. Do not rename for minor substeps within the same task.\n${SKILL_LOOKUP_INSTRUCTION}`

export function getGrokTitleInstruction(env: NodeJS.ProcessEnv = process.env): string {
    return withSessionSummaryInstruction(GROK_TITLE_INSTRUCTION, env)
}
