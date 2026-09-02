export interface Settings {
  databaseUrl: string;
  authPassword: string;
  availableProviders: string[];
  frontendOrigin: string;
  backendUrl: string;
  webSearchApiKey?: string;
  webPush?: WebPushSettings;
}

export interface WebPushSettings {
  publicKey: string;
  privateKey: string;
  subject: string;
}

const PROVIDER_ENV_VARS = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
} satisfies Record<string, string>;

/** Env var a persona's `modelProvider` reads its key from, for error messages
 *  that tell the operator exactly what to set — see job-routes.ts's
 *  "no provider configured" check. */
export function providerEnvVar(provider: string): string | undefined {
  if (!Object.hasOwn(PROVIDER_ENV_VARS, provider)) return undefined;
  // SAFETY: Object.hasOwn just confirmed `provider` is one of
  // PROVIDER_ENV_VARS's own keys.
  return PROVIDER_ENV_VARS[provider as keyof typeof PROVIDER_ENV_VARS];
}

let cached: Settings | undefined;

export function getSettings(): Settings {
  if (cached) return cached;

  const databaseUrl = process.env.DATABASE_URL;
  const authPassword = process.env.AUTH_PASSWORD;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  if (!authPassword) throw new Error("AUTH_PASSWORD is not set");

  const availableProviders = Object.entries(PROVIDER_ENV_VARS)
    .filter(([, envVar]) => Boolean(process.env[envVar]))
    .map(([name]) => name);

  const frontendOrigin = process.env.FRONTEND_ORIGIN || "http://localhost:3000";
  const backendUrl = process.env.BACKEND_URL || "http://localhost:8080";
  const webSearchApiKey = process.env.BRAVE_SEARCH_API_KEY?.trim() || undefined;
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  const subject = process.env.VAPID_SUBJECT?.trim();
  const webPush = publicKey && privateKey && subject ? { publicKey, privateKey, subject } : undefined;

  cached = { databaseUrl, authPassword, availableProviders, frontendOrigin, backendUrl, webSearchApiKey, webPush };
  return cached;
}

export function resetSettingsCache(): void {
  cached = undefined;
}
