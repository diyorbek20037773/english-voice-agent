// OPTIONAL Railway Infrastructure-as-Code for the single "web" service.
// Type-checked against the official `railway` SDK (railway/iac, v3.15.0).
// Not applied automatically: the simple path is the dashboard (docs/railway-setup.md).
// To use it: `railway login` → `railway link` → `railway config plan` → `railway config apply`.
// Secrets are never stored here: preserve() keeps the values you set in the dashboard.
import { defineRailway, github, preserve, project, service } from 'railway/iac';

export default defineRailway(() => {
  const web = service('web', {
    source: github('diyorbek20037773/english-voice-agent', { branch: 'main' }),
    build: { builder: 'DOCKERFILE', dockerfilePath: 'Dockerfile' },
    deploy: {
      healthcheckPath: '/healthz',
      healthcheckTimeout: 60,
      // One replica: practice sessions, dedup and rate limits live in memory.
      numReplicas: 1,
      // Never sleep: a cold start would add seconds to the first answer.
      sleepApplication: false,
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 5,
      // EU West (Amsterdam): a reasonable first choice for Tashkent; measure before moving.
      region: 'europe-west4-drams3a',
    },
    env: {
      NODE_ENV: 'production',
      HOST: '::',
      PORT: '3000',
      TRUST_PROXY_HOPS: '1',
      ALLOWED_ORIGIN: 'https://${{RAILWAY_PUBLIC_DOMAIN}}',
      OPENAI_TRANSCRIPTION_MODEL: 'gpt-live-transcribe',
      OPENAI_ANSWER_MODEL: 'gpt-6-luna',
      OPENAI_QUICK_REASONING: 'none',
      OPENAI_DETAILED_REASONING: 'low',
      ANSWER_DAILY_LIMIT: '200',
      OPENAI_API_KEY: preserve(),
      APP_ACCESS_TOKEN: preserve(),
    },
  });
  return project('english-voice-agent', { resources: [web] });
});
