# Running a hunt with tasks

The Tasks tab is a kanban board for the work of a hunt: who is sweeping which hosts, what is waiting on someone else, what is done and what it found. Leads plan the work there, analysts move their own cards, and everyone on a task hears when it changes.

Tasks live in the case with everything else. They are saved in the case file, synced live between everyone in the case, recorded in the history, and can be reverted like any other change. The standalone build has the same board, without accounts or notifications.

## The board

There are six columns: **Backlog**, **To do**, **In progress**, **Blocked**, **Review** and **Done**. Drag a card to move it, or change its status in the editor. Moving a card to Done stamps when it was finished; moving it back clears that.

A card shows the title, priority (when it is not normal), the ATT&CK technique it hunts for, its tags and hosts, who is on it, the due date (in red once it is late), checklist progress and how many comments it has. A card with a cyan edge is one of yours.

Above the board you can narrow it down:

- **Everyone**, **Mine**, **Following** or **Unassigned**.
- Text search across titles, descriptions, people, hosts, tags and checklist steps.
- Priority, or one host.

Press <kbd>T</kbd> anywhere in a case to add a task.

## What a task holds

| Field       | What it is for                                                                            |
| ----------- | ----------------------------------------------------------------------------------------- |
| Title       | What needs doing, in a line.                                                              |
| Status      | Its column.                                                                               |
| Priority    | Urgent, high, normal or low.                                                              |
| Assigned to | One or more people. Everyone assigned is notified of changes.                             |
| Hosts       | The case hosts the work covers. The host's editor lists its tasks, too.                   |
| Events      | Timeline events the work came from or produced. The event's editor lists its tasks.       |
| ATT&CK      | The technique a hypothesis-driven task hunts for, such as `T1003.006`.                    |
| Tags        | Free labels, such as a shift or a workstream.                                             |
| Due         | A deadline, entered in your browser's time and shown in the case's clock.                 |
| Description | Where to look and what counts as done.                                                    |
| Checklist   | The steps, ticked off as they are done.                                                   |
| Outcome     | What the work found. It shows on the card once the task is done, and stays in the export. |
| Comments    | Progress, findings and questions, in order, with who wrote them.                          |

You can also start a task from a host or an event: open it and choose **+ Task for this host** (or event), and the new task is linked to it.

## Notifications

When a task changes, its assignees and followers are told, except the person who made the change:

- Someone added to a task hears that they were assigned, and someone taken off hears that too.
- A move to another column says which column.
- An edit says which fields changed.
- A comment is quoted.
- A deleted task says so.

Anyone who can read the case can **Follow** a task from its editor, including viewers. A lead who wants to know when a task reaches Review can follow it without being assigned.

Notices arrive live, with a toast, while you have Midden open, and wait in the bell in the top bar until you read them. Choosing one opens the task. A change that touches many of your tasks at once, such as a bulk assignment or an import, arrives as one notice that sums it up, not one per task. Someone who loses access to a case stops hearing about it, and its old notices are hidden from them.

Following is personal: it isn't part of the case file and isn't reverted with the history.

## Bulk actions, import and export

These are for case owners and admins (anyone who can manage the case). Everyone who can edit the case can add, edit and move tasks one at a time.

**Selecting.** Tick a card, <kbd>Ctrl</kbd>/<kbd>⌘</kbd>-click to add cards, <kbd>Shift</kbd>-click to select a run of cards, tick a column header for the whole column, or choose **Select shown** to select everything the current filters show. Dragging one selected card moves the whole selection.

With cards selected, the bar above the board can:

- **Move to** another column.
- **Assign / edit**: add people to, remove people from, or replace the people on every selected task, and do the same for hosts. Set the priority, status or due date, and add or remove tags, all in the same step.
- **Duplicate** in this case. Copies keep the plan (title, people, hosts, checklist) and start fresh: unticked checklist, no outcome, no comments.
- **Copy to case** into another case you can edit. People are matched by username and hosts by name or address there.
- **Delete**, together with the tasks' comments.

Each bulk action is one change in the history, so one revert undoes it.

**Export** writes the selected tasks, or every task shown, as a task list (`.json`) or a spreadsheet (`.csv`). **Import** reads either back into a case, so the standard opening moves of a hunt can be written once and loaded into each new case. The import dialog can put every task in one column and assign everyone in the file to someone extra, and it says which people and hosts it could not match before anything is added.

A spreadsheet needs a `title` column. These are optional: `description`, `status`, `priority`, `assignees`, `hosts`, `technique`, `tags`, `due` and `checklist`. Put several people, hosts, tags or steps in one cell separated by `;`. Common spellings work too, such as "Assigned to", "In progress" and "P1".

```csv
title,assignees,hosts,priority,technique,checklist
Sweep DCs for DCSync,ann,DC01; DC02,high,T1003.006,Pull 4662 events; Check DRSUAPI from non-DCs
Image the file server,bob,10.20.8.4,urgent,,Memory; Disk; Hash and log custody
Review proxy logs for cloud storage,,,normal,T1567.002,
```

People are named by username in the hosted app and by name in the standalone build. Hosts are named by hostname or address, because ids mean nothing in another case. Linked events are not exported, for the same reason.

## Scripts and agents

Tasks are changed with ordinary operations through `POST /api/cases/{id}/ops`: `task.add`, `task.set`, `task.remove`, `comment.add`, `comment.set` and `comment.remove`. Notices are at `GET /api/notifications`, and following is `PUT` or `DELETE /api/cases/{id}/tasks/{taskId}/follow`. See the [API reference](api-reference.md).

AI agents connected over [MCP](mcp.md) can list and read tasks, and with a write token add them, update them and comment on them. They can't delete tasks.
