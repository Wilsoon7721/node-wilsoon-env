import { createHash, createHmac } from 'node:crypto';

const ALGORITHM = 'AWS4-HMAC-SHA256';

export const EMPTY_PAYLOAD_SHA256 = createHash('sha256').update('').digest('hex');

const hash = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

// Using RFC 3986, encodeURIComponent leaves !'()* alone but S3 wants them escaped.
export function uriEncode(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

export function encodePath(pathname) {
  return pathname
    .split('/')
    .map((segment) => uriEncode(segment))
    .join('/');
}

export function amzDate(date) {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

function canonicalQuery(searchParams) {
  const pairs = [];
  for (const [key, value] of searchParams) pairs.push([uriEncode(key), uriEncode(value)]);

  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));

  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

/**
 * Signs a request in place, returning the headers to send.
 *
 * @param {object} args
 * @param {string} args.method
 * @param {URL} args.url
 * @param {Record<string,string>} args.headers must not already contain Authorization
 * @param {Buffer|string} [args.body]
 * @param {string} args.region
 * @param {string} args.service
 * @param {{ accessKeyId: string, secretAccessKey: string, sessionToken?: string }} args.credentials
 * @param {Date} [args.date]
 * @param {string} [args.payloadSha256] pass when the hash is already known
 */
export function sign({ method, url, headers = {}, body, region, service = 's3', credentials, date = new Date(), payloadSha256, contentSha256Header = true }) {
  const stamp = amzDate(date);
  const day = stamp.slice(0, 8);

  const payloadHash = payloadSha256 ?? (body === undefined ? EMPTY_PAYLOAD_SHA256 : hash(body));

  const signed = {
    ...headers,
    host: url.host,
    'x-amz-date': stamp
  };

  // Required by S3
  if (contentSha256Header) signed['x-amz-content-sha256'] = payloadHash;

  if (credentials.sessionToken) signed['x-amz-security-token'] = credentials.sessionToken;

  const names = Object.keys(signed)
    .map((n) => n.toLowerCase())
    .sort();

  const lookup = new Map(Object.entries(signed).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]));

  const canonicalHeaders = names.map((n) => `${n}:${lookup.get(n)}\n`).join('');
  const signedHeaders = names.join(';');

  const canonicalRequest = [method.toUpperCase(), encodePath(url.pathname), canonicalQuery(url.searchParams), canonicalHeaders, signedHeaders, payloadHash].join('\n');

  const scope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = [ALGORITHM, stamp, scope, hash(canonicalRequest)].join('\n');

  const signingKey = ['aws4_request'].reduce((k, part) => hmac(k, part), hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, day), region), service));

  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  return {
    ...signed,
    authorization: `${ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  };
}
