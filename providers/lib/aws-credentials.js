import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Not yet covered: SSO caches and IMDS

function parseIni(text) {
  const sections = {};
  let current = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;

    const header = line.match(/^\[(.+)\]$/);
    if (header) {
      current = header[1].trim().replace(/^profile\s+/, '');
      sections[current] = {};
      continue;
    }

    const eq = line.indexOf('=');
    if (eq === -1 || !current) continue;

    sections[current][line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }

  return sections;
}

async function fromFile(profile) {
  const file = process.env.AWS_SHARED_CREDENTIALS_FILE || path.join(os.homedir(), '.aws', 'credentials');

  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return null;
  }

  const section = parseIni(text)[profile];
  if (!section?.aws_access_key_id || !section?.aws_secret_access_key) return null;

  return {
    accessKeyId: section.aws_access_key_id,
    secretAccessKey: section.aws_secret_access_key,
    sessionToken: section.aws_session_token,
    source: `${file} [${profile}]`
  };
}

/**
 * Explicit config, then environment, then the shared credentials file.
 *
 * @returns {Promise<{accessKeyId, secretAccessKey, sessionToken?, source}>}
 */
export async function resolveCredentials(options = {}, provider = 's3') {
  if (options.accessKeyId && options.secretAccessKey) return { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey, sessionToken: options.sessionToken, source: 'config' };

  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY)
    return {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.AWS_SESSION_TOKEN,
      source: 'environment'
    };

  const profile = options.profile || process.env.AWS_PROFILE || 'default';
  const fromShared = await fromFile(profile);
  if (fromShared) return fromShared;

  throw new Error(
    [
      `No credentials found for the ${provider} provider.`,
      '',
      '  Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or add a profile to',
      `  ~/.aws/credentials (looked for "${profile}").`,
      '',
      '  For Cloudflare R2, create an R2 API token and use it as those two variables.',
      ''
    ].join('\n')
  );
}
