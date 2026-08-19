# Oh My Pi

T3 Code connects to the external Oh My Pi CLI through its ACP interface. T3 Code does not install,
update, or replace Oh My Pi; install the `omp` executable on the machine running the T3 Code server.

## Install and authenticate

Follow the [Oh My Pi installation instructions](https://github.com/can1357/oh-my-pi#installation),
then authenticate Oh My Pi on the server host using its native login flow. The credentials stay on
that host. A phone, browser, or remote desktop connected to T3 Code does not need the CLI or its
credentials locally.

Open **Settings** and add or edit an **Oh My Pi** provider instance. T3 checks the configured binary
and starts a short ACP probe to discover the available models.

## Instance configuration

- **Binary path**: `omp` when the executable is on the server's `PATH`, or an absolute path.
- **Agent directory**: leave blank to give each T3 provider instance an isolated native directory;
  set it when you intentionally want to share an existing Oh My Pi configuration and session store.
- **Launch arguments**: optional Oh My Pi arguments. T3 adds `acp` for normal sessions and keeps
  native arguments before that subcommand.

Oh My Pi remains the source of truth for its configuration, credentials, model catalog, skills, and
session history. T3 reads the runtime model catalog and sends model selections back through ACP; it
does not ship a fixed Oh My Pi model list. The optional custom-model entries in the provider card
are only T3-side catalog additions for model identifiers your native setup already supports.

## Sessions and rollback

Normal work uses one long-lived `omp acp` process per thread and resumes the native session by its
opaque Oh My Pi session id. T3 does not recreate a conversation by replaying visible transcript
text.

When you revert a checkpoint, T3 asks Oh My Pi's native RPC control mode to branch the session at the
corresponding user entry, then starts ACP on the new native session. If the native operation fails,
T3 reports the failure and attempts to restore the original session; it does not silently substitute
a new conversation.

## Remote use

Oh My Pi runs wherever the T3 server runs. Remote clients control the same server-owned process,
files, native configuration, and credentials over T3's authenticated connection.
