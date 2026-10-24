// -----------------------------------------------------------------------------
// The only place that talks HTTP: `fetch` with a timeout (the body read
// included), a User-Agent that names the integration, no redirection
// followed and a bounded body. The tests replace it with `setFetch()`.
//
// The API key travels in the body of the request (the XML query of the
// Trafikverket API): an error message only ever carries the host of the URL,
// never the body nor the answer.
// -----------------------------------------------------------------------------

import { HTTP_TIMEOUT, MAX_BODY, USER_AGENT } from './constants.js';

let fetchImpl = (...args) => globalThis.fetch(...args);

/** Replace the fetch implementation (tests only). Returns the previous one. */
export function setFetch(impl) {
  const previous = fetchImpl;
  fetchImpl = impl;
  return previous;
}

/** Retry-After: seconds, or an HTTP date. */
export function retryAfterMs(header, now = Date.now()) {
  if (typeof header !== 'string' || header.trim() === '') {
    return undefined;
  }
  if (/^\s*\d{1,9}\s*$/.test(header)) {
    return Number(header) * 1000;
  }
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

/** The `Date` header of the answer (the clock of the service), or null. */
export function serviceDate(header) {
  if (typeof header !== 'string' || header.length > 64) {
    return null;
  }
  const date = Date.parse(header);
  return Number.isFinite(date) ? date : null;
}

/** The network failed (DNS, timeout, a body too large...): the host only. */
export class NetworkError extends Error {
  constructor(url, reason) {
    super(`network ${reason} on ${new URL(url).host}`);
    this.name = 'NetworkError';
    this.reason = reason;
  }
}

const reasonOf = (err) =>
  err?.name === 'TimeoutError' || err?.name === 'AbortError'
    ? 'timeout'
    : String(err?.cause?.code ?? 'failed')
        .replace(/[^A-Za-z0-9_-]/g, '')
        .slice(0, 40);

/**
 * Read at most `maxBytes` of the body; past it, the read stops and fails.
 * The chunks are kept as they come (no copy per chunk) and joined once.
 */
async function readBounded(response, url, maxBytes) {
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) {
      throw new NetworkError(url, 'answer too large');
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new NetworkError(url, 'answer too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

/**
 * POST an XML query, read a text answer. Never throws on an HTTP status:
 * resolves `{ status, text, retryAfterMs, date }`. Throws a NetworkError when
 * the request or the body read fails. A redirection fails the call.
 */
export async function postXml(url, xml, { timeout = HTTP_TIMEOUT, maxBytes = MAX_BODY } = {}) {
  let response;
  let text;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'text/xml; charset=utf-8',
        Accept: 'application/json',
      },
      body: xml,
      redirect: 'error',
      signal: AbortSignal.timeout(Math.max(1, timeout)),
    });
    text = await readBounded(response, url, maxBytes);
  } catch (err) {
    throw err instanceof NetworkError ? err : new NetworkError(url, reasonOf(err));
  }
  return {
    status: response.status,
    text,
    retryAfterMs: retryAfterMs(response.headers?.get?.('retry-after') ?? undefined),
    date: serviceDate(response.headers?.get?.('date') ?? undefined),
  };
}
