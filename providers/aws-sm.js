import { createHash } from 'node:crypto';

import { PAYLOAD_HEADER_LEN } from '../core/crypto/header.js';
import { assertRef, ConflictError, KIND_ENV } from '../core/provider.js';
import { resolveCredentials } from './lib/aws-credentials.js';
import { sign } from './lib/sigv4.js';

/**
 * AWS Secrets Manager, signed with SigV4
 * Limitations:
 *  - Values are capped at 64KB. A large .env will not fit.
 *  - Secrets are billed per secret per month, so a project with several environments costs meaningfully more than a bucket.
 *
 * A reason to use it is that some organisations require secrets to live in Secrets Manager.
 */

const TARGET = 'secretsmanager';
const MAX_VALUE = 65536;

function versionOf(blob, kind) {
  if (kind !== KIND_ENV) return 0n;

  if (blob.length < PAYLOAD_HEADER_LEN) throw new Error('Stored blob is truncated.');

  return blob.readBigUInt64LE(8);
}

export function create(options = {}, { dir } = {}) {
  const region = options.region ?? process.env.AWS_REGION ?? 'us-east-1';
  const prefix = options.prefix ? String(options.prefix).replace(/^\/+|\/+$/g, '') + '/' : 'wenv/';
  const endpoint = options.endpoint ?? `https://secretsmanager.${region}.amazonaws.com`;

  let credentials = null;

  const nameFor = (ref) => {
    assertRef(ref);
    return `${prefix}${ref.project}/${ref.kind}/${ref.name}`;
  };

  async function call(action, payload) {
    credentials = credentials ?? (await resolveCredentials(options, 'aws'));

    const body = JSON.stringify(payload);
    const url = new URL(endpoint);

    const headers = sign({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `${TARGET}.${action}` },
      body,
      region,
      service: TARGET,
      credentials,
      payloadSha256: createHash('sha256').update(body).digest('hex')
    });

    const response = await fetch(url, { method: 'POST', headers, body });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : {};

    if (response.ok) return parsed;

    const type = String(response.headers.get('x-amzn-errortype') ?? parsed.__type ?? '')
      .split('#')
      .pop()
      .split(':')[0]
      .trim();

    return { __error: type, __message: parsed.message ?? parsed.Message ?? '', __status: response.status };
  }

  function explain(result, what) {
    if (result.__error === 'AccessDeniedException' || result.__status === 403) return new Error(`Access denied ${what}. The credentials need secretsmanager:GetSecretValue, CreateSecret, PutSecretValue, ListSecrets and DeleteSecret.`);

    return new Error(`Secrets Manager refused ${what}: ${result.__error ?? result.__status}${result.__message ? ` - ${result.__message}` : ''}`);
  }

  return {
    name: 'aws',
    atomicCas: false,
    describe: () => `secretsmanager ${region}`,

    async get(ref) {
      const result = await call('GetSecretValue', { SecretId: nameFor(ref) });

      if (result.__error === 'ResourceNotFoundException') return null;
      if (result.__error) throw explain(result, `reading ${ref.name}`);

      const blob = Buffer.from(result.SecretBinary, 'base64');
      return { blob, version: versionOf(blob, ref.kind) };
    },

    async put(ref, blob, { ifVersion } = {}) {
      if (blob.length > MAX_VALUE) throw new Error(`${ref.name} is ${blob.length} bytes, over the ${MAX_VALUE} byte limit Secrets Manager allows.\n\n  Use the s3 provider for files this size.\n`);

      const version = versionOf(blob, ref.kind);

      // Secrets Manager has no conditional put
      if (ifVersion !== undefined) {
        const current = await this.get(ref);
        const actual = current?.version ?? 0n;
        if (actual !== BigInt(ifVersion)) throw new ConflictError(BigInt(ifVersion), actual);
      }

      const SecretId = nameFor(ref);
      const SecretBinary = blob.toString('base64');

      const updated = await call('PutSecretValue', { SecretId, SecretBinary });

      if (updated.__error === 'ResourceNotFoundException') {
        const created = await call('CreateSecret', { Name: SecretId, SecretBinary, Description: 'Sealed by @wilsoon/env' });
        if (created.__error) throw explain(created, `creating ${ref.name}`);
      } else if (updated.__error) throw explain(updated, `writing ${ref.name}`);

      return { version };
    },

    async list(project) {
      const wanted = `${prefix}${project}/`;
      const found = [];
      let token;

      do {
        const result = await call('ListSecrets', { MaxResults: 100, ...(token ? { NextToken: token } : {}), Filters: [{ Key: 'name', Values: [wanted] }] });
        if (result.__error) throw explain(result, `listing ${project}`);

        for (const secret of result.SecretList ?? []) {
          if (!secret.Name?.startsWith(wanted)) continue;

          const rest = secret.Name.slice(wanted.length);
          const slash = rest.indexOf('/');
          if (slash === -1) continue;

          const name = rest.slice(slash + 1);
          if (!name || name.includes('/')) continue;

          found.push({ kind: rest.slice(0, slash), name });
        }

        token = result.NextToken;
      } while (token);

      await Promise.all(
        found.map(async (entry) => {
          const fetched = await this.get({ project, ...entry });
          entry.version = fetched?.version ?? 0n;
        })
      );

      return found.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
    },

    async remove(ref) {
      const result = await call('DeleteSecret', { SecretId: nameFor(ref), ForceDeleteWithoutRecovery: true });

      if (result.__error === 'ResourceNotFoundException') return false;
      if (result.__error) throw explain(result, `deleting ${ref.name}`);

      return true;
    }
  };
}
