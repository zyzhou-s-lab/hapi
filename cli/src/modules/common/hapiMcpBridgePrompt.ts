import { trimIdent } from '@/utils/trimIdent';
import {
    DISPLAY_IMAGE_PROMPT_HAPI_MCP,
    DISPLAY_MEDIA_PROMPT_HAPI_MCP,
    DISPLAY_VIDEO_PROMPT_HAPI_MCP,
} from './displayImagePrompt';

/** Shell fallback for `hapi doctor inline-media` only — not injected into agent prompts. */
export const INLINE_MEDIA_SHELL_FALLBACK = trimIdent(`
    If display_image / display_video / display_media tools are not in your tool list, inline media via shell from the HAPI repo (needs bun + @modelcontextprotocol/sdk):
    cd <hapi-repo-root> && bun scripts/tooling/hapi-display-image.mjs <HAPI-session-id-prefix> <absolute-file-path> "title"
    Use the HAPI session uuid prefix from the web URL /sessions/<uuid> (first 8 chars), not cursorSessionId or other agent-native ids.
    Run hapi doctor inline-media to list active bridges and copy the exact command.
`);

/**
 * Title + display_image / display_video / display_media instructions for OpenCode first-prompt /
 * hapi-instructions.md. Cursor uses native MCP overlay + tool descriptions instead
 * (no user-turn prepend — that path was prompt-taint).
 */
export const HAPI_MCP_TITLE_INSTRUCTION = trimIdent(`
    Keep the chat title aligned with the current task. For a new chat, call the tool "hapi_change_title" once the user's initial request is clear, and call it again in later turns whenever the user switches to a new task, topic, or stage of work so the title reflects the current work. Do not rename the chat for minor substeps within the same task or a slightly better wording.
`);

export const HAPI_MCP_BRIDGE_PROMPT = trimIdent(`
    ${HAPI_MCP_TITLE_INSTRUCTION}
    ${DISPLAY_IMAGE_PROMPT_HAPI_MCP}
    ${DISPLAY_VIDEO_PROMPT_HAPI_MCP}
    ${DISPLAY_MEDIA_PROMPT_HAPI_MCP}
`);
