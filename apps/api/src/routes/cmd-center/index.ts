// SPDX-License-Identifier: AGPL-3.0-only
import { Router } from 'express'
import { statusRouter } from './status.js'
import { coolifyRouter } from './coolify.js'
import { githubRouter } from './github.js'
import { sentryRouter } from './sentry.js'
import { posthogRouter } from './posthog.js'
import { ovhcloudRouter } from './ovhcloud.js'
import { agentsRouter } from './agents.js'

export const cmdCenterRouter = Router()

cmdCenterRouter.use('/status', statusRouter)
cmdCenterRouter.use('/coolify', coolifyRouter)
cmdCenterRouter.use('/github', githubRouter)
cmdCenterRouter.use('/sentry', sentryRouter)
cmdCenterRouter.use('/posthog', posthogRouter)
cmdCenterRouter.use('/ovhcloud', ovhcloudRouter)
cmdCenterRouter.use('/agents', agentsRouter)
