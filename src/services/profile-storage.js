const crypto = require('crypto');
const { HttpError } = require('../utils');

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp'
};

function settings() {
  const baseUrl = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const apiKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const bucket = process.env.SUPABASE_PROFILE_BUCKET || 'profile-avatars';
  if (!baseUrl || !apiKey) {
    throw new HttpError(503, 'Profile image storage is not configured');
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    throw new HttpError(503, 'Profile image storage is not configured');
  }
  if (!['https:', 'http:'].includes(parsedUrl.protocol) || !/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(bucket)) {
    throw new HttpError(503, 'Profile image storage is not configured');
  }
  return { baseUrl, apiKey, bucket };
}

function objectUrl(baseUrl, bucket, objectPath) {
  const encodedPath = objectPath.split('/').map(encodeURIComponent).join('/');
  return `${baseUrl}/storage/v1/object/${encodeURIComponent(bucket)}/${encodedPath}`;
}

async function storageRequest(url, options) {
  const { apiKey } = settings();
  const authHeaders = apiKey.startsWith('sb_secret_')
    ? { apikey: apiKey }
    : { apikey: apiKey, Authorization: `Bearer ${apiKey}` };
  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers: {
        ...authHeaders,
        ...(options.headers || {})
      }
    });
  } catch {
    throw new HttpError(503, 'Profile image storage is unavailable');
  }
  if (!response.ok) {
    console.error('[profile-storage] Supabase Storage request failed', { status: response.status });
    throw new HttpError(503, 'Profile image storage is unavailable');
  }
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(503, 'Profile image storage returned an invalid response');
  }
}

function matchesImageType(image, contentType) {
  if (!Buffer.isBuffer(image) || image.length > MAX_IMAGE_BYTES) return false;
  if (contentType === 'image/jpeg') return image.length >= 3 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff;
  if (contentType === 'image/png') return image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (contentType === 'image/webp') return image.length >= 12 && image.toString('ascii', 0, 4) === 'RIFF' && image.toString('ascii', 8, 12) === 'WEBP';
  return false;
}

async function upload(userId, contentType, image) {
  if (!EXTENSIONS[contentType] || !matchesImageType(image, contentType)) {
    throw new HttpError(415, 'Upload a valid JPEG, PNG, or WebP image');
  }
  const { baseUrl, bucket } = settings();
  const accountId = String(userId);
  if (!/^[0-9a-f-]{36}$/i.test(accountId)) throw new HttpError(400, 'Invalid account ID');
  const objectPath = `${accountId}/${crypto.randomUUID()}.${EXTENSIONS[contentType]}`;
  await storageRequest(objectUrl(baseUrl, bucket, objectPath), {
    method: 'POST',
    headers: { 'Content-Type': contentType, 'x-upsert': 'false' },
    body: image
  });
  return objectPath;
}

async function createSignedUrl(objectPath) {
  const { baseUrl, bucket } = settings();
  const encodedPath = objectPath.split('/').map(encodeURIComponent).join('/');
  const result = await storageRequest(
    `${baseUrl}/storage/v1/object/sign/${encodeURIComponent(bucket)}/${encodedPath}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: 3600 })
    }
  );
  const signedPath = result.signedURL || result.signedUrl;
  if (typeof signedPath !== 'string' || !signedPath) {
    throw new HttpError(503, 'Profile image storage returned an invalid signed URL');
  }
  if (/^https?:\/\//i.test(signedPath)) return signedPath;
  if (signedPath.startsWith('/storage/v1/')) return baseUrl + signedPath;
  return `${baseUrl}/storage/v1/${signedPath.replace(/^\/+/, '')}`;
}

async function remove(objectPath) {
  const { baseUrl, bucket } = settings();
  const encodedPath = objectPath.split('/').map(encodeURIComponent).join('/');
  await storageRequest(`${baseUrl}/storage/v1/object/${encodeURIComponent(bucket)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: [objectPath] })
  });
}

module.exports = { MAX_IMAGE_BYTES, matchesImageType, upload, createSignedUrl, remove };
