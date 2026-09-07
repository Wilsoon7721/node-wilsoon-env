# Wilsoon Env — storage format

Status: **draft, v1 unreleased.** Anything here may change until `0.1.0` ships.
After that, the `format` byte governs compatibility and old blobs must keep opening.

---

## 1. Model

Two layers, deliberately independent. Neither may influence the other.

```
ACCESS   getting bytes out of a store   provider credentials (static, chain, or OIDC-federated)
CRYPTO   turning bytes into .env files  passphrase -> identity key -> DEK -> plaintext
```

A token never contributes to key derivation. A key never authenticates a request.
If those cross, a breach of the identity provider becomes a breach of every secret.

### Key hierarchy

```
passphrase                 one per user, typed once per machine
  |-- unwraps identity key   random X25519 scalar, stored encrypted in the provider
        |-- unwraps DEK      random, fresh on EVERY push
              |-- decrypts   one .env file
```

Adding a project mints a DEK and wraps it to the identity public key. No new
passphrase, no user interaction. Adding a person later wraps the same DEK to
their public key — no secret is re-encrypted.

---

## 2. Objects in a store

Addressed by `(owner, kind, name)`. On a bucket that is a path; in SQL it is a
primary key; in Mongo it is a compound index. The provider decides, not the format.

| kind       | name              | contents                        |
| ---------- | ----------------- | ------------------------------- |
| `identity` | `<keyid hex>`     | identity blob (§4), one per key |
| `env`      | `.env.production` | payload blob (§5), one per file |

Identity objects are named by the key id (§5) of the key they hold, so two people
sharing one store cannot overwrite each other. A blob still named `default`, from
before that rule, keeps opening: readers list what the store reports rather than
expecting a particular name.

Filenames are stored **verbatim**. `.env.production` and `.env.prod` are different
objects. No normalisation into canonical environment names — that mapping is lossy
and collides.

---

## 3. Header conventions

All integers little-endian. All blobs begin:

```
0   4   magic     "WENV"
4   1   format    1
5   1   kind      1 = identity, 2 = payload
```

A reader that does not recognise `format` must refuse rather than guess.

---

## 4. Identity blob — 88 bytes

```
0    4   magic "WENV"
4    1   format = 1
5    1   kind = 1
6    1   kdf   = 1 (argon2id)
7    1   log2m           16 => 65536 KiB = 64 MiB
8    1   t               3
9    1   p               1
10   2   reserved (zero)
12   16  salt
28   12  nonce
40   32  ciphertext      X25519 private scalar
72   16  tag
```

Total 88 bytes. The KDF parameters cost **7 bytes**; salt, nonce and tag are
required regardless. That is what buys the ability to raise Argon2 costs later
without stranding vaults: read the old parameters, decrypt, re-wrap at the new
ones on next push.

- KDF: Argon2**id**, `m = 64 MiB, t = 3, p = 1`, via `hash-wasm`.
- Parameters are **fixed defaults, never auto-tuned to the local machine.** The
  machine that encrypts is not the machine that decrypts, and Argon2 needs
  identical parameters both ways. A desktop that helpfully picks 1 GiB locks the
  laptop out. Users may override explicitly in config; nothing detects RAM.
- Wrap cipher: AES-256-GCM, key = Argon2id output, AAD = header bytes `0..12`.

---

## 5. Payload blob

```
0    4   magic "WENV"
4    1   format = 1
5    1   kind = 2
6    1   alg = 1 (aes-256-gcm)
7    1   slots            recipient count, >= 1
8    8   version          monotonic, set by the provider on write

-- slots * 100 bytes --
     8   key id           first 8 bytes of SHA-256(recipient public key)
     32  ephemeral pubkey X25519
     12  nonce
     32  wrapped DEK
     16  tag

-- body --
     12  nonce
     16  tag
     ..  ciphertext       the whole .env file
```

### Whole-file, not per-value

One blob, one key, one tag. Key _names_ stay hidden — a store learns nothing but
size and mtime. It also makes partial decryption structurally impossible: there
are no independently encrypted fields to succeed against.

The cost is no per-key diffing. Accepted.

### DEK wrapping

X25519 ephemeral -> HKDF-SHA256 -> AES-256-GCM over the DEK.

