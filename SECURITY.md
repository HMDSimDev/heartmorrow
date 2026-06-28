# Security Policy

Heartmorrow/DSim is a local-first, single-player application. The web client talks
to a local Fastify server, and that server talks to the LLM endpoint configured by
the user. This policy explains how to report security issues and how to run the
project safely.

## Supported Versions

Security fixes are made on the default branch for the current development
version. This project is still pre-1.0, so older commits, local forks, and
unmaintained branches are not guaranteed to receive backported fixes.

When tagged releases are introduced, the latest release and the default branch are
the supported targets unless stated otherwise.

## Reporting a Vulnerability

Please do not open a public issue with exploit details, proof-of-concept code, or
private data.

Use GitHub private vulnerability reporting, or reach out on the Discord and
we can take a look at your report to triage and fix it.

Include as much of the following as you can:

- Affected commit, branch, or release.
- Operating system, Node.js version, and pnpm version.
- Whether the API server was bound to `127.0.0.1`, `localhost`, a LAN address, or a
  public interface.
- Clear reproduction steps.
- The impact you believe is possible.
- Any relevant logs, stack traces, sample files, or requests.

## Response Expectations

This is a small project, but we'll try our best to do the following:

- Acknowledge a valid private report within 7 calendar days.
- Confirm the affected versions or commits.
- Share whether the issue is accepted, needs more information, or is considered out of scope.
- Credit the reporter if they want credit and the disclosure is coordinated.

## In Scope

Reports are especially useful when they affect:

- Arbitrary code execution, command execution, or unintended file writes.
- Path traversal or access outside configured data/upload directories.
- Secret exposure, particularly the LLM API keys stored in `.env` or local SQLite data.
- Unsafe handling of uploaded images, imported save bundles, or shared character/world packs.
- Zip bombs, archive traversal, symlink, or resource-exhaustion attacks in import paths.
- Cross-site scripting or browser-side data exfiltration, especially if reachable through
  imported data.
- Documentation that would lead users to expose the local server API unsafely.

## Usually Out of Scope

The following are usually not security vulnerabilities by themselves:

- Model jailbreaks, prompt injection, or unwanted roleplay/content that does not
  escape the app's local data and execution boundaries.
- Claims that require the attacker to already control the user's machine,
  shell, repo checkout, browser profile, or filesystem.
- Denial of service from intentionally enormous local saves or data files created
  by the same trusted user, unless it bypasses an intended import/upload limit.
- Issues caused by deliberately binding the API to a public interface.
- Vulnerabilities in third-party LLM servers, model providers, or browser
  extensions.

If in doubt, report privately anyway. We can deal with false alarms.

# Security Model

Heartmorrow is designed for one trusted local user, not for hosting as a shared
internet service. There is currently no authentication, authorization, or multi-user
account boundary. It is not designed to be used by anyone but a single user at this time.

If you decide to host this publicly somewhere, even if you intend for it to be private,
please be aware that at this time this is not an intended configuration. This may change
in the future.

## Secrets and LLM Providers

When using a remote or cloud LLM endpoint, prompts, character data, conversation
context, uploaded images sent to a vision model, and other generated context may
leave the machine and be processed by that provider. Review the provider's data
retention and privacy terms before using private content.

For local LLM servers, prefer loopback URLs such as `http://localhost:1234/v1`
or `http://127.0.0.1:1234/v1`. Avoid pointing the app at untrusted endpoints.
While LLM serving endpoints should not be able to influence the game in a security-relevant
way no matter what they return, if you find an instance where this is not true, please let us know!


## User-Provided Content

Uploaded images and imported share packs are untrusted input. The application
attempts to limit risk with MIME allow-lists, size caps, generated filenames,
path checks, strict JSON validation, and bounded ZIP decoding. Please still use
normal caution:

- Import packs only from people or communities you trust.
- Avoid running third-party scripts, experimental plugins, or modified installers
  from untrusted sources.
- Keep backups of the data directory (<game root>/apps/server/data)
  before importing large or unfamiliar content.

