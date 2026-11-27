# Contributing to AgilFrame

[Русский](CONTRIBUTING.md) · **English**

See the [README](README.en.md) for setup and test commands. Use the [issue forms](https://github.com/GillHD/agilframe-websdk/issues/new/choose) for bug reports and feature requests. Report suspected vulnerabilities [privately](SECURITY.en.md).

## Issues

- Open one issue per problem or requested outcome. Name the affected component and describe the behavior or outcome in the title.
- For a bug, include the version or commit SHA, environment, relevant roles, reproduction steps through the standard interface, and the expected and actual behavior. For a UI bug, include the theme, viewport width, and a screenshot with sensitive details removed. Include the topology for multi-node issues.
- For a feature request, describe who needs it, what they are trying to do, the requested behavior, and the acceptance criteria. For an API change, cover compatibility and any required migration.
- Remove tokens, keys, personal data, private URLs, and content from organization calls before attaching files.

## Code changes

1. Create a short-lived branch from the latest `main`. Keep each pull request focused on one task.
2. Reuse existing interfaces, permission checks, and components. Verify that changes to REST, WebSocket, or configuration remain compatible with the current SDK and previously stored data.
3. Add a regression test if the existing tests would miss the fix. Document changes to user workflows. Keep build artifacts, caches, and personal tool settings in your local environment.
4. Commit using your GitHub identity with a verified address or your GitHub-provided no-reply address. Describe the change in the subject line. Explain the rationale for technical decisions in the commit body or pull request.

List the checks you ran. For browser changes, include the test scenario and its results. Explain skipped checks when they affect acceptance.

## AI-assisted changes

Disclose substantial AI-assisted additions or rewrites in the pull request. Identify the affected module and the checks you ran. As the author, personally review the entire diff, including tests and configuration. Verify correctness, security, licensing, error handling, and compatibility. You are responsible for the changes and should be able to explain them during review. Changes with significant consequences require human review under the project’s usual rules.

## Pull requests and review

- Explain why the change is needed, what users will see, and how you tested it. Use `Fixes #123` when the pull request fully resolves an issue. Mark work in progress as a draft.
- Discuss changes to authorization, data schemas, public APIs, or licensing with a maintainer first. Describe compatibility, upgrade and rollback steps, and limitations.
- Reviewers check the stated behavior, access boundaries, backward compatibility, and tests. Resolve blocking feedback and pass the applicable CI checks before merging. Automated comments alone do not establish that a human review took place.
- Submit changes you have the right to contribute. See the [license](LICENSE) and [third-party notices](NOTICE). A maintainer verifies the necessary rights before commercial relicensing of external contributions.