### AAD binds context

Both AADs length-prefix their variable-length fields — `uint16le` length, then
UTF-8 bytes — so no pair of `(project, name)` values can concatenate to the same
bytes as another. Concatenating them raw would let `(ab, c)` and `(a, bc)`
authenticate interchangeably.

Body AAD:

```
"WENV" | format | kind=2 | version:u64le | lp(project) | lp(name)
```

Slot AAD, which binds each wrapped DEK to the recipient it was wrapped for:

```
"WENVSLOT" | format | version:u64le | keyid | lp(project) | lp(name)
```

The distinct `"WENVSLOT"` prefix domain-separates the two, so a slot can never be
verified as a body or the reverse.

This is what stops a `.env.local` blob being replayed as `.env.production`, and
what makes rollback detectable — the version is authenticated, so an attacker
serving a genuine older blob cannot relabel it. Clients track the last seen
version and warn loudly on a decrease.

### Fresh DEK on every push

Nonce reuse under a fixed key is the one catastrophic GCM failure: it leaks the
XOR of both plaintexts and exposes the authentication key. Since `push`
re-encrypts the whole file each time, a long-lived DEK would accumulate
encryptions under one key. Minting a fresh DEK per push makes reuse structurally
impossible rather than statistically unlikely, and costs 32 wrapped bytes.

---

## 6. Decryption is all-or-nothing

AES-256-GCM verifies the tag **before** releasing plaintext. A wrong key yields
zero bytes — not garbled bytes, not a partial file. Forging a 128-bit tag is
2^-128.

Implementations MUST NOT stream `update()` output anywhere before `final()`
returns:

```js
const d = createDecipheriv('aes-256-gcm', key, nonce);
d.setAAD(aad);
d.setAuthTag(tag);
const out = Buffer.concat([d.update(ct), d.final()]); // final() throws on failure
```

Writing `update()` output to a file before `final()` is the one way to leak
unauthenticated plaintext. The primitive is sound; the integration is where this
fails in practice.

---

## 7. Access control is still required

Encryption is the second barrier, never the only one. Stores MUST restrict reads
to the owner (RLS, IAM, bucket policy).

- Public ciphertext converts an online, rate-limited, logged attack into an
  unlimited offline one against the passphrase — the weakest link in the chain.
- Payloads stay sealed but metadata does not: project names, file names, sizes,
  and write times are all visible.

---

## 8. CI

CI can neither open a browser nor type a passphrase, so it never touches the
user's identity key. The two layers of §1 stay separate here too:

```
ACCESS   whatever credentials the provider names   AWS_*, SUPABASE_*, CLOUDFLARE_*, ...
CUSTODY  WILSOON_ENV_KEY                           a scoped recipient private key
```

There is deliberately no single `WILSOON_ENV_*` credential for access: each
provider already has a documented, well-known way to be given credentials, and
re-badging them would only add a translation layer to get wrong.

**This was originally specified as an exported DEK, which cannot work.** §5 mints
a fresh DEK on every push, so an exported one would be dead the moment anybody
pushed - CI would break on a schedule nobody could predict. The two rules were
in direct contradiction; the DEK rule is the one worth keeping.

Instead, CI gets **its own recipient identity**, scoped by filename:

```jsonc
// committed config
{ "name": "ci", "pubkey": "wenv1...", "files": [".env.production"] }
```

`push` wraps the DEK only to recipients whose `files` patterns match, so the CI
key gets a slot on `.env.production` and none at all on `.env.local`. Scoping is
therefore enforced by the absence of a slot, not by anything the client chooses
to respect. `WILSOON_ENV_KEY` holds that private key, `wenvsk1...`-encoded.

A recipient with no `files` key matches every file.

Issued via `npx @wilsoon/env keys new --name ci --files .env.production`, which
prints the private half once and never stores it.

This is also strictly better operationally: the CI key is revocable on its own
(drop the recipient, push) without touching anyone else, and it is never the
user's personal key.

Clients MUST NOT start an interactive flow without a TTY. Detect
`process.stdin.isTTY` and `process.env.CI`, and fail in milliseconds with
instructions rather than blocking on a browser that will never open.
