import type { AnyModel, Api, Model, Provider } from '@earendil-works/pi-ai'

/** Pi keys virtual models on this api but does not export its `isVirtualModel`. */
const VIRTUAL_API = 'pi-virtual'

/** An entry without `type` is chat, as Pi reads it. */
export function isChat<T extends { type?: string | undefined }>(model: T): model is Extract<T, { type?: 'chat' }> {
  return (model.type ?? 'chat') === 'chat'
}

/**
 * The models there are to complete. A virtual model only routes to physical ones, and Pi layers the
 * registered ones back over whatever a provider lists, so one taken along would outlive its registration.
 */
export function chatModels(provider: Provider): Model<Api>[] {
  return provider.getModels().filter(model => model.api !== VIRTUAL_API)
}

/** Image and classifier models. A registered list replaces every model type, so these ride along untouched. */
export function passthroughModels(provider: Provider): AnyModel[] {
  return (provider.getAllModels?.() ?? []).filter(model => !isChat(model))
}
