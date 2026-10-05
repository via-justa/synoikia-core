# §1 Introduction

## 1.1 Purpose

Synoikia is one MCP server for many self-hosted services. An AI client connects to an endpoint and gets two tools: `search(code)` and `execute(code)`. The model writes code that core runs in a sandbox. The code calls the upstream through a binding. Each call goes through the gate before it can reach the upstream.

## 1.2 Scope

The design has these parts:

- One core process with two HTTP listeners: the MCP listener and the Admin listener (§2).
- A plugin system. Each plugin describes one kind of upstream. An admin can run one plugin as many instances. Each instance has its own endpoint, catalog, rules and audit records (§3, §4).
- One gate, sandbox, approval flow, redaction engine and audit log for all instances (§5).
- Authentication for the admin portal and for MCP endpoints (§6).
- One SQLite database with encrypted secrets (§7).
- An admin portal on its own port (§8).
- Notifications, scheduled maintenance and deployment (§9, §10, §11).

## 1.3 Design principles

- **Security is in core, once.** Core makes every decision about what can reach an upstream. A plugin only describes its upstream. A plugin can give core wrong data, but it cannot skip the gate.
- **Fail closed.** If core cannot make a decision, it refuses the call or hides the operation.
- **A human approves, not the client.** A risky call needs a decision from a signed-in human on a page that core shows. The answer of the calling client is not an approval.
- **Secrets stay out of the sandbox.** Upstream credentials are encrypted at rest. The API does not return them. The sandbox never gets them.
- **Everything is audited.** Core writes each call, search, configuration change, sign-in failure and plugin event to the audit log.

## 1.4 Limits of the design

- There are no roles. All portal users are admins. The user table exists for OIDC, TOTP and audit records.
- There is one core process. It owns the SQLite file. The design does not scale across hosts.
- Core does not terminate TLS. A reverse proxy does this.
- There is no endpoint that combines the tools of many instances. Each instance is its own MCP server.
