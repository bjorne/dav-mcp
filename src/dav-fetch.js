/** Parse without including potentially private URL contents in errors. */
function parseHttpUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('DAV URL is not allowed: expected an absolute HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('DAV URL is not allowed: unsupported protocol or embedded credentials');
  }
  return url;
}

function restrictedFetch(configuredUrl, { exact = false, allowDavDiscovery = false } = {}) {
  const configured = parseHttpUrl(configuredUrl);
  const trustedOrigins = new Set([configured.origin]);
  const exactEndpoint = configured.href;

  const isAllowed = (url) => exact ? url.href === exactEndpoint : trustedOrigins.has(url.origin);

  return async (input, init = {}) => {
    let currentInput = input;
    let current = parseHttpUrl(input instanceof Request ? input.url : input);
    let currentInit = { ...init };
    const redirectMode = init.redirect || (input instanceof Request ? input.redirect : 'follow');

    for (let redirects = 0; ; redirects += 1) {
      if (!isAllowed(current)) {
        throw new Error('DAV URL is not allowed: destination does not match a trusted endpoint');
      }

      const response = await fetch(currentInput, { ...currentInit, redirect: 'manual' });
      if (response.status < 300 || response.status >= 400) return response;

      const location = response.headers.get('location');
      if (!location) return response;

      const next = parseHttpUrl(new URL(location, current));
      const method = (currentInit.method || (currentInput instanceof Request ? currentInput.method : 'GET')).toUpperCase();
      const isWellKnownDiscovery = allowDavDiscovery &&
        redirectMode === 'manual' &&
        method === 'PROPFIND' &&
        current.origin === configured.origin &&
        ['/.well-known/caldav', '/.well-known/carddav'].includes(current.pathname);

      if (isWellKnownDiscovery) {
        if (configured.protocol === 'https:' && next.protocol !== 'https:') {
          await response.body?.cancel();
          throw new Error('DAV URL is not allowed: HTTPS discovery cannot downgrade to HTTP');
        }
        // The configured server is allowed to delegate DAV service discovery.
        // Ordinary redirects and caller-supplied URLs cannot expand this set.
        trustedOrigins.add(next.origin);
      } else if (!isAllowed(next)) {
        await response.body?.cancel();
        throw new Error('DAV URL is not allowed: redirect destination is not trusted');
      }

      if (redirectMode === 'error') {
        await response.body?.cancel();
        throw new Error('DAV redirect is not allowed by the request policy');
      }
      if (redirectMode === 'manual') return response;
      if (redirects >= 19) {
        await response.body?.cancel();
        throw new Error('DAV redirect limit exceeded');
      }

      await response.body?.cancel();
      currentInput = next.href;
      current = next;

      // Match Fetch redirect semantics for requests whose method becomes GET.
      if (response.status === 303 || ([301, 302].includes(response.status) && method === 'POST')) {
        const headers = new Headers(currentInit.headers || (input instanceof Request ? input.headers : undefined));
        headers.delete('content-length');
        headers.delete('content-type');
        currentInit = { ...currentInit, method: 'GET', body: undefined, headers };
      }
    }
  };
}

/** DAV traffic is confined to configured or well-known-discovered origins. */
export function createDavFetch(serverUrl) {
  return restrictedFetch(serverUrl, { allowDavDiscovery: true });
}

/** OAuth secrets may only be sent to the exact configured token endpoint. */
export function createTokenFetch(tokenUrl) {
  return restrictedFetch(tokenUrl, { exact: true });
}
