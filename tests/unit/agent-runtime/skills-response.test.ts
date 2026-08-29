import { AIMessage } from '@langchain/core/messages'
import { CompositeBackend } from 'deepagents'
import { afterEach, describe, expect, it, vi } from 'vitest'

const deepAgentsSkillsMiddleware = vi.hoisted(() => vi.fn())

vi.mock('deepagents', async () => {
  const actual = await vi.importActual<typeof import('deepagents')>('deepagents')
  return { ...actual, createSkillsMiddleware: deepAgentsSkillsMiddleware }
})

import {
  createProductSkillsMiddlewareSet,
  createSkillsMiddleware
} from '../../../src/main/agent-runtime/skills/backend'
import {
  createProductGeneralPurposeSubagent,
  shouldEnableGeneralPurposeSubagent
} from '../../../src/main/agent-runtime/agent/backend'

type ModelCall = NonNullable<ReturnType<typeof createSkillsMiddleware>['wrapModelCall']>

const createModelMiddleware = (response: unknown) => {
  const wrapToolCall = vi.fn()
  const beforeAgent = vi.fn()
  const wrapModelCall = vi.fn(async () => response) as unknown as ModelCall
  const baseMiddleware = {
    name: 'SkillsMiddleware',
    wrapToolCall,
    beforeAgent,
    wrapModelCall
  }
  deepAgentsSkillsMiddleware.mockReturnValueOnce(baseMiddleware)
  return { baseMiddleware, wrapToolCall, beforeAgent }
}

const invokeSkillsMiddleware = async (response: unknown) => {
  const hooks = createModelMiddleware(response)
  const middleware = createSkillsMiddleware({ backend: {} as never, sources: ['/skills/'] })
  const wrappedResponse = await middleware.wrapModelCall?.({} as never, vi.fn() as never)
  return { middleware, wrappedResponse, ...hooks }
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('agent runtime skills model response compatibility', () => {
  it('normalizes a plain assistant response and preserves other middleware hooks', async () => {
    const { middleware, wrappedResponse, wrapToolCall, beforeAgent } = await invokeSkillsMiddleware({
      role: 'assistant',
      content: 'ready',
      tool_calls: [{ id: 'call-1', name: 'read_file', args: {} }]
    })

    expect(wrappedResponse).toBeInstanceOf(AIMessage)
    expect((wrappedResponse as AIMessage).content).toBe('ready')
    expect((wrappedResponse as AIMessage).tool_calls).toEqual([
      { id: 'call-1', name: 'read_file', args: {} }
    ])
    expect(middleware.wrapToolCall).toBe(wrapToolCall)
    expect(middleware.beforeAgent).toBe(beforeAgent)
  })

  it('normalizes a serialized ChatResult generation before LangChain validation', async () => {
    const { wrappedResponse } = await invokeSkillsMiddleware({
      generations: [[{ message: { type: 'ai', data: { content: 'from chat result' } } }]]
    })

    expect(wrappedResponse).toBeInstanceOf(AIMessage)
    expect((wrappedResponse as AIMessage).content).toBe('from chat result')
  })

  it('normalizes a serialized AIMessage constructor payload', async () => {
    const { wrappedResponse } = await invokeSkillsMiddleware({
      type: 'constructor',
      id: ['langchain_core', 'messages', 'AIMessage'],
      kwargs: { content: 'from serialized message' }
    })

    expect(wrappedResponse).toBeInstanceOf(AIMessage)
    expect((wrappedResponse as AIMessage).content).toBe('from serialized message')
  })

  it('rejects unknown response objects without including response content', async () => {
    const error = await invokeSkillsMiddleware({
      role: 'user',
      content: 'provider-secret-response-body'
    }).catch((value: unknown) => value)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/unsupported response object/)
    expect((error as Error).message).not.toContain('provider-secret-response-body')
  })

  it('uses the normalized skills middleware for the general-purpose product subagent', () => {
    createModelMiddleware({ role: 'assistant', content: 'ready' })
    const backend = new CompositeBackend({} as never, {})
    const [subagent] = createProductGeneralPurposeSubagent({
      model: {} as never,
      tools: [],
      backend,
      skillSource: '/skills/',
      requiredSkillNames: []
    })

    expect(subagent.middleware).toHaveLength(2)
    expect(subagent.middleware[1].wrapModelCall).toBeTypeOf('function')
    expect(deepAgentsSkillsMiddleware).toHaveBeenCalledTimes(1)
  })

  it('omits the general-purpose subagent when the caller disables delegation', () => {
    const backend = new CompositeBackend({} as never, {})
    const subagents = createProductGeneralPurposeSubagent({
      model: {} as never,
      tools: [],
      backend,
      skillSource: '/skills/',
      requiredSkillNames: [],
      enabled: false
    })

    expect(subagents).toEqual([])
    expect(deepAgentsSkillsMiddleware).not.toHaveBeenCalled()
  })

  it('disables delegation for single-page generation but preserves multi-page and edit flows', () => {
    expect(
      shouldEnableGeneralPurposeSubagent({
        mode: 'generate',
        selectedPageId: 'page-1',
        outlineTitles: ['Intro']
      })
    ).toBe(false)
    expect(
      shouldEnableGeneralPurposeSubagent({
        mode: 'generate',
        outlineTitles: ['Intro', 'Details']
      })
    ).toBe(true)
    expect(
      shouldEnableGeneralPurposeSubagent({
        mode: 'edit',
        selectedPageId: 'page-1',
        outlineTitles: ['Intro']
      })
    ).toBe(true)
  })

  it('uses the same normalized skills middleware for the main product agent set', () => {
    createModelMiddleware({ role: 'assistant', content: 'ready' })
    const middleware = createProductSkillsMiddlewareSet(
      {} as never,
      '/skills/',
      'session-deck',
      []
    )

    expect(middleware).toHaveLength(2)
    expect(middleware[1].wrapModelCall).toBeTypeOf('function')
  })
})
