/**
 * YESI-WMS Runtime & Build-Time Environment Configuration Validator
 *
 * SECURITY RULE: Never embed fallback Supabase URLs, publishable keys, or default
 * public credentials in client source code. When VITE_SUPABASE_URL or
 * VITE_SUPABASE_ANON_KEY is absent or invalid, the app boots cleanly into isolated
 * Offline-Only Edge Mode instead of connecting to an unintended cloud environment.
 */

export interface RuntimeConfigReport {
  cloudEnabled: boolean;
  supabaseUrl: string | null;
  supabaseAnonKey: string | null;
  tenantCode: string;
  defaultWarehouseCode: string;
  isProduction: boolean;
  warnings: string[];
  errors: string[];
}

const SAFE_CODE_REGEX = /^[A-Z0-9][A-Z0-9_-]{1,31}$/;

function isValidHttpsUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' && Boolean(parsed.hostname) && !parsed.hostname.includes('example');
  } catch {
    return false;
  }
}

function isLikelyServiceRoleKey(key: string): boolean {
  // Block accidental exposure of secret/service_role keys in browser bundles
  if (key.startsWith('sb_secret_')) return true;
  if (key.includes('service_role')) return true;
  // Decode JWT payload if 3-part token to inspect role claim
  const parts = key.split('.');
  if (parts.length === 3) {
    try {
      const json = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (json?.role === 'service_role' || json?.role === 'supabase_admin') {
        return true;
      }
    } catch {
      // Non-JWT opaque key
    }
  }
  return false;
}

export function validateRuntimeConfig(env: Record<string, unknown> = import.meta.env): RuntimeConfigReport {
  const warnings: string[] = [];
  const errors: string[] = [];

  const rawUrl = typeof env.VITE_SUPABASE_URL === 'string' ? env.VITE_SUPABASE_URL.trim() : '';
  const rawKey = typeof env.VITE_SUPABASE_ANON_KEY === 'string' ? env.VITE_SUPABASE_ANON_KEY.trim() : '';
  const rawTenant = typeof env.VITE_WMS_TENANT_CODE === 'string' ? env.VITE_WMS_TENANT_CODE.trim().toUpperCase() : '';
  const rawWh = typeof env.VITE_WMS_DEFAULT_WAREHOUSE === 'string' ? env.VITE_WMS_DEFAULT_WAREHOUSE.trim().toUpperCase() : '';
  const isProduction = Boolean(env.PROD);

  const tenantCode = SAFE_CODE_REGEX.test(rawTenant) ? rawTenant : 'YESI-FZCO';
  const defaultWarehouseCode = SAFE_CODE_REGEX.test(rawWh) ? rawWh : 'DXB-FC1';

  if (rawTenant && !SAFE_CODE_REGEX.test(rawTenant)) {
    warnings.push(`VITE_WMS_TENANT_CODE "${rawTenant}" is malformed; normalized to ${tenantCode}.`);
  }
  if (rawWh && !SAFE_CODE_REGEX.test(rawWh)) {
    warnings.push(`VITE_WMS_DEFAULT_WAREHOUSE "${rawWh}" is malformed; normalized to ${defaultWarehouseCode}.`);
  }

  if (!rawUrl && !rawKey) {
    warnings.push('Cloud sync environment variables are not set. Running in isolated Offline-Edge Mode.');
    return {
      cloudEnabled: false,
      supabaseUrl: null,
      supabaseAnonKey: null,
      tenantCode,
      defaultWarehouseCode,
      isProduction,
      warnings,
      errors,
    };
  }

  if (!rawUrl || !rawKey) {
    errors.push('Incomplete Supabase configuration: both VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set.');
  }

  if (rawUrl && !isValidHttpsUrl(rawUrl)) {
    errors.push('VITE_SUPABASE_URL must be a valid HTTPS endpoint.');
  }

  if (rawKey && rawKey.length < 20) {
    errors.push('VITE_SUPABASE_ANON_KEY is too short to be a valid Supabase publishable/anon key.');
  }

  if (rawKey && isLikelyServiceRoleKey(rawKey)) {
    errors.push('CRITICAL SECURITY VIOLATION: Secret/service_role key detected in browser env! Refusing to initialize cloud client.');
  }

  const cloudEnabled = errors.length === 0 && Boolean(rawUrl && rawKey);

  return {
    cloudEnabled,
    supabaseUrl: cloudEnabled ? rawUrl : null,
    supabaseAnonKey: cloudEnabled ? rawKey : null,
    tenantCode,
    defaultWarehouseCode,
    isProduction,
    warnings,
    errors,
  };
}

export const runtimeConfig: RuntimeConfigReport = validateRuntimeConfig();
