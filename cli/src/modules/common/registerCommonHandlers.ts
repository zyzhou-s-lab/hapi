import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { registerAgyModelHandlers } from './handlers/agyModels'
import { registerBashHandlers } from './handlers/bash'
import { registerCodexModelHandlers } from './handlers/codexModels'
import { registerCcSwitchHandlers } from './handlers/ccSwitch'
import { registerCursorModelHandlers } from './handlers/cursorModels'
import { registerOpencodeModelHandlers } from './handlers/opencodeModels'
import { registerPiModelHandlers } from './handlers/piModels'
import { registerGrokModelHandlers } from './handlers/grokModels'
import { registerCopilotModelHandlers } from './handlers/copilotModels'
import { registerDirectoryHandlers } from './handlers/directories'
import { registerDifftasticHandlers } from './handlers/difftastic'
import { registerFileHandlers } from './handlers/files'
import { registerGitHandlers } from './handlers/git'
import { registerRipgrepHandlers } from './handlers/ripgrep'
import { registerSlashCommandHandlers } from './handlers/slashCommands'
import { registerSkillsHandlers } from './handlers/skills'
import { registerSessionConfigHandlers, type SessionConfigContext } from './handlers/sessionConfig'
import { listedSessionConfigRealpaths } from './sessionInventory'
import { registerUploadHandlers } from './handlers/uploads'
import { registerImportableSessionHandlers } from '../../../../fork-features/history-import/cli/register'

export function registerCommonHandlers(
    rpcHandlerManager: RpcHandlerManager,
    workingDirectory: string,
    options?: { getSessionConfigContext?: () => SessionConfigContext }
): void {
    registerAgyModelHandlers(rpcHandlerManager)
    registerBashHandlers(rpcHandlerManager, workingDirectory)
    registerCodexModelHandlers(rpcHandlerManager)
    registerCcSwitchHandlers(rpcHandlerManager)
    registerCursorModelHandlers(rpcHandlerManager)
    registerOpencodeModelHandlers(rpcHandlerManager)
    registerPiModelHandlers(rpcHandlerManager)
    registerGrokModelHandlers(rpcHandlerManager)
    registerCopilotModelHandlers(rpcHandlerManager)
    registerFileHandlers(rpcHandlerManager, workingDirectory, () => listedSessionConfigRealpaths({
        cwd: workingDirectory,
        ...options?.getSessionConfigContext?.(),
    }))
    registerDirectoryHandlers(rpcHandlerManager, workingDirectory)
    registerRipgrepHandlers(rpcHandlerManager, workingDirectory)
    registerDifftasticHandlers(rpcHandlerManager, workingDirectory)
    registerSlashCommandHandlers(rpcHandlerManager, workingDirectory)
    registerSkillsHandlers(rpcHandlerManager, workingDirectory)
    registerSessionConfigHandlers(rpcHandlerManager, workingDirectory, options?.getSessionConfigContext)
    registerGitHandlers(rpcHandlerManager, workingDirectory)
    registerUploadHandlers(rpcHandlerManager)
    registerImportableSessionHandlers(rpcHandlerManager)
}
