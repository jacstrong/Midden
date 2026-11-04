# API reference

<!-- Generated from the server by `pnpm docs:api`. Edit packages/server/src/openapi/spec.ts, not this file. -->

Every endpoint in version 1.0.0 of the Midden API, generated from the same schemas the server validates with. Start with the [API guide](api.md) for authentication and conventions. The machine-readable version is served at `/api/openapi.json`.

## Meta

Health, this document and live updates.

### `GET /api/health`

Server health and versions.

**Access:** No sign-in needed.

**200**

[Health](#health)

### `GET /api/openapi.json`

This API description.

**Access:** No sign-in needed.

**200** (`application/json`): An OpenAPI 3.1 document.

### `GET /api/ws`

Live updates over a WebSocket.

Upgrades to a WebSocket. Send `{"t":"hello","caseId":"...","lastSeq":null}` to join a case, then receive a snapshot and every later operation. The messages are defined by `ClientMessageSchema` and `ServerMessage` in `packages/core/src/sync/protocol.ts`. Read tokens may watch, and any operation they send is rejected.

**Access:** Any API token, or a session.

**101** (`text/plain`): Switches to the WebSocket protocol.

### `POST /api/mcp`

Model Context Protocol endpoint for AI agents.

Speaks JSON-RPC over the stateless form of the Streamable HTTP transport, and takes an API token only, never a session. See the MCP guide.

**Access:** Any API token, or a session.

**200** (`application/json`): A JSON-RPC response.

### `GET /api/mcp`

Not supported; this endpoint has no server-sent stream.

**Access:** Any API token, or a session.

**405** (`application/json`): Always refused.

### `DELETE /api/mcp`

Not supported; this endpoint has no sessions to end.

**Access:** Any API token, or a session.

**405** (`application/json`): Always refused.

## Auth

Signing in. Scripts should use an API token instead.

### `POST /api/auth/login`

Sign in and receive a session cookie.

**Access:** No sign-in needed.

**Body** (`application/json`)

[Login](#login)

**200**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `user` | [User](#user) | yes |  |
| `mustChangePassword` | boolean | yes |  |

### `POST /api/auth/logout`

End the session.

**Access:** No sign-in needed.

**200**

[Ok](#ok)

### `GET /api/auth/me`

Who am I.

**Access:** Any API token, or a session.

**200**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `user` | [User](#user) | yes |  |
| `mustChangePassword` | boolean | yes |  |
| `openCases` | boolean | yes |  |
| `oidc` | boolean | yes |  |

### `POST /api/auth/password`

Change your password.

**Access:** A signed-in session only; API tokens are refused.

**Body** (`application/json`)

[Password](#password)

**200**

[Ok](#ok)

### `GET /api/auth/oidc/enabled`

Whether single sign-on is configured.

**Access:** No sign-in needed.

**200**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `enabled` | boolean | yes |  |
| `issuer` | string or null | yes |  |

### `GET /api/auth/oidc/start`

Begin single sign-on.

**Access:** No sign-in needed.

**302** (`text/plain`): Redirects to the identity provider.

### `GET /api/auth/oidc/callback`

Return from single sign-on.

**Access:** No sign-in needed.

**302** (`text/plain`): Redirects back into the app.

## Tokens

Credentials for scripts and agents.

### `GET /api/tokens`

List your API tokens.

**Access:** A signed-in session only; API tokens are refused.

**200**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `tokens` | array of [ApiToken](#apitoken) | yes |  |

### `POST /api/tokens`

Create an API token.

The `token` value is returned only here and cannot be read back.

**Access:** A signed-in session only; API tokens are refused.

**Body** (`application/json`)

[CreateToken](#createtoken)

**201**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `token` | string | yes |  |
| `record` | [ApiToken](#apitoken) | yes |  |

### `DELETE /api/tokens/{id}`

Revoke an API token.

**Access:** A signed-in session only; API tokens are refused.

**200**

[Ok](#ok)

## Users

Accounts.

### `GET /api/users`

List users.

**Access:** A signed-in session only; API tokens are refused.

**200**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `users` | array of [User](#user) | yes |  |

### `POST /api/users`

Create a user (admin).

**Access:** A signed-in session only; API tokens are refused.

**Body** (`application/json`)

[CreateUser](#createuser)

**201**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `user` | [User](#user) | yes |  |
| `temporaryPassword` | string |  |  |

### `PATCH /api/users/{id}`

Update a user (admin).

Disabling a user or resetting their password revokes their API tokens.

**Access:** A signed-in session only; API tokens are refused.

**Body** (`application/json`)

[PatchUser](#patchuser)

**200**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `user` | [User](#user) | yes |  |

## Admin

Server administration.

### `GET /api/admin/stats`

Row counts (admin).

**Access:** A signed-in session only; API tokens are refused.

**200**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `users` | integer | yes |  |
| `cases` | integer | yes |  |
| `ops` | integer | yes |  |
| `events` | integer | yes |  |
| `sessions` | integer | yes |  |

### `GET /api/admin/backup`

Download a consistent database backup (admin).

**Access:** A signed-in session only; API tokens are refused.

**200** (`application/octet-stream`): A SQLite database file.

## Cases

Investigations.

### `GET /api/cases`

List the cases you can read.

**Access:** Any API token, or a session.

**Query**

| Name | Type | Notes |
| --- | --- | --- |
| `archived` | `1` |  |

**200**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `cases` | array of [CaseSummary](#casesummary) | yes |  |

### `POST /api/cases`

Create a case.

**Access:** A write token, or a session.

**Body** (`application/json`)

[CreateCase](#createcase)

**201**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `case` | [CaseSummary](#casesummary) | yes |  |

### `GET /api/cases/{id}`

A case and its members.

**Access:** Any API token, or a session.

**200**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `case` | [CaseSummary](#casesummary) | yes |  |
| `members` | array of object | yes |  |

### `PATCH /api/cases/{id}`

Archive or restrict a case.

**Access:** A signed-in session only; API tokens are refused.

**Body** (`application/json`)

[PatchCase](#patchcase)

**200**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `case` | [CaseSummary](#casesummary) | yes |  |

### `DELETE /api/cases/{id}`

Permanently delete a case (admin).

**Access:** A signed-in session only; API tokens are refused.

**200**

[Ok](#ok)

### `GET /api/cases/{id}/state`

The full current state of a case.

**Access:** Any API token, or a session.

**200**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `seq` | integer | yes |  |
| `state` | [CaseState](#casestate) | yes |  |

### `GET /api/cases/{id}/export`

Export a case file.

The same `.json` file the standalone app opens and saves.

**Access:** Any API token, or a session.

**200** (`application/json`): A Midden case file.

### `POST /api/cases/{id}/import`

Merge a case file into a case.

**Access:** A write token, or a session.

**Body** (`application/json`)

[ImportBody](#importbody)

**200**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `seq` | integer | yes |  |
| `report` | anything | yes |  |

### `PUT /api/cases/{id}/members/{userId}`

Add a member or change their role.

**Access:** A signed-in session only; API tokens are refused.

**Body** (`application/json`)

[MemberRole](#memberrole)

**200**

[Ok](#ok)

### `DELETE /api/cases/{id}/members/{userId}`

Remove a member.

**Access:** A signed-in session only; API tokens are refused.

**200**

[Ok](#ok)

## History

The operation log: how a case changes.

### `GET /api/cases/{id}/ops`

The operation log.

The audit trail of every change. Add `format=csv` to download it as a CSV.

**Access:** Any API token, or a session.

**Query**

| Name | Type | Notes |
| --- | --- | --- |
| `after` | integer |  |
| `before` | integer |  |
| `limit` | integer | Default `200`. |
| `format` | `csv` |  |

**200**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `ops` | array of [OpRecord](#oprecord) | yes |  |
| `seq` | integer | yes |  |

### `POST /api/cases/{id}/ops`

Submit an operation.

The way to change a case. Send a `clientOpId` so a retry cannot apply twice. Send `baseSeq`, the seq you last saw, to hear in `overwrote` which fields someone else changed since.

**Access:** A write token, or a session.

**Body** (`application/json`)

[SubmitOp](#submitop)

**200**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `seq` | integer | yes |  |
| `overwrote` | array of object | yes |  |
| `duplicate` | boolean | yes |  |

### `POST /api/cases/{id}/revert`

Undo an operation.

Appends a new operation that reverses the old one. Nothing is erased.

**Access:** A write token, or a session.

**Body** (`application/json`)

[Revert](#revert)

**200**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `seq` | integer | yes |  |

## Scans

Uploaded nmap scans and the terrain they map.

### `GET /api/cases/{id}/scans`

List scans.

**Access:** Any API token, or a session.

**200**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `scans` | array of object | yes |  |

### `POST /api/cases/{id}/scans`

Upload an nmap scan.

Takes nmap XML or normal output. Parsing happens in the background: the scan starts as `parsing`, so poll the list or watch the WebSocket until it is `ready` or `failed`.

**Access:** A write token, or a session.

**Body** (`multipart/form-data`)

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `file` | file | yes | The scan output. |
| `name` | string |  | A display name. |
| `phase` | string |  | `discovery`, `service` or `other`. Inferred if left out. |

**201**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `scan` | [ScanMeta](#scanmeta) | yes |  |

### `DELETE /api/cases/{id}/scans/{scanId}`

Delete a scan.

**Access:** A write token, or a session.

**200**

[Ok](#ok)

### `GET /api/cases/{id}/scans/{scanId}/hosts`

Page through the hosts in a scan.

Pass the returned `next` value as `after` to get the next page.

**Access:** Any API token, or a session.

**Query**

| Name | Type | Notes |
| --- | --- | --- |
| `after` | string |  |
| `limit` | integer | Default `200`. |
| `net` | string |  |
| `port` | integer |  |
| `bucket` | string |  |
| `q` | string |  |
| `flagged` | `0`, `1` |  |

**200**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `items` | array of [TerrainHost](#terrainhost) | yes |  |
| `next` | string or null | yes |  |

### `GET /api/cases/{id}/scans/{scanId}/hosts/{ip}`

One host, with ports, scripts and traceroute.

**Access:** Any API token, or a session.

**200**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `host` | [TerrainHost](#terrainhost) | yes |  |

### `GET /api/cases/{id}/scans/{scanId}/map`

The aggregated network map.

**Access:** Any API token, or a session.

**Query**

| Name | Type | Notes |
| --- | --- | --- |
| `layout` | `subnet`, `trace` | Default `"subnet"`. |
| `bits` | integer | Default `24`. |
| `net` | string |  |

**200** (`application/json`): The subnet or traceroute layout.

### `GET /api/cases/{id}/scans/{scanId}/targets.txt`

The addresses of hosts that are up, one per line.

**Access:** Any API token, or a session.

**200** (`text/plain`): One IP address per line.

### `GET /api/cases/{id}/scans/{scanId}/raw`

The original scan file.

**Access:** Any API token, or a session.

**200** (`application/xml`): The file as it was uploaded.

## Files

Evidence attached to events and hosts.

### `GET /api/cases/{id}/attachments`

List attachments.

**Access:** Any API token, or a session.

**200**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `attachments` | array of [AttachmentMeta](#attachmentmeta) | yes |  |

### `POST /api/cases/{id}/attachments`

Attach a file to an event or host.

**Access:** A write token, or a session.

**Body** (`multipart/form-data`)

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `file` | file | yes | The file. |
| `targetKind` | string | yes | `event` or `host`. |
| `targetId` | string | yes | The id of that event or host. |
| `note` | string |  | An analyst note. |
| `dangerous` | string |  | Set to `1` to flag the file as dangerous yourself. |

**201**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `attachment` | [AttachmentMeta](#attachmentmeta) | yes |  |
| `dangerReason` | string or null | yes |  |

### `GET /api/cases/{id}/attachments/{attId}`

Download an attachment.

A dangerous file never leaves the server bare. It comes as an encrypted zip with the password `infected`.

**Access:** Any API token, or a session.

**200** (`application/octet-stream`): The file.

### `DELETE /api/cases/{id}/attachments/{attId}`

Delete an attachment.

**Access:** A write token, or a session.

**200**

[Ok](#ok)

## Schemas

### Error

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `error` | object | yes |  |

### Ok

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `ok` | `true` | yes |  |

### Health

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `ok` | boolean | yes |  |
| `version` | string | yes |  |
| `node` | string | yes |  |
| `arch` | string | yes |  |
| `sqlite` | string | yes |  |
| `argon2` | boolean | yes |  |
| `diskFreeMb` | number or null | yes |  |

### User

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes |  |
| `username` | string | yes |  |
| `displayName` | string | yes |  |
| `role` | `admin`, `analyst`, `viewer` | yes |  |
| `disabled` | boolean | yes |  |
| `mustChangePassword` | boolean | yes |  |
| `createdAt` | string | yes |  |
| `hasPassword` | boolean | yes |  |

### ApiToken

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes |  |
| `name` | string | yes |  |
| `prefix` | string | yes | The first characters, to recognise the token by. |
| `scope` | `read`, `write` | yes |  |
| `createdAt` | string | yes |  |
| `expiresAt` | string or null | yes |  |
| `lastUsedAt` | string or null | yes |  |

### CaseAccess

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `read` | boolean | yes |  |
| `edit` | boolean | yes |  |
| `manage` | boolean | yes |  |
| `role` | `owner`, `editor`, `viewer`, `admin`, `open` or null | yes |  |

### CaseSummary

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes |  |
| `name` | string | yes |  |
| `number` | string | yes |  |
| `analyst` | string | yes |  |
| `classification` | string | yes |  |
| `createdAt` | string | yes |  |
| `modifiedAt` | string | yes |  |
| `archivedAt` | string or null | yes |  |
| `restricted` | boolean | yes |  |
| `seq` | integer | yes | The sequence number of the latest operation. |
| `hosts` | integer | yes |  |
| `events` | integer | yes |  |
| `access` | [CaseAccess](#caseaccess) | yes |  |

### OpRecord

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `seq` | integer | yes |  |
| `ts` | string | yes |  |
| `actor` | object | yes |  |
| `via` | string or null | yes | The name of the API token that made this change, if one did. |
| `type` | string | yes |  |
| `op` | [Op](#op) | yes |  |
| `inverse` | [Op](#op) or null | yes |  |
| `clientOpId` | string or null | yes |  |
| `baseSeq` | integer or null | yes |  |

### TerrainHost

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `ip` | string | yes |  |
| `hostnames` | array of string | yes |  |
| `state` | string | yes |  |
| `osName` | string | yes |  |
| `bucket` | string | yes |  |
| `role` | string | yes |  |
| `flags` | array of string | yes |  |
| `openCount` | integer | yes |  |
| `ports` | array of map to anything | yes |  |

### Op

One change to a case. The `type` field picks the shape; see `OpSchema` in [`packages/core/src/ops/ops.ts`](../packages/core/src/ops/ops.ts) and the `Op` schema in `/api/openapi.json`.

`noop`, `case.set`, `host.add`, `host.set`, `host.remove`, `event.add`, `event.set`, `event.remove`, `scan.add`, `scan.set`, `scan.remove`, `link.set`, `link.remove`, `attachment.add`, `attachment.set`, `attachment.remove`, `batch`, `op.revert`

### CaseState

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `case` | object | yes |  |
| `hosts` | map to [Host](#host) | yes |  |
| `events` | map to [Event](#event) | yes |  |
| `scans` | map to [ScanMeta](#scanmeta) | yes |  |
| `links` | map to object | yes |  |
| `attachments` | map to [AttachmentMeta](#attachmentmeta) | yes |  |

### Event

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `ts` | string |  |  |
| `off` | integer | yes | Default `0`. |
| `hostId` | string |  |  |
| `srcHostId` | string |  |  |
| `user` | string |  |  |
| `priv` | string |  |  |
| `indicator` | string |  |  |
| `itype` | string |  |  |
| `activity` | string |  |  |
| `cmd` | string |  |  |
| `tactic` | string |  |  |
| `technique` | string |  |  |
| `source` | string |  |  |
| `link` | string |  |  |
| `conf` | `confirmed`, `high`, `medium`, `low`, `suspected` | yes | Default `"medium"`. |
| `sev` | `critical`, `high`, `medium`, `low`, `info` | yes | Default `"medium"`. |
| `key` | boolean | yes | Default `false`. |
| `tags` | array of string |  | Default `[]`. |
| `evidence` | string |  |  |
| `notes` | string |  |  |
| `id` | string | yes |  |

### Host

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string |  |  |
| `ip` | string |  |  |
| `os` | string |  |  |
| `role` | string |  |  |
| `zone` | string |  |  |
| `crit` | `crown jewel`, `high`, `moderate`, `low` | yes | Default `"moderate"`. |
| `status` | `compromised`, `suspect`, `contained`, `remediated`, `clean`, `unknown` | yes | Default `"unknown"`. |
| `owner` | string |  |  |
| `tags` | array of string |  | Default `[]`. |
| `notes` | string |  |  |
| `id` | string | yes |  |

### ScanMeta

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string |  |  |
| `phase` | `discovery`, `service`, `other` | yes | Default `"other"`. |
| `fmt` | `xml`, `text` | yes | Default `"xml"`. |
| `args` | string |  |  |
| `nmapVersion` | string |  |  |
| `startedAt` | string |  |  |
| `finishedAt` | string |  |  |
| `elapsedS` | number or null |  | Default `null`. |
| `hostsUp` | integer |  | Default `0`. |
| `hostsDown` | integer |  | Default `0`. |
| `hostsTotal` | integer |  | Default `0`. |
| `rawSha256` | string |  |  |
| `uploadedBy` | string |  |  |
| `uploadedAt` | string |  |  |
| `status` | `parsing`, `ready`, `failed` | yes | Default `"ready"`. |
| `error` | string |  |  |
| `id` | string | yes |  |

### AttachmentMeta

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes |  |
| `sha256` | string | yes |  |
| `size` | integer | yes |  |
| `mime` | string |  |  |
| `name` | string |  |  |
| `target` | object | yes |  |
| `uploadedBy` | string |  |  |
| `uploadedByName` | string |  |  |
| `createdAt` | string |  |  |
| `md5` | string |  |  |
| `note` | string |  |  |
| `dangerous` | boolean |  | Default `false`. |

### CreateCase

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string | yes |  |
| `number` | string |  |  |
| `analyst` | string |  |  |
| `classification` | string |  |  |
| `summary` | string |  |  |
| `restricted` | boolean |  |  |

### PatchCase

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `archived` | boolean |  |  |
| `restricted` | boolean |  |  |

### SubmitOp

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `op` | anything | yes |  |
| `clientOpId` | string |  |  |
| `baseSeq` | integer |  |  |

### Revert

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `seq` | integer | yes |  |

### ImportBody

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `file` | anything | yes |  |

### MemberRole

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `role` | `owner`, `editor`, `viewer` | yes |  |

### Login

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `username` | string | yes |  |
| `password` | string | yes |  |

### Password

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `current` | string |  |  |
| `next` | string | yes |  |

### CreateUser

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `username` | string | yes |  |
| `displayName` | string |  |  |
| `role` | `admin`, `analyst`, `viewer` |  | Default `"analyst"`. |
| `password` | string |  |  |

### PatchUser

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `displayName` | string |  |  |
| `role` | `admin`, `analyst`, `viewer` |  |  |
| `disabled` | boolean |  |  |
| `password` | string |  |  |

### CreateToken

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string | yes |  |
| `scope` | `read`, `write` |  | Default `"read"`. |
| `expiresInDays` | integer |  |  |
