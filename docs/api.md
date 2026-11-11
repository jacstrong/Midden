# API guide

Everything the Midden web client does goes through an HTTP API you can use too, to feed in alerts, pull case data into a report, or build your own tooling. This page covers what you need to know before you start. Every endpoint is listed in the [API reference](api-reference.md), and each server describes itself at `/api/openapi.json`, which most API clients can import.

The API belongs to the server. The standalone `.html` file has no server, so it has no API.

## Getting a token

Scripts and agents sign in with an API token rather than a password. In Midden, open **API tokens**, name the token after whatever will use it, and choose its access. The token is shown once, so copy it then.

Send it as a bearer token:

```bash
curl -H "Authorization: Bearer $MIDDEN_TOKEN" https://midden.corp.example/api/cases
```

A token acts as the person who made it and can never do more than they can. On top of that:

| Access         | Can do                                                                      |
| -------------- | --------------------------------------------------------------------------- |
| Read only      | Every `GET` a token can reach. This is the default.                         |
| Read and write | Also create cases, change them, and upload or delete scans and attachments. |

Some things always need a person signed in, whichever kind of token you hold: managing accounts and tokens, server administration (a backup contains password hashes), permanently deleting a case, and changing who can see one. These answer `403` with the code `session_required`. A stolen token can't mint more tokens or widen its own reach.

Tokens stop working when they expire, when their owner revokes them, or when an admin disables the owner or resets their password. Midden stores only a hash of each token.

## Changing a case

A case is an append-only log of operations, and what you read is that log played back. To change a case, you submit an operation:

```bash
curl -X POST https://midden.corp.example/api/cases/$CASE/ops \
  -H "Authorization: Bearer $MIDDEN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "clientOpId": "alert-48213",
    "op": {
      "type": "event.add",
      "event": {
        "id": "ev_alert_48213",
        "ts": "2026-11-04T09:14:00Z",
        "activity": "Beacon to 203.0.113.7 flagged by the EDR",
        "indicator": "203.0.113.7",
        "itype": "ip",
        "sev": "high",
        "conf": "medium",
        "source": "EDR"
      }
    }
  }'
```

Three things make this safe to automate:

- **Retries can't double up.** Send a `clientOpId` that is unique within the case, and sending the same one again returns the original result with `duplicate: true`.
- **You hear about conflicts.** Send `baseSeq`, the `seq` you last read. If someone changed the same field since, your write still applies, and `overwrote` says who you overwrote. Edits to one field are last-write-wins.
- **Nothing is lost.** Every change records who made it, and API changes are labelled with the token's name, such as `Ann via triage-bot`. `POST /api/cases/{id}/revert` undoes an operation by appending its reverse.

A `*.set` operation carries only the fields you're changing, so it doesn't disturb anyone else's edits. The operations are listed under [Op](api-reference.md#op).

Tasks work the same way, with `task.add`, `task.set` and `comment.add`. Their assignees and followers are notified of each change; a script can read its owner's notices from `GET /api/notifications`. See [Running a hunt with tasks](tasks.md).

## Reading a case

- `GET /api/cases/{id}/state` returns the whole case and the `seq` it reflects.
- `GET /api/cases/{id}/ops?after=<seq>` returns what changed since, which suits a script that polls.
- `/api/ws` pushes changes as they happen. Send `{"t":"hello","caseId":"...","lastSeq":null}` once connected.

Scan hosts can run to tens of thousands, so `GET /api/cases/{id}/scans/{scanId}/hosts` is paged: pass each response's `next` as `after`, until `next` is `null`.

Uploading a scan returns straight away with the status `parsing`. Poll `GET /api/cases/{id}/scans` until it reads `ready` or `failed`.

## Treat case data as untrusted

Scan results and evidence contain text an attacker can influence, such as hostnames, service banners and file names. Escape it wherever you display it, and don't feed it to anything that would act on it. This matters most for [AI agents](mcp.md).

## Errors

Errors have a stable `code` to branch on and a `message` to show a person:

```json
{ "error": { "code": "read_only_token", "message": "This API token is read-only" } }
```

| Status | Means                                                                                 |
| ------ | ------------------------------------------------------------------------------------- |
| `400`  | The request didn't validate.                                                          |
| `401`  | No valid credentials. The token may be expired or revoked.                            |
| `403`  | Valid credentials, but not allowed.                                                   |
| `404`  | No such thing, or you can't see it. Restricted cases don't reveal that they exist.    |
| `413`  | The upload is over the limit set by `MIDDEN_MAX_UPLOAD_MB` or `MIDDEN_CASE_QUOTA_MB`. |
| `429`  | Too many attempts. Only sign-in is rate limited.                                      |

## Calling from a browser session

The web client uses a session cookie instead of a token. With a cookie, every request that changes something must also carry an `X-Midden-Client` header, with any value, which is what stops other websites forging requests. Requests with a token don't need it.

Midden doesn't send CORS headers, so a web page on another origin can't call the API directly. Call it from your own backend.

## Stability

This is version 1 of the API, and that number is separate from Midden's release number.

Within version 1, changes only add things: new endpoints, new optional fields on requests, and new fields on responses. Ignore fields you don't recognise. A breaking change would arrive as a new `/api/v2` path alongside this one, with notice in the release notes.

The WebSocket messages and the operation vocabulary are part of this promise. The `/api/admin` routes and the `/api/ws` presence messages are not, since they exist for the web client and may change.
