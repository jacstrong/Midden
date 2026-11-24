# Tasks and playbooks

Midden tracks the work of a hunt as tasks: who is doing what, what is waiting on what, and what still needs a sign-off. Tasks live outside cases, so one checklist can span several cases or none, but a task can link to a case, and to a host or event inside it.

Tasks need a server. The standalone `.html` file has no tasks.

## Teams, runs and playbooks

- **Teams** are your analyst cells, such as a host team and a network team. An admin creates them on the **Teams** page and chooses each team's leads. A person can be on several teams.
- **A playbook** is a saved list of tasks you run at the start of every hunt, kept as a CSV file. Leads keep their team's playbooks on the **Playbooks & runs** page.
- **A run** is one use of a playbook: a set of tasks with a name, a team and a start date. Due dates in a playbook can count from the run's start, so the same playbook works for every hunt.

## Who can do what

| Who                | Can                                                                                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Viewers            | Read tasks.                                                                                                                                                |
| Analysts           | Create and edit tasks, comment, claim a task from a team queue, and assign a single task to anyone.                                                        |
| Team leads         | Everything analysts can, plus import playbooks, start runs, edit a run's statuses, and change assignees on many tasks at once, within the teams they lead. |
| Admins             | Everything, on every team, plus the default statuses for tasks outside a run.                                                                              |
| The named approver | Approve or reject a task they're asked to approve. Nobody else can, including admins.                                                                      |

A task linked to a restricted case is visible only to people who can read that case. That holds everywhere: boards, search, the API, AI agents, notifications, chat webhooks, exports and Insights.

## Approvals

Some tasks accept risk, such as leaving a legacy service running for the length of a hunt. Give such a task an approver in the task drawer. Until the approver signs off, the task can't be marked done.

The approver has to approve or reject **in person**, signed in to Midden in a browser. An API token or AI agent can't do it for them, however much access it has. They can add a comment, such as the risk they're accepting, and the decision is kept in the task's history.

## Staying informed

The bell at the top of each page shows your notifications. You're always told when you're assigned a task, mentioned with `@username`, or asked to approve something. Under **Notifications → Preferences** you choose what else you hear about, such as comments or status changes on tasks you follow. You're never told about your own changes, and quick changes to one task arrive as one notification.

