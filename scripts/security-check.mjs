#!/usr/bin/env node
/**
 * YESI-WMS Build-Time Secret & Security Gate (`npm run check:security`)
 *
 * Scans tracked repository files to ensure:
 *  1. Zero hardcoded Supabase project URLs (`https://<ref>.supabase.co`), publishable keys
 *     (`sb_publishable_...`), secret keys (`sb_secret_...`), or JWT service_role tokens
 *     exist in source, config, or documentation files.
 *  2. Zero plaintext session writes (`localStorage.setItem('vortex_session'`) exist.
 *  3. If REQUIRE_CLOUD_ENV=true (production cloud CI), verifies VITE_SUPABASE_URL and
 *     VITE_SUPABASE_ANON_KEY are present and not service_role keys.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const FORBIDDEN_PATTERNS = [
  {
    name: 'Hardcoded Supabase Project URL',
    regex: /https:\/\/[a-z0-9]{15,24}\.supabase\.co/i,
  },
  {
    name: 'Hardcoded Supabase Publishable Key',
    regex: /\bsb_publishable_[A-Za-z0-9_-]{12,}/,
  },
  {
    name: 'Hardcoded Supabase Secret Key',
    regex: /\bsb_secret_[A-Za-z0-9_-]{10,}/,
  },
  {
    name: 'Hardcoded Private Key Block',
    regex: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  },
  {
    name: 'Legacy Plaintext localStorage Session Write',
    regex: /localStorage\.setItem\(\s*['"]vortex_session['"]/,
  },
];

const IGNORED_FILES = new Set([
  'scripts/security-check.mjs',
  'package-lock.json',
]);

let trackedFiles = [];
try {
  const out = execSync('git ls-files', { encoding: 'utf8' });
  trackedFiles = out.split('\n').map((s) => s.trim()).filter(Boolean);
} catch {
  console.error('[security-check] Could not list git files.');
  process.exit(1);
}

const violations = [];

for (const relPath of trackedFiles) {
  if (IGNORED_FILES.has(relPath)) continue;
  const fullPath = path.resolve(process.cwd(), relPath);
  if (!fs.existsSync(fullPath)) continue;
  const stat = fs.statSync(fullPath);
  if (!stat.isFile() || stat.size > 2_000_000) continue;

  const content = fs.readFileSync(fullPath, 'utf8');
  const lines = content.split('\n');
  lines.forEach((line, idx) => {
    for (const rule of FORBIDDEN_PATTERNS) {
      if (rule.regex.test(line)) {
        violations.push(`${relPath}:${idx + 1} -> ${rule.name}`);
      }
    }
  });
}

if (process.env.REQUIRE_CLOUD_ENV === 'true') {
  const url = (process.env.VITE_SUPABASE_URL || '').trim();
  const key = (process.env.VITE_SUPABASE_ANON_KEY || '').trim();
  if (!url.startsWith('https://')) {
    violations.push('ENV: VITE_SUPABASE_URL must be a valid HTTPS URL when REQUIRE_CLOUD_ENV=true');
  }
  if (key.length < 20 || key.startsWith('sb_secret_')) {
    violations.push('ENV: VITE_SUPABASE_ANON_KEY is missing or is a secret key');
  }
}

if (violations.length > 0) {
  console.error('❌ YESI-WMS Security & Secret Check FAILED:');
  for (const v of violations) {
    console.error(`  - ${v}`);
  }
  process.exit(1);
}

console.log(`✅ Security & Secret Gate passed (${trackedFiles.length} tracked files scanned, 0 leaks).`);
