/**
 * Decide whether an LLM / embedding provider error should trigger a fallback to
 * a different provider. We fall back on anything that looks like "this provider
 * is out of budget / over its limit right now" so the service keeps responding
 * with degraded-but-working models. We do NOT fall back on client bugs
 * (bad-request, context-length, invalid-model) because the fallback would hit
 * the exact same bug.
 */
export function isRetriableQuotaError(err: unknown): boolean {
  if (!err) return false;
  const e = err as any;

  // OpenAI-SDK / fetch-like status codes
  const status: number | undefined = e.status ?? e.statusCode ?? e.response?.status;
  if (status === 402 || status === 429) return true;
  if (status === 401 || status === 403) return true; // bad / missing key → try next provider
  // 404: model retired / unknown (e.g. OpenRouter's `gemini-2.0-flash-exp:free`
  // was removed without notice). 5xx: upstream on fire. In both cases the
  // correct behaviour is "try the next provider", not "fail the user".
  if (status === 404) return true;
  if (status && status >= 500 && status <= 599) return true;

  const msg = (
    (typeof e.message === 'string' ? e.message : '') +
    ' ' +
    (typeof e.error?.message === 'string' ? e.error.message : '') +
    ' ' +
    (typeof e.response?.data === 'string' ? e.response.data : JSON.stringify(e.response?.data || ''))
  ).toLowerCase();

  const markers = [
    'quota',
    'insufficient',
    'rate limit',
    'rate_limit',
    'ratelimit',
    'resource_exhausted',
    'resource exhausted',
    'too many requests',
    'credits',
    'credit balance',
    'no endpoints found',
    ' 402',
    ' 429',
    ' 404',
    ' 502',
    ' 503',
  ];
  return markers.some((m) => msg.includes(m));
}