Leads can also send task events to a Rocket.Chat channel from the **Teams** page, and admins can do it for every task. The server only posts to chat hosts its administrator has allowed (see `MIDDEN_WEBHOOK_ALLOWED_HOSTS` in [Deploying Midden](deploy.md#configuration)). A task linked to a restricted case is posted by number only, as `T-142 (restricted)`, without its title, status names or who it is assigned to.

## Insights

**Tasks → Insights** shows open work by status, who is carrying it, tasks done per week, cycle time (from first in progress to done), lead time (from created to done), the tasks stuck longest in one status, approvals still waiting, and a burndown for each run. You can filter by team, run and time window. Everything is counted from the tasks you can see.

For server-level monitoring, see [Metrics](metrics.md).

## The CSV format

Playbooks, imports and exports all use one CSV format. You can export a run, keep the file, and import it again later, or turn a finished run into the next hunt's playbook.

Here is a small playbook:

```csv
key,title,description,status,priority,assignees,team,labels,due,blocked_by,checklist,approver,case
dns,Pull DNS logs,Last 30 days from both resolvers,To do,high,,Host,logs;day-1,+1d,,Export;Hash and record,,
base,Baseline services on DCs,,To do,medium,ann,Host,baseline,+2d,dns,,,
smb,Disable SMBv1 on the file server,Needs the owner's OK first,Backlog,high,,Host,hardening,+5d,base,,lena,
beac,Look for beaconing,,To do,urgent,bob;cy,Network,network,+1d12h,,"[x] Pull NetFlow;Run the jitter query",,IR-2026-014
```

Only `title` is required. Columns can be in any order, headings ignore case, and `Blocked by` or `blocked-by` work as well as `blocked_by`. A column Midden doesn't know is ignored, with a warning.

### Columns

| Column        | What goes in it                                                                                                                                                                                           |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `key`         | A short name for the row, used only inside the file so other rows can depend on it. Rows without one get one.                                                                                             |
| `title`       | Required. Up to 300 characters.                                                                                                                                                                           |
| `description` | Plain text. Links, `T-12` references and `@username` mentions become links. Quote the cell to include line breaks or commas.                                                                              |
| `status`      | A status name from the run's workflow (`To do`, `In progress`), or a kind of status: `backlog`, `todo`, `in progress`, `blocked`, `done` or `cancelled`. Empty means the first "to do" status. See below. |
| `priority`    | `urgent`, `high`, `medium` or `low`. Empty means `medium`.                                                                                                                                                |
| `assignees`   | Usernames, separated by `;`.                                                                                                                                                                              |
| `team`        | A team name. A task with a team and no assignees waits in that team's queue. Empty means the run's team.                                                                                                  |
| `labels`      | Labels, separated by `;`.                                                                                                                                                                                 |
| `due`         | A date (`2026-03-14`, meaning the end of that day, UTC), a date and time (`2026-03-14T09:00Z`), or an offset from the run's start: `+1d`, `+4h`, `+1d12h`, `+2w`.                                         |
| `blocked_by`  | Keys of other rows in the same file, separated by `;`. The task waits on them. Midden refuses a file whose tasks wait on each other in a loop.                                                            |
| `checklist`   | Checklist items, separated by `;`. Start an item with `[x]` to import it already ticked.                                                                                                                  |
| `approver`    | The username of the person who must sign the task off.                                                                                                                                                    |
| `case`        | A case's number, name or id. You can only link to cases you can see.                                                                                                                                      |

To put a `;` inside a list item, write `\;`. To put a `\` there, write `\\`.

### Statuses

Each run has its own list of statuses, and every status is one of six kinds: backlog, to do, in progress, blocked, done or cancelled. A `status` cell is matched first against the run's status names, then against those kinds.

If a file names a status the run doesn't have, the import preview says so. A lead can add it to the run's statuses there, choosing which kind it is, and the import goes ahead.

### Importing

On the **Tasks** page, choose **Import…**, pick a saved playbook or a CSV file, and choose whether to start a new run or add the tasks to an open one. For a new run, give it a name, a team and a start date: offsets such as `+2d` count from that start.

Midden checks the whole file before anything is created and lists every problem with its line number: unknown users, teams, cases or approvers, bad dates, keys that don't exist, and dependency loops. Nothing is imported until there are no errors. Then the whole import is one change, so a single **Undo** in the history removes it, and each person assigned work gets one notification for the lot rather than one per task.

Importing takes a lead of the run's team, or an admin. Files can be up to 2 MB and 5,000 rows.

Once the tasks are in, a lead can select them on the board and use **Distribute…** to share them out between people. It either balances open work, counting what each person already has, or goes round-robin, with the highest-priority tasks dealt first either way.

### Exporting

On the **Tasks** page, **Export…** downloads the tasks in the current view, in the same format. You choose:

- **Due dates as dates or as offsets.** Offsets, like `+2d`, need every task to be in one run. Exporting a run with offsets is how you make a playbook from it, as is **Save as playbook** on the Playbooks & runs page.
- **The record columns:** `id` (the T-number), `created`, `completed`, `approval_state` and `approval_comment`. Importing ignores them, so an exported file still imports cleanly.
- **Comments**, in a `comments` column, also ignored on import.

Keys in an export are task numbers, so dependencies survive a round trip. Tasks you can't see are never exported.

A cell that starts with `=`, `+`, `-` or `@` is written with a leading `'`, so a spreadsheet shows it as text instead of running it as a formula. Midden removes that `'` again when it imports the file.

An approval decision can't be imported, because it has to be made in person. A row that is already done keeps its status and loses its approver, and the preview warns about it.

## Scripts and AI agents

Everything above is in the [API](api.md), including `POST /api/tasks/import` with `?preview=1` to check a file without importing it. AI agents can list, read, create, update, assign and comment on tasks through the [MCP endpoint](mcp.md), but can't approve anything.
