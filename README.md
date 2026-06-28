# Registry Stack identifiers

This repository prepares the static site for `https://id.registrystack.org/`.
It hosts stable machine identifiers owned by Registry Stack: problem type URIs,
JSON-LD namespaces, JSON Schemas, and JSON-LD contexts.

Deployment is configured for Cloudflare Workers Static Assets with:

- Worker name: `registrystack-id`
- Build command: `npm run build`
- Asset directory: `public`
- Route: `id.registrystack.org/*`

## Identifier policy

Published identifiers are stable contracts.

- Do not repurpose an identifier after publication.
- Do not delete a published identifier without marking it deprecated and
  linking to a replacement when one exists.
- Use lowercase product scopes in paths: `registry-relay`, `registry-notary`,
  `registry-platform`, and `registry-manifest`.
- Use `code` for programmatic branching in client code. Problem `type` URLs are
  identifiers and documentation pointers, not a parsing interface.
- Keep generated static files in sync with `src/catalogs/`.

## Content quality rules

This site is an identifier resolver, not a replacement for the product docs.
Generated pages may summarize existing public facts and link to documentation,
but they must not introduce new runtime guarantees unless those guarantees are
backed by source code, tests, schemas, or published product documentation.

Problem pages separate:

- Defined facts: canonical URI, product, code, category when known, and source.
- Documentation links: public Registry Stack docs that remain authoritative for
  operational behavior.
- Guidance: explicitly marked as `not_published` unless it has been curated.

Problem records deliberately leave `http_statuses`, `retryable`,
`caller_action`, and `operator_action` as `null` when the resolver has no
curated value. Clients should use the RFC 9457 response body, especially
`code`, `status`, and `detail`, for request-specific behavior.

## Local definition of done

For the first publishable version, the local checkout is done when:

- Every generated identifier page states the authority boundary.
- Problem JSON records include `guidance.status`, `documented_by`, `authority`,
  `identifier_policy`, and `source_reference`.
- Generated pages link to public documentation on `docs.registrystack.org`
  where an appropriate page exists.
- Unknown guidance remains explicit instead of inferred.
- Generated Cloudflare header rules stay compact and readable.
- `public/` is regenerated from `src/` and `npm test` passes.
- Cloudflare project creation, DNS changes, deployment, push, or PR are not
  required for the local preparation step.

## Local workflow

Generate problem entries from a local `registry-stack` checkout:

```sh
REGISTRY_STACK_DIR=../registry-stack npm run import:problems
```

Build the static site:

```sh
npm run build
```

Check that `public/` matches the catalogs and copied schema/context artifacts:

```sh
npm test
```

## Cloudflare Workers preparation

The repository includes `wrangler.jsonc` so Wrangler deploys `public/` as
Workers static assets on the `registrystack-id` service. The compatibility date
is pinned because Wrangler does not store the dashboard's `Latest`
compatibility-date setting in source control.

The generated `public/_headers` file sets content types, CORS for machine
artifacts, and conservative cache headers.
The generated `public/_redirects` file reserves compatibility routes that can
be expanded later without changing the identifier policy.

### Cloudflare setup

The Cloudflare account is configured with:

- Worker name: `registrystack-id`
- Static assets source: `public/`
- Worker preview URL: `https://registrystack-id.jeremi-ccf.workers.dev/`
- DNS record: proxied `AAAA id -> 100::`
- Worker route: `id.registrystack.org/*` in the `registrystack.org` zone

Deploy locally with:

```sh
npm run build
npx wrangler deploy
```

### GitHub Actions deployment

The `.github/workflows/deploy-cloudflare-workers.yml` workflow deploys `public/`
to Cloudflare Workers on pushes to `main` and on manual dispatch. Configure
these repository secrets before enabling it:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN` with Workers Scripts Edit and DNS Edit permissions for
  the `registrystack.org` zone

The initial deployment, DNS record, and Worker route were created manually from
the Cloudflare dashboard.
