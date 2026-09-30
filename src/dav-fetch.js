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

function restrictedFetch(configuredUrl, exact) {
  const allowed = parseHttpUrl(configuredUrl);
  // Capture the trusted configuration, not a caller-controlled client property.
  const allowedDestination = exact ? allowed.href : allowed.origin;

  return async (input, init = {}) => {
    const target = parseHttpUrl(input instanceof Request ? input.url : input);
    if ((exact ? target.href : target.origin) !== allowedDestination) {
      throw new Error('DAV URL is not allowed: destination does not match configured endpoint');
    }

    // Force manual handling even if the caller or dependency requests follow.
    // Reject all redirects; never forward credentials or bodies to Location.
    const response = await fetch(input, { ...init, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error('DAV redirects are not allowed; configure the final endpoint URL');
    }
    return response;
  };
}

/** All DAV traffic, including discovery, is confined to this origin. */
export function createDavFetch(serverUrl) {
  return restrictedFetch(serverUrl, false);
}

/** OAuth secrets may only be sent to the exact configured token endpoint. */
export function createTokenFetch(tokenUrl) {
  return restrictedFetch(tokenUrl, true);
}
