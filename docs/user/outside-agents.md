# Outside agents

Agents that T3 Code did not start can work with an environment through its MCP
server. They can read projects and threads, start and message threads, and
check which providers and models are available. This covers Claude Code or
Codex in your own terminal, ChatGPT, and bots that support MCP. Each agent signs
in once, and you choose what it may do.

For direct access, register each machine's MCP URL with the agent. Its standard
T3 tools act on that machine. For one entry point across an approved LAN fleet,
connect a fleet client to the gateway environment: its `t3_lan_*` tools select
the destination machine. Fleet credentials keep their machine, project and task
limits; they do not become general-access credentials.

## Get the MCP URL

In **Settings → Environments**, open a saved environment's menu and choose
**Copy MCP URL**. The URL is the environment's address followed by `/mcp`, for
example:

```text
https://<environment-address>/mcp
```

The copied URL uses the route this device is connected over, so an agent on the
same device can reach it.

- **An agent on your own computers** can use `localhost` on the host, T3
  Connect, or any `https` address, such as
  [Tailscale HTTPS](./remote-access.md#tailscale-https). Signing in sends the
  agent's credentials to the environment, and agents only do that over `https`
  or to `localhost`. A plain-`http` LAN or Tailscale address, like
  `http://100.x.y.z:3773`, lets an agent find the environment but not finish
  signing in.
- **A hosted agent**, such as ChatGPT or a bot running in the cloud, must reach
  the environment from the internet. Use the T3 Connect address. A Tailscale
  address only works from your own tailnet.

## Approve a sign-in

The first time an agent connects, it opens a sign-in page on the environment.
The page names the agent and where its access goes:

- For an agent on your computer, approval returns to a `localhost` address on
  the computer that opened the page.
- For a hosted agent, approval goes to that service, such as `chatgpt.com`.
  Anyone who runs that service gets the access.

Only approve a sign-in you just started. To approve, enter a pairing code from
**Settings → Sharing & access** or from `t3 auth pairing create` on the host. A
browser already signed in to the environment with permission to manage access
can approve without a code.

Then choose what the agent may do:

- **Read only** is the default. The agent can read projects and threads and see
  the available providers and models. It cannot change anything.
- **Supervised** through **Full access** also let it start, message and stop
  threads in every project. A thread it starts or steers cannot run with more
  permissions than the mode you chose.

## Claude Code

```sh
claude mcp add --transport http t3 https://<environment-address>/mcp
claude mcp login t3
```

`claude mcp login` opens the sign-in page in your browser. On a machine
without a browser, add `--no-browser`, open the printed URL elsewhere, and
paste the final URL back when asked. `claude mcp list` shows `t3` as connected
once you approve.

## Codex

```sh
codex mcp add t3 --url https://<environment-address>/mcp
codex mcp login t3
```

`codex mcp login --no-browser` prints the sign-in URL instead of opening it.
`codex mcp list` shows `t3` with OAuth once you approve.

## ChatGPT

Add the environment as a custom MCP app in ChatGPT's apps settings:

1. Create a new app or plugin with a custom MCP server.
2. Set the server URL to `https://<environment-address>/mcp`, using the T3
   Connect address.
3. Choose **OAuth** for authentication. ChatGPT discovers the rest; you do not
   need a client ID or secret.
4. Create the app, then approve the sign-in page that opens.

## Other agents and bots

Any agent that supports remote MCP servers over HTTP with OAuth can connect. Give
it the MCP URL and choose OAuth, and the agent finds the sign-in settings itself.
Agents without OAuth support cannot connect.

## Scripts on the host

On the machine that runs the environment, `t3 thread` uses the same tools
without a sign-in:

```sh
id=$(t3 thread start . "Find why the tests are slow")
t3 thread send "$id" "Now fix it" --wait
t3 thread show "$id"
t3 thread list
```

`.` means the project that contains the current folder; a project id also
works. A new thread uses the project's default model and permission mode, and
runs in the project folder unless you pass `--worktree <base-branch>`. `send`
never interrupts: a busy thread gets the message as its next turn. Pass `-` as
the message to read it from stdin.

`--wait` prints the agent's reply. It exits 1 when the run fails or stops, and
2 when the agent waits for an answer you give in the app. Add `--json` for a
result that always includes the thread id.

## Remove an agent

Approved agents appear under **Settings → Sharing & access** like other clients.
Revoke one there to cut off its access immediately. A sign-in lasts 30 days;
after that the agent asks you to approve it again.

A gateway may instead request renewable task access. The sign-in page identifies
that request and limits it to Auto or a lower mode, within the machine and project
policy configured for that gateway. It can renew for up to 90 days before you
approve it again. Revoking its connection stops both access and renewal.

### Answer provider permission requests

Permission responses need the separate, unchecked approval option when signing
in. Full access and ordinary pairing codes do not include it. To use a code,
create an approval-capable agent code in **Settings → Sharing & access**, then
select the approval option on the agent sign-in page too.

An agent can read a request with `t3_approval_request`, show its complete
permission and lifetime, and respond only after your consent. Initial support
is local Codex 0.159.0 permissions requests with a verified native profile.
Accept grants the requested permissions for the whole provider turn. Commands,
file approvals, Chrome requests and other providers remain in the app.

A committed response is still pending delivery. A written response confirms the
native transport write; it does not confirm tool execution. An uncertain response
needs inspection before another attempt. Remove approval permission for a session
or this application's sign-ins in **Settings → Sharing & access**. Signing in
without approval permission removes earlier approval rights in the same consent
family, while other access remains available.

### Approvals through a linked environment

In the destination's **Sharing & access → Linked approval access** (or the
mobile environment's settings), create an approval link identity for the exact
source environment. On the source, request approval permission while linking
and paste a deliberately approval-capable pairing code from the destination.
This creates a new sign-in; existing link credentials keep their original rights.
Back at the destination, select that exact new peer sign-in, bind it to the
chosen link identity, and enable its approval policy. Fleet links also need
this destination's current signed fleet approval policy. Full access alone
never enables approvals.

For an existing thread, select its exact ID, the stable link identity and the
source agent's opaque client ID, then create a thread delegation. Find that
client ID in the source's agent sign-ins; matching app names are insufficient.
You can inspect and revoke delegations and bindings in the same settings.

A fresh sign-in gets a fresh client ID. To retain an earlier identity, explicitly
select the old and new source sign-ins under **Continue a source client identity**.
Choose sign-ins for the same app with unchanged permission limits; changed
authority needs a fresh identity and destination delegation.
To renew a peer binding, pair again, then select both the new sign-in and the
previous binding. These operations invalidate the old sign-in. Replacing a link
identity ends its delegations and starts without approval permission. Original
approval and creation records remain unchanged.
