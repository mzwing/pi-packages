import type { CompletionContext, ModelReport } from './complete.js'
import type { Api, Model, Provider } from '@earendil-works/pi-ai'
import { completeModel } from './complete.js'

type PiModel = Model<Api>

/**
 * Registered globally so a `/reload` — which hands us a fresh module instance — still recognises
 * our own wrapper and unwraps to the provider underneath instead of completing a completion.
 */
const WRAPPED = Symbol.for('@mzwing/pi-model-info.wrapped-provider')

interface Wrapper extends Provider {
  [WRAPPED]: Provider
}

export function isOurWrapper(provider: Provider | undefined): boolean {
  return provider !== undefined && WRAPPED in provider
}

export function unwrapProvider(provider: Provider): Provider {
  return (provider as Partial<Wrapper>)[WRAPPED] ?? provider
}

export interface NativeWrapDeps {
  /** The catalog in force right now, or `undefined` while none is loaded. Read on every pass. */
  context: () => CompletionContext | undefined
  onReports: (reports: ModelReport[]) => void
  warn: (message: string) => void
}

/**
 * A provider whose `getModels()` completes the list underneath on every read.
 *
 * This is what keeps a built-in provider reactive: Pi's own dynamic providers keep their list in a
 * closure that `refreshModels()` rewrites, so reading it late — rather than snapshotting it once and
 * registering a replacement list — is what lets `/model`, the four-hourly pi.dev catalog refresh and
 * anything else that refreshes show newly discovered models already completed.
 *
 * The wrapper is a spread of the provider it wraps, which is safe only because we never wrap a
 * third-party native registration: Pi's own providers are closures over their state, never `this`.
 */
export class NativeWrap {
  readonly pristine: Provider
  readonly provider: Provider
  private readonly deps: NativeWrapDeps
  private cache = new WeakMap<PiModel, { model: PiModel; report: ModelReport }>()

  constructor(pristine: Provider, deps: NativeWrapDeps) {
    this.pristine = pristine
    this.deps = deps

    const wrapper: Wrapper = {
      ...pristine,
      [WRAPPED]: pristine,
      getModels: () => this.completeAll(),
    }
    this.provider = wrapper
  }

  /** Drops the per-model cache; call whenever the catalog or the resolved config changes. */
  invalidate(): void {
    this.cache = new WeakMap()
  }

  private completeAll(): readonly PiModel[] {
    const base = this.pristine.getModels()
    const context = this.deps.context()
    if (context === undefined) {
      return base
    }

    try {
      const reports: ModelReport[] = []
      const models = base.map(model => {
        let completed = this.cache.get(model)
        if (completed === undefined) {
          const completion = completeModel(model, context)
          // Spread over the original: `provider`, and anything else Pi carries that a registration
          // shape cannot express, has to survive. `compact` already dropped the undefined slots.
          completed = { model: { ...model, ...completion.model } as PiModel, report: completion.report }
          this.cache.set(model, completed)
        }
        reports.push(completed.report)

        return completed.model
      })
      this.deps.onReports(reports)

      return models
    } catch (error) {
      // Pi treats a throwing `getModels()` as a provider with no models, which would take the whole
      // provider out of the picker. Handing back the uncompleted list is always the lesser harm.
      this.deps.warn(
        `completing '${this.pristine.id}' failed: ${error instanceof Error ? error.message : String(error)}`,
      )

      return base
    }
  }
}
