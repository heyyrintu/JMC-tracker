'use strict';
/**
 * Resolve the session token for a request without touching the DB.
 * Order: Authorization: Bearer -> ?access_token= (GET only) -> sid cookie.
 * The GET-only query fallback lets <img>/window.open load auth-gated
 * /uploads and *.pdf from the cross-origin WebView, without exposing a
 * token-in-URL path for mutating requests.
 */
function extractToken(req) {
  const authz = (typeof req.get === 'function' ? req.get('authorization') : req.headers?.authorization) || '';
  const m = /^Bearer\s+(\S+)\s*$/.exec(authz);
  if (m && m[1].trim()) return m[1].trim();

  if (req.method === 'GET') {
    const q = req.query && req.query.access_token;
    if (typeof q === 'string' && q.trim()) return q.trim();
  }

  const c = req.cookies && req.cookies.sid;
  if (typeof c === 'string' && c.trim()) return c.trim();

  return null;
}

module.exports = { extractToken };
