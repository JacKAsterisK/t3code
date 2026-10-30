# Task owners

T3 Code LAN marks each task (thread) with the person who manages it. A small
coloured initial on the task row and the owner in the thread header show at a
glance whose task it is. The task's agent is told too.

An owner is a label. It never locks a task and never changes who may read or
work on it. Read-only machines may change a task's owner on any machine they can
read. Nothing else opens up for them (see [Who can change an owner](#who-can-change-an-owner)).

## The users file

The fleet's people live in `fleet-users.json`, in the same folder as the fleet
roster (the directory of `T3CODE_LAN_FLEET_ROSTER_PATH`). The file lives on the
fleet share, not in git.

```json
{
  "version": 1,
  "users": [
    { "id": "dan", "name": "Dan", "color": "blue" },
    { "id": "gavin", "name": "Gavin", "color": "green" }
  ],
  "machineOwners": {
    "machine-bf7ec7c77e1d602980833816": "gavin",
    "machine-ea63af1a8a866ea2b6f84bff": "gavin",
    "machine-319682d2fc67441f86be9b87": "dan",
    "machine-4e3724fa9f1a63530f7fb465": "dan",
    "machine-53eed7cd926073000c15ddc1": "dan",
    "machine-d5d351798450e4044c3dfe2f": "dan"
  }
}
```

The example gives AnvilToad and SPDevMachine to Gavin, and CryoFrog,
PandaMedic, OldCryo and BuildMachine to Dan.

| Field           | Meaning                                                                                                                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`       | Always `1`.                                                                                                                                                                                                                                                         |
| `users[].id`    | Stable id stored on tasks: lowercase letters, digits, `-` and `_`, starting with a letter or digit, at most 32 characters. Never reuse an id for someone else.                                                                                                      |
| `users[].name`  | Display name, at most 64 characters.                                                                                                                                                                                                                                |
| `users[].color` | Optional theme colour: one of the project icon colours (`gray`, `red`, `orange`, `amber`, `yellow`, `lime`, `green`, `emerald`, `teal`, `cyan`, `sky`, `blue`, `indigo`, `violet`, `purple`, `fuchsia`, `pink`, `rose`). Without one, the id picks a stable colour. |
| `machineOwners` | Fleet machine id → user id. The owner a machine gives tasks nothing else names an owner for. Machine ids are the `machineId` values in the roster.                                                                                                                  |

The file is strict: unknown fields, duplicate keys or a user listed twice make
it invalid. Up to 50 users.

Each machine reads the file with every fleet sync (at start, every five minutes,
and when a window syncs) and keeps the last good copy in
`userdata\lan-fleet-users.json`. So badges and defaults survive the share being
away:

- **Share unreachable, file invalid, or the file cannot be checked** (an access
  or network error): the last good copy stays in use; an invalid file is logged.
- **Share reachable, file confirmed absent:** the users are cleared. Owners show as their raw
  id and no default applies.
- **Never read:** everything still works; tasks just have no owner.

A window picks up an edited file the next time it connects to its machine.

## Who owns a new task

| Task started by                                                                   | Owner                                                                                                      |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| You, from the app                                                                 | This device's **I am** user (Settings › General). It defaults to the owner of the machine the app runs on. |
| An agent: `delegate_task` (here or on another machine), provider subagents, forks | The parent task's owner.                                                                                   |
| An agent: `t3_thread_launch` (here or on a linked machine), `create_threads`      | The `ownerId` it passes, else its own task's owner.                                                        |
| `schedule_task`                                                                   | The `ownerId` it passes, else the scheduling task's owner, else each run's machine default.                |
| An outside MCP agent, `t3_lan_task_launch`, a scheduled run without an owner      | The `ownerId` passed, else the host machine's default owner.                                               |

### Existing tasks

The first time a machine knows its default owner, it gives every task it hosts
that has no owner to that default. A task gets it only if it is still unowned at
that moment, so an owner someone picks during the pass stays. A pass that covers
every task records it in `userdata\task-owner-backfill.json`, and later file
changes never reassign anything; a pass that could not label a task records
nothing and tries again at the next start.
After the pass, every task has an owner; you can reassign one but not unassign it.

## Changing an owner

- Click the badge on a task row or in the thread header.
- **Assign to…** in a task's menu (right-click a row, or the header's menu).
- **Assign to…** in the command palette for the open task.

Everyone viewing the task, on any device or machine, sees the change at once:
the owner is stored on the task by the machine that runs it.

## Filtering the sidebar

The sidebar filter menu has an **Owner** choice: **Mine**, each other user's,
or **Everyone**. It is per device. **Mine** means this device's **I am** user.
Tasks with no owner show only under **Everyone**. A subtask follows its parent.

## What agents see

Each turn tells the task's agent who manages it, for example
`This task is managed by Dan.` A Claude session learns a change when its session
next restarts; a Pi session at its next turn. `t3_thread_read` and `t3_thread_list` results include `ownerId`
and `ownerName`.

## Who can change an owner

Setting an owner is the one write a read-only session may make. Any
authenticated session that can read threads may set a task's owner, including a
read-only fleet machine through its capped credential. Guests on a shared link
never can. Everything else a read-only session tries is still refused.
See [native feature sync, row 13](../maintenance/native-feature-sync.md#13-per-machine-fleet-access).
