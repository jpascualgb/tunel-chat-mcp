# ADR-003: Bounded folder trees and ChatGPT file inputs

## Status

Accepted

## Date

2026-09-19

## Context

The original MCP surface operated on individual files. Users also need to create,
copy, move, rename and recoverably delete folders, and to save images supplied by
ChatGPT. Recursive filesystem operations increase the impact of traversal, link,
race and denial-of-service flaws. Download URLs supplied by a remote caller also
create an SSRF boundary.

## Decision

- Reuse the existing read, create, modify and delete permissions. Folder creation
  uses create; copying uses read plus create; moving uses modify plus create; and
  folder deletion uses delete.
- Keep local per-operation approval available. Bind each recursive approval to a
  deterministic SHA-256 manifest of relative names, types, sizes and file hashes.
- Reject symbolic links, junctions, hard-linked files and non-regular entries at
  every depth. Limit each operation to 10,000 entries and 512 MiB.
- Copy only to a new destination, verify the copied manifest and remove a partial
  destination on failure. Verify moves after the atomic rename and attempt rollback
  if the result differs.
- Delete folders by moving them to the protected local trash. Verify the moved tree
  before publishing its metadata and roll back on failure.
- Accept ChatGPT files through the official top-level `openai/fileParams` metadata
  contract. Require `download_url` and `file_id`; declare `mime_type` and
  `file_name` as optional fields.
- Treat every download URL as untrusted. Allow HTTPS port 443 only, prohibit URL
  credentials, resolve and validate every redirect, reject any private or reserved
  address, and pin the validated address used by the TLS request.
- Limit images to 20 MiB, accept PNG, JPEG and WebP signatures only, and create a
  new file whose extension matches the detected content. Never log the signed
  download URL.

## Consequences

- Very large folder trees must be divided into smaller operations.
- Folder deletion is recoverable through the local trash but does not create one
  binary backup per contained file.
- Expiring ChatGPT URLs may require the user to attach or select the image again
  when a delayed approval is retried.
- The controls protect the tunnel boundary, but another malicious process running
  as the same operating-system user remains outside this threat model.
