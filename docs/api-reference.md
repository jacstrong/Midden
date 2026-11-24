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

### `GET /api/metrics`

Prometheus metrics.

Off unless the server sets `MIDDEN_METRICS=token`; then it needs an API token belonging to an admin (read-only is enough). Text exposition format 0.0.4. Labels name status categories and teams, never people, cases or tasks. See the metrics guide.

**Access:** Any API token, or a session.

**200** (`text/plain`): Prometheus text format.

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

## Teams

Analyst teams and their leads.

### `GET /api/teams`

List teams and their members.

**Access:** Any API token, or a session.

**200**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `teams` | array of [Team](#team) | yes |  |

### `POST /api/teams`

Create a team (admin).

**Access:** A signed-in session only; API tokens are refused.

**Body** (`application/json`)

[CreateTeam](#createteam)

**201**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `team` | [Team](#team) | yes |  |

### `PATCH /api/teams/{id}`

Rename or describe a team (admin).

**Access:** A signed-in session only; API tokens are refused.

**Body** (`application/json`)

[PatchTeam](#patchteam)

**200**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `team` | [Team](#team) | yes |  |

### `DELETE /api/teams/{id}`

Delete a team (admin).

Tasks keep their team id and show it as a deleted team.

**Access:** A signed-in session only; API tokens are refused.

**200**

[Ok](#ok)

### `PUT /api/teams/{id}/members/{userId}`

Add a member or change their role.

Admins may do anything. A lead of the team may add and remove members, but not leads.

**Access:** A signed-in session only; API tokens are refused.

**Body** (`application/json`)

[TeamMember](#teammember)

**200**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `team` | [Team](#team) | yes |  |

### `DELETE /api/teams/{id}/members/{userId}`

Remove a member.

**Access:** A signed-in session only; API tokens are refused.

**200**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `team` | [Team](#team) | yes |  |

## Tasks

Task management, outside cases: tasks, runs and workflows.

### `GET /api/task-views`

List your saved views and those shared with your teams.

Built-in views (My tasks, Everyone’s tasks, …) are part of the web client and not listed.

**Access:** A signed-in session only; API tokens are refused.

**200**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `views` | array of [TaskView](#taskview) | yes |  |

### `POST /api/task-views`

Save a view.

Give a `teamId` to share it with a team; only that team’s leads and admins may.

**Access:** A signed-in session only; API tokens are refused.

**Body** (`application/json`)

[CreateTaskView](#createtaskview)

**201**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `view` | [TaskView](#taskview) | yes |  |

### `PATCH /api/task-views/{id}`

Change a saved view.

Its owner may change a personal view; a lead of the team, a shared one.

**Access:** A signed-in session only; API tokens are refused.

**Body** (`application/json`)

[PatchTaskView](#patchtaskview)

**200**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `view` | [TaskView](#taskview) | yes |  |

### `DELETE /api/task-views/{id}`

Delete a saved view.

**Access:** A signed-in session only; API tokens are refused.

**200**

[Ok](#ok)

### `GET /api/tasks`

Find tasks.

Newest first. Tasks linked to a restricted case are left out unless you can read that case.

**Access:** Any API token, or a session.

**Query**

| Name | Type | Notes |
| --- | --- | --- |
| `mine` | `1` |  |
| `assignee` | string |  |
| `team` | string |  |
| `run` | string |  |
| `case` | string |  |
| `category` | string |  |
| `open` | `1` |  |
| `overdue` | `1` |  |
| `following` | `1` |  |
| `archived` | `exclude`, `include`, `only` | Default `"exclude"`. |
| `q` | string |  |
| `limit` | integer | Default `200`. |
| `offset` | integer | Default `0`. |

**200**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `tasks` | array of [Task](#task) | yes |  |
| `total` | integer | yes |  |
| `seq` | integer | yes |  |

### `POST /api/tasks`

Create a task.

**Access:** A write token, or a session.

**Body** (`application/json`)

[CreateTask](#createtask)

**201**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `task` | [Task](#task) | yes |  |
| `seq` | integer | yes |  |

### `GET /api/tasks/state`

Every task, comment, run and workflow you can see.

**Access:** Any API token, or a session.

**200**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `seq` | integer | yes |  |
| `state` | [TaskState](#taskstate) | yes |  |

### `GET /api/tasks/{id}`

A task with its comments and dependencies.

The id may also be a task number: `T-12` or `12`.

**Access:** Any API token, or a session.

**200**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `task` | [Task](#task) | yes |  |
| `comments` | array of [TaskComment](#taskcomment) | yes |  |
| `blockedBy` | array of [TaskBrief](#taskbrief) | yes |  |
| `blocking` | array of [TaskBrief](#taskbrief) | yes |  |

### `PATCH /api/tasks/{id}`

Change a task.

Moving a task to a done status fails while its approver has not approved it. Changing who is assigned here affects one task, so it needs no lead.

**Access:** A write token, or a session.

**Body** (`application/json`)

[PatchTask](#patchtask)

**200**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `task` | [Task](#task) | yes |  |
| `seq` | integer | yes |  |

### `POST /api/tasks/{id}/comments`

Comment on a task.

**Access:** A write token, or a session.

**Body** (`application/json`)

[Comment](#comment)

**201**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `comment` | [TaskComment](#taskcomment) | yes |  |
| `seq` | integer | yes |  |

### `GET /api/tasks/{id}/history`

A task's history.

**Access:** Any API token, or a session.

**200**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `ops` | array of [TaskOpRecord](#taskoprecord) | yes |  |

### `GET /api/tasks/ops`

The task operation log.

Operations touching a task you cannot see are left out.

**Access:** Any API token, or a session.

**Query**

| Name | Type | Notes |
| --- | --- | --- |
| `after` | integer |  |
| `before` | integer |  |
| `limit` | integer | Default `200`. |

**200**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `ops` | array of [TaskOpRecord](#taskoprecord) | yes |  |
| `seq` | integer | yes |  |

### `POST /api/tasks/ops`

Submit a task operation.

Takes any client operation from `TaskOpSchema`. Assigning more than one task in one operation takes a team lead or an admin. Send a `clientOpId` so a retry cannot apply twice.

**Access:** A write token, or a session.

**Body** (`application/json`)

[SubmitOp](#submitop)

**200**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `seq` | integer | yes |  |
| `overwrote` | array of object | yes |  |
| `duplicate` | boolean | yes |  |

### `POST /api/tasks/revert`

Undo a task operation.

Applies the recorded inverse of that operation as a new one.

**Access:** A write token, or a session.

**Body** (`application/json`)

[Revert](#revert)

**200**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `seq` | integer | yes |  |
| `overwrote` | array of object | yes |  |
| `duplicate` | boolean | yes |  |

### `GET /api/task-runs`

List runs (playbook instances) with progress.

**Access:** Any API token, or a session.

**200**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `runs` | array of [TaskRun](#taskrun) | yes |  |

### `POST /api/task-runs`

Start a run (team lead or admin).

The run gets its own copy of a workflow, so its statuses can change without affecting others.

**Access:** A signed-in session only; API tokens are refused.

**Body** (`application/json`)

[CreateRun](#createrun)

**201**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `run` | [TaskRun](#taskrun) | yes |  |
| `seq` | integer | yes |  |

### `PATCH /api/task-runs/{id}`

Rename, move or close a run (team lead or admin).

**Access:** A signed-in session only; API tokens are refused.

**Body** (`application/json`)

[PatchRun](#patchrun)

**200**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `run` | [TaskRun](#taskrun) | yes |  |
| `seq` | integer | yes |  |

### `GET /api/playbooks`

List playbooks.

Every signed-in user can read playbooks. The CSV itself comes with `GET /api/playbooks/{id}`.

**Access:** Any API token, or a session.

**200**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `playbooks` | array of [Playbook](#playbook) | yes |  |

### `POST /api/playbooks`

Save a playbook (team lead or admin).

The CSV is checked for errors in the file itself; names of people, teams and cases are only resolved when a run is started from it. A playbook with no team takes an admin.

**Access:** A signed-in session only; API tokens are refused.

**Body** (`application/json`)

[CreatePlaybook](#createplaybook)

**201**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `playbook` | [Playbook](#playbook) | yes |  |

### `GET /api/playbooks/{id}`

Get a playbook with its CSV.

**Access:** Any API token, or a session.

**200**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `playbook` | object | yes |  |

### `PATCH /api/playbooks/{id}`

Change a playbook (team lead or admin).

**Access:** A signed-in session only; API tokens are refused.

**Body** (`application/json`)

[PatchPlaybook](#patchplaybook)

**200**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `playbook` | [Playbook](#playbook) | yes |  |

### `DELETE /api/playbooks/{id}`

Delete a playbook (team lead or admin).

Runs started from it keep their tasks.

**Access:** A signed-in session only; API tokens are refused.

**200**

[Ok](#ok)

### `POST /api/task-runs/{id}/playbook`

Save a run as a playbook (team lead or admin).

Due dates become offsets from the run's start, and by default statuses, ticks and assignees are cleared so the next hunt starts fresh. Case links are dropped, and tasks linked to a restricted case are left out (`skipped`), since a playbook is shared with the whole team.

**Access:** A signed-in session only; API tokens are refused.

**Body** (`application/json`)

[SaveRunAsPlaybook](#saverunasplaybook)

**201**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `playbook` | [Playbook](#playbook) | yes |  |
| `skipped` | integer | yes |  |

### `POST /api/tasks/import`

Import tasks from CSV or a playbook (team lead or admin).

Starts a run (`run`) or adds to one (`runId`), as a single operation that undoes in one step. With `?preview=1` nothing changes: the response lists the tasks as they would be created and every problem found, including the ones the permission checks would raise. Status names the run's workflow lacks are listed in `unknownStatuses`; pass them back in `addStatuses` to add them. See the CSV format in the guide.

**Access:** A write token, or a session.

**Query**

| Name | Type | Notes |
| --- | --- | --- |
| `preview` | `1` |  |

**Body** (`application/json`)

[ImportTasks](#importtasks)

**201**

object or object

### `GET /api/tasks/export`

Export tasks as CSV.

Takes the same filters as `GET /api/tasks` and writes the import format, so an export can be imported again. Cells that start with `= + - @` get a leading `'` so spreadsheets do not run them as formulas; import removes it.

**Access:** Any API token, or a session.

**Query**

| Name | Type | Notes |
| --- | --- | --- |
| `mine` | `1` |  |
| `assignee` | string |  |
| `team` | string |  |
| `run` | string |  |
| `case` | string |  |
| `category` | string |  |
| `open` | `1` |  |
| `overdue` | `1` |  |
| `following` | `1` |  |
| `archived` | `exclude`, `include`, `only` | Default `"exclude"`. |
| `q` | string |  |
| `due` | `absolute`, `relative` | Default `"absolute"`. |
| `comments` | `1` |  |
| `state` | `0`, `1` | Default `"1"`. |

**200** (`text/csv`): The tasks in the playbook CSV format.

### `GET /api/workflows`

List workflows.

**Access:** Any API token, or a session.

**200**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `workflows` | array of [Workflow](#workflow) | yes |  |
| `defaultWorkflowId` | string | yes |  |

### `PUT /api/workflows/{id}`

Create or replace a workflow.

The default workflow takes an admin; a run's workflow takes a lead of the run's team. Every task must still have a status in its workflow afterwards.

**Access:** A signed-in session only; API tokens are refused.

**Body** (`application/json`)

[PutWorkflow](#putworkflow)

**200**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `workflow` | [Workflow](#workflow) | yes |  |
| `seq` | integer | yes |  |

### `GET /api/tasks/insights`

Open work, throughput, cycle time and what is stuck.

Counted over the tasks you can see: a task linked to a restricted case you cannot read is left out of every number. Archived tasks count toward throughput and cycle time but not open work. Give `run` for its burndown.

**Access:** Any API token, or a session.

**Query**

| Name | Type | Notes |
| --- | --- | --- |
| `team` | string |  |
| `run` | string |  |
| `from` | string |  |
| `to` | string |  |

**200**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `insights` | [TaskInsights](#taskinsights) | yes |  |

## Notifications

Your inbox and what you are told about. Browser sessions only.

### `GET /api/notifications`

Your notifications, newest first.

Changes to one task within two minutes fold into one unread notification, and a bulk change is one notification listing every task. Tasks you can no longer see drop out, and a notification left with none is not listed or counted. Page with `before` set to the last `updatedAt`.

**Access:** A signed-in session only; API tokens are refused.

**Query**

| Name | Type | Notes |
| --- | --- | --- |
| `unread` | `0`, `1` |  |
| `limit` | integer |  |
| `before` | string |  |

**200**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `notifications` | array of [Notification](#notification) | yes |  |
| `unread` | integer | yes |  |

### `POST /api/notifications/read`

Mark notifications read.

**Access:** A signed-in session only; API tokens are refused.

**Body** (`application/json`)

[MarkRead](#markread)

**200**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `unread` | integer | yes |  |

### `GET /api/notifications/prefs`

Your notification preferences.

Being assigned, @mentioned or asked to approve always notifies you; the grid covers everything else. Your own changes never notify you.

**Access:** A signed-in session only; API tokens are refused.

**200**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `prefs` | [NotifyPrefs](#notifyprefs) | yes |  |
| `defaults` | [NotifyPrefs](#notifyprefs) | yes |  |

### `PATCH /api/notifications/prefs`

Change your notification preferences.

Send only what changes; everything else keeps its value.

**Access:** A signed-in session only; API tokens are refused.

**Body** (`application/json`)

[NotifyPrefsPatch](#notifyprefspatch)

**200**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `prefs` | [NotifyPrefs](#notifyprefs) | yes |  |

## Webhooks

Chat messages (Rocket.Chat format) about task changes, per team or for every task.

### `GET /api/webhooks`

Webhooks you manage.

Admins see every webhook; team leads see their teams'. `allowedHosts` is the server's MIDDEN_WEBHOOK_ALLOWED_HOSTS: webhooks can only post there, and are off when it is empty.

**Access:** A signed-in session only; API tokens are refused.

**200**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `webhooks` | array of [Webhook](#webhook) | yes |  |
| `allowedHosts` | array of string | yes |  |
| `origin` | string or null | yes |  |

### `POST /api/webhooks`

Add a webhook (team lead or admin).

Posts Rocket.Chat incoming-webhook messages (Slack and Mattermost accept them too). A team's webhook hears about tasks on that team or in its runs; one with no team (admins only) hears about every task. Tasks linked to a restricted case are described by number only.

**Access:** A signed-in session only; API tokens are refused.

**Body** (`application/json`)

[CreateWebhook](#createwebhook)

**201**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `webhook` | [Webhook](#webhook) | yes |  |

### `PATCH /api/webhooks/{id}`

Change a webhook.

Leave out `url` to keep the current one.

**Access:** A signed-in session only; API tokens are refused.

**Body** (`application/json`)

[PatchWebhook](#patchwebhook)

**200**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `webhook` | [Webhook](#webhook) | yes |  |

### `DELETE /api/webhooks/{id}`

Delete a webhook.

**Access:** A signed-in session only; API tokens are refused.

**200**

[Ok](#ok)

### `POST /api/webhooks/{id}/test`

Send a test message now.

Waits for the attempt and returns it. A failed test is not retried.

**Access:** A signed-in session only; API tokens are refused.

**200**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `delivery` | [WebhookDelivery](#webhookdelivery) | yes |  |

### `GET /api/webhooks/{id}/deliveries`

Recent deliveries.

The last 50, newest first. Failed sends are retried after 30 s, 2 min, 10 min, 30 min and 2 h, then marked failed.

**Access:** A signed-in session only; API tokens are refused.

**200**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `deliveries` | array of [WebhookDelivery](#webhookdelivery) | yes |  |

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

### Team

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes |  |
| `name` | string | yes |  |
| `description` | string | yes |  |
| `createdAt` | string | yes |  |
| `members` | array of object | yes |  |

### Task

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes |  |
| `num` | integer | yes |  |
| `title` | string | yes |  |
| `description` | string | yes |  |
| `statusId` | string | yes |  |
| `priority` | `urgent`, `high`, `medium`, `low` | yes |  |
| `runId` | string | yes |  |
| `teamId` | string | yes |  |
| `assignees` | array of string | yes |  |
| `followers` | array of string | yes |  |
| `labels` | array of string | yes |  |
| `dueAt` | string | yes |  |
| `caseId` | string | yes |  |
| `hostId` | string | yes |  |
| `eventId` | string | yes |  |
| `blockedBy` | array of string | yes |  |
| `checklist` | array of object | yes |  |
| `approval` | object or null | yes |  |
| `archived` | boolean | yes |  |
| `createdBy` | string | yes |  |
| `createdAt` | string | yes |  |
| `statusAt` | string | yes |  |
| `doneAt` | string | yes |  |
| `ref` | string | yes | The task number as people say it, e.g. `T-12`. |
| `category` | `backlog`, `todo`, `in_progress`, `blocked`, `done`, `cancelled` | yes |  |
| `statusName` | string | yes |  |

### TaskBrief

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes |  |
| `ref` | string | yes |  |
| `title` | string | yes |  |
| `category` | `backlog`, `todo`, `in_progress`, `blocked`, `done`, `cancelled` | yes |  |

### TaskComment

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes |  |
| `taskId` | string | yes |  |
| `authorId` | string | yes |  |
| `body` | string | yes |  |
| `createdAt` | string | yes |  |
| `editedAt` | string | yes |  |
| `deletedAt` | string | yes |  |

### TaskRun

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes |  |
| `name` | string | yes |  |
| `teamId` | string | yes |  |
| `playbookId` | string | yes |  |
| `workflowId` | string | yes |  |
| `startDate` | string | yes |  |
| `closed` | boolean | yes |  |
| `closedAt` | string | yes |  |
| `createdBy` | string | yes |  |
| `createdAt` | string | yes |  |
| `counts` | map to integer | yes |  |
| `total` | integer | yes |  |

### Workflow

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes |  |
| `name` | string | yes |  |
| `statuses` | array of object | yes |  |

### TaskOp

object or object or object or object or object or object or object or object or object or object or object or object or object or object or object or object or object or object or object or object or object or object or object or object or object or object or object or object or object or object or object

### TaskState

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `tasks` | map to object | yes |  |
| `comments` | map to [TaskComment](#taskcomment) | yes |  |
| `runs` | map to object | yes |  |
| `workflows` | map to [Workflow](#workflow) | yes |  |
| `defaultWorkflowId` | string | yes |  |
| `nextNum` | integer | yes |  |

### TaskOpRecord

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `seq` | integer | yes |  |
| `ts` | string | yes |  |
| `actor` | object | yes |  |
| `via` | string or null | yes |  |
| `type` | string | yes |  |
| `op` | [TaskOp](#taskop) | yes |  |
| `inverse` | [TaskOp](#taskop) or null | yes |  |
| `clientOpId` | string or null | yes |  |
| `baseSeq` | integer or null | yes |  |

### CreateTeam

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string | yes |  |
| `description` | string |  |  |

### PatchTeam

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string |  |  |
| `description` | string |  |  |

### TeamMember

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `role` | `lead`, `member` | yes |  |

### CreateTask

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `title` | string | yes |  |
| `description` | string |  |  |
| `status` | string |  | A status id or name in the task's workflow, or a category such as `todo`. |
| `priority` | `urgent`, `high`, `medium`, `low` |  | Default `"medium"`. |
| `runId` | string |  |  |
| `teamId` | string |  |  |
| `assignees` | array of string |  | Default `[]`. |
| `labels` | array of string |  | Default `[]`. |
| `dueAt` | string |  |  |
| `caseId` | string |  |  |
| `hostId` | string |  |  |
| `eventId` | string |  |  |
| `blockedBy` | array of string |  | Task ids or T-numbers. Default `[]`. |
| `checklist` | array of string |  | Default `[]`. |
| `approverId` | string |  |  |

### PatchTask

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `title` | string |  |  |
| `description` | string |  |  |
| `priority` | `urgent`, `high`, `medium`, `low` |  |  |
| `runId` | string |  |  |
| `labels` | array of string |  |  |
| `dueAt` | string |  |  |
| `caseId` | string |  |  |
| `hostId` | string |  |  |
| `eventId` | string |  |  |
| `archived` | boolean |  |  |
| `status` | string |  | A status id, name or category. |
| `assignees` | array of string |  | Replaces the list. |
| `teamId` | string |  |  |
| `approverId` | string |  | Empty clears the approver. |

### Comment

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `body` | string | yes |  |

### CreateRun

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string | yes |  |
| `teamId` | string |  |  |
| `startDate` | string |  | ISO-8601; defaults to now. |
| `workflowId` | string |  | Copy this workflow for the run. Defaults to the default workflow. |

### PatchRun

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string |  |  |
| `teamId` | string |  |  |
| `startDate` | string |  |  |
| `closed` | boolean |  |  |

### PutWorkflow

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string | yes |  |
| `statuses` | array of object | yes |  |

### TaskView

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes |  |
| `name` | string | yes |  |
| `ownerId` | string | yes |  |
| `teamId` | string | yes | The team it is shared with; empty for a personal view. |
| `builtIn` | boolean | yes |  |
| `config` | object | yes |  |

### CreateTaskView

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string | yes |  |
| `teamId` | string |  |  |
| `config` | object | yes |  |

### PatchTaskView

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string |  |  |
| `teamId` | string |  |  |
| `config` | object |  |  |

### Playbook

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes |  |
| `name` | string | yes |  |
| `description` | string | yes |  |
| `teamId` | string | yes | Empty for a playbook every team can use. |
| `statuses` | array of object or null | yes | Workflow for runs started from it; null uses the default. |
| `version` | integer | yes | Goes up when the CSV or workflow changes. |
| `rows` | integer | yes | Tasks in the CSV. |
| `createdBy` | string | yes |  |
| `createdAt` | string | yes |  |
| `updatedBy` | string | yes |  |
| `updatedAt` | string | yes |  |

### CreatePlaybook

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string | yes |  |
| `description` | string |  |  |
| `teamId` | string |  | Empty for a playbook every team can use (admins only). |
| `csv` | string | yes | The playbook CSV. |
| `statuses` | array of object or null |  | Workflow for runs started from it; null uses the default workflow. Default `null`. |

### PatchPlaybook

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string |  |  |
| `description` | string |  |  |
| `teamId` | string |  |  |
| `csv` | string |  | The playbook CSV. |
| `statuses` | array of object or null |  |  |

### SaveRunAsPlaybook

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string |  | Defaults to the run's name. |
| `description` | string |  |  |
| `teamId` | string |  | Defaults to the run's team. |
| `keepAssignees` | boolean |  | Default `false`. |
| `keepStatus` | boolean |  | Keep statuses and ticked checklist items instead of starting fresh. Default `false`. |

### ImportTasks

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `csv` | string |  |  |
| `playbookId` | string |  |  |
| `runId` | string |  | Add the tasks to this run instead of starting one. |
| `run` | object |  | Start this run for the tasks. |
| `addStatuses` | array of object |  | Statuses to add to the run's workflow, for status names it doesn't have. Default `[]`. |

### ImportIssue

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `line` | integer | yes | 0 for problems with the file as a whole. |
| `severity` | `error`, `warning` | yes |  |
| `message` | string | yes |  |

### Notification

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes |  |
| `kind` | `assigned`, `mention`, `approval_requested`, `status`, `comment`, `edited`, `approval_decided`, `due_soon`, `overdue`, `queued` | yes | The most important of `kinds`. |
| `kinds` | array of `assigned`, `mention`, `approval_requested`, `status`, `comment`, `edited`, `approval_decided`, `due_soon`, `overdue`, `queued` | yes |  |
| `tasks` | array of object | yes | Only tasks you can still see. |
| `actors` | array of object | yes |  |
| `comments` | array of object | yes |  |
| `count` | integer | yes | Changes folded into this notification. |
| `createdAt` | string | yes |  |
| `updatedAt` | string | yes |  |
| `read` | boolean | yes |  |

### NotifyPrefs

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `grid` | map to object | yes | What happened × how you are related to the task. |
| `queue` | boolean | yes | Tell me about new tasks in my teams' queues. |
| `autoFollow` | object | yes |  |

### NotifyPrefsPatch

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `grid` | object |  |  |
| `queue` | boolean |  |  |
| `autoFollow` | object |  |  |

### MarkRead

object or object

### WebhookDelivery

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes |  |
| `event` | string | yes | Comma-separated events, or `test`. |
| `status` | `pending`, `ok`, `failed` | yes |  |
| `attempts` | integer | yes |  |
| `nextAttemptAt` | string or null | yes |  |
| `lastStatus` | integer or null | yes |  |
| `lastError` | string | yes |  |
| `createdAt` | string | yes |  |
| `deliveredAt` | string or null | yes |  |
| `payload` | anything | yes | The Rocket.Chat message that was sent. |

### TaskInsights

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `now` | string | yes |  |
| `from` | string | yes |  |
| `to` | string | yes |  |
| `open` | object | yes |  |
| `queues` | array of object | yes |  |
| `people` | array of object | yes |  |
| `throughput` | array of object | yes | One entry per week, starting Mondays (UTC). |
| `cycle` | object | yes | First in progress to done, for tasks done in the window. |
| `lead` | object | yes | Created to done, for tasks done in the window. |
| `stuck` | array of object | yes |  |
| `approvals` | array of object | yes |  |
| `burndown` | object or null | yes |  |

### Webhook

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes |  |
| `teamId` | string | yes | Empty for a webhook that hears about every task. |
| `name` | string | yes |  |
| `url` | string | yes | Masked; the full URL is never returned. |
| `events` | array of `created`, `assigned`, `status`, `done`, `comment`, `approval_requested`, `approval_decided`, `overdue` | yes |  |
| `enabled` | boolean | yes |  |
| `createdBy` | string | yes |  |
| `createdAt` | string | yes |  |
| `updatedBy` | string | yes |  |
| `updatedAt` | string | yes |  |
| `last` | [WebhookDelivery](#webhookdelivery) or null | yes |  |

### CreateWebhook

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string | yes |  |
| `teamId` | string |  |  |
| `url` | string | yes |  |
| `events` | array of `created`, `assigned`, `status`, `done`, `comment`, `approval_requested`, `approval_decided`, `overdue` | yes |  |
| `enabled` | boolean |  | Default `true`. |

### PatchWebhook

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string |  |  |
| `url` | string |  |  |
| `events` | array of `created`, `assigned`, `status`, `done`, `comment`, `approval_requested`, `approval_decided`, `overdue` |  |  |
| `enabled` | boolean |  |  |
