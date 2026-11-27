/**
 * Config loading: server tenant config → merge `options.config` (TenantConfigPatch)
 * → merge `options.theme` (ThemePatch). When the server is unreachable the
 * widget falls back to `defaultConfig()`, so the UI can always render.
 */
import {
  deepMerge,
  defaultConfig,
  resolveTenantConfig,
  resolveTheme,
  type TenantConfig,
  type TenantConfigPatch,
  type ThemePatch,
} from '@agil/protocol';
import { ApiError, type ApiClient } from './api.js';

export interface ConfigLoadOptions {
  tenantId: string;
  theme?: ThemePatch;
  config?: TenantConfigPatch;
}

export interface ConfigLoadResult {
  config: TenantConfig;
  /** false = server did not answer (network/timeout) — demo/offline mode. */
  serverOnline: boolean;
  /** Human-readable reason when the server did not answer. */
  offlineReason?: string;
}

/** Applies local overrides (options.config, then options.theme) to a base config. */
export function applyLocalOverrides(
  base: TenantConfig,
  configPatch?: TenantConfigPatch,
  themePatch?: ThemePatch,
): TenantConfig {
  let config = base;
  if (configPatch) config = resolveTenantConfig(configPatch, config);
  if (themePatch) {
    const mergedTheme = deepMerge(structuredClone(config.theme), themePatch);
    config = {
      ...config,
      theme: resolveTheme(mergedTheme as ThemePatch, base.theme.scheme),
    };
  }
  return config;
}

export async function loadConfig(api: ApiClient, options: ConfigLoadOptions): Promise<ConfigLoadResult> {
  try {
    const serverConfig = await api.getConfig(options.tenantId);
    return { config: applyLocalOverrides(serverConfig, options.config, options.theme), serverOnline: true };
  } catch (error) {
    const offline = !(error instanceof ApiError) || error.code === 'network_error' || error.code === 'timeout';
    if (!offline) {
      // Server is up but returned an error (bad tenant id, validation, 5xx):
      // keep the local default config, report the reason.
      return {
        config: defaultConfig({
          tenantId: options.tenantId,
          themePatch: options.theme,
          overrides: options.config,
        }),
        serverOnline: true,
        offlineReason: error instanceof Error ? error.message : String(error),
      };
    }
    return {
      config: defaultConfig({
        tenantId: options.tenantId,
        themePatch: options.theme,
        overrides: options.config,
      }),
      serverOnline: false,
      offlineReason: error instanceof Error ? error.message : String(error),
    };
  }
}
