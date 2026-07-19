'use strict';

const { auth: createJwtVerifier } = require('express-oauth2-jwt-bearer');

const LEGACY_TOKEN_PATTERN = /^[a-fA-F0-9]{48}$/;
const MAX_BEARER_TOKEN_LENGTH = 8192;
const MAX_AUDIENCE_LENGTH = 2048;
const MAX_SUBJECT_LENGTH = 255;

class AuthConfigurationError extends Error {
  constructor(message, code = 'AUTH0_CONFIGURATION_ERROR') {
    super(message);
    this.name = 'AuthConfigurationError';
    this.code = code;
    this.status = 503;
  }
}

class Auth0SubjectError extends Error {
  constructor(message = 'The access token has no valid subject') {
    super(message);
    this.name = 'Auth0SubjectError';
    this.code = 'invalid_token';
    this.status = 401;
    this.headers = {
      'WWW-Authenticate': 'Bearer error="invalid_token"',
    };
  }
}

function nonEmptyEnvValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Legacy authentication is deliberately opt-in. Values such as "1" and
 * "yes" do not enable it accidentally.
 */
function isLegacyAuthEnabled(env = process.env) {
  return nonEmptyEnvValue(env.ALLOW_LEGACY_AUTH).toLowerCase() === 'true';
}

/**
 * Read and validate the Auth0 API configuration. This function throws instead
 * of returning a permissive/no-op middleware, so callers cannot accidentally
 * expose protected routes when production variables are missing.
 */
function loadAuth0Config(env = process.env) {
  const rawIssuer = nonEmptyEnvValue(env.AUTH0_ISSUER_BASE_URL);
  const audience = nonEmptyEnvValue(env.AUTH0_AUDIENCE);
  const missing = [];

  if (!rawIssuer) missing.push('AUTH0_ISSUER_BASE_URL');
  if (!audience) missing.push('AUTH0_AUDIENCE');
  if (missing.length) {
    throw new AuthConfigurationError(
      `Auth0 is not configured: missing ${missing.join(' and ')}`,
      'AUTH0_CONFIGURATION_MISSING',
    );
  }

  let issuer;
  try {
    issuer = new URL(rawIssuer);
  } catch {
    throw new AuthConfigurationError(
      'AUTH0_ISSUER_BASE_URL must be an absolute HTTPS URL',
      'AUTH0_ISSUER_INVALID',
    );
  }

  if (
    issuer.protocol !== 'https:' ||
    issuer.username ||
    issuer.password ||
    issuer.search ||
    issuer.hash
  ) {
    throw new AuthConfigurationError(
      'AUTH0_ISSUER_BASE_URL must be an absolute HTTPS URL without credentials, query, or fragment',
      'AUTH0_ISSUER_INVALID',
    );
  }

  if (audience.length > MAX_AUDIENCE_LENGTH) {
    throw new AuthConfigurationError(
      `AUTH0_AUDIENCE must be at most ${MAX_AUDIENCE_LENGTH} characters`,
      'AUTH0_AUDIENCE_INVALID',
    );
  }

  // Auth0 publishes its issuer with a trailing slash; normalize once so
  // discovery and the token's exact `iss` comparison use the same value.
  issuer.pathname = `${issuer.pathname.replace(/\/+$/, '')}/`;

  return Object.freeze({
    issuerBaseURL: issuer.toString(),
    audience,
    tokenSigningAlg: 'RS256',
  });
}

/**
 * Construct Auth0's official Express verifier with an explicitly pinned
 * asymmetric signing algorithm. Construction has no network side effects;
 * OIDC/JWKS discovery happens only when a JWT is verified.
 */
function createAuth0JwtMiddleware({ env = process.env, config } = {}) {
  if (config && config.tokenSigningAlg !== 'RS256') {
    throw new AuthConfigurationError(
      'Auth0 JWT verification requires issuerBaseURL, audience, and RS256',
      'AUTH0_CONFIGURATION_INVALID',
    );
  }
  const resolvedConfig = config
    ? loadAuth0Config({
        AUTH0_ISSUER_BASE_URL: config.issuerBaseURL,
        AUTH0_AUDIENCE: config.audience,
      })
    : loadAuth0Config(env);

  return createJwtVerifier({
    issuerBaseURL: resolvedConfig.issuerBaseURL,
    audience: resolvedConfig.audience,
    tokenSigningAlg: 'RS256',
  });
}

/**
 * Classifies only the old server's 24-byte random hex tokens as legacy.
 * Anything containing JWT/JWE segment separators remains on the JWT path even
 * when malformed, preventing verification failures from falling back to the
 * legacy database token lookup.
 */
function classifyBearerToken(token) {
  if (typeof token !== 'string' || token.length === 0) return 'missing';
  if (token.includes('.')) {
    return token.length <= MAX_BEARER_TOKEN_LENGTH ? 'jwt' : 'invalid';
  }
  if (token.length > MAX_BEARER_TOKEN_LENGTH) return 'invalid';
  if (LEGACY_TOKEN_PATTERN.test(token)) return 'legacy';
  return 'invalid';
}

function isLegacyTokenAllowed(token, env = process.env) {
  return isLegacyAuthEnabled(env) && classifyBearerToken(token) === 'legacy';
}

/**
 * Strictly extracts one Bearer credential. Comma-joined or whitespace-bearing
 * values are rejected instead of being partially parsed.
 */
function getBearerToken(req) {
  const header = req && req.headers && req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer[\t ]+([^\s,]+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

function extractAuth0Subject(req) {
  const sub = req && req.auth && req.auth.payload && req.auth.payload.sub;
  if (
    typeof sub !== 'string' ||
    !sub ||
    sub.trim() !== sub ||
    sub.length > MAX_SUBJECT_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(sub)
  ) {
    throw new Auth0SubjectError();
  }
  return sub;
}

/**
 * Run after createAuth0JwtMiddleware(). It exposes only the stable `sub`
 * identity, never mutable profile claims such as email or nickname.
 */
function bindAuth0Subject(req, _res, next) {
  try {
    const sub = extractAuth0Subject(req);
    Object.defineProperty(req, 'auth0Sub', {
      value: sub,
      enumerable: true,
      writable: false,
      configurable: false,
    });
    next();
  } catch (error) {
    next(error);
  }
}

module.exports = {
  Auth0SubjectError,
  AuthConfigurationError,
  MAX_BEARER_TOKEN_LENGTH,
  bindAuth0Subject,
  classifyBearerToken,
  createAuth0JwtMiddleware,
  extractAuth0Subject,
  getBearerToken,
  isLegacyAuthEnabled,
  isLegacyTokenAllowed,
  loadAuth0Config,
};
