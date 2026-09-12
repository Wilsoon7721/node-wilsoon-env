# @wilsoon/env

End-to-end encrypted environment variables, synced through a storage provider of your choosing.

Your `.env` files are encrypted on your machine before anything leaves it. The store — an S3 bucket, a directory, whatever you point it at — only ever holds ciphertext, so the question "is this provider trustworthy enough for my secrets?" stops mattering.

```bash
npx @wilsoon/env setup     # generate an identity, write the config
npx @wilsoon/env push      # encrypt every .env* file here and store it
npx @wilsoon/env pull      # fetch and decrypt them on another machine
```

> **Status: 0.x.** The storage format is specified in [SPEC.md](SPEC.md) and guarded by frozen test vectors, but nothing here has been through an external security review. Read [Security](#security) before trusting it with anything that matters.

---

## Why

Every tool in this category needs exactly one bootstrap secret — something you must already have before you can get everything else. `@wilsoon/env` trades **N secrets for 1**: one passphrase, typed once per machine, in exchange for every `.env` file across every project you own.

What it gives you over copying `.env` around by hand:

- The store can't read your secrets, so a breached bucket or a leaked database backup is worth nothing.
- Version history, so a bad push is recoverable and a stale one is detectable.
- Per-file access scoping, so a CI runner that builds production can't decrypt `.env.local`.
- `run --`, which puts secrets in a process's environment and never on disk at all.

## Install

For a one-off, or to try it:

```bash
npx @wilsoon/env setup
```

For daily use, pin it. `npx` resolves the latest published version on every run, which for a package that handles secrets is a live supply-chain surface:

```bash
npm install --save-dev @wilsoon/env
```

```jsonc
// package.json
"scripts": {
  "env:pull": "wilsoon-env pull",
  "dev": "wilsoon-env run -- next dev"
}
```

Requires Node 22.12 or newer.

## Getting started

```bash
npx @wilsoon/env setup
```

This asks where your secrets should live, and only the questions that store actually needs:

```
  Where should encrypted secrets be stored?

  ❯ 1  This machine only    no account, good for trying it out
    2  Supabase             Postgres, row level security
    3  S3-compatible        AWS, Cloudflare R2, MinIO, Backblaze
    4  Cloudflare KV        eventually consistent - read the caveat first
    5  AWS Secrets Manager  what production already reads
    6  MongoDB              needs the mongodb driver installed
```

Arrow keys move, Enter picks, or press the number. It never asks for a credential: the config it writes is meant to be committed, so anything secret is named as an environment variable for you to set instead. Before it generates a key it checks the store actually answers, so a wrong table or a missing credential costs you nothing.

At the end it offers to remember the store. Every project after that is one question:

```bash
npx @wilsoon/env setup --store personal
```

Saved stores live beside your credentials, not in any repository. Pass `--provider` (or any store flag) to skip the questions entirely, which is what CI does — with no terminal attached it never prompts at all.

Either way you end up with an X25519 identity keypair whose private half is encrypted with a passphrase you choose, a `wilsoon-env.config.json`, and `.env*` added to your `.gitignore`.

```bash
npx @wilsoon/env push
```

Every file matching `.env*` is encrypted and stored — except `.env.example` and friends, which are committed and non-secret by convention.

On another machine, in the same repo:

```bash
npx @wilsoon/env pull
```

You'll be asked for your passphrase. Machine one is not involved: the identity key is stored encrypted alongside your secrets, so it travels with them.

## Commands

| Command                              | What it does                                                              |
| ------------------------------------ | ------------------------------------------------------------------------- |
| `setup`                              | Create a project, generate an identity key, write the config              |
| `join`                               | Add your key to a project someone else set up                             |
| `push [files...]`                    | Encrypt and store; adding a recipient takes effect here                   |
| `pull [files...]`                    | Fetch, decrypt, and write — with a diff before overwriting                |
| `status`                             | Compare local against stored. Never decrypts, never asks for a passphrase |
| `run -- <cmd>`                       | Decrypt into a child process's environment, never onto disk               |
| `keys list\|add\|new\|audit\|remove` | Manage recipients                                                         |
| `rm <files...>`                      | Delete a file from the store (local copies untouched)                     |
| `login` / `whoami`                   | Sign in (Supabase Auth, or an OIDC issuer)                                |
| `logout`                             | Forget cached keys and tokens on this machine                             |

Useful flags: `--force` and `--yes` to skip confirmations, `--provider` and the store flags below, `--file a,b` to choose files for `run`, `--as <name>` to pick an identity, `--no-cache` to bypass the keychain, `--device` / `--browser` to pick a sign-in flow, `--cwd` to work outside the current directory.

## Remembering your passphrase

After the first successful unlock on a machine, the identity key is cached in the OS keychain, so day-to-day `pull` and `run` ask for nothing. The cache expires after 14 days, and `logout` clears it — which only forces a passphrase next time, it never makes anything unreadable.

| Platform | Backend                             | Status       |
| -------- | ----------------------------------- | ------------ |
| Windows  | DPAPI, ciphertext under `%APPDATA%` | tested       |
| macOS    | login keychain via `security`       | **untested** |
| Linux    | libsecret via `secret-tool`         | **untested** |

Only the Windows path has been exercised on real hardware. The other two are written against their documented interfaces; if a backend is missing or errors, caching is skipped and you are asked for your passphrase — the behaviour with no keychain at all. Set `WILSOON_ENV_NO_KEYCHAIN=1` to turn it off entirely.

On macOS, `security` takes the secret as a command-line argument, so it is briefly visible in the process list. That's a limitation of the tool, not a choice.

A cached key is the real key. It's protected at rest by the OS (DPAPI binds it to your Windows account; the macOS and Linux backends delegate to the platform keychain), but anything running as you can ask for it — the same as an SSH agent. Use `--no-cache`, or `WILSOON_ENV_NO_KEYCHAIN=1`, on a machine where that isn't an acceptable trade.

## Providers

The store only ever sees opaque blobs, so choosing one is an operational decision, not a security one.

```jsonc
// wilsoon-env.config.json — committed, contains no secrets
{
  "project": "my-app",
  "provider": "s3",
  "options": {
    "bucket": "my-secrets",
    "endpoint": "https://<account>.r2.cloudflarestorage.com",
    "region": "auto"
  },
  "recipients": [{ "name": "me", "keyid": "…", "pubkey": "wenv1…" }]
}
```

**`local`** — plain files under `.wilsoon-store/`. Zero infrastructure; commit it or sync it however you like.

**`s3`** — any S3-compatible endpoint: AWS, Cloudflare R2, MinIO, Backblaze B2, Wasabi, Garage. Signed with SigV4 using Node's own crypto, so it adds no dependencies. Credentials come from the conventions you already use — `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, or a profile in `~/.aws/credentials` (`AWS_PROFILE`, or `--profile`). Nothing new to manage.

Concurrent pushes are handled with conditional writes (`If-Match` on the object's ETag), so a second push against a version you haven't seen fails loudly instead of silently discarding someone's work. Verified against Cloudflare R2: two clients, one reads and holds its ETag, the other writes underneath it, and R2 refuses the first client's stale write.

**`aws`** — AWS Secrets Manager, signed with the same SigV4, so it needs no SDK either. Useful when an organisation requires secrets to live there. Two caveats worth knowing before choosing it: values are capped at **64KB**, and secrets are billed per secret per month, so several environments cost meaningfully more than a bucket. Your ciphertext also ends up encrypted again by KMS — harmless, but it buys nothing, since the payload is sealed before it leaves your machine.

**`kv`** — Cloudflare Workers KV, over the REST API. Needs `CLOUDFLARE_API_TOKEN` plus an account and namespace id.

> **KV is eventually consistent.** A write is visible immediately in the region that made it and takes up to about a minute elsewhere. So `push` on your laptop followed by `pull` on a CI runner can legitimately return the _previous_ secrets, with nothing to indicate anything is wrong. For this workload **R2 (via `s3`) is the better Cloudflare answer**. This adapter exists because people ask for it.

**`supabase`** — a Postgres row per file, over PostgREST. No SDK either. Like `s3`, it has a **genuine atomic compare-and-swap** — here because `update … where version = $prev` either matches a row or does not; there is no read-then-write window at all.

```sql
create table wilsoon_env (
  project    text   not null,
  kind       text   not null,
  name       text   not null,
  version    bigint not null default 0,
  blob       text   not null,          -- base64 ciphertext
  owner      uuid            default auth.uid(),
  updated_at timestamptz not null default now(),
  primary key (project, kind, name)
);

create index wilsoon_env_project_idx on wilsoon_env (project);

alter table wilsoon_env enable row level security;
```

`owner` records who last wrote a row, and is deliberately **outside the primary key**: the adapter addresses rows by `(project, kind, name)`, which is what lets a team share them. With row level security on and no policy yet, only a service key reaches the table — the next section removes that requirement.

If the table lives outside `public`, set `"schema"` in options **and** add it under **Settings → Data API → Exposed schemas**. PostgREST serves one schema per request via `Accept-Profile`/`Content-Profile` and refuses any schema not on that list:

```
PGRST106  Only the following schemas are exposed: …
```

The adapter reports that one specifically, because the fix is a dashboard checkbox rather than anything in your config.

### Reaching it without a privileged key

A Supabase **service key bypasses row level security across the entire project** — not just this schema. If your project also holds other applications, handing that key to a CLI hands over all of them. That surprises people, so it is worth saying plainly.

The way to avoid it is to sign in as a person:

```jsonc
{
  "provider": "supabase",
  "auth": { "type": "supabase" },
  "options": { "url": "https://xyz.supabase.co", "anonKey": "${SUPABASE_ANON_KEY}" }
}
```

```bash
npx @wilsoon/env login              # email and password
npx @wilsoon/env login --otp        # or a code emailed to you
```

The anon key is public by design; your **user token** is what PostgREST authenticates, so `auth.uid()` resolves and your policies apply. Nothing privileged is stored on the machine.

Grant the signed-in role and add a policy:

```sql
grant usage on schema public to authenticated;
grant select, insert, update, delete on wilsoon_env to authenticated;

create policy "signed in members" on wilsoon_env
  for all to authenticated using (true) with check (true);
```

That policy looks permissive, and deliberately so — see [what RLS is actually for](#what-row-level-security-buys-you-here) below.

`serviceKey` remains the right answer for a machine with no user, and for CI. Just prefer a Supabase project dedicated to the store, so the key's reach ends at data that is already encrypted.

### What row level security buys you here

**RLS is not what keeps your secrets secret. The recipient list is.**

Every value is sealed before it leaves your machine, so someone removed from `recipients` cannot read a later push _even holding the whole table_. Equally, RLS alone would protect nothing if the encryption were absent.

So policies here buy two narrower things, both worth having:

- **Integrity** — nobody can vandalise or delete your blobs.
- **Metadata privacy** — project names, file names, sizes and push times stay hidden.

That is why "any signed-in user may read and write every row" is a reasonable policy for a team: sharing rows is the point, since Alice pushes `.env.production` and Bob pulls that same row. Owner-scoped policies would break exactly the thing you wanted.

For **unrelated tenants** sharing one Supabase project the answer is different — that needs `owner` in the primary key and in every filter. The config reserves `"scope": "user"` for it; only `"shared"` is implemented today.

**Two identity providers, two levels of setup.** `"auth": { "type": "supabase" }` needs nothing configured — Supabase issued the token, so it already trusts it. `"auth": { "type": "oidc" }` pointing at your own issuer is a _foreign_ JWT, so `auth.uid()` resolves only once Supabase is configured to trust that issuer. Prefer the first unless you specifically want your own identity provider in the loop.

**`mongodb`** — a document per file. The only adapter with a dependency, kept as an optional peer so it never weighs down an `npx` run:

```bash
npm i mongodb
```

Its compare-and-swap is atomic too — `updateOne` with the expected version in the filter either matches a document or doesn't, decided by the server — and a unique index on `(project, kind, name)` makes a first write safe against two machines both seeing "nothing stored".

Verified against a real MongoDB Atlas cluster: full `setup`/`push`/`pull`, a stale write refused by the server, and a duplicate first write refused by the unique index. Blobs land as BSON `Binary`, and no plaintext reaches the database.

## Signing in

Some stores can authenticate you against an OIDC issuer instead of a long-lived key. Only Supabase uses this today: it is the one provider whose store has a notion of _people_, because row level security evaluates `auth.uid()` per request. Everything else takes a machine credential and has nothing to sign in to.

`setup` writes the block for you:

```bash
npx @wilsoon/env setup --provider supabase \
  --url https://xyz.supabase.co --anon-key "$SUPABASE_ANON_KEY" \
  --table blobs --schema my_schema \
  --auth oidc --issuer https://id.example.com --client-id my-client
```

which produces:

```jsonc
{
  "provider": "supabase",
  "auth": { "type": "oidc", "issuer": "https://id.example.com", "clientId": "my-client" },
  "options": { "url": "https://xyz.supabase.co", "anonKey": "...", "table": "blobs", "schema": "my_schema" }
}
```

A store behind a login is a chicken and egg: `setup` cannot write to it until you are signed in, and `login` reads the issuer out of the config `setup` has not written yet. Break it by naming the issuer on the command line - no config needed:

```bash
npx @wilsoon/env login --issuer https://id.example.com --client-id my-client
```

Credentials are filed per issuer for the whole machine, not per project, so you do this once and every later project on that issuer is already signed in.

```bash
npx @wilsoon/env login     # opens a browser, PKCE, no client secret
npx @wilsoon/env whoami    # who you are, and whether the token still works
npx @wilsoon/env logout    # forgets the token and any cached keys
```

The CLI talks to the issuer **directly** — there is no service in between — and registers as a **public client with no secret**, because a secret inside a published npm package is not a secret. Endpoints come from `/.well-known/openid-configuration`, or you name them explicitly with `authorizationEndpoint` / `tokenEndpoint` / `deviceEndpoint`.

For an external OIDC issuer there are two ways in, and the right one is chosen for you:

**Device grant ([RFC 8628](https://www.rfc-editor.org/rfc/rfc8628)) — preferred.** Used whenever the issuer advertises `device_authorization_endpoint`. You get a short code and a URL:

```
  Open this page and enter the code:

      https://id.example.com/device
      WDJB-MJHT
```

No redirect, no listener, and the browser can be on a **different machine entirely** — which is what makes it the flow that works over SSH, in a container, and on a headless box. Nothing needs registering beyond a client id.

**Redirect with PKCE — the fallback.** Binds a loopback listener on an ephemeral port and uses that as the redirect URI. Slightly nicer on a desktop, but it requires the issuer to permit a loopback redirect on _any_ port, as [RFC 8252 §7.3](https://www.rfc-editor.org/rfc/rfc8252#section-7.3) asks. Force it with `--browser`, or force the device grant with `--device`.

Both use PKCE. The device grant obeys the server on every deadline: `slow_down` adopts the interval the server returns, and a local timer is never treated as authoritative — the client keeps polling until the server itself says approved, refused or expired.

**The token reaches the store. It never unlocks a secret.** Signing in gets you ciphertext; your passphrase is still what decrypts it. That separation is deliberate — it means a compromised identity provider cannot read your secrets.

### Losing a concurrent push

`s3` and `supabase` reject a stale write atomically — `If-Match` on an ETag, and a version predicate in the `update`. `kv` and `aws` cannot: neither API offers a conditional write, so those adapters read, compare and then write, which narrows the race without closing it. `push` says so explicitly when you are on one of them, rather than letting you assume a guarantee you don't have.

`local` is also read-compare-write, but its store is a directory on one machine, so a race needs two processes on that box rather than two people on two laptops. It does not warn for that reason.

Config is read from `package.json` under a `"wilsoon-env"` key if present, then `wilsoon-env.config.json`, then `env.config.json`, walking up from the current directory. `${VAR}` in any string is substituted from the environment, and an unset variable is an error rather than an empty string.

Every field is described by a JSON Schema shipped in the package, so a local install gives you autocomplete and inline documentation in any editor that understands `$schema`. `setup` points at the installed copy when there is one and falls back to the published URL otherwise.

## Teams

Recipients live in your **committed config**, which means granting access is a reviewable diff rather than a silent bucket write.

```bash
# Bob, in the repo he just cloned
npx @wilsoon/env join --name bob    # generates his key, adds him to the config

# You, after reviewing his commit
npx @wilsoon/env push               # re-seals, granting access
```

`join` is the verb for "add me to this project". It generates an identity, stores it under its own key id, and appends Bob to `recipients` — leaving the provider, the options and everyone else's keys untouched. Alternatively Bob sends you his public key from `keys list` and you run `keys add --name bob --pubkey wenv1...` yourself.

Either way, **joining grants nothing**. Whatever is already stored was sealed before Bob existed, so he can't read it until someone who can runs `push`. The command says so rather than leaving him to discover it from a failed `pull`.

Adding a recipient to the config grants nothing on its own — the stored files were sealed before it. Access arrives on the next `push`, and `push` tells you when it is about to grant it:

```
! This push grants access to 1 new recipient:
    bob  c41d8ba0…
```

An attacker who fully compromises your bucket still cannot read future pushes, because becoming a recipient means getting a pull request merged.

Each person's identity is stored under their own key id, so several people can share one store without overwriting each other. When a store holds more than one, pick yours with `--as`:

```bash
npx @wilsoon/env pull --as alice
```

`keys audit` reports the Argon2 cost each stored identity was sealed at, which is the one part of a passphrase policy anybody else can verify. Passphrase strength itself is never recorded anywhere, by design, and cannot be checked.

## CI

CI can neither open a browser nor type a passphrase, so give it a key of its own, scoped to the files it needs:

```bash
npx @wilsoon/env keys new --name ci --files .env.production
```

The private key is printed **once** and never stored. Put it in your CI secrets as `WILSOON_ENV_KEY`, run `push` to seal the existing files to it, and CI can then:

```bash
npx @wilsoon/env pull .env.production
npx @wilsoon/env run -- npm start
```

Scoping is enforced by the absence of a key slot in the blob, not by a check the client could skip — a CI key scoped to `.env.production` has no slot in `.env.local` and cannot open it under any circumstances. It's also revocable on its own: drop the recipient, push, done.

Without a TTY the CLI fails in milliseconds with instructions, rather than blocking on a prompt nobody can answer.

## Security

### How it works

```
passphrase                one per person, typed once per machine
  └─ unwraps identity key   X25519, stored encrypted in your store
       └─ unwraps DEK       random, fresh on every push
            └─ decrypts     one .env file
```

- **Argon2id** (64 MiB, t=3) derives a key from your passphrase. Parameters are recorded in each blob, so they can be raised later without stranding old vaults.
- **AES-256-GCM** encrypts each file whole, so key _names_ never leak — the store learns only size and modification time.
- **X25519** wraps the file key once per recipient, which is why adding someone costs 100 bytes rather than re-encrypting anything.
- Project, filename and version are bound into the authenticated data, so a blob can't be replayed as a different file or silently rolled back.

See [SPEC.md](SPEC.md) for byte layouts and the reasoning behind each choice.

### What it protects against

A breached or malicious store, a leaked backup, a curious employee at your cloud provider, and an attacker with bucket write access who wants to grant themselves read access.

### What it does not

- **A compromised machine.** The key is on it, or in its memory.
- **Revocation of what someone already has.** Removing a recipient stops them decrypting _future_ pushes. It does nothing about the plaintext already on their laptop. If someone should lose access to the current values, rotate the secrets themselves.
- **A weak passphrase.** It's the one thing an attacker holding a stolen blob can attack offline, at their own pace. `keys audit` can verify the Argon2 cost each identity was sealed at, but passphrase strength itself is never recorded anywhere and cannot be checked by anyone.
- **Supply chain.** `npx` fetches the latest published version every run. Pin it for anything routine.

### Handling secrets safely

- `WILSOON_ENV_PASSPHRASE` exists for automation. Environment variables are visible to other processes on the same machine and often end up in shell history — prefer the prompt for interactive use.
- `run --` is the strongest option available here: plaintext never reaches the filesystem.
- Keep encryption as a second barrier, not the only one. Restrict read access to your store as though the contents were plaintext.

### Reporting a vulnerability

Please open a security advisory on the repository rather than a public issue.

## Programmatic use

```js
import { generateIdentity, seal, open, encodePublic } from '@wilsoon/env';

const me = generateIdentity();
const blob = seal({ plaintext: 'A=1\n', recipients: [me.publicRaw], project: 'app', name: '.env', version: 1 });
const { plaintext } = open({ blob, privateRaw: me.privateRaw, project: 'app', name: '.env' });
```

The entry point exports the crypto primitives, the provider interface, config loading, and `.env` parsing. Everything else is internal and may change.

## Contributing

```bash
npm install
npm test
```

The test suite covers the crypto against frozen format vectors, SigV4 against AWS's published test vectors, and the CLI end to end against a real store.

`test/format.test.js` holds blobs generated once and never regenerated. **If they fail, do not regenerate them** — a format change needs a new format byte and a reader for the old one, or every existing vault silently breaks.

## Licence

MIT © Wilson Oon
