import { overviewDefaultRegions, workbenchDefaultRegions } from '@hapi/protocol'
import { LAYOUT_REVISION, type WorkLayout } from './layout'

export const overviewLayout: WorkLayout = {
    revision: LAYOUT_REVISION,
    regions: overviewDefaultRegions,
}

export const workbenchLayout: WorkLayout = {
    revision: LAYOUT_REVISION,
    regions: workbenchDefaultRegions,
}
